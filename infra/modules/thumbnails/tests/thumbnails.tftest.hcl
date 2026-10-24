# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "archive" {}

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  # Policies only need to be valid JSON for the IAM resources' plan-time checks.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/test"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:test"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:123456789012:test-dlq"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/test"
    }
  }
}

variables {
  environment = "test"
  source_dir  = "./tests/fixtures/package"
  bucket_name = "photo-app-photos-test-123456789012"
  bucket_arn  = "arn:aws:s3:::photo-app-photos-test-123456789012"
  table_name  = "photo-app-test"
  table_arn   = "arn:aws:dynamodb:us-east-1:123456789012:table/photo-app-test"
}

run "function_matches_spec" {
  command = plan

  assert {
    condition = (
      aws_lambda_function.thumbnails.function_name == "photo-app-test-thumbnails" &&
      aws_lambda_function.thumbnails.runtime == "python3.13" &&
      aws_lambda_function.thumbnails.architectures == tolist(["arm64"]) &&
      aws_lambda_function.thumbnails.handler == "thumbnails.handler.handler"
    )
    error_message = "Python 3.13 on arm64, entry thumbnails.handler.handler (spec §10)."
  }

  assert {
    condition     = aws_lambda_function.thumbnails.memory_size == 1536 && aws_lambda_function.thumbnails.timeout == 60
    error_message = "1536 MB, 60 s (spec §10)."
  }

  assert {
    condition     = aws_lambda_function.thumbnails.environment[0].variables.TABLE_NAME == "photo-app-test"
    error_message = "The handler reads the table name from TABLE_NAME."
  }

  assert {
    condition     = aws_cloudwatch_log_group.thumbnails.retention_in_days == 30 && one(aws_lambda_function.thumbnails.logging_config).log_format == "JSON"
    error_message = "Structured JSON logs, 30-day retention (spec §10)."
  }
}

run "retries_then_dlq" {
  command = plan

  assert {
    condition     = aws_lambda_function_event_invoke_config.thumbnails.maximum_retry_attempts == 2
    error_message = "Transient errors are retried twice (spec §10)."
  }

  assert {
    condition     = one(one(aws_lambda_function_event_invoke_config.thumbnails.destination_config).on_failure).destination == aws_sqs_queue.dlq.arn
    error_message = "Events that still fail go to the SQS DLQ (NFR-OPS-1)."
  }

  assert {
    condition     = aws_sqs_queue.dlq.message_retention_seconds == 1209600 && aws_sqs_queue.dlq.sqs_managed_sse_enabled == true
    error_message = "The DLQ keeps messages 14 days, encrypted."
  }
}

run "triggered_by_uploads_under_users" {
  command = plan

  assert {
    condition = (
      one(aws_s3_bucket_notification.photos.lambda_function).filter_prefix == "users/" &&
      one(aws_s3_bucket_notification.photos.lambda_function).events == toset(["s3:ObjectCreated:*"])
    )
    error_message = "S3 ObjectCreated:* on prefix users/ (spec §10)."
  }

  assert {
    condition = (
      aws_lambda_permission.s3.principal == "s3.amazonaws.com" &&
      aws_lambda_permission.s3.source_arn == "arn:aws:s3:::photo-app-photos-test-123456789012" &&
      aws_lambda_permission.s3.source_account == "123456789012"
    )
    error_message = "Only the photo bucket in this account may invoke the Lambda."
  }
}

run "least_privilege" {
  command = plan

  assert {
    condition = (
      toset(data.aws_iam_policy_document.thumbnails.statement[0].actions) == toset(["s3:GetObject", "s3:DeleteObject"]) &&
      toset(data.aws_iam_policy_document.thumbnails.statement[0].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012/users/*/originals/*"])
    )
    error_message = "Originals: read + delete only (orphan cleanup, 6.12), never write (loop protection)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.thumbnails.statement[1].actions) == toset(["s3:PutObject", "s3:DeleteObject"]) &&
      toset(data.aws_iam_policy_document.thumbnails.statement[1].resources) == toset([
        "arn:aws:s3:::photo-app-photos-test-123456789012/users/*/thumbs/*",
        "arn:aws:s3:::photo-app-photos-test-123456789012/users/*/previews/*",
      ])
    )
    error_message = "Thumbs and previews: write + delete (race cleanup) only."
  }

  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.thumbnails.statement : !contains(s.actions, "s3:PutObject") || !anytrue([for r in s.resources : strcontains(r, "/originals/")])])
    error_message = "No statement may allow writing originals (spec §10 loop protection)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.thumbnails.statement[2].actions) == toset(["dynamodb:GetItem", "dynamodb:UpdateItem"]) &&
      toset(data.aws_iam_policy_document.thumbnails.statement[2].resources) == toset(["arn:aws:dynamodb:us-east-1:123456789012:table/photo-app-test"])
    )
    error_message = "Table: read the photo, update photo + Usage (transaction), nothing else."
  }
}
