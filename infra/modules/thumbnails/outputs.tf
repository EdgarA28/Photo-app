output "function_name" {
  description = "Thumbnail Lambda, for logs and manual checks."
  value       = aws_lambda_function.thumbnails.function_name
}

output "dlq_url" {
  description = "Messages that failed 5 receives (NFR-OPS-1); inspect or redrive to the queue from here."
  value       = aws_sqs_queue.dlq.url
}

output "queue_arn" {
  description = "Thumbnail queue ARN; the daily sweep may send stuck photos to it (6.11)."
  value       = aws_sqs_queue.thumbnails.arn
}

output "queue_url" {
  description = "Thumbnail queue (S3 events waiting for the Lambda, 13.6); its depth shows the backlog."
  value       = aws_sqs_queue.thumbnails.url
}
