# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "archive" {}

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

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
      arn = "arn:aws:sqs:us-east-1:123456789012:test-videos"
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
      aws_lambda_function.videos.function_name == "photo-app-test-videos" &&
      aws_lambda_function.videos.runtime == "python3.13" &&
      aws_lambda_function.videos.architectures == tolist(["arm64"]) &&
      aws_lambda_function.videos.handler == "thumbnails.video_handler.handler"
    )
    error_message = "Python 3.13 on arm64, entry thumbnails.video_handler.handler (spec §10.2)."
  }

  assert {
    condition     = aws_lambda_function.videos.memory_size == 3008 && aws_lambda_function.videos.timeout == 900
    error_message = "3008 MB (2 vCPUs), 15 min for the playback copy (spec §10.2, 14.9)."
  }

  assert {
    condition     = one(aws_lambda_function.videos.ephemeral_storage).size == 2048
    error_message = "2 GB /tmp for the playback copy before upload (14.9)."
  }

  assert {
    condition     = aws_lambda_function.videos.environment[0].variables.TABLE_NAME == "photo-app-test"
    error_message = "The handler reads the table name from TABLE_NAME."
  }

  assert {
    condition     = aws_cloudwatch_log_group.videos.retention_in_days == 30 && one(aws_lambda_function.videos.logging_config).log_format == "JSON"
    error_message = "Structured JSON logs, 30-day retention."
  }
}

run "queue_then_dlq" {
  command = plan

  assert {
    condition = (
      aws_sqs_queue.videos.name == "photo-app-test-videos" &&
      aws_sqs_queue.videos.visibility_timeout_seconds == 5400 &&
      aws_sqs_queue.videos.sqs_managed_sse_enabled == true
    )
    error_message = "Queue photo-app-{env}-videos: visibility 6 × the 15 min timeout, encrypted (spec §10.2)."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.videos.redrive_policy).maxReceiveCount == 5
    error_message = "After 5 receives a message moves to the DLQ."
  }

  assert {
    condition = (
      aws_sqs_queue.dlq.name == "photo-app-test-videos-dlq" &&
      aws_sqs_queue.dlq.message_retention_seconds == 1209600 &&
      aws_sqs_queue.dlq.sqs_managed_sse_enabled == true
    )
    error_message = "The DLQ keeps messages 14 days, encrypted (NFR-OPS-1)."
  }
}

run "triggered_by_video_originals_only" {
  command = plan

  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.originals.event_pattern) == {
      source        = ["aws.s3"]
      "detail-type" = ["Object Created"]
      detail = {
        bucket = { name = ["photo-app-photos-test-123456789012"] }
        object = { key = [
          { wildcard = "users/*/originals/*.mp4" },
          { wildcard = "users/*/originals/*.mov" },
        ] }
      }
    }
    error_message = "Only .mp4/.mov originals of the photo bucket match (§10.2): not photos, not the posters this function writes."
  }

  assert {
    condition = (
      aws_cloudwatch_event_target.originals.rule == "photo-app-test-videos-originals" &&
      data.aws_iam_policy_document.queue.statement[0].actions == toset(["sqs:SendMessage"]) &&
      one([for p in data.aws_iam_policy_document.queue.statement[0].principals : p.identifiers]) == toset(["events.amazonaws.com"]) &&
      toset([for c in data.aws_iam_policy_document.queue.statement[0].condition : c.variable]) == toset(["aws:SourceArn", "aws:SourceAccount"])
    )
    error_message = "The video rule targets the video queue; only it (this account) may send."
  }
}

run "event_source_mapping" {
  command = plan

  assert {
    condition = (
      aws_lambda_event_source_mapping.videos.batch_size == 1 &&
      aws_lambda_event_source_mapping.videos.function_response_types == toset(["ReportBatchItemFailures"]) &&
      one(aws_lambda_event_source_mapping.videos.scaling_config).maximum_concurrency == 2 &&
      one(aws_lambda_event_source_mapping.videos.metrics_config).metrics == toset(["EventCount"])
    )
    error_message = "One video per invocation, at most 2 at once (spec §10.2)."
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
      toset(data.aws_iam_policy_document.videos.statement[0].actions) == toset(["s3:GetObject", "s3:DeleteObject"]) &&
      toset(data.aws_iam_policy_document.videos.statement[0].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012/users/*/originals/*"])
    )
    error_message = "Originals: read (ranged) + delete (orphans) only, never write (loop protection)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.videos.statement[1].actions) == toset(["s3:ListBucket"]) &&
      toset(data.aws_iam_policy_document.videos.statement[1].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012"])
    )
    error_message = "ListBucket on the photo bucket only (404 for a missing original)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.videos.statement[2].actions) == toset(["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]) &&
      toset(data.aws_iam_policy_document.videos.statement[2].resources) == toset([
        "arn:aws:s3:::photo-app-photos-test-123456789012/users/*/thumbs/*",
        "arn:aws:s3:::photo-app-photos-test-123456789012/users/*/previews/*",
        "arn:aws:s3:::photo-app-photos-test-123456789012/users/*/playback/*",
      ])
    )
    error_message = "Poster thumbs, previews and playback copies (14.9): write + delete only."
  }

  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.videos.statement : !contains(s.actions, "s3:PutObject") || !anytrue([for r in s.resources : strcontains(r, "/originals/")])])
    error_message = "No statement may allow writing originals (loop protection)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.videos.statement[3].actions) == toset(["dynamodb:GetItem", "dynamodb:UpdateItem"]) &&
      toset(data.aws_iam_policy_document.videos.statement[4].actions) == toset(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) &&
      toset(data.aws_iam_policy_document.videos.statement[4].resources) == toset([aws_sqs_queue.videos.arn])
    )
    error_message = "Table: read + update; queue: receive/delete/attributes on the video queue only."
  }
}
