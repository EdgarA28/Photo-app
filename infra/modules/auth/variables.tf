variable "environment" {
  description = "Environment name (dev, prod); part of the pool name and the Cognito domain prefix."
  type        = string
}

variable "app_origins" {
  description = "Origins the web app runs on. Each gets <origin>/auth/callback and <origin>/login (spec §11.1)."
  type        = list(string)

  validation {
    condition     = alltrue([for o in var.app_origins : can(regex("^https?://[^/]+$", o))])
    error_message = "Origins are scheme + host (+ port), without a path or trailing slash."
  }
}

variable "deletion_protection" {
  description = "Block deleting the user pool. Off in dev so test environments can be destroyed."
  type        = bool
  default     = true
}
