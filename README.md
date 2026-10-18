# Photo App

A private, multi-user photo storage and gallery PWA, similar in spirit to Google Photos, built serverless on AWS.

- **Spec:** [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md)
- **Implementation plan & progress:** [`PROGRESS.md`](PROGRESS.md)

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
docs/                    Specification
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

Infrastructure and deployment commands will be documented here once Phase 1 (AWS bootstrap) and Phase 10 (CI/CD) are done.
