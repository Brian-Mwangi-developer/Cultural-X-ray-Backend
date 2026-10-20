# Cultural X-Ray backend: architecture

This document is the map. Read the first two sections before changing anything; read the rest when you touch that part. The aim is that nobody needs to understand the whole system to work safely on one piece of it.

---

## 1. The rules that keep this simple

1. **Two processes, one codebase.** `api` answers HTTP. `worker` runs background jobs. They never call each other; they talk through RabbitMQ.
2. **Slow or fallible work goes on a queue.** If it calls a third party (SES, Qloo, a video model) or can take more than a second, the API publishes a job and returns. Email already works this way; map builds and ad checks will too.
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
| `xray.jobs` | `xray.map.build` | `map.build` | 2 | 3 | 30 s | not yet (messages wait, never dropped) |
| `xray.jobs` | `xray.ad.check` | `ad.check` | 1 | 3 | 60 s | not yet |
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

Ad checks and map builds will follow exactly this pattern.

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
  - Email and password plus Google. Email verification and password resets are sent through the email queue.
  - Sessions are stored in Postgres and cached in Redis (`session-store.ts`). If Redis fails, reads fall back to Postgres and sign-in keeps working.
  - Auth rate limits use Redis counters (sign-in 10/min, sign-up 5/min, password reset 5 per 5 min).
- **Organization plugin**: agencies and workspaces are both `organization` rows with `kind = AGENCY | WORKSPACE`. Members and invitations come from the plugin. `connection` links an agency to a workspace at `VIEW | EDIT | MANAGE`.
- `BETTER_AUTH_URL` is the **web app's** origin, because browsers reach auth through the web app's `/api` proxy. Cookies stay first-party and the Google OAuth redirect URI is unchanged.
- Protected routes use `requireAuth` and read the session with `sessionOf(req)`. `GET /api/v1/me` returns the user and their memberships.

---

## 8. Email

- Producer: `enqueueEmail(job)` in `modules/email/email.queue.ts`. Templates and their zod schemas live in `email.templates.ts`; all user values are HTML-escaped.
- Transport: `EMAIL_PROVIDER=ses` sends through Amazon SES (us-east-1) from `EMAIL_FROM`; `log` writes the email to the log instead (use it when you don't want real mail).
- SES errors that retrying cannot fix (`MessageRejected`, unverified sender, suspended account) become `PermanentError` → dead letter. Throttling and network errors are retried.
- Addresses on reserved test domains (`.test`, `.example`, `.invalid`, `.localhost`, `example.com/net/org`) are skipped, never sent, to protect sender reputation.
- Read-only health check: `pnpm ses:verify` (sender verified, DKIM, quota, credential source).

---

## 9. Security and secrets

- **Where secrets live:** `backend/.env` locally (mode 600, gitignored), generated by `pnpm env:init`. Production injects them from a secret manager; nothing is baked into images.
- **AWS credentials:**
  - Locally, the app uses the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `backend/.env`. These **always** win over ambient machine credentials (for example a global `AWS_PROFILE`).
  - In production, leave them unset; the SDK's default chain uses the task or instance IAM role.
  - This app has its own IAM user, `cultural-xray-ses`, under path `/apps/cultural-xray/` in account 746050096605. Its single inline policy `cultural-xray-ses-send` allows `ses:SendEmail` / `ses:SendRawEmail` only as `*@platform.learnitpal.com` through that identity and its configuration set, plus read-only `ses:GetAccount` and `ses:GetEmailIdentity`. It shares nothing with other applications' IAM users. When this app gets its own sending domain, update that policy's resources and condition.
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

Open:
- Move the web app's auth and session reads to this backend (planned next, awaiting the go-ahead).
- This app's own sending domain (today it sends as `platform.learnitpal.com`).
- Alert delivery (Alertmanager, Slack or email) and production deployment target.
