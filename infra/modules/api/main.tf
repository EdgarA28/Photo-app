# API (spec §9, §13.1): HTTP API with a Cognito JWT authorizer in front of one Lambda (Hono
# router, D-1). Code: apps/api, bundled into dist/ by `pnpm build` and zipped here.
#
# Routes keep the /api prefix (CloudFront forwards /api/* unchanged in Phase 7). No CORS: the
# browser reaches the API on the app's own origin (CloudFront, or the Vite dev proxy in Phase 8).

locals {
  name = "photo-app-${var.environment}-api"

  originals_arn = "${var.bucket_arn}/users/*/originals/*"
  photo_object_arns = [
    local.originals_arn,
    "${var.bucket_arn}/users/*/thumbs/*",
    "${var.bucket_arn}/users/*/previews/*",
  ]
}

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${local.name}.zip"
  # Same zip on any machine: file modes otherwise follow the builder's umask (664 locally, 644 in
  # CI), which changes the hash and redeploys an unchanged function (10.2).
  output_file_mode = "0644"
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

resource "aws_iam_role" "api" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "api" {
  # Every repository operation, incl. the items inside TransactWriteItems (Put/Update/Delete/
  # ConditionCheck) and GSI1 queries. Tenant isolation is enforced in code (keys from the JWT
  # sub, NFR-SEC-1): shares and album memberships live outside the owner's partition, so a
  # LeadingKeys condition can't express it.
  statement {
    sid = "Table"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
    ]
    resources = [var.table_arn, "${var.table_arn}/index/*"]
  }

  # Pre-signed upload POSTs (5.6) and download GETs (5.8) act with the signer's permissions.
  statement {
    sid       = "Originals"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = [local.originals_arn]
  }

  # Photo delete (5.9); DeleteObjects checks s3:DeleteObject per key.
  statement {
    sid       = "DeletePhotoObjects"
    actions   = ["s3:DeleteObject"]
    resources = local.photo_object_arns
  }

  # GET /me (profile by sub) and sharing (user by verified email).
  statement {
    sid       = "Users"
    actions   = ["cognito-idp:ListUsers"]
    resources = [var.user_pool_arn]
  }

  # Media cookie signing key (7.3), read once per execution environment. Decryption with the
  # AWS-managed aws/ssm key is granted by that key's policy for calls through SSM.
  statement {
    sid       = "MediaSigningKey"
    actions   = ["ssm:GetParameter"]
    resources = [var.media_private_key_parameter_arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# --- Function -----------------------------------------------------------------------------------

# NFR-OPS-2: 30 days. Created before the function so Lambda never makes its own group.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "api" {
  function_name    = local.name
  role             = aws_iam_role.api.arn
  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  # CPU scales with memory; 1769 MB is one full vCPU, all a single Node thread can use. Signing
  # shared-album image URLs is RSA work (7.4: ~13 ms per signature measured at 512 MB).
  memory_size = 1769
  # Every route is a few DynamoDB/S3/Cognito calls; API Gateway itself allows at most 30 s.
  timeout = 10

  # Read by apps/api/src/lib/config.ts; a missing one fails the cold start.
  environment {
    variables = {
      TABLE_NAME          = var.table_name
      PHOTO_BUCKET        = var.bucket_name
      USER_POOL_ID        = var.user_pool_id
      DEFAULT_QUOTA_BYTES = tostring(var.default_quota_bytes)
      # Media cookies (7.3): values from the frontend module.
      MEDIA_ORIGIN                = var.media_origin
      MEDIA_KEY_PAIR_ID           = var.media_key_pair_id
      MEDIA_PRIVATE_KEY_PARAMETER = var.media_private_key_parameter_name
      NODE_OPTIONS                = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }

  depends_on = [aws_iam_role_policy.api]
}

# --- HTTP API -----------------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = local.name
  protocol_type = "HTTP"
}

# Validates signature, issuer, expiry and client before the Lambda runs (NFR-SEC-1); the Lambda
# then reads `sub` from the claims (apps/api/src/lib/auth.ts).
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = var.issuer_url
    audience = var.audience
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

# Every route except the health check needs a Cognito access token: requiring the `openid` scope
# rejects ID tokens, which carry no scope claim.
resource "aws_apigatewayv2_route" "api" {
  api_id               = aws_apigatewayv2_api.main.id
  route_key            = "ANY /api/{proxy+}"
  target               = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.cognito.id
  authorization_scopes = ["openid"]
}

# Unauthenticated, for the post-deploy smoke test (5.5, spec §14). More specific, so it wins.
resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /api/health"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${local.name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  # NFR-SEC-9: applies to the whole API (WAF on CloudFront comes before public launch, 11.2).
  default_route_settings {
    throttling_rate_limit  = var.throttling_rate_limit
    throttling_burst_limit = var.throttling_burst_limit
  }

  # One JSON line per request; no headers, query strings or bodies.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      time               = "$context.requestTime"
      ip                 = "$context.identity.sourceIp"
      routeKey           = "$context.routeKey"
      path               = "$context.path"
      status             = "$context.status"
      latencyMs          = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      integrationError   = "$context.integrationErrorMessage"
      authorizerError    = "$context.authorizer.error"
      userId             = "$context.authorizer.claims.sub"
    })
  }
}

# Only this API may invoke the function (apps/api/src/lib/auth.ts relies on it).
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
