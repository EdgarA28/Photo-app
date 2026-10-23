variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "app_origins" {
  description = "Origins the web app runs on (S3 CORS, Cognito callback and sign-out URLs)."
  type        = list(string)
}
