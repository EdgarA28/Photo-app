# Frontend (spec §5, §13.1, Phase 7.1): site bucket + one CloudFront distribution that puts the
# web app, the API and the photo images behind a single origin (no CORS for the API, and media
# cookies in 7.3 are first-party).
#
#   /api/*    → API Gateway (no caching, all viewer headers except Host)
#   /users/*  → photo bucket via OAC (cached; the bucket policy in the storage module only grants
#               thumbs/ and previews/, never originals)
#   /*        → site bucket via OAC, SPA rewrite function for app routes
#
# /users/* requires a signature from the media key (media-keys.tf, 7.2).
# Not here yet: custom domain + ACM cert (11.1), WAF (11.2).

data "aws_caller_identity" "current" {}

locals {
  name = "photo-app-${var.environment}"
  # Account ID keeps the name globally unique.
  site_bucket_name = "photo-app-site-${var.environment}-${data.aws_caller_identity.current.account_id}"

  api_domain = trimprefix(var.api_endpoint, "https://")

  content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self' ${var.auth_domain_url} https://${var.photo_bucket_regional_domain_name}",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
}

# --- Site bucket (NFR-SEC-3, NFR-SEC-4) -------------------------------------------------------

resource "aws_s3_bucket" "site" {
  bucket        = local.site_bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]

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

  # OAC: only this distribution may read.
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# --- CloudFront -------------------------------------------------------------------------------

# One OAC for both buckets: CloudFront signs its S3 requests (SigV4), the bucket policies trust it.
resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${local.name}-s3"
  description                       = "Photo app site and photo buckets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.name}-spa-rewrite"
  comment = "Serve /index.html for app routes (paths without a file extension)"
  runtime = "cloudfront-js-2.0"
  code    = file("${path.module}/functions/spa-rewrite.js")
  publish = true
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# API Gateway rejects a foreign Host header; everything else (Authorization, query, body) passes.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, X-XSS-Protection.
data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

# The app's own headers (12.2a): the managed security headers plus a Content-Security-Policy, so
# an injected script couldn't run or send the refresh token (IndexedDB) anywhere. The app has no
# inline scripts or styles and loads everything from its own origin; it calls only the API and
# images (same origin), Cognito (token refresh/revocation) and the photo bucket (upload POST).
# Also served with sw.js, so it applies to the service worker's uploads and token refreshes.
resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${local.name}-site"
  comment = "Security headers + CSP for the web app"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "main" {
  comment             = "Photo app (${var.environment})"
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = var.price_class
  default_root_object = "index.html"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id                = "photos"
    domain_name              = var.photo_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id   = "api"
    domain_name = local.api_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Routes keep the /api prefix (apps/api basePath), so the path is forwarded unchanged.
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  # URL path == S3 key (packages/shared/src/s3Keys.ts). Derived images are immutable
  # (Cache-Control set by the thumbnail Lambda), so they cache at the edge (NFR-PERF-4).
  # CloudFront checks the signed cookie/URL before the cache: no valid signature → 403. The
  # cookies are not in the cache key, so every user's images still cache.
  ordered_cache_behavior {
    path_pattern               = "/users/*"
    target_origin_id           = "photos"
    trusted_key_groups         = [aws_cloudfront_key_group.media.id]
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Default *.cloudfront.net certificate until the custom domain (11.1, D-4).
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
