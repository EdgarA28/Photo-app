# Photo App

A private, multi-user photo storage and gallery PWA, similar in spirit to Google Photos, built serverless on AWS.

- **Spec:** [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md)
- **Implementation plan & progress:** [`PROGRESS.md`](PROGRESS.md)
- **Architecture (as built):** [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Stack

React + Vite + TanStack (Router, Query, Virtual) PWA · TypeScript API on Lambda (Hono) · Python thumbnail Lambda (Pillow + pillow-heif) · Cognito (Google + email) · API Gateway · DynamoDB · S3 · CloudFront · OpenTofu · GitHub Actions.

## Repository layout

```
apps/web                 React SPA + PWA
apps/api                 API Lambda (TypeScript)
packages/shared          Zod schemas, types, S3 key helpers
services/thumbnails      Thumbnail Lambda (Python)
services/auth-triggers   Cognito pre-sign-up Lambda (TypeScript)
infra/bootstrap          OpenTofu state bucket (run once)
infra/modules            OpenTofu modules
infra/envs/{dev,prod}    Environment roots
docs/                    Specification, scaling analysis
```

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 22 (see `.nvmrc`) | `nvm install && nvm use` |
| pnpm | pinned in `package.json` | `corepack enable` |
| Python | 3.13 (see `.python-version`) | `uv python install 3.13` |
| uv | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| OpenTofu | ≥ 1.10 | https://opentofu.org/docs/intro/install/ |
| AWS CLI | v2 | https://docs.aws.amazon.com/cli/ |
| Docker | any recent | Needed by `pnpm test` (API repository tests start DynamoDB Local); or set `DYNAMODB_ENDPOINT` |

## Quick start

```bash
nvm use                                  # Node 22
pnpm install                             # TypeScript workspaces
uv sync --project services/thumbnails    # Python service (creates .venv)
```

## Common commands

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint for all TypeScript code |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | Vitest across all TS packages |
| `pnpm build` | Build every package |
| `pnpm lint:py` | ruff lint + format check for the thumbnail service |
| `pnpm test:py` | pytest for the thumbnail service |
| `pnpm test:infra` | Offline `tofu test` for every infra module (mocked AWS, creates nothing) |

## AWS

AWS Organization in **us-east-1**, accessed via IAM Identity Center (SSO):

| CLI profile | Account | Purpose |
|---|---|---|
| `dev` | 063359189013 | Development environment |
| `prod` | 968632140314 | Production environment |
| `general` | 590980992845 | Management account: organization-wide budget only |

```bash
aws sso login --profile dev       # when the SSO session has expired
```

## Infrastructure (OpenTofu)

| Path | What | State |
|---|---|---|
| `infra/bootstrap/` | One-time per account: state bucket, GitHub OIDC + CI roles, budget. See its [README](infra/bootstrap/README.md) | Local, one workspace per account |
| `infra/envs/dev/`, `infra/envs/prod/` | The app's infrastructure per environment | S3 `photo-app-tfstate-<account-id>`, key `<env>/terraform.tfstate`, S3-native locking |
| `infra/modules/` | Reusable modules (storage, database, auth, api, thumbnails, frontend) | n/a |

```bash
cd infra/envs/dev
AWS_PROFILE=dev tofu init
AWS_PROFILE=dev tofu plan -var-file=env.tfvars
```

Deployment runs in GitHub Actions: `ci.yml` checks every pull request and push to `main` (with a dev `tofu plan`), and `deploy.yml` deploys dev after CI passes on `main`. Prod deploys come with Phase 11 (see `PROGRESS.md`).

## Third-party data

Place names for search by place (13.2) come from [GeoNames](https://www.geonames.org) (`cities1000`, `admin1CodesASCII`, `countryInfo`), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The compact list `services/thumbnails/src/thumbnails/data/places.tsv.gz` is generated from them by `services/thumbnails/scripts/build_places.py` (download the three files into an empty folder, unzip `cities1000.zip`, run `uv run python scripts/build_places.py <folder>`); the app shows the attribution in Settings.
