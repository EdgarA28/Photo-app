variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "app_origins" {
  description = "Origins the web app runs on (S3 CORS now; Cognito callback URLs later)."
  type        = list(string)
}
