# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/photo-app-test-spa-rewrite"
    }
  }

  mock_resource "aws_cloudfront_key_group" {
    defaults = {
      id = "test-key-group-id"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:distribution/EXAMPLE"
    }
  }
}

variables {
  environment                       = "test"
  photo_bucket_regional_domain_name = "photo-app-photos-test-123456789012.s3.us-east-1.amazonaws.com"
  api_endpoint                      = "https://abc123.execute-api.us-east-1.amazonaws.com"
  auth_domain_url                   = "https://photo-app-test-123456789012.auth.us-east-1.amazoncognito.com"
}

run "site_bucket_is_private_and_encrypted" {
  command = plan

  assert {
    condition     = aws_s3_bucket.site.bucket == "photo-app-site-test-123456789012"
    error_message = "Site bucket name must be photo-app-site-<env>-<account-id>."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.site.block_public_acls,
      aws_s3_bucket_public_access_block.site.block_public_policy,
      aws_s3_bucket_public_access_block.site.ignore_public_acls,
      aws_s3_bucket_public_access_block.site.restrict_public_buckets,
    ])
    error_message = "All public access must be blocked (NFR-SEC-3)."
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.site.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "SSE-S3 is required (NFR-SEC-4)."
  }

  assert {
    condition     = aws_s3_bucket.site.force_destroy == false
    error_message = "force_destroy must default to false."
  }
}

run "origins" {
  command = plan

  assert {
    condition     = toset([for o in aws_cloudfront_distribution.main.origin : o.origin_id]) == toset(["site", "photos", "api"])
    error_message = "Expected the site, photos and api origins."
  }

  assert {
    condition     = one([for o in aws_cloudfront_distribution.main.origin : o.domain_name if o.origin_id == "api"]) == "abc123.execute-api.us-east-1.amazonaws.com"
    error_message = "The API origin is the endpoint host without the scheme."
  }

  assert {
    condition     = one([for o in aws_cloudfront_distribution.main.origin : o.domain_name if o.origin_id == "photos"]) == "photo-app-photos-test-123456789012.s3.us-east-1.amazonaws.com"
    error_message = "The photos origin is the photo bucket."
  }

  assert {
    condition     = one([for o in aws_cloudfront_distribution.main.origin : one(o.custom_origin_config).origin_protocol_policy if o.origin_id == "api"]) == "https-only"
    error_message = "The API origin must be HTTPS only."
  }
}

run "behaviors" {
  command = plan

  assert {
    condition     = [for b in aws_cloudfront_distribution.main.ordered_cache_behavior : b.path_pattern] == ["/api/*", "/users/*"]
    error_message = "Expected /api/* then /users/* behaviors."
  }

  assert {
    condition     = aws_cloudfront_distribution.main.ordered_cache_behavior[0].target_origin_id == "api" && contains(aws_cloudfront_distribution.main.ordered_cache_behavior[0].allowed_methods, "DELETE")
    error_message = "/api/* goes to the API with all methods."
  }

  assert {
    condition     = aws_cloudfront_distribution.main.ordered_cache_behavior[0].cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id
    error_message = "The API must not be cached."
  }

  assert {
    condition     = aws_cloudfront_distribution.main.ordered_cache_behavior[1].target_origin_id == "photos" && toset(aws_cloudfront_distribution.main.ordered_cache_behavior[1].allowed_methods) == toset(["GET", "HEAD"])
    error_message = "/users/* is read-only from the photo bucket."
  }

  assert {
    condition     = alltrue([for b in concat(aws_cloudfront_distribution.main.ordered_cache_behavior, aws_cloudfront_distribution.main.default_cache_behavior) : b.viewer_protocol_policy == "redirect-to-https"])
    error_message = "Every behavior must redirect to HTTPS."
  }
}

