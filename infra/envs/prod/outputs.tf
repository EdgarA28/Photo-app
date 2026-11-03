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

output "google_login" {
  value = module.auth.google_login
}

output "google_redirect_uri" {
  value = module.auth.google_redirect_uri
}

output "login_url" {
  value = module.auth.login_url
}

output "pre_sign_up_function_name" {
  value = module.auth.pre_sign_up_function_name
}

output "thumbnails_function_name" {
  value = module.thumbnails.function_name
}

output "thumbnails_dlq_url" {
  value = module.thumbnails.dlq_url
}

output "thumbnails_queue_url" {
  value = module.thumbnails.queue_url
}

output "videos_function_name" {
  description = "Video Lambda (14.4), for logs and manual checks."
  value       = module.videos.function_name
}

output "videos_dlq_url" {
  description = "Video messages that failed 5 receives; inspect or redrive from here."
  value       = module.videos.dlq_url
}

output "videos_queue_url" {
  description = "Video queue: its depth shows videos waiting to be processed."
  value       = module.videos.queue_url
}

output "api_endpoint" {
  value = module.api.api_endpoint
}

output "api_function_name" {
  value = module.api.function_name
}

output "app_url" {
  value = module.frontend.url
}

output "cloudfront_distribution_id" {
  value = module.frontend.distribution_id
}

output "site_bucket_name" {
  value = module.frontend.site_bucket_name
}

output "media_key_pair_id" {
  value = module.frontend.media_key_pair_id
}
