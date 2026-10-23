# Cognito user pool, domain, app client and Google IdP (spec §11, §13.1).
#
# Added later in this module:
#   - pre-sign-up trigger from services/auth-triggers (4.5/4.6) → lambda_config

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  name = "photo-app-${var.environment}"

  # Prefix domains are global per region; the account ID keeps this one unique.
  domain_prefix = "photo-app-${var.environment}-${data.aws_caller_identity.current.account_id}"
  domain_url    = "https://${local.domain_prefix}.auth.${data.aws_region.current.region}.amazoncognito.com"

  google_enabled = var.google_client_id != null
}

resource "aws_cognito_user_pool" "main" {
  name = local.name

  # Essentials: free for the first 10,000 MAU (§16) and needed for managed login.
  user_pool_tier      = "ESSENTIALS"
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  # FR-AUTH-2: sign in with the email address; Cognito's username is then the user's `sub`.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  # Sharing trusts verified emails (5.12): a changed email only applies once the new one is verified.
  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  # FR-AUTH-2: self sign-up with an emailed verification code.
  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
  }

  # Cognito's own sender: 50 emails/day, enough for dev and a small user base.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Length over character classes (NIST SP 800-63B).
  password_policy {
    minimum_length                   = 12
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  mfa_configuration = "OFF"
}

# Hosted sign-in pages at https://<prefix>.auth.<region>.amazoncognito.com (version 2 = managed login).
resource "aws_cognito_user_pool_domain" "main" {
  domain                = local.domain_prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}

# The web app (spec §11.1): public client, authorization code grant with PKCE.
resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  # Referencing the IdP (not the literal "Google") makes the client wait until it exists.
  supported_identity_providers = concat(["COGNITO"], aws_cognito_identity_provider.google[*].provider_name)

  callback_urls = [for o in var.app_origins : "${o}/auth/callback"]
  logout_urls   = [for o in var.app_origins : "${o}/login"]

  # Sign-in only through the hosted pages; the app itself just refreshes tokens (FR-AUTH-4).
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # Logout can revoke the refresh token (FR-AUTH-5).
  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"
}

# FR-AUTH-1: "Continue with Google" (spec §11.2). Only when a Google client ID is configured.
resource "aws_cognito_identity_provider" "google" {
  count = local.google_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  # Besides the client and scopes, Cognito fills in Google's endpoints; listing them avoids a diff on every plan.
  provider_details = {
    client_id                     = var.google_client_id
    client_secret                 = var.google_client_secret
    authorize_scopes              = "openid email profile"
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    oidc_issuer                   = "https://accounts.google.com"
    token_request_method          = "POST"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
  }

  # email_verified is needed to receive shares (5.12 trusts only verified emails).
  attribute_mapping = {
    username       = "sub"
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
    picture        = "picture"
  }

  lifecycle {
    precondition {
      condition     = var.google_client_secret != null && var.google_client_secret != ""
      error_message = "google_client_secret is required with google_client_id (set TF_VAR_google_client_secret)."
    }
  }
}

# Managed login needs a style per client; Cognito's default look for now.
resource "aws_cognito_managed_login_branding" "web" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.web.id
  use_cognito_provided_values = true
}
