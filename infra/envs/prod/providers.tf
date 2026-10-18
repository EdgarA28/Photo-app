# Credentials come from the environment: AWS_PROFILE=prod locally, OIDC role in CI.
provider "aws" {
  region              = var.region
  allowed_account_ids = ["968632140314"]

  default_tags {
    tags = {
      Project     = "photo-app"
      Environment = "prod"
      ManagedBy   = "opentofu"
    }
  }
}
