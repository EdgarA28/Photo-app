variable "environment" {
  description = "Environment name (dev, prod); part of the site bucket name."
  type        = string
}

variable "photo_bucket_regional_domain_name" {
  description = "Photo bucket origin domain (storage module), served under /users/*."
  type        = string
}

variable "api_endpoint" {
  description = "API Gateway endpoint (api module), https://<id>.execute-api.<region>.amazonaws.com; served under /api/*."
  type        = string
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_100 = North America + Europe edges (cheapest)."
  type        = string
  default     = "PriceClass_100"
}

variable "force_destroy" {
  description = "Allow destroying the site bucket while it still contains objects. Only for disposable dev environments."
  type        = bool
  default     = false
}