run "spa_rewrite_only_on_site" {
  command = plan

  assert {
    condition     = one(one(aws_cloudfront_distribution.main.default_cache_behavior).function_association).event_type == "viewer-request"
    error_message = "The SPA rewrite runs on viewer request of the default behavior."
  }

  assert {
    condition     = alltrue([for b in aws_cloudfront_distribution.main.ordered_cache_behavior : length(b.function_association) == 0])
    error_message = "/api/* and /users/* must keep their real 403/404 (no rewrite)."
  }

  assert {
    condition     = length(aws_cloudfront_distribution.main.custom_error_response) == 0
    error_message = "No distribution-wide error responses: they would turn API 404s into index.html."
  }
}

run "site_bucket_trusts_only_this_distribution" {
  command = plan

  assert {
    condition     = one(one(data.aws_iam_policy_document.site.statement[1].condition).values) == "arn:aws:cloudfront::123456789012:distribution/EXAMPLE"
    error_message = "Only this distribution may read the site bucket (AWS:SourceArn)."
  }
}

run "users_require_signed_media" {
  command = plan

  assert {
    condition     = one(aws_cloudfront_distribution.main.ordered_cache_behavior[1].trusted_key_groups) == aws_cloudfront_key_group.media.id
    error_message = "/users/* must only serve requests signed with the media key (7.2)."
  }

  assert {
    condition = alltrue([
      length(coalesce(aws_cloudfront_distribution.main.ordered_cache_behavior[0].trusted_key_groups, [])) == 0,
      length(coalesce(one(aws_cloudfront_distribution.main.default_cache_behavior).trusted_key_groups, [])) == 0,
    ])
    error_message = "The API and the site must not require signed cookies."
  }

  assert {
    condition     = tls_private_key.media.algorithm == "RSA" && tls_private_key.media.rsa_bits == 2048
    error_message = "CloudFront signed cookies/URLs need an RSA 2048 key."
  }
}

run "private_key_is_a_secure_string" {
  command = plan

  assert {
    condition     = aws_ssm_parameter.media_private_key.type == "SecureString"
    error_message = "The signing key must be encrypted (SecureString)."
  }

  assert {
    condition     = aws_ssm_parameter.media_private_key.name == "/photo-app/test/cloudfront/media-private-key"
    error_message = "The parameter lives under /photo-app/<env>/."
  }
}

run "site_sends_a_strict_csp" {
  command = plan

  assert {
    condition = (
      aws_cloudfront_distribution.main.default_cache_behavior[0].response_headers_policy_id == aws_cloudfront_response_headers_policy.site.id
    )
    error_message = "The site behavior must use the app's own headers policy with the CSP (12.2a)."
  }

  assert {
    condition = alltrue([
      for directive in [
        "default-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "connect-src 'self' https://photo-app-test-123456789012.auth.us-east-1.amazoncognito.com https://photo-app-photos-test-123456789012.s3.us-east-1.amazonaws.com",
      ] : contains(split("; ", one(aws_cloudfront_response_headers_policy.site.security_headers_config).content_security_policy[0].content_security_policy), directive)
    ])
    error_message = "The CSP must allow only the app's origin, Cognito and the photo bucket (12.2a)."
  }

  assert {
    condition     = !strcontains(one(aws_cloudfront_response_headers_policy.site.security_headers_config).content_security_policy[0].content_security_policy, "unsafe-")
    error_message = "No unsafe-inline/unsafe-eval: the build has no inline scripts or styles."
  }

  assert {
    condition = (
      one(aws_cloudfront_response_headers_policy.site.security_headers_config).strict_transport_security[0].access_control_max_age_sec >= 31536000 &&
      one(aws_cloudfront_response_headers_policy.site.security_headers_config).frame_options[0].frame_option == "DENY"
    )
    error_message = "Keep the managed security headers (HSTS 1 year, no framing)."
  }
}

run "rejects_auth_domain_with_path" {
  command = plan

  variables {
    auth_domain_url = "https://photo-app-test.auth.us-east-1.amazoncognito.com/"
  }

  expect_failures = [var.auth_domain_url]
}
