output "distribution_id" {
  description = "For cache invalidations (deploy, 10.2)."
  value       = aws_cloudfront_distribution.main.id
}

output "distribution_arn" {
  description = "Source ARN the bucket policies trust (OAC)."
  value       = aws_cloudfront_distribution.main.arn
}

output "domain_name" {
  description = "<id>.cloudfront.net until the custom domain (11.1)."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "url" {
  value = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "site_bucket_name" {
  value = aws_s3_bucket.site.bucket
}
