# Cultural X-Ray backend: architecture

This document is the map. Read the first two sections before changing anything; read the rest when you touch that part. The aim is that nobody needs to understand the whole system to work safely on one piece of it.

---

## 1. The rules that keep this simple

1. **Two processes, one codebase.** `api` answers HTTP. `worker` runs background jobs. They never call each other; they talk through RabbitMQ.
2. **Slow or fallible work goes on a queue.** If it calls a third party (SES, Qloo, a video model) or can take more than a second, the API publishes a job and returns. Email, website reads, Culture Map builds and ad checks work this way. **One exception:** onboarding's search-as-you-type lookups call Qloo inside the request, because a person is waiting on each keystroke. They are cached, time-limited and rate-limited instead (section 13).
3. **Every job is safe to run twice.** RabbitMQ delivers *at least once*. Handlers must be idempotent: check before you write, use upserts, key side effects by the job id.
4. **Nothing fails silently.** A job either succeeds, is retried after a delay, or lands in the dead-letter queue with the reason attached. There is no fourth path.
5. **A business owns its workspace; an agency is a connection to it.** Data a brand produces hangs off its workspace (`workspaceId`), never off an agency. See `prisma/schema.prisma` and `../design/data-model.html`.
6. **Dependencies point one way** (section 3). If you need to break a rule there, the design is wrong; ask before working around it.
7. **Secrets live in the environment, never in code, logs or git.** Production uses IAM roles, not static keys (section 9).

---

## 2. The system at a glance

```
            browser
               │  (via the web app's /api proxy; same-site cookies)
               ▼
   ┌────────────────────────┐      publish (confirmed)      ┌──────────────┐
   │  api   :4000           │ ─────────────────────────────▶│  RabbitMQ    │
   │  Express + Better Auth │      falls back to Redis      │  exchanges,  │
   │  /api/auth/*  /api/v1  │      outbox if broker is down │  queues, DLQ │
   └───────────┬────────────┘                               └──────┬───────┘
               │                                                   │ consume
               │ sessions, rate limits, outbox                     ▼
               ▼                                         ┌────────────────────┐
           ┌───────┐        ┌──────────────┐             │ worker  :4001      │
           │ Redis │◀──────▶│ Postgres     │◀────────────│ handlers: email,   │
           └───────┘        │ (Neon)       │             │ diagnostics, …     │
                            └──────────────┘             └─────────┬──────────┘
                                                                   │
                                                                   ▼
                                                            AWS SES, Qloo, …

   Prometheus scrapes api, worker, RabbitMQ and Redis → Grafana dashboard + alert rules
```

| Process | Entry | Does | Never does |
|---|---|---|---|
| api | `src/server.ts` | HTTP, auth, validation, reads, publishing jobs, outbox replay | Long work, calls to slow third parties inside a request |
| worker | `src/worker.ts` | Consumes queues, runs handlers, samples queue depth, outbox replay | Serve user traffic (it exposes only `/health` and `/metrics`) |

Both connect to Postgres, Redis and RabbitMQ at start and refuse to boot if Postgres or Redis are unreachable.

---

## 3. Layers and who may import whom

```
src/
  config/          env.ts                    validated settings; the only reader of process.env (except the AWS SDK, section 9)
  observability/   logger, metrics           no imports from anywhere else in src/
  infra/           database, redis, rabbitmq clients and connection lifecycle only
  messaging/       topology, publisher, outbox, consumer, dead-letters, index (wiring)
  modules/<name>/  one feature each: routes, queue handlers, services, templates
  http/            app.ts (wiring), errors, middleware, rate limits
  runtime/         startup and graceful shutdown
  server.ts        api entry
  worker.ts        worker entry
```

Allowed direction of imports (left may import right, never the reverse):

```
server.ts / worker.ts → http, runtime → modules → messaging → infra → config, observability
```

- `infra/` knows nothing about features. It exposes clients and health checks.
- `messaging/` knows nothing about features either, except `messaging/index.ts`, which is the one place that maps queues to handlers.
- `modules/` may use `infra`, `messaging`, `config`, `observability`. A module may use another module only through that module's exported functions (for example `enqueueEmail`), never its internals.
- `http/app.ts` only mounts routers. Business logic does not live in `http/`.
- Generated code (`src/generated/prisma`) is never edited.

---

## 4. Request flow (api)

1. `requestId` gives every request an `X-Request-Id` (logged with errors).
2. `httpMetrics` records duration by **matched route** only, so arbitrary URLs cannot explode metric labels.
3. `helmet`, `cors` (origins from `WEB_ORIGINS`, credentials allowed).
4. `/health` (liveness, no dependencies) and `/ready` (Postgres, Redis, RabbitMQ).
5. `/metrics` behind `METRICS_TOKEN`.
6. `/api/auth/*` is handed to Better Auth **before** the JSON body parser (it reads the raw body itself).
7. `express.json` (1 MB), then `/api/v1/*` behind the Redis rate limiter (300/min per IP, fails open if Redis is down).
8. `notFound`, then `errorHandler`: `HttpError` → its status, `ZodError` → 400 with issues, anything else → 500 with a reference code (`ERR-XXXXXXXX`) that is logged with the stack.

Route handlers validate input with zod, call a service or Prisma, and return JSON. They publish jobs instead of doing slow work.

---

## 5. Jobs: how messaging works

### 5.1 Topology (`src/messaging/topology.ts`)

