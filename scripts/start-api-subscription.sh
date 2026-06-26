#!/usr/bin/env bash
# Start the Gamehub API with PLATFORM_API_KEY sourced from the Claude Code
# SUBSCRIPTION (the macOS keychain OAuth token), so generations triggered from the
# web UI bill the subscription instead of a metered API key — matching how we test.
#
# The token is read FRESH at each start, so it stays valid as Claude Code refreshes
# it in the keychain. NOTE: the API captures PLATFORM_API_KEY once at boot, and an
# sk-ant-oat access token expires after ~2h — so if UI generations start returning
# 401 after a long idle, just restart the service to pick up a refreshed token.
#
# If no subscription token is found, it falls back to the service's existing
# PLATFORM_API_KEY (the metered API key), so the API always starts.
set -euo pipefail

cred="$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || true)"
if [ -n "$cred" ]; then
  tok="$(printf '%s' "$cred" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).claudeAiOauth.accessToken;if(t&&t.includes("sk-ant-oat"))process.stdout.write(t)}catch(e){}})')"
  if [ -n "$tok" ]; then
    export PLATFORM_API_KEY="$tok"
    echo "[start-api] using Claude subscription token (sk-ant-oat…) as PLATFORM_API_KEY" >&2
  else
    echo "[start-api] no sk-ant-oat token in keychain; using existing PLATFORM_API_KEY" >&2
  fi
else
  echo "[start-api] no Claude Code keychain credential; using existing PLATFORM_API_KEY" >&2
fi

exec pnpm --filter @playforge/api start
