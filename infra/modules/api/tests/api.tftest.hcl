# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "archive" {}

mock_provider "aws" {
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
      arn        = "arn:aws:lambda:us-east-1:123456789012:function:test"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:test/invocations"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:test"
    }
  }

  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:us-east-1:123456789012:rule/test"
    }
  }

  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:123456789012:test"
      url = "https://sqs.us-east-1.amazonaws.com/123456789012/test"
    }
  }

  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn = "arn:aws:ssm:us-east-1:123456789012:parameter/test"
    }
  }

  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:abc123"
    }
  }
}

variables {
  environment         = "test"
  source_dir          = "./tests/fixtures/bundle"
  table_name          = "photo-app-test"
  table_arn           = "arn:aws:dynamodb:us-east-1:123456789012:table/photo-app-test"
  bucket_name         = "photo-app-photos-test-123456789012"
  bucket_arn          = "arn:aws:s3:::photo-app-photos-test-123456789012"
  thumbnail_queue_arn = "arn:aws:sqs:us-east-1:123456789012:photo-app-test-thumbnails"
  thumbnail_queue_url = "https://sqs.us-east-1.amazonaws.com/123456789012/photo-app-test-thumbnails"
  video_queue_arn     = "arn:aws:sqs:us-east-1:123456789012:photo-app-test-videos"
  video_queue_url     = "https://sqs.us-east-1.amazonaws.com/123456789012/photo-app-test-videos"
  user_pool_id        = "us-east-1_test"
  user_pool_arn       = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test"
  issuer_url          = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test"
  audience            = ["webclient123"]
  default_quota_bytes = 2147483648

  media_origin                     = "https://d111.cloudfront.net"
  media_key_pair_id                = "K2TEST"
  media_private_key_parameter_name = "/photo-app/test/cloudfront/media-private-key"
  media_private_key_parameter_arn  = "arn:aws:ssm:us-east-1:123456789012:parameter/photo-app/test/cloudfront/media-private-key"
}

run "function_and_config" {
  command = plan

  assert {
    condition = (
      aws_lambda_function.api.function_name == "photo-app-test-api" &&
      aws_lambda_function.api.runtime == "nodejs22.x" &&
      aws_lambda_function.api.architectures == tolist(["arm64"]) &&
      aws_lambda_function.api.handler == "index.handler" &&
      aws_lambda_function.api.memory_size == 1769
    )
    error_message = "Node.js 22 on arm64, dist/index.mjs (spec §4)."
  }

  assert {
    condition = aws_lambda_function.api.environment[0].variables == tomap({
      TABLE_NAME                  = "photo-app-test"
      PHOTO_BUCKET                = "photo-app-photos-test-123456789012"
      USER_POOL_ID                = "us-east-1_test"
      DEFAULT_QUOTA_BYTES         = "2147483648"
      MEDIA_ORIGIN                = "https://d111.cloudfront.net"
      MEDIA_KEY_PAIR_ID           = "K2TEST"
      MEDIA_PRIVATE_KEY_PARAMETER = "/photo-app/test/cloudfront/media-private-key"
      NODE_OPTIONS                = "--enable-source-maps"
    })
    error_message = "The Lambda gets every variable apps/api/src/lib/config.ts requires."
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.lambda.retention_in_days == 30 &&
      aws_cloudwatch_log_group.access.retention_in_days == 30 &&
      one(aws_lambda_function.api.logging_config).log_format == "JSON"
    )
    error_message = "JSON logs; Lambda and access logs kept 30 days (NFR-OPS-2)."
  }
}