| Exchange (topic) | Queue | Routing | Prefetch | Attempts | Retry delay | Consumer today |
|---|---|---|---|---|---|---|
| `xray.email` | `xray.email.send` | `email.#` | 10 | 5 | 15 s | yes |
| `xray.jobs` | `xray.map.build` | `map.build` | 2 | 3 | 30 s | yes (Culture Map builds, section 14) |
| `xray.jobs` | `xray.ad.check` | `ad.check` | 1 | 3 | 60 s | yes (ad checks, section 16) |
| `xray.jobs` | `xray.site.read` | `site.read` | 4 | 2 | 2 s | yes (Firecrawl website reads, section 13) |
| `xray.system` | `xray.system.diagnostics` | `system.#` | 5 | 2 | 0.5 s | yes |
| `xray.dlx` (direct) | `xray.dead_letters` | one binding per source queue | — | — | — | inspected by ops endpoints |

Every work queue has a twin `<queue>.retry` with a message TTL equal to its retry delay. It has no consumer; when the TTL expires, RabbitMQ moves the message back to the work queue. That is how retries wait instead of hammering a failing dependency.

Declaring topology is idempotent. If you change a queue's arguments, `assertTopology` redeclares it **only if it is empty**; if it still holds messages it refuses to start, so a deploy can never drop work.

### 5.2 Publishing (`src/messaging/publisher.ts`)

`publish(exchange, type, payload)` wraps the payload in an envelope `{ id, type, payload, createdAt, attempt }` and returns only when the message is durable:

1. Published on a confirm channel and **confirmed by RabbitMQ** → `durable: "broker"`.
2. Not confirmed (broker down or slow) → parked in the **Redis outbox** → `durable: "outbox"`. A drain loop in both processes replays parked messages every 5 s once the broker is back. In-flight entries survive a crash (`LMOVE` to an in-flight list).
3. Both unavailable → `ok: false`. The caller decides what to tell the user.

### 5.3 Consuming (`src/messaging/consumer.ts`)

For each delivery:

```
parse JSON ─✗→ dead letter: malformed_json
find handler by envelope.type ─✗→ dead letter: no_handler
validate payload with the handler's zod schema ─✗→ dead letter: invalid_payload
run handler
  ├─ returns Outcome.Processed / Skipped → ack
  ├─ throws PermanentError → dead letter: permanent_error (no retry)
  ├─ throws, attempt < maxAttempts → copy to <queue>.retry with attempt+1, confirm, then ack
  └─ throws, attempt = maxAttempts → dead letter: max_attempts
```

Every dead letter carries headers: source queue, reason, error message and name, attempt, failed-at, message type. If publishing the dead letter or the retry is not confirmed, the original delivery is **requeued**, so the failure path itself can never lose a message. Each consumer has its own channel so one queue's prefetch cannot starve another.

### 5.4 Adding a new job type (checklist)

1. Add the queue to `QUEUES` in `topology.ts` (prefetch, attempts, delay) or reuse an exchange.
2. In `src/modules/<feature>/<feature>.queue.ts`: a zod schema, a `Handler` (`schema` + `handle`), an exported `enqueueX()` producer, and a `HandlerMap`.
3. Make the handler idempotent. Throw `PermanentError` for failures retrying cannot fix.
4. Register `[QUEUES.x, xHandlers]` in `CONSUMERS` in `messaging/index.ts`.
5. Add a test in `tests/` (happy path plus one failure).
6. If it matters operationally, add an alert in `devops/prometheus/alerts.yml`.

Map builds (section 14) and ad checks (section 16) follow this pattern.

---

## 6. Data and migrations

- Schema: `prisma/schema.prisma` (no comments in the file by convention). Visual map with every relationship: `../design/data-model.html`.
- Client: generated to `src/generated/prisma` (`pnpm prisma generate`; `pnpm build` does it too).
- Postgres is a **shared Neon database**. This app uses the `public` schema; other projects use `recs` and `storefront`. Never run `prisma migrate reset` or anything that drops schemas.
- Migration workflow:
  1. Edit `schema.prisma`.
  2. `pnpm prisma migrate dev --name <change> --create-only` and **read the SQL**. Additive changes are routine; any `DROP` or type change needs a plan.
  3. `pnpm db:deploy` to apply. `pnpm prisma migrate status` to confirm.
- The web app no longer owns the schema. It will talk to this backend instead of the database once auth moves.

---

## 7. Authentication and tenancy

- **Better Auth** (`src/modules/auth/auth.ts`), mounted at `/api/auth/*`.
  - Email and password plus Google. **No session until the email is confirmed**: sign-up sends a 24-hour confirmation link, and the link signs you in and lands on its `callbackURL` (onboarding, an invite or a claim). Signing in unconfirmed resends the link.
  - Password reset links last one hour and sign out every other session.
  - Sessions are stored in Postgres and cached in Redis (`session-store.ts`). If Redis fails, reads fall back to Postgres and sign-in keeps working.
  - Auth rate limits use Redis counters (sign-in 10/min, sign-up 5/min, password reset 5 per 5 min).
