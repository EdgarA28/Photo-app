# Photo App

Serverless photo storage PWA on AWS. Full spec: `docs/SPECIFICATION.md`.

## Working across sessions

- At the start of a session, read `PROGRESS.md` (current status, next tasks).
- At the end of a session, update `PROGRESS.md`: tick tasks, update "Current status" / "Next up", add a session-log line.
- **Whenever something is implemented or changed, update `ARCHITECTURE.md` in the same change**: status markers (✅/🚧/📋), new objects, schemas, resources, flows, repo tree, versions, deviations from the spec, and its changelog. It must always describe what actually exists.
- Reference requirement IDs (FR-*, NFR-*) and spec sections (§n) in code comments, tests and commits where relevant.

## Layout

- `apps/web` — React + Vite + TanStack PWA
- `apps/api` — TypeScript API Lambda (Hono)
- `packages/shared` — Zod schemas, types, S3 key helpers (single source of truth for key format)
- `services/thumbnails` — Python 3.13 thumbnail Lambda
- `services/auth-triggers` — Cognito pre-sign-up Lambda (TypeScript)
- `infra/` — OpenTofu (`bootstrap/`, `modules/`, `envs/{dev,prod}`)

## Rules

- Backend user identity comes only from the JWT `sub`; other users' resources return 404.
- Never commit secrets, `*.tfstate` or `terraform.tfvars`. (`infra/bootstrap/*.tfvars` are fine: IDs and email only.)

## AWS

- Region `us-east-1`. SSO profiles: `dev` (063359189013), `prod` (968632140314), `general` (590980992845, management, budget only). Expired session → user runs `! aws sso login --profile <p>`.
- **Ask the user before creating any AWS resource**: show the plan, wait for an explicit yes. Approval is per account. Apply from a saved plan (`tofu plan -out` → `tofu apply <file>`).
- Resources created for testing get destroyed afterwards. **Never destroy `infra/bootstrap` resources** (state buckets, budget, CI roles).
- `infra/envs/<env>`: run with `AWS_PROFILE=<env>`; the provider's `allowed_account_ids` blocks the wrong account.

## Commands

Run `source ~/.nvm/nvm.sh && nvm use` first (system Node is 24; the project uses 22 from `.nvmrc`).

- `pnpm lint` · `pnpm format` · `pnpm format:check` · `pnpm test` · `pnpm typecheck` · `pnpm build`
- `pnpm test` needs Docker running: `apps/api` repository tests start DynamoDB Local (`amazon/dynamodb-local:3.3.1`), or use `DYNAMODB_ENDPOINT`.
- Infra modules: `pnpm test:infra` (offline `tofu test`, mocked provider). Env plans: `AWS_PROFILE=<env> tofu plan -var-file=env.tfvars -out=<env>.tfplan` in `infra/envs/<env>`
- Python (thumbnails): `pnpm lint:py` · `pnpm test:py`, or `uv run …` inside `services/thumbnails` (uv is in `~/.local/bin`)
- Web dev server: `API_PROXY_TARGET=$(tofu -chdir=infra/envs/dev output -raw api_endpoint) pnpm --filter @photo-app/web dev` (port 5173, `/api` proxied; the API has no CORS)
- Lambda bundles (needed before env plans): `pnpm build` (includes the auth trigger → `services/auth-triggers/dist`) · `pnpm build:py` (thumbnails, aarch64 wheels → `services/thumbnails/dist`, used by the env plans once 6.9 wires it in)
- New TS packages: extend `../../tsconfig.base.json`, add a `vitest.config.ts` (auto-discovered by the root config) and a `typecheck` script (`tsc`).
