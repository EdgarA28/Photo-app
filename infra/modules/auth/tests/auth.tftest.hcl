# Offline tests: mocked AWS provider, nothing is created. Run: tofu test
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
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
