provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "photo-app"
      Environment = var.environment
      ManagedBy   = "opentofu"
      Stack       = "bootstrap"
    }
  }
}
