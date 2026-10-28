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

variable "google_client_id" {
  description = "Google OAuth client ID (4.3, spec §11.2). Null leaves Google sign-in off."
  type        = string
  default     = null
}

variable "google_client_secret" {
  description = "Google OAuth client secret. Never in git: pass it as TF_VAR_google_client_secret (NFR-SEC-8)."
  type        = string
  default     = null
  sensitive   = true
}

variable "pre_sign_up_source_dir" {
  description = "Built pre sign-up trigger (services/auth-triggers/dist, `pnpm build`). Null = no trigger."
  type        = string
  default     = null
}

variable "allowed_emails" {
  description = "Only these emails may sign up (email/password or Google); null = anyone. Pass as TF_VAR_allowed_emails, not in git."
  type        = list(string)
  default     = null
  sensitive   = true

  validation {
    condition     = var.allowed_emails == null ? true : alltrue([for e in var.allowed_emails : can(regex("^[^\\s,@]+@[^\\s,@]+$", e))])
    error_message = "Each entry is one email address (no commas or spaces)."
  }
}

variable "branding_logo_svg" {
  description = "App icon (SVG) for the managed login page: logo above the form and favicon. Null = Cognito's default look."
  type        = string
  default     = null
}
