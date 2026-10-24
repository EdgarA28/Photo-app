output "function_name" {
  description = "Thumbnail Lambda, for logs and manual checks."
  value       = aws_lambda_function.thumbnails.function_name
}

output "dlq_url" {
  description = "Failed events after the retries (NFR-OPS-1); inspect or redrive from here."
  value       = aws_sqs_queue.dlq.url
}
