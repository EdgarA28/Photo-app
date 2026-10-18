variable "environment" {
  description = "Environment name (dev, prod); part of the bucket name."
  type        = string
}

variable "cors_allowed_origins" {
  description = "Origins allowed to upload directly to the bucket with pre-signed POST (app origins only)."
  type        = list(string)
}

variable "versioning" {
  description = "Keep previous object versions (accidental-delete protection; spec §13.2: on in prod)."
  type        = bool
  default     = false
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which previous object versions are deleted, when versioning is on."
  type        = number
  default     = 30
}

variable "force_destroy" {
  description = "Allow destroying the bucket while it still contains objects. Only for disposable dev environments."
  type        = bool
  default     = false
}
