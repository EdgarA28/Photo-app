# Credentials come from the environment: AWS_PROFILE=dev locally, OIDC role in CI.
provider "aws" {
  region              = var.region
  allowed_account_ids = ["063359189013"]

  default_tags {
    tags = {
      Project     = "photo-app"
      Environment = "dev"
      ManagedBy   = "opentofu"
    }
  }
}
