import { describe, expect, it } from 'vitest';
import { PLAYFORGE_MCP_TOOLS, assertMcpProjectAccess, listMcpToolNames } from './mcp-tools.js';

describe('S13 MCP tools', () => {
  it('lists cloud generate/playtest/scene tools', () => {
    const names = listMcpToolNames();
    expect(names).toContain('playforge_generate');
    expect(names).toContain('playforge_playtest');
    expect(PLAYFORGE_MCP_TOOLS.length).toBeGreaterThanOrEqual(4);
  });

  it('enforces project-scoped auth', () => {
    const auth = { userId: 'u1', projectIds: new Set(['p1']) };
    expect(() => assertMcpProjectAccess(auth, 'p1')).not.toThrow();
    expect(() => assertMcpProjectAccess(auth, 'p2')).toThrow(/forbidden|not in/i);
  });
});
