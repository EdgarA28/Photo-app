output "state_bucket" {
  description = "Remote state bucket for infra/envs/<env>/backend.tf."
  value       = var.create_state_bucket ? aws_s3_bucket.state[0].bucket : null
}

output "ci_plan_role_arn" {
  description = "Role for GitHub Actions `tofu plan` (secret AWS_PLAN_ROLE_ARN)."
  value       = local.github_oidc_enabled ? aws_iam_role.ci_plan[0].arn : null
}

output "ci_deploy_role_arn" {
  description = "Role for GitHub Actions deploys (secret AWS_DEPLOY_ROLE_ARN)."
  value       = local.github_oidc_enabled ? aws_iam_role.ci_deploy[0].arn : null
}
