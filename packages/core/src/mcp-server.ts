/**
 * S13 — minimal MCP HTTP/stdio entry for Playforge cloud tools.
 *
 * Lists PLAYFORGE_MCP_TOOLS and asserts project access before any tool proxy.
 * This is a stub server suitable for Cursor / Claude Code MCP config — it does
 * not implement full JSON-RPC; use `playforge-dev` for stream guidance.
 */

import {
  PLAYFORGE_MCP_TOOLS,
  assertMcpProjectAccess,
  listMcpToolNames,
  type McpAuthContext,
} from './mcp-tools.js';

export interface McpServerOptions {
  auth: McpAuthContext;
  /** Optional HTTP listen port (default: no listen — stdio-style list only). */
  port?: number;
}

/** Print the MCP tool catalog to stdout (stdio mode). */
export function printMcpCatalog(auth: McpAuthContext): void {
  const payload = {
    name: 'playforge',
    tools: PLAYFORGE_MCP_TOOLS,
    toolNames: listMcpToolNames(),
    scopedProjects: [...auth.projectIds],
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Assert access then return the tool descriptor (proxy hook). */
export function resolveMcpTool(auth: McpAuthContext, projectId: string, toolName: string) {
  assertMcpProjectAccess(auth, projectId);
  const tool = PLAYFORGE_MCP_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Unknown MCP tool: ${toolName}`);
  return tool;
}

/** CLI entry when run as `node …/mcp-server.ts` or via tsx. */
export function main(argv: string[] = process.argv.slice(2)): void {
  const projectIds = new Set(
    (process.env['PLAYFORGE_MCP_PROJECTS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const userId = process.env['PLAYFORGE_MCP_USER'] ?? 'local-dev';
  const auth: McpAuthContext = { userId, projectIds };

  if (argv.includes('--list') || argv.length === 0) {
    printMcpCatalog(auth);
    return;
  }
  if (argv[0] === 'assert' && argv[1]) {
    assertMcpProjectAccess(auth, argv[1]);
    process.stdout.write(`ok: project ${argv[1]} in scope\n`);
    return;
  }
  process.stderr.write(
    'Usage: playforge-mcp [--list] | playforge-mcp assert <projectId>\n' +
      'Env: PLAYFORGE_MCP_USER, PLAYFORGE_MCP_PROJECTS (comma-separated)\n',
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mcp-server.ts')) {
  main();
}
