# Photo App

Serverless photo storage PWA on AWS. Full spec: `docs/SPECIFICATION.md`.

## Working across sessions

- At the start of a session, read `PROGRESS.md` (current status, next tasks).
- At the end of a session, update `PROGRESS.md`: tick tasks, update "Current status" / "Next up", add a session-log line.
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
- Never commit secrets, `*.tfstate` or `terraform.tfvars`.

## Commands

Run `source ~/.nvm/nvm.sh && nvm use` first (system Node is 24; the project uses 22 from `.nvmrc`).

- `pnpm lint` · `pnpm format` · `pnpm format:check` · `pnpm test` · `pnpm typecheck` · `pnpm build`
- Python (thumbnails): `pnpm lint:py` · `pnpm test:py`, or `uv run …` inside `services/thumbnails` (uv is in `~/.local/bin`)
- New TS packages: extend `../../tsconfig.base.json`, add a `vitest.config.ts` (auto-discovered by the root config) and a `typecheck` script (`tsc`).
