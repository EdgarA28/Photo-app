environment         = "dev"
account_id          = "063359189013"
aws_profile         = "dev"
create_state_bucket = true

github_oidc = {
  # GitHub's token `sub` names the owner and repo with their immutable IDs (seen in CloudTrail,
  # 2026-10-27), so a deleted and re-created repo of the same name can't assume these roles.
  repository      = "EdgarA28@139340405/Photo-app@1424847030"
  deploy_subjects = ["repo:EdgarA28@139340405/Photo-app@1424847030:ref:refs/heads/main"]
}
