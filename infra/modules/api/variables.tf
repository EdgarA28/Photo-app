variable "environment" {
  description = "Environment name (dev, prod); part of every resource name."
  type        = string
}

variable "source_dir" {
  description = "Built API bundle (apps/api/dist from `pnpm build`)."
  type        = string
}

variable "table_name" {
  description = "App table (database module): TABLE_NAME."
  type        = string
}

variable "table_arn" {
  description = "App table ARN (database module); its indexes are included."
  type        = string
}

variable "bucket_name" {
  description = "Photo bucket (storage module): PHOTO_BUCKET, for pre-signed uploads and downloads."
  type        = string
}

variable "bucket_arn" {
  description = "Photo bucket ARN (storage module)."
  type        = string
}

variable "user_pool_id" {
  description = "Cognito user pool (auth module): USER_POOL_ID, profile and email lookups."
  type        = string
}

variable "user_pool_arn" {
  description = "Cognito user pool ARN (auth module), for cognito-idp:ListUsers."
  type        = string
}

variable "issuer_url" {
  description = "JWT issuer: the user pool's URL (auth module)."
  type        = string
}

variable "audience" {
  description = "Accepted app client IDs (auth module web client). Cognito access tokens carry it as client_id."
  type        = list(string)
}

variable "default_quota_bytes" {
  description = "DEFAULT_QUOTA_BYTES: quota for users without an override (FR-ACC-2; spec §13.2: 2 GB dev, 10 GB prod)."
  type        = number

  validation {
    condition     = var.default_quota_bytes > 0 && floor(var.default_quota_bytes) == var.default_quota_bytes
    error_message = "default_quota_bytes must be a positive whole number."
  }
}

variable "throttling_rate_limit" {
  description = "Steady-state requests per second for the whole API (NFR-SEC-9)."
  type        = number
  default     = 25
}

variable "throttling_burst_limit" {
  description = "Burst size for the whole API (NFR-SEC-9)."
  type        = number
  default     = 50
}

variable "media_origin" {
  description = "MEDIA_ORIGIN: https://<CloudFront domain> (frontend module url); the media cookie policy's resource prefix."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.media_origin))
    error_message = "media_origin is https:// + host, without a path or trailing slash."
  }
}

variable "media_key_pair_id" {
  description = "MEDIA_KEY_PAIR_ID: CloudFront public key ID that signs media cookies (frontend module)."
  type        = string
}

variable "media_private_key_parameter_name" {
  description = "MEDIA_PRIVATE_KEY_PARAMETER: SSM SecureString with the signing key (frontend module)."
  type        = string
}

variable "media_private_key_parameter_arn" {
  description = "ARN of that parameter: the only one the API may read."
  type        = string
}
