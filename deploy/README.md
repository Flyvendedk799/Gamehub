# Deploying Gamehub

Single-VM deployment: **Postgres (pgvector) + API + Next.js web + Caddy**, all on
one host, behind automatic HTTPS.

Target is an **Oracle Cloud Always Free** Ampere VM (4 OCPU / 24 GB RAM / 200 GB
disk) — genuinely free indefinitely, and the only free tier that satisfies what
this app actually needs. Nothing here is Oracle-specific though; any Docker host
works.

## Why not Vercel

Vercel is a great host for the Next.js shell but **cannot run this API**:

| What the API does | Why serverless breaks it |
| --- | --- |
| Generation runs for minutes, fire-and-forget after the HTTP response | The function is frozen/killed once the response is sent |
| Streams build events over SSE | Hobby response limits cut long-lived streams |
| Stores every generated game via `LocalFsBlobStore` | No persistent filesystem — games vanish between invocations |
| Runs Playwright Chromium in-process for playtest + repair gates | Doesn't fit serverless size/runtime limits |

`packages/storage` is local-filesystem only today (an S3/R2 driver is a stated
TODO behind the same `BlobStore` interface), so **persistent disk is a hard
requirement** until that lands. That rules out Render's free tier too, which has
no persistent disk, sleeps after 15 min idle, caps at 512 MB RAM, and deletes
free Postgres after 30 days.

## Architecture

```
                    ┌───────── Caddy :443 (auto-TLS) ─────────┐
   browser ────────►│  /v1/*  ──► api:3191   (Fastify, SSE)   │
                    │  /*     ──► web:3004   (Next.js)        │
                    └─────────────────────────────────────────┘
                                    │              │
                            db:5432 (pgvector)   blob-data volume
```

Both the app and the API are served from **one origin**, so there is no CORS and
no mixed-content problem. Caddy routes `/v1/*` straight to Fastify rather than
through the Next.js rewrite, which keeps SSE unbuffered and preserves the
trailing slashes the game preview routes depend on.

Redis is intentionally omitted — with `REDIS_URL` unset the API runs generation
in-process with an in-memory event bus. That is a supported, fully functional
mode, not a degraded one. See [Scaling out](#scaling-out).

## 1. Create the VM

In the OCI console: **Compute → Instances → Create instance**

- **Image:** Canonical Ubuntu 24.04
- **Shape:** `VM.Standard.A1.Flex` (Ampere/ARM), **4 OCPUs, 24 GB RAM** — the
  entire Always Free ARM allowance in one instance
- **Boot volume:** 200 GB
- Save the SSH public key

> If you get **"Out of host capacity"**, that's the well-known free-tier ARM
> contention. Retry later, or try another availability domain/region. It is not
> a problem with your account.

The ARM architecture is fine here — the compose stack pulls multi-arch images and
lets Playwright fetch its own arm64 Chromium build.

## 2. Open the ports (both layers)

Oracle blocks inbound traffic in **two** places. Miss either and Caddy's TLS
challenge fails with no obvious cause.

**a. VCN security list** — Networking → VCN → Subnet → Security List → add
ingress rules, source `0.0.0.0/0`, TCP ports **80** and **443**.

**b. The instance firewall** — Oracle's Ubuntu images ship iptables rules that
drop everything except SSH:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Point DNS at it

Create an **A record** for your domain → the instance's public IP. Verify before
continuing, because Caddy requests the certificate on first boot:

```bash
dig +short gamehub.example.com
```

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

## 5. Configure and launch

```bash
git clone https://github.com/Flyvendedk799/Gamehub.git
cd Gamehub
bash deploy/bootstrap-oracle.sh
```

`bootstrap-oracle.sh` does steps 2 and 4 for you (firewall + Docker), generates
every secret locally on the box, prompts only for the domain, an ACME email and
your provider key, checks DNS actually points here before Caddy requests a
certificate, and brings the stack up. It is idempotent — re-running it never
overwrites an existing `deploy/.env`.

Prefer to do it by hand:

```bash
cd Gamehub/deploy
cp .env.example .env
openssl rand -hex 32   # run once per secret in .env
nano .env              # fill DOMAIN, ACME_EMAIL, secrets, PLATFORM_API_KEY
docker compose up -d --build
```

First build takes roughly 5–10 minutes (full workspace install plus a Chromium
download). Migrations apply automatically on API startup.

```bash
docker compose logs -f api     # watch migrations + boot
docker compose ps              # all services healthy?
```

Then open `https://<your domain>`.

## 6. Before you make it public

Every generation is a multi-turn agent loop (build → playtest → repair), so each
one is real provider spend. Two defaults matter:

1. **`CREDIT_PURCHASE_ENABLED=true`** uses `MockCreditProvider`, which the source
   itself marks *"NEVER use in production — no money changes hands."* It confirms
   any purchase instantly and grants the credits free — so anyone who registers
   can mint **unlimited** credits against your key. `bootstrap-oracle.sh` writes
   `false` for this reason.
2. **Signup is open** — this build has no invite gate, and registration grants
   `FREE_TIER_CREDITS = 100`. At `CREDITS_PER_RUN = 10` that is **10 free
   generations per email address**, on your key, even with purchases disabled.

Disabling purchases does *not* break signup: the welcome grant is committed
atomically with the user row, so new accounts can still generate.

The effective cost ceiling is **`MAX_RUN_TOKENS`** — set it. Without it, a single
runaway build has no token limit. `MAX_CONCURRENT_RUNS` (default 1) bounds how
much can run at once.

Also worth knowing: generated games are served from the **same origin** as the
app. `next.config.mjs` flags per-project origin isolation (`*.games.<brand>`) as
a follow-up before heavy public use — the public play iframes are sandboxed
without `allow-same-origin`, but that isolation work is still outstanding.

## Operating it

```bash
docker compose logs -f api          # tail the API
docker compose restart api          # restart one service
docker compose up -d --build        # redeploy after `git pull`
docker compose down                 # stop (volumes survive)
```

**Back up these two volumes — they are your data:**

```bash
# Postgres
docker compose exec db pg_dump -U playforge playforge | gzip > backup-$(date +%F).sql.gz

# Generated games (content-addressed blobs)
docker run --rm -v gamehub_blob-data:/data -v "$PWD":/out alpine \
  tar czf /out/blobs-$(date +%F).tar.gz -C /data .
```

## Scaling out

When one box isn't enough, add Redis and split generation into dedicated
workers — the code already supports this and switches on `REDIS_URL` alone:

1. Add a `redis:7-alpine` service.
2. Set `REDIS_URL=redis://redis:6379` on the API. It will then publish events
   over `RedisEventBus` and enqueue jobs to BullMQ instead of running in-process.
3. Add `services/worker` (generation) and `services/browser-worker` (Playwright
   pool) as their own services using `Dockerfile.api` with the command
   overridden to `pnpm --filter @playforge/worker start` and
   `pnpm --filter @playforge/browser-worker start`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Caddy loops on the TLS challenge | DNS not propagated, or port 80/443 blocked at one of the two firewall layers (step 2) |
| API restarts repeatedly | Missing required env var — `docker compose logs api` names it |
| Login works, then requests 401 | `NEXT_PUBLIC_API_URL` was baked with the wrong origin; rebuild with `--build` after fixing `DOMAIN` |
| Games generate but previews are blank | Chromium failed to start — check `docker compose logs api` for Playwright errors |
| Build events arrive all at once | Something is buffering SSE; confirm requests hit Caddy's `/v1/*` handler and not the Next rewrite |
