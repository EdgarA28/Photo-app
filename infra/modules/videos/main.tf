# Video Lambda (spec §10.2, §13.1, 14.4): video originals → SQS → poster thumb + preview and
# metadata → DynamoDB `ready`/`failed`. Code: services/thumbnails (`thumbnails.video_handler`),
# packaged into dist-video/ by `pnpm build:py` (Pillow + PyAV, 14.3) and zipped here.
#
# Same pattern as the thumbnails module, which owns the bucket's notification (S3 → EventBridge):
# this module adds a second EventBridge rule for `.mp4` / `.mov` originals and its own queue.

locals {
  name = "photo-app-${var.environment}-videos"

  # Spec §10.2: probing reads a few MB, but a 4K HEVC poster or a big index takes a while; 5 min
  # leaves room for slow S3 reads. The queue's visibility timeout derives from it.
  timeout_seconds = 300

  # Key layout from packages/shared s3Keys.ts; VIDEO_EXTENSIONS in constants.ts.
  originals_arn    = "${var.bucket_arn}/users/*/originals/*"
  derived_arns     = ["${var.bucket_arn}/users/*/thumbs/*", "${var.bucket_arn}/users/*/previews/*"]
  video_extensions = ["mp4", "mov"]
}

data "archive_file" "package" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${local.name}.zip"
  # Same zip on any machine (file modes otherwise follow the builder's umask, 10.2).
  output_file_mode = "0644"
}

data "aws_caller_identity" "current" {}

# --- Queue + failed events (spec §10.2; NFR-OPS-1) ------------------------------------------------

resource "aws_sqs_queue" "videos" {
  name = local.name
  # AWS guidance for Lambda consumers: 6 × the function timeout.
  visibility_timeout_seconds = 6 * local.timeout_seconds
  message_retention_seconds  = 4 * 24 * 60 * 60
  sqs_managed_sse_enabled    = true

  # As the thumbnail queue (13.6): after 5 receives (AWS's minimum for Lambda) to the DLQ.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 14 * 24 * 60 * 60
  sqs_managed_sse_enabled   = true
}

# Only the video originals rule of this account may send (confused-deputy protection). The daily
# sweep (api module) sends retries with its own role's identity policy, same account.
data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "VideoOriginalsRule"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.videos.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.originals.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "videos" {
  queue_url = aws_sqs_queue.videos.id
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

resource "aws_iam_role" "videos" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "videos" {
  # HeadObject + ranged GETs of the upload (s3_range.py); delete it when its item no longer exists
  # (orphan, 6.12). No PutObject: the Lambda can never write an original (loop protection, §10).
  statement {
    sid       = "Originals"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = [local.originals_arn]
  }

  # Without it S3 answers HeadObject for a missing original with 403 instead of 404, and a
  # video deleted before processing would be retried until the DLQ instead of skipped.
  statement {
    sid       = "ListForMissingOriginals"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  # Poster thumb and preview; deleted again if the video was deleted meanwhile (race).
  statement {
    sid       = "Derived"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = local.derived_arns
  }

  # Item read + the final transaction (status, Usage, places, album order).
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.table_arn]
  }

  # Event source mapping (polls with the function's role). The DLQ is fed by SQS itself.
  statement {
    sid       = "Queue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.videos.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.videos.arn}:*"]
  }
}

resource "aws_iam_role_policy" "videos" {
  name   = "videos"
  role   = aws_iam_role.videos.id
  policy = data.aws_iam_policy_document.videos.json
}

# --- Function -----------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "videos" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "videos" {
  function_name    = local.name
  role             = aws_iam_role.videos.arn
  filename         = data.archive_file.package.output_path
  source_code_hash = data.archive_file.package.output_base64sha256

  runtime       = "python3.13"
  architectures = ["arm64"]
  handler       = "thumbnails.video_handler.handler"
  # Spec §10.2: ~3008 MB; memory buys CPU for decoding the poster (HEVC/4K).
  memory_size = 3008
  timeout     = local.timeout_seconds

  environment {
    variables = {
      TABLE_NAME = var.table_name
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.videos.name
  }

  depends_on = [aws_iam_role_policy.videos]
}

# --- Trigger ------------------------------------------------------------------------------------

# Video originals only (the thumbnail rule takes the photo extensions). The bucket's EventBridge
# notification is the thumbnails module's.
resource "aws_cloudwatch_event_rule" "originals" {
  name        = "${local.name}-originals"
  description = "Video originals created in the photo bucket → video queue (spec §10.2)"
  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = { name = [var.bucket_name] }
      object = { key = [for ext in local.video_extensions : { wildcard = "users/*/originals/*.${ext}" }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "originals" {
  rule = aws_cloudwatch_event_rule.originals.name
  arn  = aws_sqs_queue.videos.arn

  depends_on = [aws_sqs_queue_policy.videos]
}

resource "aws_lambda_event_source_mapping" "videos" {
  event_source_arn = aws_sqs_queue.videos.arn
  function_name    = aws_lambda_function.videos.arn
  # One video per invocation: each may take a while and uses the function's memory.
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.maximum_concurrency
  }

  metrics_config {
    metrics = ["EventCount"]
  }
}
