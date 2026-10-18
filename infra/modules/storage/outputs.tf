output "bucket_name" {
  value = aws_s3_bucket.photos.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.photos.arn
}

output "bucket_regional_domain_name" {
  description = "Origin domain for CloudFront (Phase 7)."
  value       = aws_s3_bucket.photos.bucket_regional_domain_name
}
