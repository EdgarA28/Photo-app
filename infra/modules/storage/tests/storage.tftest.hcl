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
}

variables {
  environment          = "test"
  cors_allowed_origins = ["http://localhost:5173"]
}

run "bucket_is_private_and_encrypted" {
  command = plan

  assert {
    condition     = aws_s3_bucket.photos.bucket == "photo-app-photos-test-123456789012"
    error_message = "Bucket name must be photo-app-photos-<env>-<account-id>."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.photos.block_public_acls,
      aws_s3_bucket_public_access_block.photos.block_public_policy,
      aws_s3_bucket_public_access_block.photos.ignore_public_acls,
      aws_s3_bucket_public_access_block.photos.restrict_public_buckets,
    ])
    error_message = "All public access must be blocked (NFR-SEC-3)."
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.photos.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "SSE-S3 is required (NFR-SEC-4)."
  }

  assert {
    condition     = aws_s3_bucket.photos.force_destroy == false
    error_message = "force_destroy must default to false."
  }
}

run "cors_only_for_app_origins" {
  command = plan

  assert {
    condition     = one(aws_s3_bucket_cors_configuration.photos.cors_rule).allowed_origins == toset(["http://localhost:5173"])
    error_message = "CORS must allow exactly the configured app origins."
  }

  assert {
    condition     = contains(one(aws_s3_bucket_cors_configuration.photos.cors_rule).allowed_methods, "POST")
    error_message = "Pre-signed POST uploads need POST in CORS."
  }
}

run "versioning_off_by_default" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.photos.versioning_configuration[0].status == "Suspended"
    error_message = "Versioning must be off unless requested."
  }

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.photos.rule) == 1
    error_message = "Without versioning only the abort-multipart rule applies."
  }
}

run "versioning_in_prod" {
  command = plan

  variables {
    versioning = true
  }

  assert {
    condition     = aws_s3_bucket_versioning.photos.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning must be enabled when requested."
  }

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.photos.rule) == 2
    error_message = "With versioning, noncurrent versions must expire."
  }
}