- **Organizations**: agencies and brand workspaces are both `organization` rows with `kind = AGENCY | WORKSPACE`. Members and invitations come from the plugin.
  - Roles (`roles.ts`, mirrored in `web/src/lib/roles.ts`): `owner`, `admin`, `strategist`, `viewer`. People are invited as admin, strategist or viewer; ownership moves only by transfer.
  - Hooks enforce: a valid kind, workspace URLs that never shadow app routes (`orgs/slugs.ts`), a connect code for every workspace (`orgs/connect-code.ts`), and no deleting an agency while a client workspace still waits for its owner.
  - Join by domain: an owner or admin can let anyone with a confirmed address at **their own** company domain join as Viewer. Public mailbox domains (gmail.com and similar) are refused.
- **Connections** (`modules/connections`): the only bridge between an agency and a brand.
  - *Created in trust*: an agency sets up a workspace for a client (`POST /orgs/:id/clients`). The workspace's `custodianId` is the agency, the connection is ACTIVE, and a `workspace_claim` (token hashed, 14 days) is emailed to the client owner.
  - *Claimed*: the owner signs in with that exact, confirmed address and claims (`POST /claims/:token/accept`), choosing the agency's access. They become `owner`; custody ends.
  - *Connected by code*: an agency enters a workspace's code (`POST /orgs/:id/connections`) → REQUESTED; the brand's owners and admins are emailed and approve or decline, and can lower the access first.
  - Either side can end it (`POST /connections/:id/end`). The workspace and everything in it always stays with the brand; an unclaimed workspace stays claimable.
  - Every change writes an `audit_event` (`orgs/audit.ts`). Non-members get 404, never 403, so ids and slugs don't leak.
