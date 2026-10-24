# Pre sign-up trigger from services/auth-triggers (spec §11.3, FR-AUTH-3). Only when a built
# bundle is given (pre_sign_up_source_dir = services/auth-triggers/dist after `pnpm build`).
#
# Dependencies: pool → Lambda → role; the role's policy and the invoke permission reference the
# pool. Keeping the policy a separate resource is what lets it name the exact pool ARN without a
# cycle.

locals {
  pre_sign_up_enabled = var.pre_sign_up_source_dir != null
  pre_sign_up_name    = "${local.name}-pre-sign-up"
}

data "archive_file" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  type        = "zip"
  source_dir  = var.pre_sign_up_source_dir
  output_path = "${path.root}/.build/${local.pre_sign_up_name}.zip"
}

data "aws_iam_policy_document" "pre_sign_up_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  name               = local.pre_sign_up_name
  assume_role_policy = data.aws_iam_policy_document.pre_sign_up_trust.json
}

# NFR-SEC-7: least privilege — look up users and link identities in this pool only, write own logs.
data "aws_iam_policy_document" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  statement {
    sid       = "LinkAccounts"
    actions   = ["cognito-idp:ListUsers", "cognito-idp:AdminLinkProviderForUser"]
    resources = [aws_cognito_user_pool.main.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pre_sign_up[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  name   = "pre-sign-up"
  role   = aws_iam_role.pre_sign_up[0].id
  policy = data.aws_iam_policy_document.pre_sign_up[0].json
}

# Created before the function so Lambda never makes its own (never-expiring) group.
resource "aws_cloudwatch_log_group" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  name              = "/aws/lambda/${local.pre_sign_up_name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  function_name    = local.pre_sign_up_name
  role             = aws_iam_role.pre_sign_up[0].arn
  filename         = data.archive_file.pre_sign_up[0].output_path
  source_code_hash = data.archive_file.pre_sign_up[0].output_base64sha256

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 256
  # Cognito waits at most 5 s for a trigger.
  timeout = 5

  environment {
    variables = {
      NODE_OPTIONS = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.pre_sign_up[0].name
  }
}

resource "aws_lambda_permission" "pre_sign_up" {
  count = local.pre_sign_up_enabled ? 1 : 0

  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_sign_up[0].function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
