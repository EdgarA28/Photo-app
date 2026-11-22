output "api_endpoint" {
  description = "https://<id>.execute-api.<region>.amazonaws.com; routes live under /api. CloudFront origin in Phase 7."
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "function_name" {
  description = "API Lambda, for logs and manual checks."
  value       = aws_lambda_function.api.function_name
}

output "purge_function_name" {
  description = "Daily trash purge Lambda (FR-DEL-3), for logs and manual runs."
  value       = aws_lambda_function.purge.function_name
}

output "import_worker_function_name" {
  description = "Google Photos import worker (13.5f), for logs; null without google_client_id."
  value       = local.imports ? aws_lambda_function.import_worker[0].function_name : null
}

output "import_queue_url" {
  description = "Import queue (13.5f); null without google_client_id."
  value       = local.imports ? aws_sqs_queue.imports[0].url : null
}

output "import_client_id" {
  description = "Google OAuth client ID the web app starts the import consent with (13.5g, VITE_GOOGLE_IMPORT_CLIENT_ID); null without the import."
  value       = local.imports ? var.google_client_id : null
}
