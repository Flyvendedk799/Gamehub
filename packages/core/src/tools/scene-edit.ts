/**
 * Scene editing as tool calls.
 *
 * The agent used to change a game by rewriting source files. That works, and it
 * is invisible: the user sees a spinner, then a diff, and has no idea what
 * happened in between or why. Worse, it is one-way — there is no manual
 * equivalent of "rewrite main.js", so a person who wants to nudge one object has
 * to ask for it in English and hope.
 *
 * These tools change that by making every scene edit a discrete, named call
 * against the shared `EditorSession`. Three things follow:
 *
 *  1. **The UI can show it as it happens.** A tool call already streams as
 *     `tool_execution_start` → SSE → the client. Each result carries the change
 *     record and a scene summary, so the viewport can move the object while the
 *     agent is still talking rather than after it finishes.
 *  2. **A person can do the same things.** Identical commands, same session, same
 *     undo stack — because the manual editor calls `execute` too.
 *  3. **Mistakes come back as data.** A failed edit returns a code the model can
 *     branch on and a detail it can repair from, instead of a stack trace or,
 *     worse, a silently mangled file.
 *
 * `batch` exists because an agent placing a turret emits four or five commands
 * that only make sense together; landing three of them and failing the fourth
 * leaves a scene nobody asked for.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { AgentCommand, AgentResult } from '../editor/editor-core.mjs';
import { type EditorSession, type SceneSummary, describeCommand } from '../editor/session.js';

/** What the renderer receives for every scene tool call. */
export interface SceneEditDetails {
  readonly op: string;
  readonly ok: boolean;
  /** Scene revision after the call. Unchanged when the call failed. */
  readonly revision: number;
  /** One line, written to be read as it streams past. */
  readonly summary: string;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
  /** Enough for a viewport or hierarchy panel to redraw. */
  readonly scene: SceneSummary;
}

const NodeIdSchema = Type.String({
  description: 'Stable id of the node, unique within the scene. Lowercase, no spaces.',
});

const SceneEditParams = Type.Object({
  commands: Type.Array(
    Type.Object({
      op: Type.String({
        description:
          'Operation name. One of: scene.addNode, scene.removeNode, scene.setField, ' +
          'scene.setParent, scene.instantiatePrefab, scene.setOverride, ' +
          'asset.import, asset.move, asset.remove.',
      }),
      id: Type.Optional(NodeIdSchema),
      name: Type.Optional(Type.String({ description: 'Display name shown in the hierarchy.' })),
      parent: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: 'Parent node id, or null for a root.',
        }),
      ),
      component: Type.Optional(Type.String({ description: 'Component name, e.g. Transform.' })),
      field: Type.Optional(Type.String({ description: 'Field within the component, e.g. x.' })),
      value: Type.Optional(Type.Unknown({ description: 'New value for the field.' })),
      asset: Type.Optional(Type.String({ description: 'Asset id, for prefab instantiation.' })),
      instance: Type.Optional(Type.String({ description: 'Prefab instance node id.' })),
      node: Type.Optional(
        Type.String({ description: 'Node id inside the prefab, for overrides.' }),
      ),
      path: Type.Optional(Type.String({ description: 'Project-relative asset path.' })),
      type: Type.Optional(Type.String({ description: 'Asset type, e.g. prefab or texture.' })),
      content: Type.Optional(Type.String({ description: 'Asset content, for asset.import.' })),
      force: Type.Optional(Type.Boolean({ description: 'Delete even if still referenced.' })),
    }),
    {
      minItems: 1,
      description:
        'Commands to apply atomically. If any one fails, none of them land and the ' +
        'scene is exactly as it was.',
    },
  ),
});

const SceneQueryParams = Type.Object({
  what: Type.Union(
    [Type.Literal('scene'), Type.Literal('node'), Type.Literal('assets'), Type.Literal('validate')],
    {
      description:
        "'scene' lists every node with prefabs expanded; 'node' returns one node in full " +
        "(needs id); 'assets' lists the project's assets; 'validate' reports problems.",
    },
  ),
  id: Type.Optional(Type.String({ description: "Node id, when what='node'." })),
  type: Type.Optional(Type.String({ description: "Filter assets by type, when what='assets'." })),
});

const SceneHistoryParams = Type.Object({
  direction: Type.Union([Type.Literal('undo'), Type.Literal('redo')], {
    description:
      'Step the shared history. The user shares this stack — undo takes back ' +
      'whichever edit was last, whoever made it.',
  }),
});

function resultText(details: SceneEditDetails): string {
  if (!details.ok) {
    const error = details.error;
    return [
      `FAILED: ${error?.message ?? 'unknown error'} (${error?.code ?? 'unknown'})`,
      'Nothing was applied. Fix the command and try again.',
    ].join('\n');
  }
  const counts = `${details.scene.nodes.length} node${details.scene.nodes.length === 1 ? '' : 's'}`;
  const problems = details.scene.issues.filter((issue) => issue.severity === 'error');
  const lines = [`${details.summary} — scene now has ${counts} (revision ${details.revision}).`];
  if (problems.length > 0) {
    // Surfaced, not buried: the agent can fix a dangling parent right now, and
    // will not if it has to go looking.
    const listed = problems
      .slice(0, 5)
      .map((issue) => `${issue.node}: ${issue.message}`)
      .join('; ');
    lines.push(`${problems.length} problem(s) to fix: ${listed}`);
  }
  return lines.join('\n');
}

