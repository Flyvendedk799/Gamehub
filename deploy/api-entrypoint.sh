#!/bin/sh
# Apply pending Drizzle migrations, then start the API.
#
# Migrating here (rather than as a separate compose service) guarantees the
# schema is current before Fastify binds, and keeps the compose graph free of
# the api <-> migrate ordering cycle. Safe because this deployment runs a single
# API replica; if you scale out, move this into a dedicated one-shot service.
set -e

echo "[entrypoint] applying database migrations…"
pnpm --filter @playforge/db db:migrate

echo "[entrypoint] starting API…"
exec pnpm --filter @playforge/api start
