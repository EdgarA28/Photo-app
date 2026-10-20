# Photo App — Implementation Plan & Progress

> **How to use this file (every session)**
> 1. Read **Current status** and **Next up** below.
> 2. Work on the next unchecked task(s). Requirement IDs (FR-*/NFR-*) and § numbers refer to [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md).
> 3. Before ending the session: tick finished tasks (`[x]`), update **Current status**, **Next up**, and add a line to the **Session log**.
> 4. If a decision is made or the plan changes, record it in **Decisions & notes** (and in spec §18/§19 if it changes the spec).
> 5. Update [`ARCHITECTURE.md`](ARCHITECTURE.md) for everything implemented or changed (status markers, objects, resources, flows, changelog).
>
> Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` skipped / deferred

---

## Current status

| | |
|---|---|
| **Phase** | 3 done (dev), 5.1–5.3 done (API skeleton), 6.1–6.7 done (thumbnail code) → next: API routes 5.5–5.13 (code only) or Phase 4 (auth) |
| **Last updated** | 2026-10-19 |
| **Deployed envs** | dev: bootstrap + table `photo-app-dev` + bucket `photo-app-photos-dev-063359189013` (test resources, destroy when done). general: budget. prod: nothing |
| **Blockers** | none |

## Next up

1. API routes without AWS: 5.5 `GET /me`, 5.7 list/get photos, 5.10–5.11 albums. Register them via `createApp({ routes })` with `createRepositories`; use `validate()` + `orNotFound()`. Routes needing S3/Cognito/CloudFront signing (5.6, 5.8, 5.9, 5.12) need those clients added (mock in tests). 5.6 follows the Photo item lifecycle in ARCHITECTURE.md §8.2.
2. Phase 4 (auth: Cognito + Google + pre-sign-up trigger): creates AWS resources, needs approval.
   Dev app resources (table + photo bucket) are test resources: `AWS_PROFILE=dev tofu destroy -var-file=env.tfvars` in `infra/envs/dev` when the user says testing is done.
3. Thumbnails 6.8 (aarch64 packaging) + 6.9 (infra module, can be written and `tofu test`ed offline; deploy needs approval). IAM must include `s3:DeleteObject` on `thumbs/`+`previews/` (race cleanup) and Lambda JSON log format.
4. Prod bootstrap (1.3/1.4/1.5 for prod) whenever the user approves it; it isn't needed until Phase 11.
5. Add GitHub repo secrets/environments for the CI roles when Phase 10 starts.

---

## Phase 0 — Repository foundations

- [x] **0.1** Folder structure per spec §15 (`apps/`, `packages/`, `services/`, `infra/`, `.github/`), `git init`, spec moved to `docs/SPECIFICATION.md`
- [x] **0.1a** Root files: `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.editorconfig`, `.nvmrc` (22), `.python-version` (3.13), `PROGRESS.md`, `CLAUDE.md`
- [x] **0.2** Local tools (§3.2)
  - [x] pnpm 10.18 (via corepack on Node 22, pinned in `packageManager`)
  - [x] uv 0.13 (in `~/.local/bin`)
  - [x] Node 22.23 via nvm (system default is still 24, so run `nvm use` in the repo)
  - [x] Python 3.13.16 via uv
  - [x] OpenTofu 1.13.1, AWS CLI, git
- [x] **0.3** Root TypeScript tooling
  - `tsconfig.base.json` (strict, bundler resolution, `noEmit`): packages extend it
  - `eslint.config.js` (flat, typescript-eslint, prettier) run once from root: `pnpm lint`
  - Prettier (`pnpm format` / `format:check`); Markdown excluded because it mangles `FR-*`
  - `vitest.config.ts` auto-discovers `{apps,packages,services}/*/vitest.config.ts`: `pnpm test`
  - Root scripts: `build`/`typecheck` run per package (`pnpm -r`), `lint`/`format`/`test` run at root
- [x] **0.4** Python tooling for `services/thumbnails`
  - `pyproject.toml` (uv, `uv_build`, src layout, Python `>=3.13,<3.14`), `uv.lock`
  - Runtime deps: pillow, pillow-heif. Dev: boto3 (provided by the Lambda runtime, so not packaged), pytest, ruff
  - Root scripts `pnpm lint:py` / `pnpm test:py`; smoke test in `tests/test_package.py`
- [x] **0.5** `README.md` with prerequisites, quick start and commands
- [x] **0.6** GitHub repo `git@github.com:EdgarA28/Photo-app.git`, initial commit pushed to `main`

## Phase 1 — AWS & external prerequisites (§3, §13.3, §14.1)

- [x] **1.1** AWS Organization with IAM Identity Center SSO; profiles `dev` (063359189013), `prod` (968632140314), `general` (590980992845, management), all AdministratorAccess. Root-user MFA is the user's responsibility (can't be checked via SSO)
- [x] **1.2** Org-wide budget `photo-app-monthly`, $5/month, in the management account (`general`), alerts to edgar.ayala2893@gmail.com at 80 %/100 % actual and 100 % forecast. `infra/bootstrap/budget.tf`, workspace `general`. **Applied 2026-10-19.** (The account also has a pre-existing "My Zero-Spend Budget", which isn't managed here)
- [~] **1.3** `infra/bootstrap/`: state bucket `photo-app-tfstate-<account-id>` per account (versioning, SSE-S3, ACLs disabled, public access block, TLS-only policy, old versions expire after 90 days keeping the newest 10, `prevent_destroy`). Workspaces `dev`/`prod`
  - [x] dev: `photo-app-tfstate-063359189013` **applied 2026-10-19**
  - [ ] prod: `photo-app-tfstate-968632140314`, plan clean, **needs user approval**
- [~] **1.4** `infra/envs/{dev,prod}`: S3 backend (`use_lockfile = true`, key `<env>/terraform.tfstate`), provider with `allowed_account_ids` + default tags
  - [x] dev: `tofu init` against the bucket done; empty plan OK (lock round-trip works)
  - [ ] prod: after prod bucket exists
- [~] **1.5** `infra/bootstrap/github-oidc.tf`: OIDC provider + `photo-app-ci-plan` (ReadOnlyAccess + state read + `.tflock` write; denies reading S3 objects other than state and DynamoDB items; any ref/PR of `EdgarA28/Photo-app`) and `photo-app-ci-deploy` (AdministratorAccess for now → 12.6; 1 h sessions; dev: `ref:refs/heads/main`, prod: `environment:prod`)
  - [x] dev **applied 2026-10-19**: `arn:aws:iam::063359189013:role/photo-app-ci-plan`, `arn:aws:iam::063359189013:role/photo-app-ci-deploy`
  - [ ] prod: with prod bootstrap, **needs user approval**
- [ ] **1.6** Google Cloud project + OAuth consent screen (done after Cognito domain exists → see 4.3)
- [ ] **1.7** Decide domain name (D-4) — only needed for prod

## Phase 2 — Shared package (`packages/shared`)

- [x] **2.1** Package setup: `@photo-app/shared`, source-only (exports `src/index.ts`, no build step; consumers bundle it), Vitest, `tsc` typecheck. Deps: zod 4, ulid 3
- [x] **2.2** `s3Keys.ts`: `originalKey`, `thumbKey`, `previewKey`, `userPrefix`, `extensionFor`, `parseOriginalKey` (strict; returns null for non-originals). Builders throw on invalid IDs. Tested against `test-vectors/s3-keys.json`, which the Python mirror (6.6) must also use
- [x] **2.3** `ids.ts`: `newId()` (monotonic ULID), `isId`, `isUserId`, `ULID_REGEX` (uppercase canonical), `USER_ID_REGEX` (lowercase UUID)
- [x] **2.4** Zod schemas in `src/schemas/` (common, errors, photos, albums, account) for every §9 route + error envelope and `errorCodes`
- [x] **2.5** `constants.ts`: content type → extension map (FR-UP-2), 50 MB limit (FR-UP-3), page limits, URL/cookie TTLs, derived image sizes. Per-env quota is config, not a shared constant

## Phase 3 — Core infrastructure, dev (`infra/modules`)

- [x] **3.1** Common tagging (`Project`, `Environment`, `ManagedBy`) via provider `default_tags` in `infra/envs/*/providers.tf`
- [x] **3.2** `database` module: table `photo-app-{env}`, on-demand, PK/SK + GSI1 (new `key_schema` syntax), PITR flag, `deletion_protection` flag (default on), AWS-owned encryption key. 3 `tofu test` runs (mock provider)
- [x] **3.3** `storage` module: bucket `photo-app-photos-{env}-{account-id}`, ACLs off, public access block, SSE-S3, TLS-only policy, CORS (app origins; POST/GET/HEAD), abort-multipart lifecycle, optional versioning + noncurrent expiry, `force_destroy` flag (default off). 4 `tofu test` runs
- [x] **3.4** `envs/{dev,prod}/main.tf` wire both modules; settings in `env.tfvars` (`app_origins`). dev: PITR off, no deletion protection, `force_destroy`; prod: PITR on, deletion protection, versioning with 30-day expiry
  - [x] dev plan clean: 9 to add (`photo-app-dev`, `photo-app-photos-dev-063359189013` + 7 bucket settings)
  - [x] dev apply **done 2026-10-19** (9 added); re-plan shows no drift; verified table ACTIVE + GSI1 ACTIVE, bucket public access fully blocked
  - prod: validated only (`-backend=false`); applied in Phase 11

## Phase 4 — Authentication (§11)

- [ ] **4.1** `auth` module: Cognito user pool (email username, verification), prefix domain, public app client (code + PKCE), callback/sign-out URLs, token lifetimes (FR-AUTH-2, FR-AUTH-4)
- [ ] **4.2** Apply to dev; note Cognito domain
- [ ] **4.3** Google OAuth client (origin + `/oauth2/idpresponse` redirect), consent screen in testing mode (§11.2)
- [ ] **4.4** Google IdP in Cognito with attribute mapping; client secret as sensitive variable (FR-AUTH-1)
- [ ] **4.5** `services/auth-triggers`: pre-sign-up Lambda linking Google → existing verified native user (`AdminLinkProviderForUser`) + tests (FR-AUTH-3)
- [ ] **4.6** Deploy trigger via `auth` module; manually verify both login methods + linking

## Phase 5 — API Lambda (`apps/api`, §9)

- [x] **5.1** Project setup: Hono, esbuild bundle (arm64, Node 22), Vitest, AWS SDK v3 clients
- [x] **5.2** Middleware: user ID from JWT `sub` only (NFR-SEC-1), error handler → error shape, 404-not-403 helper (NFR-SEC-2), Zod validation
- [x] **5.3** DynamoDB repository layer (photos, albums, memberships, shares, usage) + cursor encoding
  - 47 API tests (app/middleware, cursor tampering, repositories on DynamoDB Local in Docker); bundle 474 KB, smoke-tested by invoking `dist/index.mjs`
- [ ] **5.4** `api` infra module: HTTP API, JWT authorizer, Lambda, least-privilege IAM, throttling, 30-day logs (NFR-SEC-7/9, NFR-OPS-2)
- [~] **5.5** `GET /health` (for smoke tests) ✅ + `GET /me` (usage + quota) (FR-ACC-1, FR-ACC-2)
- [ ] **5.6** `POST /photos/upload-url`: quota check, `pending` item, pre-signed POST with size/type conditions (FR-UP-3/4/7, NFR-SEC-6)
- [ ] **5.7** `GET /photos` (GSI1, desc, cursor), `GET /photos/{id}` (FR-GAL-1/2)
- [ ] **5.8** `GET /photos/{id}/download-url` (5 min, attachment + original filename) (FR-DL-1/2)
- [ ] **5.9** `DELETE /photos/{id}`: S3 objects, item, memberships, usage update (FR-DEL-1)
- [ ] **5.10** Albums CRUD: `GET/POST /albums`, `PATCH/DELETE /albums/{id}` (FR-ALB-1)
- [ ] **5.11** Album photos: `GET/POST /albums/{id}/photos`, `DELETE /albums/{id}/photos/{photoId}` (FR-ALB-2)
- [ ] **5.12** Sharing: `GET/POST /albums/{id}/shares`, `DELETE …/shares/{userId}`, `GET /shared-albums`; lookup user by email in Cognito (FR-SHR-1..4)
- [ ] **5.13** Access check "can user X see photo P" for shared albums (§8.2)
- [ ] **5.14** Tenant-isolation test suite: every route with another user's IDs → 404

## Phase 6 — Thumbnail service (`services/thumbnails`, §10)

- [x] **6.1** Handler: key filter (loop protection), download, decode (Pillow + pillow-heif), EXIF orientation (FR-GAL-6)
- [x] **6.2** Extract `DateTimeOriginal`, width, height; fallback to upload time
- [x] **6.3** Generate thumb (400 px, q75) + preview (1600 px, q82), no upscale, flatten alpha, strip metadata (NFR-SEC-5)
- [x] **6.4** Upload with `image/jpeg` + immutable cache headers; update DynamoDB to `ready` (+ GSI1SK)
- [x] **6.5** Error handling: permanent → `failed`, transient → raise (FR-GAL-5, NFR-OPS-1)
- [x] **6.6** Python mirror of S3 key format + tests kept in sync with `packages/shared`
- [x] **6.7** pytest fixtures: JPEG with orientation, PNG with alpha, HEIC, corrupt file
  - 73 tests (key vectors, imaging, handler/processor on moto S3 + DynamoDB); fixtures generated in `conftest.py`, no binaries in git
- [ ] **6.8** Packaging: manylinux2014 aarch64 wheels → zip
- [ ] **6.9** `thumbnails` infra module: Lambda (1536 MB, 60 s), IAM (read `originals/`, write `thumbs/`+`previews/`), S3 notification, retries 2×, SQS DLQ 14 days, logs (NFR-SEC-7)
- [ ] **6.10** End-to-end check: upload via pre-signed POST → thumb ≤ 5 s (NFR-PERF-1)

## Phase 7 — CloudFront & media access (§5, §13.1 `frontend`)

- [ ] **7.1** `frontend` module: site bucket, CloudFront with OAC, behaviors `/` (site), `/api/*` (API GW), `/users/*` (photo bucket), SPA fallback
- [ ] **7.2** CloudFront key pair + key group; private key in Secrets Manager / SSM for the API
- [ ] **7.3** `POST /session/media-cookie`: signed cookies for `/users/{sub}/*`, 8 h
- [ ] **7.4** Signed URLs (15 min) for photos in albums shared with me
- [ ] **7.5** Update Cognito callback URLs + S3 CORS with the CloudFront domain

## Phase 8 — Frontend (`apps/web`, §12)

- [ ] **8.1** Vite + React + TS scaffold, TanStack Router (file-based) + Query, Zod
- [ ] **8.2** Decide UI library (D-3) and set up styling
- [ ] **8.3** Auth: `oidc-client-ts` (D-2), PKCE, `/login`, `/auth/callback`, token refresh, `_authenticated` guard (FR-AUTH-1/4/6)
- [ ] **8.4** API client with bearer token + Zod response parsing; media cookie call after login/refresh
- [ ] **8.5** App layout + navigation (gallery, albums, upload, settings)
- [ ] **8.6** Gallery: `useInfiniteQuery`, TanStack Virtual grid, reserved tile sizes, URL search params `album`/`sort` (FR-GAL-1/2/3, NFR-PERF-3)
- [ ] **8.7** Pending / failed tile states (FR-GAL-5)
- [ ] **8.8** Viewer `/photos/$photoId`: preview image, prev/next, keyboard + swipe (FR-GAL-4)
- [ ] **8.9** Download + delete with confirmation (FR-DL-1/2, FR-DEL-1/2)
- [ ] **8.10** Upload queue in IndexedDB: picker, drag & drop, camera; 3 concurrent; progress; retry on `online`/start (FR-UP-1/5/6)
- [ ] **8.11** Albums: list, create, rename, delete, add/remove photos, album view (FR-ALB-1/2)
- [ ] **8.12** Sharing UI: share by email, revoke, "Shared with me" section (FR-SHR-1..4)
- [ ] **8.13** Settings: usage/quota bar, logout clearing tokens, cookies, Query cache, IndexedDB (FR-ACC-1, FR-AUTH-5)
- [ ] **8.14** Quota exceeded + error messages (FR-UP-7)

## Phase 9 — PWA (§12.5)

- [ ] **9.1** vite-plugin-pwa: manifest, icons 192/512 + maskable, `start_url: /gallery` (FR-PWA-1)
- [ ] **9.2** Service worker: precache shell, CacheFirst thumbs (3,000 / 30 d), NetworkOnly API, denylist `/api/*` `/users/*` (NFR-PERF-4)
- [ ] **9.3** Persist Query cache to IndexedDB for offline (FR-PWA-2)
- [ ] **9.4** Update prompt (`registerType: 'prompt'`, `useRegisterSW`) (FR-PWA-3)
- [ ] **9.5** Background Sync for upload queue (Chromium)
- [ ] **9.6** `share_target` (Android) (FR-PWA-4)
- [ ] **9.7** Test install + Google login in standalone mode on iOS and Android (§12.6)

## Phase 10 — CI/CD (§14)

- [ ] **10.1** `ci.yml`: install with cache, lint, typecheck, ruff, Vitest, pytest, build, `tofu fmt/validate/plan` + PR comment
- [ ] **10.2** `deploy.yml` (dev on `main`): build all, `tofu apply`, upload site with correct `Cache-Control`, CloudFront invalidation, smoke test
- [ ] **10.3** Prod deploy job with GitHub `prod` environment + required approval

## Phase 11 — Production

- [ ] **11.1** Domain + ACM cert in `us-east-1`, custom domain on CloudFront (D-4)
- [ ] **11.2** `envs/prod`: 10 GB quota, PITR on, bucket versioning + 30-day noncurrent expiry (D-6), WAF rate limiting (NFR-SEC-9)
- [ ] **11.3** Add prod callback URLs to Cognito and Google
- [ ] **11.4** Publish Google consent screen (§11.2)
- [ ] **11.5** First prod deploy + smoke test

## Phase 12 — Verification before launch

- [ ] **12.1** Walk through every FR-* in spec §6 and confirm
- [ ] **12.2** Security review: tenant isolation, bucket policies, IAM, metadata stripping (NFR-SEC-*)
- [ ] **12.3** Performance checks: 10,000-photo gallery, API p95, thumbnail latency (NFR-PERF-*)
- [ ] **12.4** Cost check after first month vs §16 estimate
- [ ] **12.5** Enable OpenTofu client-side state encryption (deferred by user 2026-10-18): passphrase (pbkdf2, free) or KMS (~$1/month per key); migrate existing state
- [ ] **12.6** Scope `photo-app-ci-deploy` down from AdministratorAccess to the services actually deployed
- [ ] **12.7** Revisit the budget (currently $5/month org-wide) before public launch

---

## Decisions & notes

| Date | Note |
|---|---|
| 2026-10-18 | Spec moved from repo root to `docs/SPECIFICATION.md` (matches §15). |
| 2026-10-18 | Open decisions D-1…D-7 still as in spec §18; resolve D-2/D-3 at the start of Phase 8, D-4 before Phase 11. |
| 2026-10-18 | Local machine has Node 24 / Python 3.14; Lambda runtimes are Node 22 / Python 3.13, so use `.nvmrc` / `.python-version` to match. |
| 2026-10-18 | TypeScript pinned to `~6.0`: TS 7 is out but typescript-eslint 8.x supports only `<6.1`. Revisit when typescript-eslint supports 7. |
| 2026-10-18 | Root `package.json` is `"type": "module"`. React-specific ESLint plugins get added with the web scaffold (8.1). |
| 2026-10-18 | API contract choices (refine if needed): photo sort values `taken-desc`/`taken-asc`; `Photo.thumbUrl`/`previewUrl` are null until `ready`; albums carry `coverThumbUrl`; shared albums add `ownerId`, `sharedAt`; `GET /shared-albums` is paginated, `GET /albums` and `GET /albums/{id}/shares` are not; extra error codes `SHARE_TARGET_NOT_FOUND`, `RATE_LIMITED`; max 100 photo IDs per add-to-album request; album names ≤ 100 chars. |
| 2026-10-18 | Not added: a `GET /health` schema (5.5 adds it with the API). |
| 2026-10-18 | **Region us-east-1** (spec said eu-central-1); spec updated to v0.2. Separate AWS accounts for dev and prod; `general` is the management account and only holds the budget. |
| 2026-10-18 | **State encryption deferred** to the end (task 12.5). State buckets use SSE-S3 only for now. |
| 2026-10-18 | **AWS rule:** ask the user before creating any resource (show the plan, wait for an explicit yes, approval is per account). Resources created for testing are destroyed afterwards. |
| 2026-10-19 | **Kept permanently:** everything in `infra/bootstrap` (state buckets, budget, GitHub OIDC provider, CI roles). Only app resources from Phases 3+ count as test resources to destroy after testing. |
| 2026-10-19 | User approved bootstrap for **dev + general only**; prod waits. |
| 2026-10-19 | The first dev apply was interrupted after 12 of 13 resources; the S3 lifecycle rule had been created in AWS but wasn't in state. Fixed with `tofu import` (no AWS change). Lesson: after an interrupted apply, compare `tofu state list` with AWS before re-applying. |
| 2026-10-19 | Bootstrap plans are applied from saved plan files (`tofu plan -out` → `tofu apply <file>`) so exactly the reviewed plan is applied. |
| 2026-10-19 | `infra/bootstrap/*.tfvars` are committed on purpose: they hold account IDs and the alert email, no secrets. Secrets (e.g. Google client secret) must never go into tfvars in git. |
| 2026-10-19 | Same for `infra/envs/<env>/env.tfvars` (non-secret per-env settings). Run plans with `-var-file=env.tfvars`. |
| 2026-10-19 | Infra modules have offline `tofu test` suites using `mock_provider "aws"` (no credentials, nothing created). Root script `pnpm test:infra`. |
| 2026-10-19 | Storage: originals' INTELLIGENT_TIERING storage class will be set by the API in the pre-signed POST (lifecycle filters can't match `users/*/originals/`). The S3 → Lambda notification will live in the `thumbnails` module and CloudFront OAC access in the bucket policy from Phase 7. Versioning off uses `Suspended` (valid whether or not the bucket was ever versioned). |
| 2026-10-19 | AWS provider 6.69 deprecates GSI `hash_key`/`range_key`; modules use `key_schema` blocks. |
| 2026-10-19 | **Usage is counted by the thumbnail Lambda**, atomically with the final status, for both `ready` and `failed` (the original is stored either way). The API only creates the `pending` item (with provisional GSI1SK = uploadedAt) and decrements on delete. The Lambda also writes the actual S3 `sizeBytes`. |
| 2026-10-19 | `takenAt`: EXIF offset applied when present; without one the wall-clock time is stored as UTC. All timestamps use the JS `toISOString()` format so GSI1SK sorts correctly. |
| 2026-10-19 | Thumbnails convert embedded ICC profiles (e.g. Display P3) to sRGB before stripping metadata, so colours stay correct. Max source 100 MP (decompression-bomb guard). |
| 2026-10-19 | Known libheif quirk: pure random-noise images encoded at high quality produce HEIC files libde265 can't decode; real photos are fine. Such files would be marked `failed`. |
| 2026-10-19 | moto added as a Python dev dependency for S3/DynamoDB tests. |
| 2026-10-19 | API Lambda adapter: `@hono/aws-lambda` 1.0.0 (Hono's built-in `hono/aws-lambda` is deprecated, removed in Hono 5). AWS SDK is bundled into the API zip rather than using the runtime's copy. Bundle is ESM (`dist/index.mjs`, handler `index.handler`) with a source map: set `NODE_OPTIONS=--enable-source-maps` in 5.4. |
| 2026-10-19 | API repository tests run against **DynamoDB Local in Docker** (`amazon/dynamodb-local:3.3.1`, pinned) for real query/transaction/condition semantics; `pnpm test` therefore needs Docker (or `DYNAMODB_ENDPOINT`, e.g. a CI service container in 10.1). |
| 2026-10-19 | Photo items carry `albumIds` (string set) as the reverse index of album memberships, needed by photo delete (5.9) and the shared-photo access check (5.13); spec §8.2 had no photo→album lookup. |
| 2026-10-19 | Unknown `/api/*` routes answer 401 to anonymous callers (auth runs before routing) and 404 to signed-in users. JSON bodies are capped at 64 KB. |
| 2026-10-19 | Album photos are listed in membership (upload/ULID) order for now; ordering by date taken would need another index. Quota check at upload (5.6) only sees counted (non-pending) usage, so parallel uploads can overshoot slightly. |

## Session log

| Date | Summary |
|---|---|
| 2026-10-18 | Created folder structure, root config files, this plan and `CLAUDE.md`. |
| 2026-10-18 | Installed pnpm, uv, Node 22, Python 3.13. Completed 0.3 (tsconfig base, ESLint, Prettier, Vitest projects); lint/format/test all pass. |
| 2026-10-18 | Completed 0.4 (thumbnails uv project, ruff, pytest) and 0.5 (README). |
| 2026-10-18 | Completed Phase 2 (`packages/shared`): constants, IDs, S3 keys + shared test vectors, Zod API schemas. 44 tests pass; lint/typecheck/format clean. |
| 2026-10-18 | Completed 0.6: pushed initial commit to GitHub (`EdgarA28/Photo-app`, branch `main`). Project-scope Claude plugins enabled in `.claude/settings.json`. |
| 2026-10-18 | Phase 1 code: `infra/bootstrap` (state buckets, budget, GitHub OIDC roles), `infra/envs/{dev,prod}` backend + provider. All validate; plans clean (dev 13, prod 13, general 1 to add). Nothing applied yet. Spec → v0.2. |
| 2026-10-19 | Applied bootstrap in **dev** (13 resources: state bucket + 6 bucket settings, GitHub OIDC provider, ci-plan/ci-deploy roles + policies) and **general** (budget). `infra/envs/dev` initialised against remote state. Prod not applied. Docs updated (README, CLAUDE.md, bootstrap README, spec §3/§14). |
| 2026-10-19 | Added `ARCHITECTURE.md` (as-built architecture: stack + versions, accounts, repo tree, toolchain, shared objects/schemas, data model, API surface, workflows, security, infra resources, CI/CD, deviations). Rule added to keep it updated with every change. |
| 2026-10-19 | Phase 3 code: `database` + `storage` modules with `tofu test` suites (7 passing), wired into `envs/dev` and `envs/prod`; `pnpm test:infra`. dev plan clean (9 to add); apply waits for approval. |
| 2026-10-19 | Applied Phase 3 in dev (user approved): `photo-app-dev` table + `photo-app-photos-dev-063359189013` bucket and its 7 settings. No drift. |
| 2026-10-19 | API skeleton 5.1–5.3 (`apps/api`): Hono app, auth/validation/error middleware, `/health`, DynamoDB repositories (photos, albums, memberships, shares, usage, cursors), esbuild bundle. 47 tests incl. DynamoDB Local; lint/typecheck/format clean. Nothing deployed. |
| 2026-10-19 | Thumbnail service code 6.1–6.7: `handler.py`, `processor.py`, `imaging.py`, `s3_keys.py`; 73 pytest tests pass, ruff clean. 12 MP photo processes in 0.3–1.0 s locally. Nothing deployed. |
