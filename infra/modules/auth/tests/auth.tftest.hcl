# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "archive" {}

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  # Policies only need to be valid JSON for the IAM resources' plan-time checks.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/test"
    }
  }

  mock_resource "aws_cognito_user_pool" {
    defaults = {
      arn = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:test"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }
}

variables {
  environment = "test"
  app_origins = ["http://localhost:5173", "https://photos.example.com"]
}

run "pool_signs_in_with_verified_email" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.main.username_attributes == toset(["email"])
    error_message = "Users sign in with their email (FR-AUTH-2)."
  }

  assert {
    condition     = aws_cognito_user_pool.main.auto_verified_attributes == toset(["email"])
    error_message = "Email must be verified (FR-AUTH-2)."
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.username_configuration).case_sensitive == false
    error_message = "Email sign-in must be case-insensitive."
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.user_attribute_update_settings).attributes_require_verification_before_update == toset(["email"])
    error_message = "Email changes must only apply once verified (sharing trusts verified emails, 5.12)."
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.admin_create_user_config).allow_admin_create_user_only == false
    error_message = "Self sign-up must be allowed (FR-AUTH-2)."
  }

  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "ACTIVE"
    error_message = "Deletion protection must default to on."
  }
}

run "domain_is_unique_prefix" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool_domain.main.domain == "photo-app-test-123456789012"
    error_message = "Domain prefix must be photo-app-<env>-<account-id>."
  }

  assert {
    condition     = output.google_redirect_uri == "https://photo-app-test-123456789012.auth.us-east-1.amazoncognito.com/oauth2/idpresponse"
    error_message = "Google redirect URI must be <domain>/oauth2/idpresponse (spec §11.2)."
  }

  assert {
    condition     = startswith(output.login_url, "https://photo-app-test-123456789012.auth.us-east-1.amazoncognito.com/login?client_id=") && endswith(output.login_url, "&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback")
    error_message = "login_url must open the hosted sign-in page with the first origin's callback."
  }
}

run "web_client_is_public_with_code_pkce" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool_client.web.generate_secret == false
    error_message = "The web client is public: no secret (spec §11.1)."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.allowed_oauth_flows == toset(["code"])
    error_message = "Only the authorization code grant is allowed (no implicit flow)."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.allowed_oauth_scopes == toset(["openid", "email", "profile"])
    error_message = "Scopes must be openid email profile (spec §11.1)."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.explicit_auth_flows == toset(["ALLOW_REFRESH_TOKEN_AUTH"])
    error_message = "Sign-in only through the hosted pages; the client only refreshes tokens."
  }

  assert {
    condition = (
      aws_cognito_user_pool_client.web.access_token_validity == 1 &&
      aws_cognito_user_pool_client.web.id_token_validity == 1 &&
      aws_cognito_user_pool_client.web.refresh_token_validity == 30 &&
      one(aws_cognito_user_pool_client.web.token_validity_units).refresh_token == "days"
    )
    error_message = "Tokens: access/ID 1 h, refresh 30 days (spec §11.1, FR-AUTH-4)."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.prevent_user_existence_errors == "ENABLED"
    error_message = "Sign-in errors must not reveal whether an account exists."
  }
}

run "redirects_only_to_app_origins" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool_client.web.callback_urls == toset(["http://localhost:5173/auth/callback", "https://photos.example.com/auth/callback"])
    error_message = "Callback URLs must be <origin>/auth/callback for each app origin."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.logout_urls == toset(["http://localhost:5173/login", "https://photos.example.com/login"])
    error_message = "Sign-out URLs must be <origin>/login for each app origin."
  }
}

run "rejects_origins_with_paths" {
  command = plan

  variables {
    app_origins = ["http://localhost:5173/"]
  }

  expect_failures = [var.app_origins]
}

run "dev_can_be_destroyed" {
  command = plan

  variables {
    deletion_protection = false
  }

  assert {
    condition     = aws_cognito_user_pool.main.deletion_protection == "INACTIVE"
    error_message = "Deletion protection must be off when disabled."
  }
}

run "google_off_without_client_id" {
  command = plan

  assert {
    condition     = length(aws_cognito_identity_provider.google) == 0
    error_message = "No Google IdP without a client ID."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.supported_identity_providers == toset(["COGNITO"])
    error_message = "Only email/password sign-in without Google."
  }
}