/**
 * The error a model should actually see.
 *
 * A batch reports its own failure as `validation_failed` with the real problem
 * nested in `detail.cause` — correct for the batch, useless for the caller. A
 * model told "validation_failed" cannot tell a duplicate id from a path that
 * escaped the project, and those want opposite fixes. So the cause is unwrapped
 * and the index is folded into the message, which keeps both facts.
 */
function readableError(error: {
  code: string;
  message: string;
  detail?: Readonly<Record<string, unknown>> | undefined;
}): { code: string; message: string } {
  const cause = error.detail?.['cause'] as { code?: string; message?: string } | undefined;
  if (!cause?.code || !cause.message) return { code: error.code, message: error.message };

  const index = error.detail?.['index'];
  const where = typeof index === 'number' ? `command ${index}: ` : '';
  return { code: cause.code, message: `${where}${cause.message}` };
}

function toDetails(
  session: EditorSession,
  op: string,
  summary: string,
  result: AgentResult<unknown>,
): SceneEditDetails {
  return {
    op,
    ok: result.ok,
    revision: session.revision(),
    summary,
    ...(result.ok ? {} : { error: readableError(result.error) }),
    scene: session.summary(),
  };
}

/**
 * `edit_scene` — apply a batch of scene commands.
 *
 * One tool rather than nine, because an agent that has to pick between
 * `add_node` and `set_node_field` before it knows what it wants spends its
 * turns on routing. The commands are the vocabulary; the tool is the verb.
 */
export function makeEditSceneTool(
  getSession: () => EditorSession,
): AgentTool<typeof SceneEditParams, SceneEditDetails> {
  return {
    name: 'edit_scene',
    label: 'Edit scene',
    description:
      'Change the game scene directly: add or delete objects, set component fields, ' +
      'reparent, place prefabs, import assets. Commands apply ATOMICALLY — if one ' +
      'fails, none land. Prefer this over editing source files for anything the ' +
      'player can see in the world; the user watches each edit happen live and can ' +
      'adjust it by hand afterwards. Call query_scene first if you do not know what ' +
      'is already there.',
    parameters: SceneEditParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<SceneEditDetails>> {
      const session = getSession();
      const commands = (params.commands ?? []) as unknown as AgentCommand[];
      const result = session.batch(commands, 'agent');
      const first = commands[0];
      const summary =
        commands.length === 1 && first ? describeCommand(first) : `${commands.length} edits`;
      const details = toDetails(session, 'edit_scene', summary, result);
      return { content: [{ type: 'text', text: resultText(details) }], details };
    },
  };
}

/** `query_scene` — read the scene without changing it. */
export function makeQuerySceneTool(
  getSession: () => EditorSession,
): AgentTool<typeof SceneQueryParams, { readonly what: string; readonly ok: boolean }> {
  return {
    name: 'query_scene',
    label: 'Read scene',
    description:
      'Read the current scene, one node, the asset list, or a validation report. ' +
      'Cheap and read-only. Use before editing so you act on what is actually there ' +
      'rather than what you last wrote — the user may have moved things by hand.',
    parameters: SceneQueryParams,
    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<{ readonly what: string; readonly ok: boolean }>> {
      const session = getSession();
      const op =
        params.what === 'node'
          ? 'query.node'
          : params.what === 'assets'
            ? 'query.assets'
            : params.what === 'validate'
              ? 'query.validate'
              : 'query.scene';

      const command: AgentCommand = {
        op,
        ...(params.id === undefined ? {} : { id: params.id }),
        ...(params.type === undefined ? {} : { type: params.type }),
      };
      // The read path: no revision bump, no listeners notified. A viewport that
      // redraws because the agent looked at the scene flickers for nothing.
      const result = session.query(command);
      const text = result.ok
        ? JSON.stringify(result.value, null, 2)
        : `FAILED: ${result.error.message} (${result.error.code})`;
      return {
        content: [{ type: 'text', text }],
        details: { what: params.what, ok: result.ok },
      };
    },
  };
}

/** `scene_history` — undo or redo, on the stack shared with the user. */
export function makeSceneHistoryTool(
  getSession: () => EditorSession,
): AgentTool<typeof SceneHistoryParams, SceneEditDetails> {
  return {
    name: 'scene_history',
    label: 'Undo/redo',
    description:
      'Undo or redo the most recent scene edit. The history is SHARED with the user, ' +
      'so undo may take back something they did by hand — say what you are undoing ' +
      'and why before calling this.',
    parameters: SceneHistoryParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<SceneEditDetails>> {
      const session = getSession();
      const result = params.direction === 'undo' ? session.undo('agent') : session.redo('agent');
      const details = toDetails(
        session,
        `scene.${params.direction}`,
        params.direction === 'undo' ? 'Undo' : 'Redo',
        result,
      );
      return { content: [{ type: 'text', text: resultText(details) }], details };
    },
  };
}

/** Every scene tool, for registration in one place. */
export function makeSceneTools(
  getSession: () => EditorSession,
): [
  AgentTool<typeof SceneEditParams, SceneEditDetails>,
  AgentTool<typeof SceneQueryParams, { readonly what: string; readonly ok: boolean }>,
  AgentTool<typeof SceneHistoryParams, SceneEditDetails>,
] {
  return [
    makeEditSceneTool(getSession),
    makeQuerySceneTool(getSession),
    makeSceneHistoryTool(getSession),
  ];
}
