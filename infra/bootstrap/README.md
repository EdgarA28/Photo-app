# Bootstrap (run once per account)

One-time setup with **local state** (spec §13.3). One workspace per account; the workspace name must match `environment` in the tfvars file (a `check` block warns otherwise, and `allowed_account_ids` refuses the wrong account).

Everything here is **permanent**: it is not destroyed after tests. State buckets also have `prevent_destroy`.

| Workspace | Account | Creates | Status |
|---|---|---|---|
| `dev` | 063359189013 | State bucket `photo-app-tfstate-063359189013` (+ 6 settings: ownership, public access block, versioning, encryption, lifecycle, TLS-only policy), GitHub OIDC provider, `photo-app-ci-plan` (+ ReadOnlyAccess, inline state policy), `photo-app-ci-deploy` (+ AdministratorAccess) = 13 resources | Applied 2026-10-19 |
| `prod` | 968632140314 | Same 13 for prod; deploy role only for the GitHub `prod` environment | **Not applied** |
| `general` | 590980992845 (management) | Organization-wide `photo-app-monthly` budget, $5/month, email alerts | Applied 2026-10-19 |

## Usage

Always ask the project owner before applying. Apply from a saved plan so exactly what was reviewed gets applied:

```bash
cd infra/bootstrap
tofu init
tofu workspace select -or-create dev
tofu plan -var-file=dev.tfvars -out=dev.tfplan
tofu apply dev.tfplan
```

Outputs (`tofu output`): `state_bucket`, `ci_plan_role_arn`, `ci_deploy_role_arn`.

## Notes

- Local state is in `terraform.tfstate.d/<workspace>/` (git-ignored, only on the machine that ran it). If it is lost, re-import the resources with `tofu import`.
- If an apply is interrupted, compare `tofu state list` with what exists in AWS before applying again. A resource can exist in AWS without being recorded in state; `tofu import` it rather than recreating it.
- The `*.tfvars` files are committed: account IDs and the alert email only, never secrets.
