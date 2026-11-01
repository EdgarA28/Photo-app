# Scaling to millions of users — analysis & plan

> Reference document from a design session on 2026-10-31 (status notes added 2026-11-01). Mostly not implemented yet (see the notes on D1, D4, J2); it is a backlog of changes and a cost model for the scenario **"up to 100 GB per user, millions of users"**.
> Prices are approximate us-east-1 list prices as of 2026; re-check them with the AWS Pricing Calculator before making decisions.
> Related: [`SPECIFICATION.md`](SPECIFICATION.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## 1. Summary

- The architecture already scales horizontally: serverless compute, photo bytes never pass through the API, and per-user partitioning (`USER#{sub}` in DynamoDB, `users/{sub}/` in S3).
- The real limits at this scale are:
  1. **Cost**, mostly storage (≈ 80 % of the bill).
  2. **Global hot keys** in DynamoDB (`PENDING`, `GSI1PK = TRASH`).
  3. **Cognito `ListUsers`** on request paths. Its rate limit is low and applies to the whole account.
  4. **Unbounded synchronous / single-run jobs** (daily purge, `DELETE /trash`, thumbnail bursts).
- A 100 GB quota is only viable as a **paid tier**. The free quota should stay small.

## 2. S3: one bucket is fine

**An S3 bucket has no capacity limit**: any total size, any number of objects. "First 50 TB / month" is only the first S3 **pricing tier**.

| Limit | Value | Impact |
|---|---|---|
| Bucket size / object count | Unlimited | None |
| Single object | 5 TB | None (uploads capped at 50 MB) |
| Request rate | ~3,500 PUT/s and 5,500 GET/s **per prefix**; S3 splits its partitions as traffic grows | Fine: keys start with `users/{sub}/` and `sub` is random, so load spreads across many prefixes. Sudden bursts can return `503 SlowDown`; the SDK retries |
| Buckets per account | 10,000 (default) | None |

**Decision: keep one photo bucket per environment.** Splitting adds routing (user → bucket) and more policies, CORS settings and CloudFront origins, without any capacity gain.

Valid reasons to split later:

- Data residency or latency (e.g. an EU bucket).
- Different replication or lifecycle rules.
- A smaller blast radius when a policy or lifecycle rule is misconfigured.

If needed, add a bucket choice in the `packages/shared` key helpers.

At billions of objects, bucket listing becomes impractical. Use S3 Inventory for audits and S3 Batch Operations for bulk changes, and drive jobs from DynamoDB (as the purge already does).

## 3. Changes to implement

Ordered by priority. 🔴 = do before / at launch (hard to change later), 🟠 = needed as traffic grows, 🟢 = optimisation.

### 3.1 DynamoDB hot keys and expensive reads

DynamoDB limits a single partition to about 1,000 WCU/s (writes), and a throttled GSI also throttles writes to the base table.

| # | Prio | Change | Why |
|---|---|---|---|
| D1 | 🔴 | **Shard the pending marker:** `PK = PENDING#{hash(photoId) % 32}` instead of `PENDING`; the stale-pending sweep (`lib/pending.ts`, 6.11) queries all shards | Every upload in the app writes to the single `PENDING` partition. *(2026-11-01: 6.11 shipped to dev with the single `PENDING` key; prod has no data yet, so sharding before the prod launch is still cheap.)* |
| D2 | 🔴 | **Trash index key by date:** `GSI1PK = TRASH#{purgeDate}` (YYYY-MM-DD) instead of `TRASH`; the purge queries the days that have come due | Every trashed photo in the app lands on one GSI partition |
| D3 | 🟠 | **Sparse per-user indexes** for `listTrashed` (e.g. `TRASH#{userId}`) and the map's `listLocated` (e.g. `LOCATED#{userId}`) | Both currently read the user's whole photo partition and filter afterwards. At 100 GB that is ~30–50k items per request |
| D4 | 🟠 | Retries with backoff for `TransactionConflict` on the per-user `Usage` item; limit parallel uploads per client | Bulk imports run many transactions on one item (API reserve + thumbnail Lambda count). *✅ Retries done (13.4, 2026-11-01: every transaction, up to 8 tries with jittered backoff; thumbnail Lambda too); uploads per client stay at 3 (13.1i may raise it adaptively)* |
| D5 | 🟢 | Switch from on-demand to provisioned capacity + auto scaling (+ reserved capacity) once traffic is steady | Cost |

### 3.2 Cognito

| # | Prio | Change | Why |
|---|---|---|---|
| C1 | 🔴 | Copy `email`/`name` into the `PROFILE` item with a **post-confirmation trigger** (next to the pre-sign-up trigger in `services/auth-triggers`); `GET /me` reads it from DynamoDB | `GET /me` calls `ListUsers` (`apps/api/src/lib/users.ts`), which is limited to a few tens of RPS for the whole account |
| C2 | 🔴 | **`EMAIL#{email}` lookup item** (userId, verified flag) for sharing by email | Removes the second `ListUsers` call from request paths. Keep the current rules: only verified, enabled users count |
| C3 | 🟠 | Keep the profile copy in sync when the email changes (Cognito trigger or periodic reconcile) | Correctness |

### 3.3 Background jobs instead of single runs

| # | Prio | Change | Why |
|---|---|---|---|
| J1 | 🔴 | **Fan out the daily purge:** the scheduled Lambda only lists what's due (trash by `TRASH#{date}`, pending shards) and sends batches to SQS; worker Lambdas delete them in parallel | `purge.handler` does every user's work in one run with a 15-minute ceiling |
| J2 | 🟠 | **`DELETE /trash` (`emptyTrash`) as a background job:** 202 Accepted + SQS worker; the UI polls the trash | API Gateway gives up after 30 s; a trash with thousands of photos times out. *Partly done (2026-11-01): `DELETE /trash` now works for up to 5 s per request and returns `{deleted, remaining}`; the web repeats it until empty, so no timeout. A background job is still the option for very large trashes* |
| J3 | 🟠 | Same pattern for account deletion and the Google Photos import (13.5) | Unbounded work per user |
| J4 | 🟠 | **Thumbnails via SQS:** S3 event → SQS → thumbnail Lambda with *maximum concurrency* and batches (replaces S3 → Lambda async + DLQ on-failure destination) | Smooths import bursts, protects DynamoDB / `Usage`, gives cleaner retries |

### 3.4 Storage cost

| # | Prio | Change | Why |
|---|---|---|---|
| S1 | ✅ | Originals in `INTELLIGENT_TIERING` (already the case). **Do not** enable the Deep Archive tiers | Originals are rarely read (the gallery uses thumbs/previews), so after ~90 days they move to Archive Instant Access (~$0.004/GB). Deep Archive would need a restore that takes hours before a download |
| S2 | 🟠 | **Thumbnails/previews as WebP or AVIF** instead of JPEG (thumbnail Lambda) | They cost ~$23k/month at 1M users; −30–50 % size |
| S3 | 🟢 | Previews in Intelligent-Tiering as well (or regenerate on demand) | Previews of old photos are rarely viewed |
| S4 | 🟢 | **Skip duplicate files:** content hash per user (e.g. `HASH#{sha256}` item); skip re-uploads of the same file | Google Photos imports produce many duplicates; −5–15 % of storage |
| S5 | 🟢 | Downloads of originals through CloudFront (signed URLs) instead of pre-signed S3 GET | CloudFront's price per GB is lower at volume |

### 3.5 Product / business

| # | Prio | Change | Why |
|---|---|---|---|
| B1 | 🔴 | **Paid plans:** small free quota (5–15 GB), 100 GB as a paid tier. A billing webhook (e.g. Stripe) writes the existing `Usage.quotaBytes` override | A user at the full 100 GB costs ~$0.40–$2.10/month for storage alone (more in the first ~90 days); everyone at 100 GB would be ~$800k/month at 1M users |
| B2 | 🟢 | Commit to spend for discounts: Compute Savings Plans, DynamoDB reserved capacity, S3/CloudFront private pricing | ~10–30 % at petabyte scale |

### 3.6 Platform

| # | Prio | Change | Why |
|---|---|---|---|
| P1 | 🔴 | Raise service quotas in prod: Lambda concurrent executions (default 1,000), API Gateway RPS (default 10k), Cognito API rates | Account-level ceilings |
| P2 | 🔴 | Load test a mass import in dev; CloudWatch alarms on DynamoDB throttling, Lambda throttles, DLQ depth, S3 5xx | Find limits before users do |
| P3 | 🟢 | Global uploads: S3 Transfer Acceleration or regional upload buckets | Uploads all go to us-east-1 (viewing is already served by CloudFront) |
| P4 | 🟢 | Cross-region backup copy of originals (Glacier Instant Retrieval in the target region) | Protects against losing a region or a buggy release; ~+$40k/month at 10 PB. Business decision |
| P5 | 🟢 | Videos: multipart upload, transcoding pipeline | A 100 GB tier attracts video; the current flow is a single 50 MB POST |

**Suggested order:** D1, D2 (cheap now, painful later) → C1, C2, J1 → B1 → J2–J4, D3, P1, P2 → the rest.

## 4. Cost model (1M users)

### Assumptions

| | Value |
|---|---|
| Registered users | 1M; 500k monthly active |
| Average stored per user | 10 GB (most users far below 100 GB) |
| Average photo size | 3 MB, so ~3.3B photos in total |
| New uploads | ~100 photos per user per month = 100M photos/month (~300 TB) |
| Viewing per active user per month | ~2,000 thumbs + 200 previews ≈ 120 MB, so ~60 TB/month through CloudFront |
| Downloads of originals | ~5 TB/month |
| Derived images | ~30 KB thumb + ~300 KB preview per photo |

### Monthly cost when that much has accumulated (~10 PB stored)

| Item | Calculation | ≈ per month |
|---|---|---|
| S3 originals (Intelligent-Tiering) | ~90 % in Archive Instant Access at $0.004/GB, the rest at $0.0125–$0.021 | $53k |
| Intelligent-Tiering monitoring fee | 3.3B objects × $0.0025 per 1,000 | $8k |
| S3 thumbs + previews (Standard) | ~1.1 PB × $0.021 | $23k |
| S3 requests | ~300M PUTs (original, thumb, preview) + GETs | $1.5k |
| CloudFront | ~60 TB of traffic + ~1.1B requests | $6k |
| Downloads of originals | 5 TB × $0.09 | $0.5k |
| Thumbnail Lambda (arm64) | 100M runs × ~1.5 s × 1.5 GB | $3k |
| API Gateway + API Lambda | ~500M requests | $1k |
| DynamoDB (on-demand) | Writes + reads + ~5 TB of items and indexes | $3k |
| Cognito | 500k monthly active users (Lite $0.0055 to Essentials $0.015 per user) | $3–8k |
| CloudWatch, SQS, purge jobs | | $2–3k |
| **Total** | | **≈ $105–110k/month (~$1.3M/year)** |

That is about **$0.10 per registered user per month**. Storage is ~80 % of the bill; compute and database together are under 10 %. The changes in §3 add well under $100/month. They are about reliability, not cost.

### How the cost changes

- **It grows over time.** On day one you pay only for traffic. Storage builds up as people upload: at 300 TB of new uploads per month, the bill grows by roughly $3k each month.
- **Linear in users.** 10k users ≈ $1k/month; 100k ≈ $10k/month (at the same assumptions).
- **Ceiling:** if every user filled 100 GB, storage would be 100 PB ≈ $800k/month. Hence B1.
- **Optional extras:**
  - Cross-region backup copy of originals ≈ +$40k/month plus transfer costs.
  - AWS Business Support ≈ $7k/month at this size.

### Biggest savings

1. Smaller derived images: WebP/AVIF (S2), previews in Intelligent-Tiering (S3): −$7–12k/month.
2. Skipping duplicate files (S4): −5–15 % of storage.
3. A small free quota with paid upgrades (B1).
4. Commitments and private pricing (B2).

## 5. Servers instead of serverless?

**Decision: stay serverless.** Move individual parts to containers or instances only where the numbers prove it.

### Why not switch

- **The money isn't in compute.** In the §4 model, the parts servers would replace (API Gateway, the API Lambda and the thumbnail Lambda) come to about **$4–5k of ~$105k/month**. Storage (~80 %) costs the same either way. Even if compute became half as expensive, the saving would be about 2 %.
- **Operations cost:** patching, autoscaling, health checks, load balancers, deploys, and capacity planning for import spikes. For a small team this is the largest hidden cost.
- **A fixed minimum bill:** a load balancer plus at least two instances across availability zones runs about $50–100/month even with zero users. Serverless is close to $0 when idle.
- **The same limits as before:** the DynamoDB shared keys, Cognito's lookup limit, S3 costs and the long-running jobs (§3) are architecture problems. Servers fix none of them.

### When servers or containers do win

| Case | Why | Fit for this app |
|---|---|---|
| Very high, steady request volume (thousands per second around the clock) | Lambda's per-request price becomes more expensive than instances you keep busy | API ≈ $1k/month at 1M users: not yet |
| Heavy, steady CPU work | Spot instances are 60–90 % cheaper | Thumbnails at ~40 photos/s steady: ~$2k/month saving possible |
| Jobs over 15 min, video transcoding, very large imports | Lambda's time and memory limits | Relevant with videos (P5) |
| Persistent connections (WebSockets), in-memory caches | Lambda keeps no state between requests | Not needed |

### How to keep the option open

1. **API:** keep it on Lambda. Hono also runs as an ordinary Node server, so moving it to containers (ECS Fargate, arm64) later is a small change if traffic ever justifies it.
2. **Thumbnails / video:** the most likely candidate. With SQS in front (J4), whatever reads the queue can be Lambda or containers on Spot instances (ECS/Fargate Spot) without changing anything else.
3. **Lambda Managed Instances:** Lambdas running on EC2 capacity in your account at EC2 prices, with Savings Plans. Most of the server savings without rewriting code or running servers yourself. Check the current feature details and pricing before adopting it.

**When to look again:** compute (Lambda + API Gateway) grows past ~15–20 % of the monthly bill, or video support is added.
