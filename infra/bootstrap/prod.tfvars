environment         = "prod"
account_id          = "968632140314"
aws_profile         = "prod"
create_state_bucket = true

github_oidc = {
  repository = "EdgarA28/Photo-app"
  # Only jobs running in the GitHub `prod` environment (with required approval) can deploy.
  deploy_subjects = ["repo:EdgarA28/Photo-app:environment:prod"]
}
