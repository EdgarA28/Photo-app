variable "table_name" {
  description = "DynamoDB table name, e.g. photo-app-dev."
  type        = string
}

variable "point_in_time_recovery" {
  description = "Enable point-in-time recovery (spec §13.2: off in dev, on in prod)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Block table deletion. Off in dev so test environments can be destroyed."
  type        = bool
  default     = true
}
