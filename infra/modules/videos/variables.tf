variable "environment" {
  description = "Environment name (dev, prod); part of every resource name."
  type        = string
}

variable "source_dir" {
  description = "Built package (services/thumbnails/dist-video from `pnpm build:py`)."
  type        = string
}

variable "bucket_name" {
  description = "Photo bucket (storage module): source of the video events, target of posters."
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
  description = "Most video Lambdas running at once (SQS event source maximum concurrency, spec §10.2)."
  type        = number
  default     = 2

  validation {
    # Lambda's limits for SQS event sources.
    condition     = var.maximum_concurrency >= 2 && var.maximum_concurrency <= 1000
    error_message = "maximum_concurrency must be between 2 and 1000."
  }
}

variable "memory_size" {
  description = "Video Lambda memory in MB (spec §10.2, 14.9): CPU scales with it (10,240 MB = 6 vCPUs, for the playback copy)."
  type        = number
  default     = 10240

  validation {
    condition     = var.memory_size >= 3008 && var.memory_size <= 10240
    error_message = "memory_size must be between 3008 and 10240 MB."
  }
}
