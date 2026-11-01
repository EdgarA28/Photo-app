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

variable "maximum_concurrency" {
  description = "Most thumbnail Lambdas running at once (SQS event source maximum concurrency, spec §10, B-11)."
  type        = number
  default     = 5

  validation {
    # Lambda's limits for SQS event sources.
    condition     = var.maximum_concurrency >= 2 && var.maximum_concurrency <= 1000
    error_message = "maximum_concurrency must be between 2 and 1000."
  }
}
