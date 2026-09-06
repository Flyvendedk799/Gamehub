#!/usr/bin/env node
/**
 * playforge-dev — CLI stub that prints how to stream a project run.
 *
 * Usage: pnpm exec tsx scripts/playforge-dev.ts <projectId>
 */

const projectId = process.argv[2] ?? '<projectId>';
const apiBase = process.env['PLAYFORGE_API_BASE'] ?? 'http://localhost:3001';

const help = `
playforge-dev — stream a Playforge cloud project

1. Authenticate (Clerk session cookie or Bearer token).
2. Enqueue a generation:
   curl -X POST ${apiBase}/v1/projects/${projectId}/generate \\
     -H "Authorization: Bearer $TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"prompt":"a juicy arcade shooter"}'

3. Stream SSE events:
   curl -N ${apiBase}/v1/runs/<runId>/stream \\
     -H "Authorization: Bearer $TOKEN"

4. MCP (local):
   PLAYFORGE_MCP_PROJECTS=${projectId} pnpm exec tsx packages/core/src/mcp-server.ts --list

5. Netplay relay (same-origin):
   ws://<game-host>/v1/rt?room=${projectId}
`.trim();

process.stdout.write(`${help}\n`);
