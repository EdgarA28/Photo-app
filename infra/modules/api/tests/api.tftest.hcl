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
    error_message = "Only the health check is public (5.5)."
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
    condition     = toset(data.aws_iam_policy_document.api.statement[2].actions) == toset(["s3:DeleteObject"]) && length(data.aws_iam_policy_document.api.statement[2].resources) == 3
    error_message = "Delete only photo objects (original, thumb, preview)."
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
    condition     = aws_lambda_function.purge.environment[0].variables == tomap({ TABLE_NAME = "photo-app-test", PHOTO_BUCKET = "photo-app-photos-test-123456789012", NODE_OPTIONS = "--enable-source-maps" })
    error_message = "The purge needs only the table and the photo bucket."
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
    condition     = toset(data.aws_iam_policy_document.purge.statement[1].actions) == toset(["s3:DeleteObject"]) && length(data.aws_iam_policy_document.purge.statement[1].resources) == 3
    error_message = "Purge deletes only photo objects (original, thumb, preview)."
  }
}
