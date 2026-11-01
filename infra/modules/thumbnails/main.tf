# Thumbnail Lambda (spec §10, §13.1): S3 upload → SQS → thumb + preview → DynamoDB `ready`/`failed`.
# Code: services/thumbnails, packaged into dist/ by `pnpm build:py` (6.8) and zipped here.
#
# This module owns the photo bucket's event notification (S3 allows one configuration per
# bucket, so nothing else may declare one).

locals {
  name = "photo-app-${var.environment}-thumbnails"

  # Spec §10: 60 s. The queue's visibility timeout derives from it.
  timeout_seconds = 60

  # Key layout from packages/shared s3Keys.ts.
  originals_arn = "${var.bucket_arn}/users/*/originals/*"
  derived_arns  = ["${var.bucket_arn}/users/*/thumbs/*", "${var.bucket_arn}/users/*/previews/*"]
}

data "archive_file" "package" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${local.name}.zip"
  # Same zip on any machine: file modes otherwise follow the builder's umask (664 locally, 644 in
  # CI), which changes the hash and redeploys an unchanged function (10.2).
  output_file_mode = "0644"
}

# --- Queue + failed events (spec §10, B-11, 13.6; NFR-OPS-1) -----------------------------------

# S3 events wait here; the event source mapping below caps how many Lambdas work on them at once,
# so an upload burst (bulk upload 13.1, import 13.5) can't use up the account's concurrency and
# throttle the API, and fewer final transactions hit the Usage item at once (13.4).
resource "aws_sqs_queue" "thumbnails" {
  name = local.name
  # AWS guidance for Lambda consumers: 6 × the function timeout, so a message isn't received
  # again while a (retried) invocation still works on it.
  visibility_timeout_seconds = 6 * local.timeout_seconds
  message_retention_seconds  = 4 * 24 * 60 * 60
  sqs_managed_sse_enabled    = true

  # Transient errors: the message comes back after the visibility timeout; after 3 receives it
  # moves to the DLQ.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })
}

# Messages that failed 3 times (the S3 event as sent). 14 days (longer than the queue's 4, as
# SQS keeps the original enqueue time) to inspect or redrive to the queue.
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 14 * 24 * 60 * 60
  sqs_managed_sse_enabled   = true
}

# Only this account's photo bucket may send (confused-deputy protection).
data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "PhotoBucket"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.thumbnails.arn]

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [var.bucket_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "thumbnails" {
  queue_url = aws_sqs_queue.thumbnails.id
  policy    = data.aws_iam_policy_document.queue.json
}

# --- IAM (NFR-SEC-7) --------------------------------------------------------------------------

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "thumbnails" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "thumbnails" {
  # Read the upload; delete it when its photo no longer exists (orphaned original, 6.12).
  # No PutObject here: the Lambda can never write an original (loop protection, spec §10).
  statement {
    sid       = "Originals"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = [local.originals_arn]
  }

  # Write thumbs and previews; delete them again if the photo was deleted meanwhile (race).
  statement {
    sid       = "Derived"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = local.derived_arns
  }

  # Photo item read + the final transaction (photo status and Usage counters).
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.table_arn]
  }

  # Event source mapping (polls with the function's role). The DLQ is fed by SQS itself.
  statement {
    sid       = "Queue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.thumbnails.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.thumbnails.arn}:*"]
  }
}

resource "aws_iam_role_policy" "thumbnails" {
  name   = "thumbnails"
  role   = aws_iam_role.thumbnails.id
  policy = data.aws_iam_policy_document.thumbnails.json
}

# --- Function -----------------------------------------------------------------------------------

# Created before the function so Lambda never makes its own (never-expiring) group.
resource "aws_cloudwatch_log_group" "thumbnails" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "thumbnails" {
  function_name    = local.name
  role             = aws_iam_role.thumbnails.arn
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256

  runtime       = "python3.13"
  architectures = ["arm64"]
  handler       = "thumbnails.handler.handler"
  # Spec §10: 1536 MB (also buys CPU for decoding), 60 s.
  memory_size = 1536
  timeout     = local.timeout_seconds

  environment {
    variables = {
      TABLE_NAME = var.table_name
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.thumbnails.name
  }

  # The role's policy must exist before the first event arrives.
  depends_on = [aws_iam_role_policy.thumbnails]
}

# --- Trigger ------------------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

# Spec §10: every object created under users/. S3 filters can't express users/*/originals/, and
# Lambda event filters can't either (prefix/suffix only, and all keys start with users/), so the
# handler skips thumbs, previews and anything else (a few ms each inside a batch).
resource "aws_s3_bucket_notification" "photos" {
  bucket = var.bucket_name

  queue {
    queue_arn     = aws_sqs_queue.thumbnails.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "users/"
  }

  # S3 checks it may send (with a test event) when the configuration is saved.
  depends_on = [aws_sqs_queue_policy.thumbnails]
}

resource "aws_lambda_event_source_mapping" "thumbnails" {
  event_source_arn = aws_sqs_queue.thumbnails.arn
  function_name    = aws_lambda_function.thumbnails.arn
  # A batch holds originals and the (instant) thumb/preview events; the handler hands back what it
  # can't finish before the timeout.
  batch_size = 5
  # Failed messages only, not the whole batch, come back (handler returns batchItemFailures).
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.maximum_concurrency
  }
}
