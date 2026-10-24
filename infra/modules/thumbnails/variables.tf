variable "environment" {
  description = "Environment name (dev, prod); part of every resource name."
  type        = string
}

variable "source_dir" {
  description = "Built package (services/thumbnails/dist from `pnpm build:py`)."
  type        = string
}

variable "bucket_name" {
  description = "Photo bucket (storage module): source of the S3 events, target of thumbs and previews."
  type        = string
}

variable "bucket_arn" {
  description = "Photo bucket ARN (storage module)."
  type        = string
}

variable "table_name" {
  description = "App table (database module): TABLE_NAME for the Lambda."
  type        = string
}

variable "table_arn" {
  description = "App table ARN (database module)."
  type        = string
}
