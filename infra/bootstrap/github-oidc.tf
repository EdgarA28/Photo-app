# GitHub Actions → AWS without long-lived keys (spec §14.1, NFR-SEC-8).
#   ci-plan   — read-only + state access, any ref/PR of the repo (for `tofu plan`)
#   ci-deploy — deploy permissions, only for the subjects in var.github_oidc.deploy_subjects

locals {
  github_oidc_enabled = var.github_oidc != null
  github_oidc_host    = "token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = local.github_oidc_enabled ? 1 : 0
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "ci_plan_trust" {
  count = local.github_oidc_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "${local.github_oidc_host}:sub"
      values   = ["repo:${var.github_oidc.repository}:*"]
    }
  }
}

data "aws_iam_policy_document" "ci_deploy_trust" {
  count = local.github_oidc_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = var.github_oidc.deploy_subjects
    }
  }
}

resource "aws_iam_role" "ci_plan" {
  count              = local.github_oidc_enabled ? 1 : 0
  name               = "photo-app-ci-plan"
  assume_role_policy = data.aws_iam_policy_document.ci_plan_trust[0].json
}

resource "aws_iam_role_policy_attachment" "ci_plan_readonly" {
  count      = local.github_oidc_enabled ? 1 : 0
  role       = aws_iam_role.ci_plan[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "ci_plan_inline" {
  count = local.github_oidc_enabled ? 1 : 0

  # Read state and take the S3-native lock (use_lockfile writes <key>.tflock).
  statement {
    sid       = "StateRead"
    actions   = ["s3:ListBucket", "s3:GetObject"]
    resources = ["arn:aws:s3:::${local.state_bucket_name}", "arn:aws:s3:::${local.state_bucket_name}/*"]
  }

  statement {
    sid       = "StateLock"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${local.state_bucket_name}/*.tflock"]
  }

  # Refreshing SecureString parameters (the CloudFront media key, 7.3) reads them decrypted.
  # Only through SSM and only for this app's parameters; the same values are in the state anyway.
  statement {
    sid       = "AppParameterDecrypt"
    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:*:${data.aws_caller_identity.current.account_id}:key/*"]

    condition {
      test     = "StringLike"
      variable = "kms:ViaService"
      values   = ["ssm.*.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = ["arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/photo-app/*"]
    }
  }

  # ReadOnlyAccess would otherwise let CI read users' photos and metadata.
  statement {
    sid           = "DenyUserDataReads"
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = ["arn:aws:s3:::${local.state_bucket_name}/*"]
  }

  statement {
    sid       = "DenyTableDataReads"
    effect    = "Deny"
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:GetRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ci_plan" {
  count  = local.github_oidc_enabled ? 1 : 0
  name   = "state-access"
  role   = aws_iam_role.ci_plan[0].id
  policy = data.aws_iam_policy_document.ci_plan_inline[0].json
}

resource "aws_iam_role" "ci_deploy" {
  count                = local.github_oidc_enabled ? 1 : 0
  name                 = "photo-app-ci-deploy"
  assume_role_policy   = data.aws_iam_policy_document.ci_deploy_trust[0].json
  max_session_duration = 3600
}

# TODO (PROGRESS 12.x): scope down from AdministratorAccess once the deployed resource set is known.
resource "aws_iam_role_policy_attachment" "ci_deploy_admin" {
  count      = local.github_oidc_enabled ? 1 : 0
  role       = aws_iam_role.ci_deploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
