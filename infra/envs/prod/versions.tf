terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State bucket created by infra/bootstrap (spec §13.3). S3-native locking, no DynamoDB table.
  # TODO (PROGRESS 12.5): enable OpenTofu client-side state encryption.
  backend "s3" {
    bucket       = "photo-app-tfstate-968632140314"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
