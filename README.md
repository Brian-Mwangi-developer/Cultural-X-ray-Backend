# Cultural X-Ray backend

Express API and RabbitMQ worker for Cultural X-Ray. How it's built, its rules, endpoints and runbook: **[Architecture.md](Architecture.md)** (read sections 1–2 before changing anything).

```bash
pnpm env:init   # once: writes .env with fresh service credentials
pnpm dev        # Redis, RabbitMQ, monitoring, then api (:4000) and worker (:4001)
pnpm test
```

### Ad check settings

| Name | What it does |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store for uploaded ads. Empty: ad checks answer "not set up yet". |
| `BLOB_ACCESS` | `private` (default; the store must be created as private) or `public` (uploads get an unguessable suffix). |
| `ADCHECK_MAX_SECONDS`, `ADCHECK_MAX_BYTES`, `ADCHECK_KEEP_DAYS` | 60 s, 1 GB, and how long videos are kept (14 days). |
| `GEMINI_PROVIDER` | `vertex`, `practice` (scripted answers, no cost) or `off`. |
| `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | The Vertex project; `global` is 10% cheaper than a named region. |
| `GOOGLE_VERTEX_API_KEY` | A key **bound to a service account** with the Vertex AI User role. Empty: Google application credentials (`gcloud auth application-default login` locally, the service account in production). |
| `GEMINI_MODEL_FAST`, `GEMINI_MODEL_SMART` | Whole-ad reading passes and per-shot descriptions. |

Every Gemini call is stored in `ai_call` with its cost; see Architecture.md section 16.

---

## Gemini on Vertex AI: pricing

*Prices checked on Google's Agent Platform (formerly Vertex AI) pricing page on 25 October 2026. Recheck before quoting a customer: Google changes them, and two changes are already announced below.*

The ad check uses Gemini on **Vertex AI** (Google now calls it "Gemini Enterprise Agent Platform"), billed to the Cloud billing account. That's what lets Google Cloud credits pay for it; Gemini through AI Studio is prepaid and only spends promotional credits once a paid balance exists.

### How you're charged

- **Per token**, input and output separately. Thinking ("reasoning") tokens count as output.
- **Only successful calls are billed.** Requests that return 4xx or 5xx cost nothing.
- **Region:** "global" is the list price; a named region costs 10% more. We use `global`.
- **Video and audio become input tokens.** At 1 frame a second: about **66 tokens a frame** at low or medium resolution, **about 264 a frame at high** (what we use to read on-screen text), plus **25 tokens a second of audio**. A 30-second ad is about 2,000 video tokens at low and 7,900 at high, plus 750 for its sound.
- **Clipping a video to one shot bills only that shot**, frames and audio both.

### Model prices (USD per 1M tokens, global region)

**Gemini 3.8 Flash** (what the ad check uses):

| Tier | Input (text, image, video, audio) | Cached input | Output | When to use |
|---|---|---|---|---|
| **Standard, until 31 Dec 2026** | **$0.75** | $0.075 | **$3.75** | Default: a person is waiting on the result |
| **Standard, from 1 Jan 2027** | **$1.50** | $0.15 | **$7.50** | Price the product on this, not the promotion |
| Priority, until 31 Dec 2026 | $1.35 | $0.135 | $6.75 | Guaranteed capacity at peak times |
| Priority, from 1 Jan 2027 | $2.70 | $0.27 | $13.50 | |
| Batch / Flex, until 31 Dec 2026 | $0.375 | $0.0375 | $1.875 | Results within hours: competitor scans, overnight re-checks |
| Batch / Flex, from 1 Jan 2027 | $0.75 | $0.075 | $3.75 | |

The lower 2026 price is a promotion ("50% credits back on net spend"), so **plan on the 2027 price.**

**Other models we might use for lighter jobs:**

| Model | Input | Output | Good for |
|---|---|---|---|
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | High-volume, simple tasks (tagging, short summaries) |
| Gemini 3.1 Flash-Lite | $0.25 (audio $0.50) | $1.50 | The cheapest option for text and video |
| Gemini 4 Argon, until 30 Nov 2026 | $2.00 | $10.00 | Not used: the flagship, priced for hard reasoning |
| Gemini 4 Argon, from 1 Dec 2026 | $4.00 | $20.00 | |

### What one ad check costs (measured)

Measured on 25 October 2026 with Gemini 3.8 Flash, thinking `LOW`, on 7 real 22–50 s ads. Each ad: a whole-ad context pass, a text pass at high resolution, an audio pass (script, speakers, music, sounds), then one call per shot.

| Ad | Shots | Calls | Tokens in / out | Today | From 1 Jan 2027 |
|---|---|---|---|---|---|
| Jude's (22 s) | 6 | 9 | 22,510 / 3,578 | $0.030 | $0.061 |
| Ben & Jerry's Cookie Cores (30 s) | 13 | 16 | 34,601 / 4,316 | $0.042 | $0.084 |
| Nike (30 s) | 14 | 17 | 34,553 / 4,329 | $0.042 | $0.084 |
| Häagen-Dazs, tortoise (30 s) | 15 | 18 | 35,465 / 5,220 | $0.046 | $0.092 |
| Häagen-Dazs, Super Bowl (30 s) | 20 | 22 | 41,377 / 5,649 | $0.052 | $0.104 |
| Ben & Jerry's Refugees (50 s) | 13 | 16 | 45,796 / 5,079 | $0.053 | $0.107 |

**Rule of thumb: about $0.05 an ad today, about $0.10 from January 2027** for a 30-second ad, and roughly double for a 60-second ad. A re-check after edits costs the same again; caching the context pass would cut that.

| Ads checked a month | Today | From Jan 2027 | From Jan 2027, batch |
|---|---|---|---|
| 100 | ~$5 | ~$10 | ~$5 |
| 1,000 | ~$50 | ~$100 | ~$50 |
| 10,000 | ~$500 | ~$1,000 | ~$500 |

Not included: Qloo, storage, email, hosting, or a fingerprinting service for the music-licensing flag (AudD lists about $5 per 1,000 requests; a 30 s ad is about 3 requests).

### Things that affect cost and reliability

- **Credits.** "My Billing Account" holds $70 of Google Developer Program credits (seven $10 credits, expiring Feb–Oct 2027), scoped to "All of Google Cloud Platform and Google Maps APIs", so they cover Vertex usage. That's about 700 ad checks at today's price, 350 at 2027's.
- **Shared capacity.** Standard calls sometimes return HTTP 429 ("Resource exhausted") at busy times. Retry with a backoff (15 s worked); Priority is the paid fix.
- **Acceptable use.** Never ask the model to describe a person's age, body, face or looks, and never a child's. A request like that on an ad with young children got the project blocked on 25 October 2026 pending an appeal. Prompts describe people only by role and action, and never identify anyone from their face.
- **Schema limits.** Vertex rejects some JSON Schema values with a bare HTTP 400: `maxItems: 60` failed, 40 or fewer worked.
- **Access.** Vertex doesn't accept a plain API key. Set up on 26 October 2026: service account `xray-vertex` with only **Vertex AI User**, and an API key bound to it and restricted to `aiplatform.googleapis.com`, in `GOOGLE_VERTEX_API_KEY`. The same key works in production; no Google sign-in.
- **Models enabled.** After the project was reinstated (26 October), only `gemini-3.8-flash` answers; 3.5 Flash-Lite and the other Flash models return 404 until enabled in Model Garden. `GEMINI_MODEL_FAST` is set to 3.8 Flash until then.
- **Schema complexity.** A list capped at 40 whose items carry ranged numbers (`minimum`/`maximum`) was rejected with a bare 400; number ranges are no longer sent (zod still checks the answer).
- **Silence.** On a silent ad Gemini invented a voice-over and music. The worker measures loudness first (ffmpeg `volumedetect`, peak below −50 dB is silence) and skips the audio pass.
- **Measured live (26 October):** a 24-second, 6-shot silent draft cost **$0.023** on 3.8 Flash for every pass (context, text, six shots, cues) and read in 91 s, most of it Qloo placement.
