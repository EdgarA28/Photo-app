locals {
  environment = "dev"
}

# Disposable environment: no deletion protection, bucket can be destroyed with contents.
module "database" {
  source = "../../modules/database"

  table_name             = "photo-app-${local.environment}"
  point_in_time_recovery = false
  deletion_protection    = false
}

module "storage" {
  source = "../../modules/storage"

  environment          = local.environment
  cors_allowed_origins = var.app_origins
  versioning           = false
  force_destroy        = true
}

module "auth" {
  source = "../../modules/auth"

  environment         = local.environment
  app_origins         = var.app_origins
  deletion_protection = false

  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}
