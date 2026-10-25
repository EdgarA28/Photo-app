# Media signing keys (7.2, spec §9): CloudFront only serves /users/* with a valid signed cookie
# (own photos, 7.3) or signed URL (shared albums, 7.4). The API signs with the private key; the
# distribution verifies with the public key through the key group.
#
# The private key is generated here, so it is also in the OpenTofu state (private, SSE-S3, like
# the Google client secret; client-side state encryption is task 12.5). Rotation: add a second
# public key to the group, sign with it, remove the old one after the cookies expired (≤ 8 h).

# CloudFront signed cookies/URLs need RSA 2048.
resource "tls_private_key" "media" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "media" {
  name        = "${local.name}-media"
  comment     = "Verifies photo app media cookies and signed URLs"
  encoded_key = tls_private_key.media.public_key_pem
}

resource "aws_cloudfront_key_group" "media" {
  name    = "${local.name}-media"
  comment = "Trusted by the /users/* behavior"
  items   = [aws_cloudfront_public_key.media.id]
}

# Read by the API Lambda at cold start (7.3; its IAM grant lives with that code).
# SecureString with the AWS-managed aws/ssm key: free, unlike Secrets Manager.
resource "aws_ssm_parameter" "media_private_key" {
  name        = "/photo-app/${var.environment}/cloudfront/media-private-key"
  description = "Private key for CloudFront media cookies and signed URLs (PEM)"
  type        = "SecureString"
  value       = tls_private_key.media.private_key_pem
}
