output "function_name" {
  description = "Video Lambda, for logs and manual checks."
  value       = aws_lambda_function.videos.function_name
}

output "dlq_url" {
  description = "Video messages that failed 5 receives (NFR-OPS-1); inspect or redrive from here."
  value       = aws_sqs_queue.dlq.url
}

output "queue_arn" {
  description = "Video queue ARN; the daily sweep may send stuck videos to it (6.11)."
  value       = aws_sqs_queue.videos.arn
}

output "queue_url" {
  description = "Video queue (events waiting for the video Lambda)."
  value       = aws_sqs_queue.videos.url
}