run "jwt_protects_everything_but_health" {
  command = plan

  assert {
    condition = (
      aws_apigatewayv2_authorizer.cognito.authorizer_type == "JWT" &&
      one(aws_apigatewayv2_authorizer.cognito.jwt_configuration).issuer == "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test" &&
      one(aws_apigatewayv2_authorizer.cognito.jwt_configuration).audience == toset(["webclient123"])
    )
    error_message = "Tokens must come from this pool and the web client (NFR-SEC-1)."
  }

  assert {
    condition = (
      aws_apigatewayv2_route.api.route_key == "ANY /api/{proxy+}" &&
      aws_apigatewayv2_route.api.authorization_type == "JWT" &&
      aws_apigatewayv2_route.api.authorization_scopes == toset(["openid"])
    )
    error_message = "All /api routes need an access token."
  }

  assert {
    condition     = aws_apigatewayv2_route.health.route_key == "GET /api/health" && aws_apigatewayv2_route.health.authorization_type == "NONE"
    error_message = "The health check is public (5.5)."
  }

  assert {
    condition     = aws_apigatewayv2_route.photo_links.route_key == "GET /api/links/{proxy+}" && aws_apigatewayv2_route.photo_links.authorization_type == "NONE"
    error_message = "Public photo links (FR-SHR-8): GET only, under /api/links/ only."
  }

  assert {
    condition     = aws_lambda_permission.api_gateway.principal == "apigateway.amazonaws.com" && aws_lambda_permission.api_gateway.source_arn == "arn:aws:execute-api:us-east-1:123456789012:abc123/*/*"
    error_message = "Only this API may invoke the Lambda."
  }
}

run "throttled" {
  command = plan

  assert {
    condition = (
      one(aws_apigatewayv2_stage.default.default_route_settings).throttling_rate_limit == 25 &&
      one(aws_apigatewayv2_stage.default.default_route_settings).throttling_burst_limit == 50
    )
    error_message = "API Gateway throttling must be on (NFR-SEC-9)."
  }
}

