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

  # Built by `pnpm build` (services/auth-triggers); run it before planning.
  pre_sign_up_source_dir = "${path.root}/../../../services/auth-triggers/dist"
}

module "thumbnails" {
  source = "../../modules/thumbnails"

  environment = local.environment
  # Built by `pnpm build:py` (services/thumbnails); run it before planning.
  source_dir  = "${path.root}/../../../services/thumbnails/dist"
  bucket_name = module.storage.bucket_name
  bucket_arn  = module.storage.bucket_arn
  table_name  = module.database.table_name
  table_arn   = module.database.table_arn
}