run "google_sign_in" {
  command = plan

  variables {
    google_client_id     = "123-abc.apps.googleusercontent.com"
    google_client_secret = "test-secret"
  }

  assert {
    condition     = aws_cognito_identity_provider.google[0].provider_type == "Google" && aws_cognito_identity_provider.google[0].provider_details.authorize_scopes == "openid email profile"
    error_message = "Google IdP must request openid email profile (spec §11.2)."
  }

  assert {
    condition = aws_cognito_identity_provider.google[0].attribute_mapping == tomap({
      username       = "sub"
      email          = "email"
      email_verified = "email_verified"
      name           = "name"
      picture        = "picture"
    })
    error_message = "Attribute mapping must follow spec §11.2, incl. email_verified (needed for shares, 5.12)."
  }

  assert {
    condition     = aws_cognito_user_pool_client.web.supported_identity_providers == toset(["COGNITO", "Google"])
    error_message = "The web client must offer Google and email/password (FR-AUTH-1, FR-AUTH-2)."
  }
}

run "google_needs_secret" {
  command = plan

  variables {
    google_client_id = "123-abc.apps.googleusercontent.com"
  }

  expect_failures = [aws_cognito_identity_provider.google]
}

run "no_trigger_without_bundle" {
  command = plan

  assert {
    condition     = length(aws_lambda_function.pre_sign_up) == 0 && length(aws_cognito_user_pool.main.lambda_config) == 0
    error_message = "No pre sign-up trigger without a built bundle."
  }
}

run "pre_sign_up_trigger" {
  command = plan

  variables {
    pre_sign_up_source_dir = "./tests/fixtures/trigger"
  }

  assert {
    condition = (
      aws_lambda_function.pre_sign_up[0].runtime == "nodejs22.x" &&
      aws_lambda_function.pre_sign_up[0].architectures == tolist(["arm64"]) &&
      aws_lambda_function.pre_sign_up[0].handler == "index.handler"
    )
    error_message = "Trigger runs dist/index.mjs on Node.js 22, arm64 (spec §4)."
  }

  assert {
    condition     = one(aws_cognito_user_pool.main.lambda_config).pre_sign_up == aws_lambda_function.pre_sign_up[0].arn
    error_message = "The pool must call the trigger before sign-up (FR-AUTH-3)."
  }

  assert {
    condition     = aws_lambda_function.pre_sign_up[0].timeout <= 5
    error_message = "Cognito waits at most 5 s for a trigger."
  }

  assert {
    condition     = aws_cloudwatch_log_group.pre_sign_up[0].retention_in_days == 30 && one(aws_lambda_function.pre_sign_up[0].logging_config).log_format == "JSON"
    error_message = "Structured JSON logs, 30-day retention (spec §10)."
  }

  assert {
    condition     = aws_lambda_permission.pre_sign_up[0].principal == "cognito-idp.amazonaws.com"
    error_message = "Only Cognito may invoke the trigger."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.pre_sign_up[0].statement[0].actions) == toset(["cognito-idp:ListUsers", "cognito-idp:AdminLinkProviderForUser"])
    error_message = "The trigger may only look up users and link identities (NFR-SEC-7)."
  }

  assert {
    condition     = !contains(keys(one(aws_lambda_function.pre_sign_up[0].environment).variables), "ALLOWED_EMAILS")
    error_message = "Without an allowlist, sign-up stays open."
  }
}

run "pre_sign_up_allowlist" {
  command = plan

  variables {
    pre_sign_up_source_dir = "./tests/fixtures/trigger"
    allowed_emails         = ["a@example.com", "b@example.com"]
  }

  assert {
    condition     = nonsensitive(one(aws_lambda_function.pre_sign_up[0].environment).variables["ALLOWED_EMAILS"]) == "a@example.com,b@example.com"
    error_message = "The allowlist reaches the trigger as ALLOWED_EMAILS."
  }
}

run "rejects_malformed_allowlist" {
  command = plan

  variables {
    allowed_emails = ["a@example.com, b@example.com"]
  }

  expect_failures = [var.allowed_emails]
}
