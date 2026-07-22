# Deploying Gamehub

Single-VM deployment: **Postgres (pgvector) + Redis + API + generation worker +
browser worker + Next.js web + Caddy**, all on one host behind automatic HTTPS.

Runs on any Linux VPS with root and Docker — one.com, Hetzner, Oracle Cloud,
DigitalOcean. **16 GB RAM is comfortable**; 8 GB works; 4 GB is the floor.

## Why not Vercel

Vercel is a great host for the Next.js shell but **cannot run this API**:

| What the API does | Why serverless breaks it |
| --- | --- |
| Generation runs for minutes, fire-and-forget after the HTTP response | The function is frozen/killed once the response is sent |
| Streams build events over SSE | Hobby response limits cut long-lived streams |
| Stores every generated game via `LocalFsBlobStore` | No persistent filesystem — games vanish between invocations |
| Runs Playwright Chromium for playtest + repair gates | Doesn't fit serverless size/runtime limits |

`packages/storage` is local-filesystem only today (an S3/R2 driver is a stated
TODO behind the same `BlobStore` interface), so **persistent disk is a hard
requirement** until that lands. That also rules out Render's free tier, which has
no persistent disk, sleeps after 15 min idle, caps at 512 MB RAM, and deletes
free Postgres after 30 days.

## Architecture

```
                    ┌───────── Caddy :443 (auto-TLS) ─────────┐
   browser ────────►│  /v1/*  ──► api:3191   (Fastify, SSE)   │
                    │  /*     ──► web:3004   (Next.js)        │
                    └─────────────────────────────────────────┘
                             │                    │
                    db:5432 (pgvector)      redis:6379
                                                  │
                              ┌───────────────────┴───────────────────┐
                              │                                       │
                    worker (agent loop)              browser-worker (Chromium)
                              │
                        blob-data volume  ◄── shared with api
```

Both the app and the API are served from **one origin**, so there is no CORS and
no mixed-content problem. Caddy routes `/v1/*` straight to Fastify rather than
through the Next.js rewrite, which keeps SSE unbuffered and preserves the
trailing slashes the game preview routes depend on.

### Concurrency — read this before going public

`MAX_CONCURRENT_RUNS` is a **per-user** cap: the API calls `countActiveByUser`
and returns 429 only when *one user* has too many runs in flight. It is not a
global limit. Fifty users starting one build each is fifty concurrent builds.

The global ceiling is **`WORKER_CONCURRENCY`** on the `worker` service. Setting
`REDIS_URL` (which this stack always does) switches the API out of in-process
generation: it enqueues to BullMQ, `worker` consumes at most `WORKER_CONCURRENCY`
jobs at once, and everything else waits in Redis. That's what turns a traffic
burst into a queue instead of an OOM.

Budget roughly **1.5 GB per parallel run**, plus ~2 GB for the base stack:

| RAM | `WORKER_CONCURRENCY` | `BROWSER_WORKER_CONCURRENCY` |
| --- | --- | --- |
| 4 GB | 1 | 1 |
| 8 GB | 2 | 2 |
| 16 GB | 4 | 3 |
| 32 GB | 8 | 6 |

`bootstrap.sh` detects installed RAM and writes these for you.

## Deploy

```bash
git clone https://github.com/Flyvendedk799/Gamehub.git
cd Gamehub
bash deploy/bootstrap.sh
```

`bootstrap.sh` opens the host firewall if one is active, installs Docker,
generates every secret locally on the box, sizes concurrency to available RAM,
checks DNS actually points here before Caddy requests a certificate, and brings
the stack up. It is idempotent — re-running never overwrites `deploy/.env`.

Prefer to do it by hand:

```bash
cd Gamehub/deploy
cp .env.example .env
openssl rand -hex 32   # run once per secret in .env
nano .env              # fill DOMAIN, ACME_EMAIL, secrets, PLATFORM_API_KEY
docker compose up -d --build
```

First build takes 5–10 minutes (full workspace install plus a Chromium
download). Migrations apply automatically on API startup.

### Before you start: DNS and firewall

