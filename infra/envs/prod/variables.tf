variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "app_origins" {
  description = "Origins the web app runs on (S3 CORS, Cognito callback and sign-out URLs)."
  type        = list(string)
}

variable "google_client_id" {
  description = "Google OAuth client ID (spec §11.2). Not secret; null = no Google sign-in."
  type        = string
  default     = null
}

variable "google_client_secret" {
  description = "Google OAuth client secret. Never in git: export TF_VAR_google_client_secret (NFR-SEC-8)."
  type        = string
  default     = null
  sensitive   = true
}

variable "allowed_emails" {
  description = "Only these emails may sign up; null = anyone. Not in git: export TF_VAR_allowed_emails='[\"a@example.com\"]'."
  type        = list(string)
  default     = null
  sensitive   = true
}
