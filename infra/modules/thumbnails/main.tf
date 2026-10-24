# Thumbnail Lambda (spec §10, §13.1): S3 upload → thumb + preview → DynamoDB `ready`/`failed`.
# Code: services/thumbnails, packaged into dist/ by `pnpm build:py` (6.8) and zipped here.
#
# This module owns the photo bucket's event notification (S3 allows one configuration per
# bucket, so nothing else may declare one).

locals {
  name = "photo-app-${var.environment}-thumbnails"

  # Key layout from packages/shared s3Keys.ts.
  originals_arn = "${var.bucket_arn}/users/*/originals/*"
  derived_arns  = ["${var.bucket_arn}/users/*/thumbs/*", "${var.bucket_arn}/users/*/previews/*"]
}

data "archive_file" "package" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${local.name}.zip"
}

# --- Failed events (NFR-OPS-1) ----------------------------------------------------------------

# Receives an event after the async retries are used up, with the error (Lambda on-failure
# destination record: request payload + response). 14 days to inspect or redrive.
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 14 * 24 * 60 * 60
  sqs_managed_sse_enabled   = true
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

  statement {
    sid       = "FailedEvents"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
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
  timeout     = 60

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

# S3 invokes asynchronously: transient errors are retried twice, then the event goes to the DLQ.
resource "aws_lambda_function_event_invoke_config" "thumbnails" {
  function_name          = aws_lambda_function.thumbnails.function_name
  maximum_retry_attempts = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.dlq.arn
    }
  }
}

# --- Trigger ------------------------------------------------------------------------------------

resource "aws_lambda_permission" "s3" {
  statement_id   = "AllowPhotoBucket"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.thumbnails.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = var.bucket_arn
  source_account = data.aws_caller_identity.current.account_id
}

data "aws_caller_identity" "current" {}

# Spec §10: every object created under users/. S3 filters can't express users/*/originals/, so
# the handler ignores thumbs, previews and anything else (they cost one short invocation each).
resource "aws_s3_bucket_notification" "photos" {
  bucket = var.bucket_name

  lambda_function {
    lambda_function_arn = aws_lambda_function.thumbnails.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "users/"
  }

  depends_on = [aws_lambda_permission.s3]
}
