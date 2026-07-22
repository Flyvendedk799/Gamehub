#!/usr/bin/env bash
# One-shot bootstrap for a fresh Linux VPS (one.com, Hetzner, Oracle, anything
# with root + Docker support).
#
#   git clone https://github.com/Flyvendedk799/Gamehub.git
#   cd Gamehub && bash deploy/bootstrap.sh
#
# Idempotent: safe to re-run. An existing deploy/.env is never overwritten.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/deploy/.env"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$1"; }

# ── 1. Firewall ───────────────────────────────────────────────────────────────
# Most VPS providers ship a wide-open host firewall; Oracle Cloud is the notable
# exception, shipping iptables rules that DROP everything except SSH. Only touch
# rules when something is actually blocking, so this stays safe everywhere.
say "Checking host firewall for ports 80/443"
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
	sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443/tcp >/dev/null
	echo "  ufw active — opened 80/443"
elif command -v iptables >/dev/null 2>&1 && sudo iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT DROP|-j (DROP|REJECT)'; then
	for port in 80 443; do
		if sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
			echo "  port $port already allowed"
		else
			sudo iptables -I INPUT 1 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
			echo "  port $port opened"
		fi
	done
	if command -v netfilter-persistent >/dev/null 2>&1; then
		sudo netfilter-persistent save >/dev/null
		echo "  rules persisted across reboot"
	else
		warn "netfilter-persistent missing — these rules will not survive a reboot."
	fi
else
	echo "  no restrictive host firewall detected — nothing to do"
fi
warn "If your provider has a firewall in ITS control panel (Oracle security lists,"
warn "Hetzner Cloud Firewall, one.com panel), open 80 + 443 there too."

# ── 2. Docker ─────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
	say "Docker already installed ($(docker --version))"
else
	say "Installing Docker"
	curl -fsSL https://get.docker.com | sudo sh
	sudo usermod -aG docker "$USER"
	warn "Added $USER to the docker group — log out and back in to use docker"
	warn "without sudo. This script uses sudo, so no need to right now."
fi

# ── 3. Configuration ──────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
	say "Using existing deploy/.env (delete it to reconfigure)"
else
	say "Creating deploy/.env"

	# Size the global concurrency ceiling to available RAM. Each parallel run
	# costs roughly 1.5 GB once its Chromium playtest spins up, and the base
	# stack (Postgres, Redis, API, web, Caddy) needs ~2 GB before any of that.
	RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 4)
	if [ "$RAM_GB" -lt 6 ]; then
		WORKERS=1; BROWSERS=1
	elif [ "$RAM_GB" -lt 10 ]; then
		WORKERS=2; BROWSERS=2
	elif [ "$RAM_GB" -lt 20 ]; then
		WORKERS=4; BROWSERS=3
	else
		WORKERS=8; BROWSERS=6
	fi
	echo "  detected ${RAM_GB} GB RAM -> WORKER_CONCURRENCY=$WORKERS, BROWSER_WORKER_CONCURRENCY=$BROWSERS"

	read -rp "  Domain (e.g. playerzero.online): " DOMAIN
	read -rp "  Email for Let's Encrypt notices: " ACME_EMAIL
	echo "  Provider API key. Users can also bring their own key in Settings;"
	echo "  this one funds platform-credit runs and is required for the API to boot."
	read -rsp "  PLATFORM_API_KEY: " PLATFORM_API_KEY
	echo

	[ -n "$DOMAIN" ] || { echo "Domain is required." >&2; exit 1; }
	[ -n "$PLATFORM_API_KEY" ] || { echo "PLATFORM_API_KEY is required." >&2; exit 1; }

	# Secrets are generated here, on the box — never transported.
	umask 077
	cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL

POSTGRES_PASSWORD=$(openssl rand -hex 32)
# Never change this after launch — stored BYOK keys become undecryptable.
API_KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)

PLATFORM_API_KEY=$PLATFORM_API_KEY
PLATFORM_PROVIDER=anthropic
PLATFORM_MODEL_ID=claude-sonnet-4-6

# Per-user cap (API). Not a global limit.
MAX_CONCURRENT_RUNS=1
# Global ceiling — everything above this queues in Redis.
WORKER_CONCURRENCY=$WORKERS
BROWSER_WORKER_CONCURRENCY=$BROWSERS
# Hard token ceiling per run. Empty = unlimited. Set it before going public.
MAX_RUN_TOKENS=

# MockCreditProvider grants credits for FREE and signup is ungated. Leave false
# on a public URL until real payments exist, or anyone who registers can spend
# your provider budget.
CREDIT_PURCHASE_ENABLED=false
EOF
	echo "  wrote $ENV_FILE (mode 600, secrets generated locally)"
fi

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"

# ── 4. DNS preflight ──────────────────────────────────────────────────────────
# Caddy requests a certificate the moment it starts. If DNS isn't pointing here
# yet that fails, and repeated failures hit Let's Encrypt rate limits — so check
# rather than discovering it in the logs.
say "Checking DNS for $DOMAIN"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')"
echo "  this server : ${PUBLIC_IP:-unknown}"
echo "  $DOMAIN resolves to: ${RESOLVED:-nothing}"
if [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
	warn "DNS does not point at this server yet."
	warn "Create an A record: $DOMAIN -> $PUBLIC_IP  (Cloudflare: grey cloud / DNS-only)"
	read -rp "  Continue anyway? TLS will fail until DNS resolves. [y/N] " go
	[ "$go" = "y" ] || [ "$go" = "Y" ] || { echo "Stopped. Re-run once DNS is set."; exit 0; }
fi

# ── 5. Launch ─────────────────────────────────────────────────────────────────
say "Building and starting the stack (first build takes 5-10 minutes)"
cd "$REPO_ROOT/deploy"
sudo docker compose up -d --build

say "Done"
sudo docker compose ps
cat <<EOF

Watch the API come up (migrations run on startup):
  cd $REPO_ROOT/deploy && sudo docker compose logs -f api

Watch generation jobs being consumed:
  cd $REPO_ROOT/deploy && sudo docker compose logs -f worker browser-worker

Then open: https://$DOMAIN
EOF
