variable "environment" {
  description = "Account this run targets: dev, prod or general (management account). Must match the workspace."
  type        = string

  validation {
    condition     = contains(["dev", "prod", "general"], var.environment)
    error_message = "environment must be dev, prod or general."
  }
}

variable "account_id" {
  description = "Expected AWS account ID; the provider refuses to run against any other account."
  type        = string
}

variable "aws_profile" {
  description = "AWS CLI (SSO) profile for this account."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "create_state_bucket" {
  description = "Create the OpenTofu remote state bucket in this account."
  type        = bool
  default     = false
}

variable "budget" {
  description = "Monthly cost budget with email alerts. Set only in the management account (covers the whole organization)."
  type = object({
    limit_usd = number
    email     = string
  })
  default = null
}

variable "github_oidc" {
  description = "GitHub Actions OIDC access (spec §14.1). repository as in the token `sub` (`owner@ownerId/repo@repoId`); deploy_subjects are the full `sub` values allowed to assume ci-deploy."
  type = object({
    repository      = string
    deploy_subjects = list(string)
  })
  default = null
}
