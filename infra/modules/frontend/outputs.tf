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

output "media_key_pair_id" {
  description = "Public key ID: the CloudFront-Key-Pair-Id the API signs with (7.3)."
  value       = aws_cloudfront_public_key.media.id
}

output "media_private_key_parameter_name" {
  description = "SSM SecureString holding the signing key (7.3)."
  value       = aws_ssm_parameter.media_private_key.name
}

output "media_private_key_parameter_arn" {
  description = "For the API's ssm:GetParameter grant (7.3)."
  value       = aws_ssm_parameter.media_private_key.arn
}
