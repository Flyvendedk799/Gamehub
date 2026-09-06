/**
 * S13 — Cloud MCP server over existing Playforge agent tools.
 *
 * Cursor / Claude Code connect here instead of a desktop Godot process.
 * Auth is a project-scoped PAT; tools proxy to the API (generate, playtest,
 * scene ops, file read). No local engine binary.
 */

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool surface Summer advertises via MCP — we mirror the *useful* subset
 *  against our cloud API rather than a desktop scene tree. */
export const PLAYFORGE_MCP_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: 'playforge_generate',
    description: 'Enqueue a cloud generation run for a project from a natural-language brief.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['projectId', 'prompt'],
    },
  },
  {
    name: 'playforge_playtest',
    description: 'Run the browser-worker playtest against the project HEAD and return the verdict.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'playforge_scene_list',
    description: 'List nodes in the live EditorSession scene document.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'playforge_scene_set_field',
    description: 'Set a field on a scene node (transform, component prop).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string' },
        field: { type: 'string' },
        value: {},
      },
      required: ['projectId', 'nodeId', 'field', 'value'],
    },
  },
  {
    name: 'playforge_list_files',
    description: 'List files in the project working tree / latest snapshot.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
] as const;

export interface McpAuthContext {
  userId: string;
  projectIds: ReadonlySet<string>;
}

export function assertMcpProjectAccess(auth: McpAuthContext, projectId: string): void {
  if (!auth.projectIds.has(projectId)) {
    throw new Error(`MCP forbidden: project ${projectId} is not in the token scope`);
  }
}

export function listMcpToolNames(): string[] {
  return PLAYFORGE_MCP_TOOLS.map((t) => t.name);
}
