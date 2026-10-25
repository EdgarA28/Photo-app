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
