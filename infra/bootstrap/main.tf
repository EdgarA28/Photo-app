check "workspace_matches_environment" {
  assert {
    condition     = terraform.workspace == var.environment
    error_message = "Workspace '${terraform.workspace}' does not match environment '${var.environment}'. Run: tofu workspace select ${var.environment}"
  }
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "photo-app-tfstate-${data.aws_caller_identity.current.account_id}"
}

# --- Remote state bucket (spec §13.3, NFR-OPS-3) ------------------------------

resource "aws_s3_bucket" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = local.state_bucket_name

  # State buckets are kept permanently; remove this block deliberately if one must go.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = aws_s3_bucket.state[0].id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = 90
      newer_noncurrent_versions = 10
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  count = var.create_state_bucket ? 1 : 0

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state[0].arn, "${aws_s3_bucket.state[0].arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  count  = var.create_state_bucket ? 1 : 0
  bucket = aws_s3_bucket.state[0].id
  policy = data.aws_iam_policy_document.state_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.state]
}
