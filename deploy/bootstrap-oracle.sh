#!/usr/bin/env bash
# One-shot bootstrap for a fresh Oracle Cloud Ubuntu VM.
#
#   git clone https://github.com/Flyvendedk799/Gamehub.git
#   cd Gamehub && bash deploy/bootstrap-oracle.sh
#
# Idempotent: safe to re-run. Existing deploy/.env is never overwritten.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/deploy/.env"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$1"; }

if [ "$(id -u)" -eq 0 ]; then
	warn "Running as root. The compose stack will be owned by root; that works, but"
	warn "running as the default 'ubuntu' user is tidier."
fi

# ── 1. Firewall ───────────────────────────────────────────────────────────────
# Oracle's Ubuntu images ship iptables rules that DROP everything except SSH.
# This is the single most common reason Caddy's TLS challenge fails on OCI.
# Note this only covers the *instance*; you must ALSO add ingress rules for
# 80/443 to the VCN security list in the OCI console. Both layers are required.
say "Opening ports 80 and 443 on the instance firewall"
for port in 80 443; do
	if sudo iptables -C INPUT -m state --state NEW -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
		echo "  port $port already allowed"
	else
		sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
		echo "  port $port opened"
	fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
	sudo netfilter-persistent save >/dev/null
	echo "  rules persisted across reboot"
else
	warn "netfilter-persistent not found — rules will not survive a reboot."
fi
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
	sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi

# ── 2. Docker ─────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
	say "Docker already installed ($(docker --version))"
else
	say "Installing Docker"
	curl -fsSL https://get.docker.com | sudo sh
	sudo usermod -aG docker "$USER"
	warn "Added $USER to the docker group — log out and back in to use docker"
	warn "without sudo. This script uses sudo, so no need to do it right now."
fi

# ── 3. Configuration ──────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
	say "Using existing deploy/.env (delete it to reconfigure)"
else
	say "Creating deploy/.env"
	read -rp "  Domain (e.g. playerzero.online): " DOMAIN
	read -rp "  Email for Let's Encrypt notices: " ACME_EMAIL
	read -rsp "  Anthropic API key (PLATFORM_API_KEY): " PLATFORM_API_KEY
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

MAX_CONCURRENT_RUNS=1
MAX_RUN_TOKENS=

# MockCreditProvider grants credits for FREE and signup is ungated. Leave this
# false on a public URL until a real payment provider is wired in, or anyone who
# registers can spend your provider budget.
CREDIT_PURCHASE_ENABLED=false
EOF
	echo "  wrote $ENV_FILE (mode 600, secrets generated locally)"
fi

# shellcheck disable=SC1090
DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"

# ── 4. DNS preflight ──────────────────────────────────────────────────────────
# Caddy requests a certificate the moment it starts. If DNS isn't pointing here
# yet, that fails and Let's Encrypt rate-limits repeated attempts — so check
# first rather than discovering it in the logs.
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

Then open: https://$DOMAIN
EOF
