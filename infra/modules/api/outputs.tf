output "api_endpoint" {
  description = "https://<id>.execute-api.<region>.amazonaws.com; routes live under /api. CloudFront origin in Phase 7."
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "function_name" {
  description = "API Lambda, for logs and manual checks."
  value       = aws_lambda_function.api.function_name
}