run "least_privilege" {
  command = plan

  assert {
    condition     = toset(data.aws_iam_policy_document.api.statement[0].resources) == toset(["arn:aws:dynamodb:us-east-1:123456789012:table/photo-app-test", "arn:aws:dynamodb:us-east-1:123456789012:table/photo-app-test/index/*"])
    error_message = "Table access only to the app table and its indexes."
  }

  assert {
    condition     = !anytrue([for a in data.aws_iam_policy_document.api.statement[0].actions : contains(["dynamodb:Scan", "dynamodb:DeleteTable", "dynamodb:*"], a)])
    error_message = "No scans or table-level actions."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.api.statement[1].actions) == toset(["s3:PutObject", "s3:GetObject"]) &&
      toset(data.aws_iam_policy_document.api.statement[1].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012/users/*/originals/*"])
    )
    error_message = "Sign uploads/downloads for originals only; never write thumbs or previews."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.api.statement[2].actions) == toset(["s3:DeleteObject"]) && toset(data.aws_iam_policy_document.api.statement[2].resources) == toset([for d in ["originals", "thumbs", "previews", "playback"] : "arn:aws:s3:::photo-app-photos-test-123456789012/users/*/${d}/*"])
    error_message = "Delete only photo objects (original, thumb, preview, a video's playback copy)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.api.statement[6].actions) == toset(["s3:AbortMultipartUpload"]) &&
      toset(data.aws_iam_policy_document.api.statement[6].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012/users/*/originals/*"])
    )
    error_message = "Abort video uploads of originals only (14.2)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.api.statement[7].actions) == toset(["s3:ListBucket"]) &&
      toset(data.aws_iam_policy_document.api.statement[7].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012"])
    )
    error_message = "ListBucket on the photo bucket only, for 404s of missing originals."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.api.statement[3].actions) == toset(["cognito-idp:ListUsers"]) && toset(data.aws_iam_policy_document.api.statement[3].resources) == toset(["arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test"])
    error_message = "Cognito: ListUsers on this pool only."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.api.statement[4].actions) == toset(["ssm:GetParameter"]) &&
      toset(data.aws_iam_policy_document.api.statement[4].resources) == toset(["arn:aws:ssm:us-east-1:123456789012:parameter/photo-app/test/cloudfront/media-private-key"])
    )
    error_message = "SSM: read the media signing key parameter only (7.3)."
  }
}

run "rejects_media_origin_with_path" {
  command = plan

  variables {
    media_origin = "https://d111.cloudfront.net/"
  }

  expect_failures = [var.media_origin]
}

run "rejects_bad_quota" {
  command = plan

  variables {
    default_quota_bytes = 0
  }

  expect_failures = [var.default_quota_bytes]
}

run "trash_purge" {
  command = plan

  assert {
    condition     = aws_lambda_function.purge.handler == "purge.handler" && aws_lambda_function.purge.source_code_hash == aws_lambda_function.api.source_code_hash
    error_message = "The purge runs purge.handler from the API's bundle."
  }

  assert {
    condition     = aws_iam_role.purge.name == "photo-app-test-trash-purge" && aws_iam_role_policy.purge.role == aws_iam_role.purge.id
    error_message = "The purge has its own role."
  }

  assert {
    condition     = aws_lambda_function.purge.environment[0].variables == tomap({ TABLE_NAME = "photo-app-test", PHOTO_BUCKET = "photo-app-photos-test-123456789012", THUMBNAIL_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/photo-app-test-thumbnails", VIDEO_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/photo-app-test-videos", NODE_OPTIONS = "--enable-source-maps" })
    error_message = "The purge needs the table, the photo bucket and the thumbnail queue."
  }

  assert {
    condition     = aws_cloudwatch_event_rule.purge.schedule_expression == "cron(0 3 * * ? *)"
    error_message = "Runs once a day."
  }

  assert {
    condition     = aws_lambda_permission.purge_schedule.principal == "events.amazonaws.com"
    error_message = "Only its schedule invokes it."
  }

  assert {
    condition     = !anytrue([for a in data.aws_iam_policy_document.purge.statement[0].actions : contains(["dynamodb:Scan", "dynamodb:PutItem", "dynamodb:DeleteTable", "dynamodb:*"], a)])
    error_message = "Purge: no scans, puts or table-level actions."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.purge.statement[1].actions) == toset(["s3:DeleteObject"]) && length(data.aws_iam_policy_document.purge.statement[1].resources) == 4
    error_message = "Purge deletes only photo objects (original, thumb, preview, playback copy)."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.purge.statement[2].actions) == toset(["s3:GetObject"]) && toset(data.aws_iam_policy_document.purge.statement[2].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012/users/*/originals/*"])
    error_message = "The stale-pending sweep reads (heads) originals only (6.11)."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.purge.statement[3].actions) == toset(["s3:ListBucket"]) && toset(data.aws_iam_policy_document.purge.statement[3].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012"])
    error_message = "ListBucket on the photo bucket, so a missing original is a 404, not a 403 (6.11)."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.purge.statement[5].actions) == toset(["sqs:SendMessage"]) && toset(data.aws_iam_policy_document.purge.statement[5].resources) == toset(["arn:aws:sqs:us-east-1:123456789012:photo-app-test-thumbnails", "arn:aws:sqs:us-east-1:123456789012:photo-app-test-videos"])
    error_message = "The sweep only sends to the thumbnail and video queues (6.11, 13.6, 14.4)."
  }

  assert {
    condition = (
      toset(data.aws_iam_policy_document.purge.statement[6].actions) == toset(["s3:AbortMultipartUpload"]) &&
      toset(data.aws_iam_policy_document.purge.statement[6].resources) == toset(["arn:aws:s3:::photo-app-photos-test-123456789012/users/*/originals/*"])
    )
    error_message = "The sweep aborts only video uploads of originals (14.2)."
  }
}

# --- Import from Google Photos (13.5f) ----------------------------------------------------------

run "imports_off_without_google_client" {
  command = plan

  assert {
    condition = (
      length(aws_sqs_queue.imports) == 0 &&
      length(aws_lambda_function.import_worker) == 0 &&
      length(aws_ssm_parameter.google_client_secret) == 0 &&
      length(aws_iam_role_policy.api_imports) == 0 &&
      !contains(keys(aws_lambda_function.api.environment[0].variables), "GOOGLE_CLIENT_ID")
    )
    error_message = "Without google_client_id there is no import (prod until Phase 11): /imports stays off."
  }

  assert {
    condition     = output.import_client_id == null
    error_message = "No client ID for the web build: the app hides the import (13.5g)."
  }
}

run "imports_on_with_google_client" {
  command = apply

  variables {
    google_client_id        = "client-id.apps.googleusercontent.com"
    google_client_secret    = "test-secret"
    import_redirect_origins = ["https://d111.cloudfront.net", "http://localhost:5173"]
  }

  assert {
    condition = (
      aws_sqs_queue.imports[0].name == "photo-app-test-imports" &&
      aws_sqs_queue.imports[0].visibility_timeout_seconds == 720 &&
      aws_sqs_queue.imports[0].sqs_managed_sse_enabled &&
      jsondecode(aws_sqs_queue.imports[0].redrive_policy).maxReceiveCount == 5 &&
      aws_sqs_queue.imports_dlq[0].message_retention_seconds == 1209600
    )
    error_message = "Import queue: 720 s visibility (6 × 120 s), SSE, DLQ after 5 receives kept 14 days (§10.1)."
  }

  assert {
    condition = (
      aws_lambda_function.import_worker[0].function_name == "photo-app-test-import-worker" &&
      aws_lambda_function.import_worker[0].handler == "importWorker.handler" &&
      aws_lambda_function.import_worker[0].memory_size == 512 &&
      aws_lambda_function.import_worker[0].timeout == 120 &&
      aws_lambda_function.import_worker[0].architectures == tolist(["arm64"]) &&
      aws_lambda_function.import_worker[0].environment[0].variables["IMPORT_QUEUE_URL"] == aws_sqs_queue.imports[0].url &&
      !contains(keys(aws_lambda_function.import_worker[0].environment[0].variables), "GOOGLE_CLIENT_SECRET_PARAMETER")
    )
    error_message = "Worker: dist/importWorker.mjs, 512 MB, 120 s, its queue, no Google secret (§10.1, NFR-SEC-10)."
  }

  assert {
    condition = (
      aws_lambda_event_source_mapping.import_worker[0].batch_size == 1 &&
      aws_lambda_event_source_mapping.import_worker[0].scaling_config[0].maximum_concurrency == 3
    )
    error_message = "One message per invocation, at most 3 workers (§10.1)."
  }

  assert {
    condition = (
      aws_ssm_parameter.google_client_secret[0].name == "/photo-app/test/google/client-secret" &&
      aws_ssm_parameter.google_client_secret[0].type == "SecureString"
    )
    error_message = "The Google client secret is an SSM SecureString (NFR-SEC-10)."
  }

  assert {
    condition = (
      aws_lambda_function.api.environment[0].variables["GOOGLE_CLIENT_ID"] == "client-id.apps.googleusercontent.com" &&
      aws_lambda_function.api.environment[0].variables["GOOGLE_CLIENT_SECRET_PARAMETER"] == "/photo-app/test/google/client-secret" &&
      aws_lambda_function.api.environment[0].variables["IMPORT_QUEUE_URL"] == aws_sqs_queue.imports[0].url &&
      aws_lambda_function.api.environment[0].variables["IMPORT_REDIRECT_ORIGINS"] == "https://d111.cloudfront.net,http://localhost:5173" &&
      aws_lambda_function.api.environment[0].variables["TABLE_NAME"] == "photo-app-test"
    )
    error_message = "The API gets the import settings (loadImportConfig) next to its own."
  }

  assert {
    condition     = length(aws_iam_role_policy.api_imports) == 1 && aws_iam_role_policy.api_imports[0].role == aws_iam_role.api.id
    error_message = "The API's import grants (secret, queue) are a separate policy on its role."
  }

  assert {
    condition     = output.import_client_id == "client-id.apps.googleusercontent.com"
    error_message = "The web build gets the client ID that starts the import consent (13.5g)."
  }
}

run "imports_need_the_secret" {
  command = plan

  variables {
    google_client_id        = "client-id.apps.googleusercontent.com"
    import_redirect_origins = ["https://d111.cloudfront.net"]
  }

  expect_failures = [aws_ssm_parameter.google_client_secret]
}

run "import_origins_have_no_path" {
  command = plan

  variables {
    import_redirect_origins = ["https://d111.cloudfront.net/app"]
  }

  expect_failures = [var.import_redirect_origins]
}
