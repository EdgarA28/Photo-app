# Daily maintenance, once a day (Lambda `trash-purge`, name kept from FR-DEL-3):
# - trash purge (FR-DEL-3): deletes every trashed photo whose 15 days are up (files, item, place
#   entries, Usage);
# - stale-pending sweep (6.11): deletes `pending` photos over a day old whose original never
#   arrived, releasing their quota reservation (album memberships, Usage `bytesReserved`).
# Same bundle as the API (dist/purge.mjs), own role: it only touches photo items, pending markers
# and photo objects, and is invoked only by its schedule.

locals {
  purge_name = "photo-app-${var.environment}-trash-purge"
}

resource "aws_iam_role" "purge" {
  name               = local.purge_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "purge" {
  # Query on GSI1 (`TRASH`, by purge date) and on the `PENDING` marker partition, then the photo
  # delete transaction: photo item, album memberships, place items and Usage
  # (apps/api/src/repo/photos.ts `delete`), and the marker delete. No scans.
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

  # Stale-pending sweep: did the original ever arrive? HeadObject needs s3:GetObject; without
  # s3:ListBucket S3 answers 403 instead of 404 for a missing key, and the sweep would fail
  # (never delete) on every abandoned upload.
  statement {
    sid       = "CheckOriginals"
    actions   = ["s3:GetObject"]
    resources = [local.originals_arn]
  }

  statement {
    sid       = "ListForMissingOriginals"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
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
  # Five photos at a time, a few calls each; a day's expired trash and stale uploads fit easily
  # (the sweep stops 30 s before the timeout and leaves the rest for the next day).
  # No reserved concurrency: the account limit is shared (dev 1,000 since 12.3a). An overlapping
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
  description         = "Daily trash purge (FR-DEL-3) and stale-pending sweep (6.11)"
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
