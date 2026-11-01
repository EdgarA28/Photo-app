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

run "queue_then_dlq" {
  command = plan

  assert {
    condition = (
      aws_sqs_queue.thumbnails.name == "photo-app-test-thumbnails" &&
      aws_sqs_queue.thumbnails.visibility_timeout_seconds == 360 &&
      aws_sqs_queue.thumbnails.message_retention_seconds == 345600 &&
      aws_sqs_queue.thumbnails.sqs_managed_sse_enabled == true
    )
    error_message = "Queue photo-app-{env}-thumbnails: visibility 6 × the 60 s timeout, 4 days, encrypted (spec §10, 13.6)."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.thumbnails.redrive_policy).maxReceiveCount == 3
    error_message = "After 3 receives a message moves to the DLQ (spec §10)."
  }

  assert {
    condition     = aws_sqs_queue.dlq.message_retention_seconds == 1209600 && aws_sqs_queue.dlq.sqs_managed_sse_enabled == true
    error_message = "The DLQ keeps messages 14 days, encrypted (NFR-OPS-1)."
  }
}

run "triggered_by_uploads_under_users" {
  command = plan

  assert {
    condition = (
      one(aws_s3_bucket_notification.photos.queue).filter_prefix == "users/" &&
      one(aws_s3_bucket_notification.photos.queue).events == toset(["s3:ObjectCreated:*"]) &&
      length(aws_s3_bucket_notification.photos.lambda_function) == 0
    )
    error_message = "S3 ObjectCreated:* on prefix users/ goes to the queue, not the Lambda (spec §10, 13.6)."
  }

  assert {
    condition = (
      data.aws_iam_policy_document.queue.statement[0].actions == toset(["sqs:SendMessage"]) &&
      one([for p in data.aws_iam_policy_document.queue.statement[0].principals : p.identifiers]) == toset(["s3.amazonaws.com"]) &&
      toset([for c in data.aws_iam_policy_document.queue.statement[0].condition : "${c.variable}=${one(c.values)}"]) == toset([
        "aws:SourceArn=arn:aws:s3:::photo-app-photos-test-123456789012",
        "aws:SourceAccount=123456789012",
      ])
    )
    error_message = "Only the photo bucket in this account may send to the queue."
  }
}

run "event_source_mapping" {
  command = plan

  assert {
    condition = (
      aws_lambda_event_source_mapping.thumbnails.batch_size == 5 &&
      aws_lambda_event_source_mapping.thumbnails.function_response_types == toset(["ReportBatchItemFailures"]) &&
      one(aws_lambda_event_source_mapping.thumbnails.scaling_config).maximum_concurrency == 5
    )
    error_message = "Batches of 5, per-message failures, at most 5 Lambdas at once by default (spec §10, B-11)."
  }
}

run "maximum_concurrency_is_configurable" {
  command = plan

  variables {
    maximum_concurrency = 10
  }

  assert {
    condition     = one(aws_lambda_event_source_mapping.thumbnails.scaling_config).maximum_concurrency == 10
    error_message = "maximum_concurrency sets the event source's maximum concurrency."
  }
}

run "maximum_concurrency_minimum_is_2" {
  command = plan

  variables {
    maximum_concurrency = 1
  }

  expect_failures = [var.maximum_concurrency]
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

  assert {
    condition = (
      toset(data.aws_iam_policy_document.thumbnails.statement[3].actions) == toset(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) &&
      toset(data.aws_iam_policy_document.thumbnails.statement[3].resources) == toset([aws_sqs_queue.thumbnails.arn])
    )
    error_message = "Queue: receive + delete + attributes (event source mapping) on the thumbnail queue only."
  }
}
