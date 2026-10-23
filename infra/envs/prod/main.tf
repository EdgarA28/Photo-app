locals {
  environment = "prod"
}

module "database" {
  source = "../../modules/database"

  table_name             = "photo-app-${local.environment}"
  point_in_time_recovery = true
  deletion_protection    = true
}

module "storage" {
  source = "../../modules/storage"

  environment                        = local.environment
  cors_allowed_origins               = var.app_origins
  versioning                         = true
  noncurrent_version_expiration_days = 30
  force_destroy                      = false
}

module "auth" {
  source = "../../modules/auth"

  environment         = local.environment
  app_origins         = var.app_origins
  deletion_protection = true

  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
}