- `BETTER_AUTH_URL` is the **web app's** origin, because browsers reach auth through the web app's `/api` proxy. Cookies stay first-party and the Google OAuth redirect URI is unchanged.
- Protected routes use `requireAuth` and read the session with `sessionOf(req)`.
- **One account per browser, never switched silently:**
  - A confirmation link opened while *another* account is signed in doesn't sign anyone in. The `before` hook in `auth.ts` sends it to the web's `/switch-account`, which offers "Log out and continue as <link's address>" or "Stay". Better Auth would otherwise replace the session cookie without a word.
  - The web sends `x-xray-user` (the user a page was rendered for) with every `/api/v1` call. `requireAuth` answers `409 SESSION_CHANGED` if the session now belongs to someone else, so a stale tab can't act as the wrong person. Its `SessionGuard` also checks on focus and asks for a reload.
  - Claims and invitations are locked to their address on the server: wrong or unconfirmed email is a 403 (`CLAIM_WRONG_ACCOUNT`, `EMAIL_NOT_VERIFIED`; Better Auth checks the invitation's recipient). The web locks the email field on sign-up and log-in that come from an invite or claim, and offers "Log out and switch account" on a mismatch.

| Endpoint | What it's for |
|---|---|
| `GET /api/v1/me`, `PUT /api/v1/me/preferences` | The user, memberships, appearance preferences (saved to the profile) |
| `GET /api/v1/slugs/:slug` | Is a workspace URL free, and why not |
| `GET /api/v1/orgs/:slug`, `PATCH /api/v1/orgs/:id/profile` | Org context for members; markets, join-by-domain |
| `GET /api/v1/me/joinable`, `POST /api/v1/orgs/:id/join` | Teams matching your confirmed email domain |
| `GET /api/v1/invitations/:id/preview` | Public invite summary for the invite page |
| `GET/POST /api/v1/orgs/:id/clients`, `POST /api/v1/orgs/:id/connections`, `GET /api/v1/orgs/:id/agencies` | Agency clients and brand agencies |
| `POST /api/v1/connections/:id/decide`, `PATCH …/access`, `POST …/end` | The brand's decisions; ending from either side |
| `GET /api/v1/claims/:token`, `POST …/accept`, `POST …/decline` | Claiming a workspace held in trust |
| `POST /api/v1/orgs/:id/connect-code` | A new workspace code (the old one stops working) |
| `POST /api/v1/me/feedback` | "Report an issue"; logged with a reference until a support tool takes it |

**Errors:** `HttpError` carries a stable `code`. 4xx messages are written for people and the web shows them as written; Better Auth hook errors use `XRAY_*` codes for the same reason. 5xx responses carry only a reference.

---

## 8. Email

- Producer: `enqueueEmail(job)` in `modules/email/email.queue.ts`. Templates and their zod schemas live in `email.templates.ts`; all user values are HTML-escaped.
- Templates: `verify-email` (copy changes with where the link lands), `reset-password`, `organization-invite` (role and what it can do), `workspace-claim`, `connection-request`, `connection-ended`, `plain`.
- Design: one layout for all of them. A wordmark bar, a photo band (Unsplash, hotlinked at 1120×360; security emails have none), an ember eyebrow, a detail card, a table-cell pill button with a fallback link, a security note, dark-mode overrides, and a plain-text twin. Addresses are rendered as styled `mailto:` links so mail apps don't paint them blue.
- Review a template in a real inbox: `POST /api/v1/ops/email/test` with `{ "to": "...", "template": "workspace-claim" }` sends it with sample data (`email.samples.ts`).
- Transport: `EMAIL_PROVIDER=ses` sends through Amazon SES (us-east-1) from `EMAIL_FROM` (display name "Cultural X-Ray"); `log` writes the email to the log instead (use it when you don't want real mail).
- SES errors that retrying cannot fix (`MessageRejected`, unverified sender, suspended account) become `PermanentError` → dead letter. Throttling and network errors are retried. Notification emails after a change are best-effort: a queue failure is logged, and never undoes the change.
- Addresses on reserved test domains (`.test`, `.example`, `.invalid`, `.localhost`, `example.com/net/org`) are skipped, never sent, to protect sender reputation.
- Read-only health check: `pnpm ses:verify` (sender verified, DKIM, quota, credential source).

---

## 9. Security and secrets

- **Where secrets live:** `backend/.env` locally (mode 600, gitignored), generated by `pnpm env:init`. Production injects them from a secret manager; nothing is baked into images.
- **AWS credentials:**
  - Locally, the app uses the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `backend/.env`. These **always** win over ambient machine credentials (for example a global `AWS_PROFILE`).
  - In production, leave them unset; the SDK's default chain uses the task or instance IAM role.
  - This app has its own IAM user, `cultural-xray-ses`, under path `/apps/cultural-xray/` in account 746050096605. Its single inline policy `cultural-xray-ses-send` allows `ses:SendEmail` / `ses:SendRawEmail` only as `*@platform.learnitpal.com` through that identity and its configuration set, plus read-only `ses:GetAccount` and `ses:GetEmailIdentity`. It shares nothing with other applications' IAM users. When this app gets its own sending domain, update that policy's resources and condition.
- **Third-party keys:** `QLOO_API_KEY` (with `QLOO_BASE`) and `FIRECRAWL_API_KEY` live only in `backend/.env`; the web never sees them. Empty keys switch lookups off with a person-facing message.
- **Internal endpoints:** `/metrics` needs `METRICS_TOKEN`; `/api/v1/ops/*` needs `OPS_TOKEN`. Both are compared in constant time.
- **Logs:** pino redacts passwords, tokens, secrets, cookies and authorization headers.
- **Network:** every container port binds to `127.0.0.1` only. Redis requires a password; RabbitMQ uses a dedicated user and vhost (`xray`).
- **Limits:** request bodies 1 MB, API rate limits, server timeouts (headers 10 s, request 60 s).

---

## 10. Observability and operations

| What | Where |
|---|---|
| Grafana dashboard "Xray backend" | http://localhost:3005 (admin / `GRAFANA_ADMIN_PASSWORD`) |
| Prometheus, alerts, targets | http://localhost:9095 (`/alerts`, `/targets`) |
| RabbitMQ management | http://localhost:15682 (`xray` / `RABBITMQ_PASSWORD`) |
| App metrics | api `:4000/metrics`, worker `:4001/metrics` (bearer `METRICS_TOKEN`) |
| Queue depths | `GET /api/v1/ops/queues` (bearer `OPS_TOKEN`) |

Key metrics are prefixed `xray_` (HTTP, publish outcomes, consume outcomes, retries, dead letters, outbox depth, handler duration, email outcomes, dependency up). RabbitMQ and Redis export their own.

Alert rules (`devops/prometheus/alerts.yml`): `DeadLettersWaiting`, `DeadLetterSpike`, `OutboxBacklog`, `QueueBacklog`, `QueueHasNoConsumers`, `TargetDown`, `DependencyUnreachable`, `HighErrorRate`, `RabbitMQMemoryAlarm`. They show in Prometheus and Grafana; no pager is wired yet.

### Runbook

- **Dead letters waiting:** `GET /api/v1/ops/dead-letters` shows reason and error per message. Fix the cause, then `POST /api/v1/ops/dead-letters/replay` with `{ "sourceQueue": "xray.email.send" }` to send them back with a fresh attempt count.
- **Outbox backlog:** RabbitMQ is refusing publishes. Check `pnpm stack status` and the broker; the drain loop replays automatically once it recovers.
- **Queue has no consumers:** the worker is down. Start it (`pnpm dev:worker`, or the `app` profile).
- **End-to-end check:** `POST /api/v1/ops/diagnostics/echo` publishes a job; the worker leaves a receipt in Redis.

---

## 11. Local development

```bash
pnpm env:init        # once: writes backend/.env with fresh service credentials
pnpm dev             # starts Redis, RabbitMQ, monitoring; waits until healthy; runs api + worker with reload
pnpm stack status    # containers; also: pnpm stack logs <service>, pnpm stack down, pnpm stack urls
pnpm stack up app    # runs api and worker as containers (production-like)
pnpm test            # integration tests against the running containers and the database
pnpm check           # typecheck
pnpm lookup:smoke    # onboarding lookups against live Qloo, through the cache
pnpm map:smoke <slug> [--rebuild]   # build a workspace's Culture Map through the real queue and print it
# Ask X-Ray: ASK_PRACTICE=true streams scripted answers through the real tools at no cost;
# ASK_MODEL / ASK_MAX_TOKENS / ASK_DAILY_LIMIT bound what a live key can spend.
```

Host ports: api 4000, worker 4001, Redis 6390, RabbitMQ 5682 / 15682, Prometheus 9095, Grafana 3005. They avoid the defaults so other local stacks can run alongside.

---

## 12. Decisions and open questions

| Decision | Why |
|---|---|
| Separate api and worker processes | Long jobs (ad checks) must not slow or crash request handling; they scale independently |
| RabbitMQ with confirms plus a Redis outbox | A 202 means the job is durable, even during a broker outage |
| Delayed retries through TTL queues | Failing dependencies get breathing room; attempts are not burned in a second |
| Zod schema per handler, `PermanentError` | Bad data goes straight to dead letters instead of being retried pointlessly |
| Agencies and workspaces are both organizations | Reuses Better Auth's members and invitations; the connection table is the only bridge |
| App-specific AWS keys locally, IAM role in production | No static keys in production; no accidental use of another app's identity |
| The brand always owns its workspace; agencies connect | A client can leave an agency without losing anything; access is the brand's to grant |
| Agency-created workspaces are held in trust, then claimed | Agencies can start work before the client signs up, without ever owning the client's data |
| Confirm email before any session | Invites, claims and join-by-domain all trust the address, so it must be proven first |
| Search-as-you-type calls Qloo in the request | A person waits on each keystroke; a queue would add seconds. Two-level cache, single flight and timeouts keep it cheap and bounded |
| Website reads go on a queue | Firecrawl takes 5–20 s; the web polls a job instead of holding a request open |
| Map builds on RabbitMQ, not a second job system (Inngest was considered) | The worker already has retries, dead letters and the outbox. Resuming a build comes from saving each category as it finishes, not from a workflow engine, so there's one less container (~80 MB image) to run and secure |
| Ask X-Ray streams from the API, not a queue | A person is reading each word as it arrives; the answer is short (capped tokens, at most 5 steps) and the request is cancelled when they leave. Rule 2's other exception |
| A practice model, not mocks in tests only | With little model credit, the whole chat (tools, pictures, saving, UI) must be testable for free. Practice mode runs the real tools and writes from their output |
| Owners never see Qloo scores | Affinities bunch near 1 and lean percentages read as precision we don't have. The API returns labels and a 0–1 lean; the web turns them into words ("Only yours", "Shared with X · leans your way") |
| Only resolved Qloo ids are saved | A map built on a name Qloo doesn't know would silently drop that brand |

Done:
- The web app's auth and session reads moved here. The web proxies `/api/auth/*` and `/api/v1/*` (except `/api/v1/ops/*`) to this backend and holds no database or auth secrets.

Open:
- This app's own sending domain (today it sends as `platform.learnitpal.com`), and hosting email images on it instead of Unsplash.
- Per-client access for agency members (`member_client_access`): the tables exist and the clients list honours them, but there's no UI to narrow a member to some clients yet.
- Billing, Qloo usage metering (the sidebar meter), briefs, plays beyond the overview's three, the Culture Map page and ad checks: the web shows sample data for these. The overview and the build screen are live.
- Agencies can't read or build a client's map yet: map routes check direct membership only. Reuse the connection access rules when the agency client views go live.
- Deleting a user straight from the database leaves their sessions alive in Redis (Better Auth's secondary storage) until they expire. Delete users through Better Auth, or revoke their sessions first.
- Connection writes make several sequential round trips to Neon (about 7 s from Nairobi). Batch them or move the database closer before launch.
- Alert delivery (Alertmanager, Slack or email) and production deployment target.
- Onboarding lookups don't count against a workspace's Qloo quota yet; decide before metering lands.
- The agency "add client" flow still takes a name only; it should reuse the brand search.

---

## 13. Lookups: finding brands, shops and rivals (`src/modules/lookup`)

Onboarding asks Qloo who a business is, what category it's in and who it competes with, instead of using hard-coded lists. Evidence for every rule below: `../research-onboarding-lookup.md` and `../test/onboarding-lookup/`.

### 13.1 Files

| File | Does |
|---|---|
| `cache.ts` | The two-level cache (13.3) and its TTLs |
| `qloo.client.ts` | `qloo(path, params, ttl)`: a cached GET with the API key, a 12 s timeout and up to 3 tries on 429/5xx. Failures become a person-facing 502 |
| `qloo.shape.ts` | Reading records: name matching, categories, markets, cards. Pure functions, unit-tested in `tests/lookup.test.ts` |
| `lookup.service.ts` | Searches, suggestions, categories, big brands; remembers shown entities as `QlooEntity` rows |
| `site.ts` | Website reads through Firecrawl, as a queued job |
| `lookup.routes.ts` | The endpoints (13.2) and `POST /orgs/:id/brand-setup` |

### 13.2 Endpoints (all need a session; rate limit 150 per person per minute, failing open without Redis)

| Endpoint | Returns |
|---|---|
| `GET /api/v1/lookup/brands?q=` | Up to 6 brand cards (exact match first): name, categories, markets, description, logo |
| `GET /api/v1/lookup/localities?q=&market=GB\|US` | Towns in that country. The query is sent as "Brighton, United Kingdom", because a bare "Brighton" ranks five US and Australian towns first |
| `GET /api/v1/lookup/places?q=&lat=&lon=` | Up to 6 shops, cafés or restaurants within 15 miles: address, genres, rating |
| `GET /api/v1/lookup/entities/:id/suggestions?kind=brand\|place&market=` | `{ categories, rivals[], seeds[] }`, each suggestion `ok`, `other_market` or `not_found` |
| `GET /api/v1/lookup/categories?q=` | Up to 4 product categories for plain words (`/v2/tags` with `feature.semantic_search=true`; without it Qloo returns nothing) |
| `GET /api/v1/lookup/category-brands?tag=&market=` | Best-known brands in a category that sell in the market; falls back to any market when fewer than 3, and says which (`scope`) |
| `POST /api/v1/lookup/site { url }` → `GET /api/v1/lookup/site/:jobId` | A website read: `pending`, then `done` with name, what it sells, product types, where based, or `failed` with a message |
| `POST /api/v1/orgs/:id/brand-setup` | Saves onboarding's picks into `organization.metadata` (intent version 2), `markets` and `brandEntityId`. Managers only. Every Qloo id must resolve (fetched and stored if a background write hasn't landed). With `complete: true`, a brand Qloo doesn't know needs at least one read-through brand |

### 13.3 Cache strategy

Every Qloo and Firecrawl answer goes through `cached(path, params, ttl, load)`:

1. **Key:** `lk:v1:` plus the SHA-256 of the path and the params sorted by name, so parameter order never splits the cache.
2. **Redis first.** A hit returns in about a millisecond.
3. **Postgres next** (`qloo_cache` table: key, path, params, response, `expiresAt`). A hit that hasn't expired refills Redis for its remaining lifetime, so answers survive Redis restarts and are shared by api and worker.
4. **Then the source.** The answer is written to both levels. Only successful answers are stored; **empty results are stored too**, because "not found" is an answer and the same typo shouldn't cost a call twice. Errors are never cached.
5. **Single flight.** Identical calls in flight in the same process share one promise, so a burst of keystrokes or two tabs make one Qloo call.
6. **Failures don't block.** If Redis is down, reads and writes skip it; if a Postgres write fails, it's logged and the answer is still returned.

| What | TTL | Why |
|---|---|---|
| Brand search (`/search`, brands) | 7 days | Brand records change slowly |
| Place search | 3 days | Opening hours and closures change faster |
| Localities | 90 days | Towns don't move |
| Entity records (`/entities`) | 14 days | Read again when suggestions are built |
| Insights (suggestions, big brands, nearby places) | 7 days | Taste data moves slowly |
| Category matching (`/v2/tags`) | 30 days | Qloo's tag list is stable |
| Website reads (Firecrawl, keyed by domain) | 30 days | One read per brand per month; credits are paid |

**Stored entities.** Every brand or place shown to a person is also upserted as a `QlooEntity` (name, kind, logo, the card and its tags), in the background and at most every 6 hours per id per process. Neon writes are slow from far away, so lookups never wait on them. Saving a pick checks those rows and fetches any missing record from the cache, so saving rarely calls Qloo.

Measured: a full onboarding run (searches, suggestions, towns, shops, categories, big brands) took 36 s cold and **1.2 s** warm (`pnpm lookup:smoke`).

To clear the cache for one call, delete its `qloo_cache` row and Redis key (`lk:v1:*`); there's no admin endpoint yet.

### 13.4 Rules for suggestions (from the lookup lab)

- **Matching a name:** ignore case, accents and punctuation; then akas; then a prefix match of 4+ characters ("Dunkin'" → "Dunkin' Donuts").
- **A rival must share a category** (product category, or a non-generic industry) with the brand it came from. Otherwise it's `not_found`: "Oppo Brothers" resolves to OPPO, a phone maker.
- **Market:** a brand that lists markets but not the workspace's is `other_market` (set aside, still selectable). Vague markets ("Global", "International", "Europe") and no markets at all are never set aside.
- **Never the brand itself** (Allbirds lists itself as a competitor).
- **Shops:** rivals are taste-closest places of the same main genre within 5 km (`signal.interests.entities` plus `filter.location` POINT and radius), same main business first; read-through brands are the brands the shop's customers like, filtered to the market. Branches of the same shop are excluded.
- **Categories:** `product_category`, else `industry` (restaurants and some big brands have no product category).

### 13.5 Website reads (`site.ts`)

- `normaliseSite` accepts only public http(s) hostnames: no IPs, `localhost`, `.local` or `.internal`.
- `POST /lookup/site` answers from cache when it can; otherwise it stores a `pending` job in Redis (`site:job:<id>`, 1 hour) and publishes `site.read`.
- The worker calls Firecrawl `/v1/scrape` with a JSON schema, caches the result per domain, and marks the job `done`.
- DNS failures and blocked sites are permanent; a second failure of anything else gives up. Either way the job is marked `failed` with "We couldn't open that website…", and the handler acks rather than dead-lettering, because the person has already moved on.

---

## 14. Culture Map builds (`src/modules/maps`)

A map reads what a brand's customers listen to, watch, follow and visit, from Qloo, and splits it against up to three rivals into **yours / contested / theirs**. The build runs in the worker; the web only reads progress, so leaving the page, closing the tab or losing the connection never stops it.

### 14.1 Files

| File | Does |
|---|---|
| `map.shape.ts` | Pure rules, no I/O: the 8 categories, the insights parameters, reading Qloo entities, the territory split, the one-line reading per category. Tested in `tests/maps.test.ts`. |
| `map.build.ts` | The `map.build` handler: resumable, one transaction per category, then marks the map ready, stores a `MAP_READY` notification and emails whoever started it. |
| `map.service.ts` | `startBuild` (creates, resumes or returns a map, then publishes) and `latestMap` (the shape the overview and build screen read). |
| `maps.routes.ts` | `POST /orgs/:id/maps` (owner, admin, strategist; 202), `GET /orgs/:id/maps/latest` and `GET /orgs/:id/maps/latest/audience` (any member). |

### 14.2 What a build does

1. **Sides.** Your side reads as your brand (when Qloo knows it) together with the brands your customers also buy, in one call (`signal.interests.entities=a,b,c`). Each rival is its own side. Brands added as new aren't in Qloo and are left out; onboarding says so.
2. **Per category, per side:** one `/v2/insights` call, `take=20`. Lists are localised with `signal.location.query=United Kingdom|United States`; without it a global rival reads as its home market (Häagen-Dazs came back Japanese in the lab). Destinations use `filter.geocode.country_code` instead. Calls go through the lookup cache (7 days) with a 60 s timeout, at most 6 in flight per worker.
3. **Split.** Only on your side → yours. On both → contested, credited to the rival that ranks it highest, with a lean from where it ranks on each side (affinities bunch at 0.95–0.99 and can't separate sides). Only a rival's → theirs.
4. **Save.** One transaction per category: entities, one evidence row per call, associations, territory items, the reading, the query count. Image links are checked first; Qloo answers some with a redirect to a placeholder, and those are dropped.
5. **Places on the globe.** The Places category also writes one `geo_signal` per side and place, with its rank and location, for the Audience & places globe.
6. **Who they are.** One call per age band and gender (8 calls) scores every brand on the map at once (`filter.results.entities`), with **no** location signal: with one, scores bunch near 1 and some brands vanish from the answer. Qloo's fill values for "no data" (0.554054 and 0.76) are masked, and 45+ scores between 0.55 and 0.66 are flagged as thin data (brand lab). Saved to `audience_index` in one transaction; a retry skips it once rows exist. Your side is your brand when Qloo knows it, otherwise the average of the brands your customers also buy.
7. **Finish.** All 8 readings and the audience in → `READY`, `builtAt`, `thinData` when fewer than 20 items are yours or shared.

Cost: 8 × (1 + rivals) + 8 calls, so 32 for two rivals. Measured: 44 s cold, about 20 s from cache (`pnpm map:smoke`), most of it Neon writes from far away.

### 14.3 Failure and retries

- A category that fails doesn't undo the others; the job is retried (3 attempts, 30 s apart) and skips categories that already have a reading.
- On the last attempt the map is marked `FAILED` and the message goes to dead letters. The build screen says how many categories are saved and offers **Try again**, which re-queues the same map and resumes.
- A Redis lock per map (15 min) stops a duplicate delivery building the same map twice at once.
- `startBuild` returns the running build for the same brands and market, resumes a failed one, keeps a ready one unless `rebuild` is asked for, and otherwise starts a new map. If neither broker nor outbox take the job, the map is marked `FAILED` and the API answers 503.

### 14.4 How the web uses it

- Home (`/[org]`) reads `maps/latest` on the server: building or failed → the build screen; ready → the overview; none → "Build my map".
- The build screen polls every 2 s and pauses while the tab is hidden.
- The overview's headline, four columns and three plays come only from map items. Every claim is in plain words; no affinity or percentage is shown.
- Audience & places (`/[org]/audience`) turns scores into words in `web/src/lib/audience.ts`: "Very strong" to "Weak", "thin data", "Not enough data", who leads each group compared with you, and places by rank ("Top pick for Jude's", "Not in Häagen-Dazs' top 20"). Scores only shade the cells and the globe. Maps built before the audience step offer a rebuild.

---

## 15. Ask X-Ray (`src/modules/ask`)

The assistant inside the product. It answers from the workspace's own Culture Map, in plain words, and can draw a ranking, a chart or a table in the conversation.

### 15.1 Files

| File | Does |
|---|---|
| `ask.routes.ts` | `POST /orgs/:id/ask` streams an answer (AI SDK UI message stream; the thread id comes back in `X-Ask-Thread`). `GET /ask/status`, `GET/DELETE /orgs/:id/ask/threads[/:threadId]`. |
| `ask.tools.ts` | `read_map` and `read_audience` give the model the map **in words** (holders, leans, positions, "strong"/"weak"; never scores). `show_ranking`, `show_chart`, `show_table` are pictures: the model's input is the picture, validated by zod, rendered by the web, each with a required `howToRead`. |
| `ask.prompt.ts` | Short instructions: tools first, plain words, no scores, at most one picture. |
| `ask.practice.ts` | Practice model (`ASK_PRACTICE=true`): costs nothing, still calls the real tools and draws from their output. |
| `ask.service.ts` | Threads and messages (`ask_thread`, `ask_message`; `metadata` holds model and token counts per answer). |

### 15.2 Rules

- **Only the new question is sent;** the server loads the history. Every saved message gets a server id (ids from the browser are never used as keys).
- **Spending is bounded:** `ASK_MODEL` (default `claude-sonnet-5-5`; dev uses `claude-haiku-5-5`), `ASK_MAX_TOKENS` per step, at most 5 steps, `ASK_DAILY_LIMIT` questions per person per day (Redis; practice is free). Token counts are saved on each answer.
- **Model access:** `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` for a compatible endpoint (it must include `/v1`). With neither, the API answers 503 and the web says the assistant isn't connected.
- **Errors in words:** out of credit, bad key, busy, wrong model and provider outages each get a plain message; the raw error is only logged.
- **Fast first words:** independent reads run together, a new chat loads no history, the question is saved while the answer streams, and ready maps' read-outs are cached in Redis for a day (`map:view:*`, `map:audience:*`). Measured: first words in about 1.7 s on a warm cache (practice); a live Haiku answer with a ranking took about 10 s and 10.4k input / 1k output tokens.

Open: agencies' Ask X-Ray (needs client map access); feedback sending (the web's form is built, Send says it isn't connected); thumbs up/down on answers.

## 16. Ad check (`src/modules/adcheck`, `src/modules/gemini`, `src/modules/usage`)

Someone uploads a draft ad; the worker reads what's seen and heard in it with Gemini on Vertex AI. Spec: `../spec-ad-check-recut.md`; plan and progress: `../plan-ad-check.md`. Placing it on the map, the verdict and the re-cuts come next (plan phases 2–4).

### 16.1 Files

| File | Does |
|---|---|
| `adcheck.routes.ts` | Endpoints below. Owners, admins and strategists create and delete; any member reads and plays. |
| `adcheck.service.ts` | Create (with an upload token), start, list, detail, delete video, delete check; the hourly sweep in the worker. |
| `storage.ts` | Vercel Blob: one-path client upload tokens, `head`, download, ranged streaming, delete. |
| `adcheck.video.ts` | ffmpeg: probe, normalise (H.264 + AAC, ≤720p, ~2 Mbps, ≤30 fps), scene cuts (`scene > 0.3`). |
| `adcheck.shape.ts` | Pure: zod schemas per Gemini pass, prompts, the people rule, practice answers, shot cleaning, answers → `ad_element` rows. |
| `adcheck.queue.ts` | The `ad.check` handler. |
| `gemini/gemini.client.ts` | Vertex `generateContent` with structured output; retries; refusals; practice and off. |
| `usage/pricing.ts`, `usage/ai-calls.ts` | Dated price table and `costMicros`; `recordCall` writes `ai_call`. |

### 16.2 Endpoints (all under `/api/v1`, need a session)

| Endpoint | Does |
|---|---|
| `POST /orgs/:id/ads` `{ fileName, sizeBytes, contentType }` | Creates the ad (`UPLOADING`); returns `{ adId, pathname, clientToken, access, maxSeconds }`. The browser uploads with `put(pathname, file, { access, token: clientToken })` from `@vercel/blob/client`. |
| `POST /orgs/:id/ads/:adId/start` `{ pathname?, rivals, placements }` | Checks the file arrived (`pathname` is what `put` returned; it must stay inside the path handed out), sets `QUEUED`, publishes `ad.check` (202). Retries a `FAILED` check. |
| `GET /orgs/:id/ads`, `GET /orgs/:id/ads/:adId` | List; one ad with status, `stage` (plain words), shots with descriptions, elements. |
| `GET /orgs/:id/ads/:adId/video` | Streams the video through the backend, honouring `Range` (206). 410 once deleted. |
| `DELETE /orgs/:id/ads/:adId/video` | Deletes the file from Blob; the reading stays (`hasVideo: false`). |
| `DELETE /orgs/:id/ads/:adId` | Deletes the file and everything read from it. |

### 16.3 What the worker does

Download → normalise → shots (saved) → three whole-ad passes on the **fast** model in parallel (context; on-screen text at high resolution; script, music and sounds) → one call per shot on the **smart** model, clipped with `videoMetadata`, at most 4 at once → elements saved → `READY`. Each shot's description is saved as it arrives, so a retry only repeats the cheap whole-ad passes. One Redis lock per ad; a second delivery is skipped.

| Failure | Result |
|---|---|
| Gemini refuses (403 policy, blocked prompt, safety stop) | `PolicyRefusal`, never retried: `FAILED`, "We couldn't read this ad.", logged for review |
| `GEMINI_PROVIDER=off`, no project or no credentials | `GeminiUnavailable`: `FAILED`, "Ad reading isn't set up yet." |
| Over `ADCHECK_MAX_SECONDS`, unreadable file, upload missing | `FAILED` with a plain reason, no retry |
| 429, 5xx, timeouts | Retried 3× in the client (2 s, 8 s, ~20 s or `Retry-After`), then by the queue; `FAILED` "Try again" after the last attempt |

### 16.4 Rules

- **The people rule is in every prompt that sees or hears people:** role and action only; never age, body, face, skin, ethnicity or looks; never identify anyone from their face. A test checks no prompt asks for any of it. (A per-shot request about children got the Vertex project blocked on 25 October 2026.)
- **Schemas:** one zod schema per pass is both the JSON schema sent to Gemini and the check on its answer. Fixed values are one-value enums (Vertex has no `const`); arrays stay at 40 or fewer.
- **Models per stage:** `GEMINI_MODEL_FAST` (Gemini 3.5 Flash-Lite) for the whole-ad passes, `GEMINI_MODEL_SMART` (Gemini 3.8 Flash) for shots. Flash-Lite hasn't been scored on the golden set yet (plan phase 2).
- **Every call is costed:** `ai_call` holds provider, model, stage, feature, person, workspace, ad, tokens in/out/thinking, cost in micro-dollars (from `pricing.ts`, dated rows, global region, thinking billed as output), duration and outcome. Refusals and errors are recorded too. Practice calls are recorded at cost 0. A failed write is logged and never fails the job.
- **Storage:** with `BLOB_ACCESS=private` (needs a private Blob store) only the backend can read files. On a public store, set `BLOB_ACCESS=public`: uploads get a random suffix so URLs can't be guessed, and playback still goes through the backend. Videos are deleted `ADCHECK_KEEP_DAYS` (14) after upload by the worker's hourly sweep; uploads never started are removed after a day.
- **Practice:** `GEMINI_PROVIDER=practice` returns scripted, schema-checked answers at no cost; the tests run the whole flow this way against real Blob storage.

