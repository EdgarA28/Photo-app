locals {
  environment = "dev"

  # The CloudFront origin (7.5) is added to the configured ones (localhost in dev): Cognito callback
  # and sign-out URLs, S3 CORS for direct uploads. Configured origins stay first (login_url output).
  app_origins = concat(var.app_origins, [module.frontend.url])
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
  cors_allowed_origins = local.app_origins
  versioning           = false
  force_destroy        = true

  # OAC read access to thumbs/ and previews/ (7.1).
  cloudfront_distribution_arn = module.frontend.distribution_arn
}

module "auth" {
  source = "../../modules/auth"

  environment         = local.environment
  app_origins         = local.app_origins
  deletion_protection = false

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

module "api" {
  source = "../../modules/api"

  environment = local.environment
  # Built by `pnpm build` (apps/api); run it before planning.
  source_dir = "${path.root}/../../../apps/api/dist"

  table_name    = module.database.table_name
  table_arn     = module.database.table_arn
  bucket_name   = module.storage.bucket_name
  bucket_arn    = module.storage.bucket_arn
  user_pool_id  = module.auth.user_pool_id
  user_pool_arn = module.auth.user_pool_arn
  issuer_url    = module.auth.issuer_url
  audience      = [module.auth.web_client_id]

  # FR-ACC-2, spec §13.2: 2 GB in dev.
  default_quota_bytes = 2 * 1024 * 1024 * 1024
}

module "frontend" {
  source = "../../modules/frontend"

  environment                       = local.environment
  photo_bucket_regional_domain_name = module.storage.bucket_regional_domain_name
  api_endpoint                      = module.api.api_endpoint
  force_destroy                     = true
}
