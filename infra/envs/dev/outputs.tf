output "table_name" {
  value = module.database.table_name
}

output "photo_bucket_name" {
  value = module.storage.bucket_name
}

output "user_pool_id" {
  value = module.auth.user_pool_id
}

output "web_client_id" {
  value = module.auth.web_client_id
}

output "cognito_domain_url" {
  value = module.auth.domain_url
}

output "google_redirect_uri" {
  value = module.auth.google_redirect_uri
}

output "login_url" {
  value = module.auth.login_url
}
