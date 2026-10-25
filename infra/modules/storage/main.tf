# Photo bucket (spec §8.1, §13.1). Key layout is defined in packages/shared/src/s3Keys.ts:
#   users/{userId}/originals/{photoId}.{ext}   uploaded via pre-signed POST (storage class set by the API)
#   users/{userId}/thumbs/{photoId}.jpg        written by the thumbnail Lambda
#   users/{userId}/previews/{photoId}.jpg      written by the thumbnail Lambda
#
# Owned elsewhere (one resource per bucket, so not here):
#   - S3 event notification → thumbnails module (Phase 6)

data "aws_caller_identity" "current" {}

locals {
  # Account ID keeps the name globally unique.
  bucket_name = "photo-app-photos-${var.environment}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "photos" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_ownership_controls" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# NFR-SEC-3: never public; access only through CloudFront (OAC) or short-lived pre-signed URLs.
resource "aws_s3_bucket_public_access_block" "photos" {
  bucket = aws_s3_bucket.photos.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# NFR-SEC-4: SSE-S3 at rest.
resource "aws_s3_bucket_server_side_encryption_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "photos" {
  bucket = aws_s3_bucket.photos.id

  versioning_configuration {
    # "Disabled" is only valid on a bucket that was never versioned; "Suspended" works in both cases.
    status = var.versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }

  dynamic "rule" {
    for_each = var.versioning ? [1] : []

    content {
      id     = "expire-noncurrent-versions"
      status = "Enabled"
      filter {}

      noncurrent_version_expiration {
        noncurrent_days = var.noncurrent_version_expiration_days
      }

      # Remove delete markers once no versions remain behind them.
      expiration {
        expired_object_delete_marker = true
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.photos]
}

# Browser uploads go straight to S3 (FR-UP-4), so the app origins need CORS.
resource "aws_s3_bucket_cors_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  cors_rule {
    allowed_methods = ["POST", "GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "photos" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.photos.arn, "${aws_s3_bucket.photos.arn}/*"]

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

  # CloudFront OAC (frontend module, 7.1) may read derived images only. Originals stay reachable
  # only through 5-minute pre-signed download URLs (FR-DL-1), even though /users/* routes here.
  dynamic "statement" {
    for_each = var.cloudfront_distribution_arn == null ? [] : [var.cloudfront_distribution_arn]

    content {
      sid     = "CloudFrontReadDerivedImages"
      actions = ["s3:GetObject"]
      resources = [
        "${aws_s3_bucket.photos.arn}/users/*/thumbs/*",
        "${aws_s3_bucket.photos.arn}/users/*/previews/*",
      ]

      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [statement.value]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "photos" {
  bucket = aws_s3_bucket.photos.id
  policy = data.aws_iam_policy_document.photos.json

  depends_on = [aws_s3_bucket_public_access_block.photos]
}
