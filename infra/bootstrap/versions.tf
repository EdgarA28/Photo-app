terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Local state on purpose (spec §13.3): this config creates the remote state bucket.
  # One workspace per account (dev, prod, general); state lives in terraform.tfstate.d/ (git-ignored).
}
