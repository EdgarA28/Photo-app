environment         = "dev"
account_id          = "063359189013"
aws_profile         = "dev"
create_state_bucket = true

github_oidc = {
  repository      = "EdgarA28/Photo-app"
  deploy_subjects = ["repo:EdgarA28/Photo-app:ref:refs/heads/main"]
}
