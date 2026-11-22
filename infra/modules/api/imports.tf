# Import from Google Photos (13.5f; spec §6.9, §10.1, §11.5, NFR-SEC-10), only with
# `google_client_id` (prod stays without until Phase 11):
# - the import queue + DLQ: the API sends a `list` message once the user is done picking; the
#   worker sends one `copy` message per photo;
# - the import worker (dist/importWorker.mjs, same zip as the API), at most 3 at a time;
# - the Google client secret as an SSM SecureString, read by the API only (the worker uses the
#   Google token stored in the Import item);
# - the API's extra grants (secret, queue) and settings (api_imports below, `local.import_env`).

locals {
  imports        = var.google_client_id != null
  imports_name   = "photo-app-${var.environment}-imports"
  worker_name    = "photo-app-${var.environment}-import-worker"
  worker_timeout = 120

  # Merged into the API Lambda's environment (main.tf); read by `loadImportConfig`.
  import_env = local.imports ? {
    GOOGLE_CLIENT_ID               = var.google_client_id
    GOOGLE_CLIENT_SECRET_PARAMETER = aws_ssm_parameter.google_client_secret[0].name
    IMPORT_QUEUE_URL               = aws_sqs_queue.imports[0].url
    IMPORT_REDIRECT_ORIGINS        = join(",", var.import_redirect_origins)
  } : {}
}

# --- Queue ---------------------------------------------------------------------------------------

resource "aws_sqs_queue" "imports" {
  count = local.imports ? 1 : 0

  name = local.imports_name
  # AWS guidance for Lambda consumers: 6 × the function timeout (§10.1: 720 s).
  visibility_timeout_seconds = 6 * local.worker_timeout
  # Google's download URLs and token last ~1 h; older messages can't succeed anyway.
  message_retention_seconds = 4 * 24 * 60 * 60
  sqs_managed_sse_enabled   = true

  # Transient errors (Google 429/5xx, S3, DynamoDB) come back after the visibility timeout;
  # after 5 receives (AWS's minimum for Lambda consumers) the message moves to the DLQ.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.imports_dlq[0].arn
    maxReceiveCount     = 5
  })
}

# 14 days to inspect what failed 5 times. Messages hold Google download URLs (valid ~1 h), never
# the token.
resource "aws_sqs_queue" "imports_dlq" {
  count = local.imports ? 1 : 0

  name                      = "${local.imports_name}-dlq"
  message_retention_seconds = 14 * 24 * 60 * 60
  sqs_managed_sse_enabled   = true
}

# --- Google client secret (NFR-SEC-10) ---------------------------------------------------------

# The value comes from TF_VAR_google_client_secret (the same secret the auth module gives
# Cognito), so it is in the state like there; never in git.
resource "aws_ssm_parameter" "google_client_secret" {
  count = local.imports ? 1 : 0

  name        = "/photo-app/${var.environment}/google/client-secret"
  description = "Google OAuth client secret for the Google Photos import token exchange"
  type        = "SecureString"
  value       = var.google_client_secret

  lifecycle {
    precondition {
      condition     = var.google_client_secret != null && var.google_client_secret != ""
      error_message = "google_client_secret is required with google_client_id (export TF_VAR_google_client_secret)."
    }
    precondition {
      condition     = length(var.import_redirect_origins) > 0
      error_message = "import_redirect_origins needs at least the app's own origin."
    }
  }
}

# --- API grants --------------------------------------------------------------------------------

data "aws_iam_policy_document" "api_imports" {
  count = local.imports ? 1 : 0

  # Token exchange (POST /imports/google): read once per execution environment.
  statement {
    sid       = "GoogleClientSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.google_client_secret[0].arn]
  }

  # The `list` message once the user is done picking (GET /imports/{id}).
  statement {
    sid       = "ImportQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.imports[0].arn]
  }
}

resource "aws_iam_role_policy" "api_imports" {
  count = local.imports ? 1 : 0

  name   = "imports"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_imports[0].json
}

# --- Worker ------------------------------------------------------------------------------------

resource "aws_iam_role" "import_worker" {
  count = local.imports ? 1 : 0

  name               = local.worker_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "import_worker" {
  count = local.imports ? 1 : 0

  # Import item, counted markers, upload claims, the pending photo + Usage transaction
  # (createPending), and deleting a pending photo whose original never came (repo `delete`:
  # memberships, place items). Same table operations as the API, minus batch writes.
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
    ]
    resources = [var.table_arn, "${var.table_arn}/index/*"]
  }

  # Stores the original (PutObject) and checks whether an earlier delivery already did
  # (HeadObject → s3:GetObject; s3:ListBucket so a missing key is 404, not 403).
  statement {
    sid       = "Originals"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = [local.originals_arn]
  }

  statement {
    sid       = "ListForMissingOriginals"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  # Its own queue: receive (event source mapping) and the `copy` messages the list step sends.
  statement {
    sid = "ImportQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.imports[0].arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.import_worker[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "import_worker" {
  count = local.imports ? 1 : 0

  name   = "import-worker"
  role   = aws_iam_role.import_worker[0].id
  policy = data.aws_iam_policy_document.import_worker[0].json
}

# NFR-OPS-2: 30 days. Logs never hold the token or download URLs (NFR-SEC-10).
resource "aws_cloudwatch_log_group" "import_worker" {
  count = local.imports ? 1 : 0

  name              = "/aws/lambda/${local.worker_name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "import_worker" {
  count = local.imports ? 1 : 0

  function_name    = local.worker_name
  role             = aws_iam_role.import_worker[0].arn
  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "importWorker.handler"
  # One original (≤ 50 MB) in memory at a time (§10.1).
  memory_size = 512
  timeout     = local.worker_timeout

  environment {
    variables = {
      TABLE_NAME          = var.table_name
      PHOTO_BUCKET        = var.bucket_name
      IMPORT_QUEUE_URL    = aws_sqs_queue.imports[0].url
      DEFAULT_QUOTA_BYTES = tostring(var.default_quota_bytes)
      NODE_OPTIONS        = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.import_worker[0].name
  }

  depends_on = [aws_iam_role_policy.import_worker]
}

resource "aws_lambda_event_source_mapping" "import_worker" {
  count = local.imports ? 1 : 0

  event_source_arn = aws_sqs_queue.imports[0].arn
  function_name    = aws_lambda_function.import_worker[0].arn
  # One message per invocation: a failure retries just that photo (§10.1).
  batch_size = 1

  # At most 3 workers (§10.1): keeps Lambda capacity for the API and thumbnails (12.3a), and
  # Google's per-user rate in check.
  scaling_config {
    maximum_concurrency = 3
  }
}
