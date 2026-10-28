# Trash purge (FR-DEL-3): once a day, a Lambda deletes every trashed photo whose 15 days are up
# (files, item, place entries, Usage). Same bundle as the API (dist/purge.mjs), own role: it only
# touches photo items and photo objects, and is invoked only by its schedule.

locals {
  purge_name = "photo-app-${var.environment}-trash-purge"
}

resource "aws_iam_role" "purge" {
  name               = local.purge_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "purge" {
  # Query on GSI1 (`TRASH`, by purge date), then the photo delete transaction: photo item,
  # place items and Usage (apps/api/src/repo/photos.ts `delete`). No scans.
  statement {
    sid = "Table"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:Query",
    ]
    resources = [var.table_arn, "${var.table_arn}/index/*"]
  }

  statement {
    sid       = "DeletePhotoObjects"
    actions   = ["s3:DeleteObject"]
    resources = local.photo_object_arns
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.purge.arn}:*"]
  }
}

resource "aws_iam_role_policy" "purge" {
  name   = "trash-purge"
  role   = aws_iam_role.purge.id
  policy = data.aws_iam_policy_document.purge.json
}

# NFR-OPS-2: 30 days.
resource "aws_cloudwatch_log_group" "purge" {
  name              = "/aws/lambda/${local.purge_name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "purge" {
  function_name    = local.purge_name
  role             = aws_iam_role.purge.arn
  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "purge.handler"
  memory_size   = 512
  # Five photos at a time, a few calls each; a day's expired trash fits easily.
  # No reserved concurrency: dev's account limit is 10 (12.3a), all unreserved. An overlapping
  # run would be harmless anyway, every write is conditional.
  timeout = 300

  environment {
    variables = {
      TABLE_NAME   = var.table_name
      PHOTO_BUCKET = var.bucket_name
      NODE_OPTIONS = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.purge.name
  }

  depends_on = [aws_iam_role_policy.purge]
}

# Daily at 03:00 UTC. A photo is purged at most a day after its 15 days are up.
resource "aws_cloudwatch_event_rule" "purge" {
  name                = local.purge_name
  description         = "Daily trash purge (FR-DEL-3)"
  schedule_expression = "cron(0 3 * * ? *)"
}

resource "aws_cloudwatch_event_target" "purge" {
  rule = aws_cloudwatch_event_rule.purge.name
  arn  = aws_lambda_function.purge.arn

  # A failed run is simply repeated by the next day's; no event retries piling up.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 3600
  }
}

resource "aws_lambda_permission" "purge_schedule" {
  statement_id  = "AllowDailySchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.purge.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.purge.arn
}
