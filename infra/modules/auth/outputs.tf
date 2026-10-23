output "user_pool_id" {
  description = "USER_POOL_ID for the API Lambda (5.4)."
  value       = aws_cognito_user_pool.main.id
}

output "user_pool_arn" {
  description = "For the API role's cognito-idp:ListUsers permission (5.4)."
  value       = aws_cognito_user_pool.main.arn
}

output "issuer_url" {
  description = "JWT issuer for the API Gateway authorizer (5.4) and the web app's OIDC client (8.3)."
  value       = "https://${aws_cognito_user_pool.main.endpoint}"
}

output "web_client_id" {
  description = "Public app client ID: OIDC client_id for the web app, audience for the JWT authorizer."
  value       = aws_cognito_user_pool_client.web.id
}

output "domain_url" {
  description = "Hosted sign-in base URL; Google's authorized JavaScript origin (4.3)."
  value       = local.domain_url
}

output "google_redirect_uri" {
  description = "Authorized redirect URI for the Google OAuth client (4.3, spec §11.2)."
  value       = "${local.domain_url}/oauth2/idpresponse"
}