1. **A record** for your domain → the server's public IP. Verify with
   `dig +short yourdomain.com` *before* launching, because Caddy requests the
   certificate on first boot and repeated failures hit Let's Encrypt rate limits.
   Behind Cloudflare, use **grey cloud / DNS-only** — the orange-cloud proxy
   intercepts the HTTP-01 challenge and can buffer long-lived SSE streams.
2. **Ports 80 and 443** must be open in your provider's control-panel firewall
   (Oracle security lists, Hetzner Cloud Firewall, one.com panel). The script
   only handles the firewall running *inside* the machine.

### Oracle Cloud specifics

Oracle needs two extra things nobody else does, and both fail silently:

- Its Ubuntu images ship iptables rules that DROP everything except SSH.
  `bootstrap.sh` detects and fixes this.
- **VCN security list** — Networking → VCN → Subnet → Security List → add
  ingress for TCP 80 and 443 from `0.0.0.0/0`. The script cannot do this.

Use shape `VM.Standard.A1.Flex` at 4 OCPU / 24 GB (the whole Always Free ARM
allowance). ARM is fine — the images are multi-arch and Playwright fetches its
own arm64 Chromium. "Out of host capacity" is free-tier contention, not your
account; retry or switch availability domain.

## Before you make it public

Every generation is a multi-turn agent loop (build → playtest → repair), so each
one is real provider spend. Three things matter:

1. **`CREDIT_PURCHASE_ENABLED`** defaults to `false` here, deliberately. Setting
   it `true` activates `MockCreditProvider`, which the source itself marks
   *"NEVER use in production — no money changes hands."* It confirms any purchase
   instantly, so anyone who registers could mint **unlimited** credits.
2. **Signup is open** — no invite gate — and registration grants
   `FREE_TIER_CREDITS = 100`. At `CREDITS_PER_RUN = 10` that is **10 free
   generations per email address** on your key, even with purchases disabled.
3. **`MAX_RUN_TOKENS` is the only hard cost ceiling** and ships unset. Set it.

Disabling purchases does *not* break signup: the welcome grant is committed
atomically with the user row, so new accounts can still generate.

Users can supply their own provider key under **Settings → Build provider**
(encrypted at rest with `API_KEY_ENCRYPTION_SECRET`). Pushing BYOK is the
cheapest way to run this publicly. The two *subscription* options there are
**local-development only** — they harvest a CLI login from the machine running
the API (macOS keychain for Claude), so they can never work on a server.

Also worth knowing: generated games are served from the **same origin** as the
app. `next.config.mjs` flags per-project origin isolation (`*.games.<brand>`) as
a follow-up before heavy public use.

## Operating it

```bash
docker compose logs -f api                    # API + migrations
docker compose logs -f worker browser-worker  # generation pipeline
docker compose restart api                    # restart one service
docker compose up -d --build                  # redeploy after `git pull`
docker compose down                           # stop (volumes survive)
```

**Back up these two volumes — they are your data:**

```bash
# Postgres
docker compose exec db pg_dump -U playforge playforge | gzip > backup-$(date +%F).sql.gz

# Generated games (content-addressed blobs)
docker run --rm -v gamehub_blob-data:/data -v "$PWD":/out alpine \
  tar czf /out/blobs-$(date +%F).tar.gz -C /data .
```

To scale generation throughput, raise `WORKER_CONCURRENCY` (RAM permitting) or
run `docker compose up -d --scale worker=2`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Caddy loops on the TLS challenge | DNS not propagated, ports 80/443 blocked at the provider firewall, or Cloudflare proxy is on (use grey cloud) |
| API restarts repeatedly | Missing required env var — `docker compose logs api` names it |
| Builds queue but never start | `worker` is down or can't reach Redis — `docker compose logs worker` |
| Games generate but previews are blank | Chromium failing — `docker compose logs browser-worker` |
| Runs fail with an OpenAI error on an Anthropic key | `PLATFORM_PROVIDER`/`PLATFORM_MODEL_ID` unset on the **worker** — it defaults to `openai`/`o4-mini`, unlike the API |
| Login works, then requests 401 | `NEXT_PUBLIC_API_URL` baked with the wrong origin; fix `DOMAIN` and rebuild with `--build` |
| Build events arrive all at once | SSE buffering — confirm requests hit Caddy's `/v1/*` handler, not the Next rewrite |
