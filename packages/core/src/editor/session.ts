/**
 * The editor session — one document, two drivers.
 *
 * PlayerZero has always had exactly one way to change a game: the agent writes
 * files. That is fine for "make the enemies faster" and hopeless for "move that
 * crate two metres left", which is a thing you point at, not a thing you
 * describe. So there are two layers now, and the whole design rests on them
 * sharing a single model:
 *
 *  - **Prompting.** The agent calls scene tools. Because they are tool calls
 *    rather than a file rewrite, each one is a discrete, named, inspectable
 *    event — which is what lets the UI show the edit as it happens instead of a
 *    spinner followed by a diff.
 *  - **Manual editing.** A person drags, types, deletes.
 *
 * Both go through `execute`. Not "both eventually reach the same file" — the
 * same function, the same validation, the same undo stack. That is the property
 * worth protecting, because the moment the agent gets a private path the two
 * layers start disagreeing about what the scene is, and every bug after that is
 * a merge conflict nobody can see.
 *
 * The session is deliberately isomorphic: the vendored authoring bundle imports
 * nothing, so this runs unchanged on the server (driving an agent run) and in
 * the browser (driving the editor). Same code, same results.
 */

import {
  type AgentCommand,
  type AgentResult,
  type AgentSession,
  type AssetDatabase,
  type SceneDocument,
  type SceneIssue,
  createAgentSession,
  createAssetDatabase,
  emptyScene,
  flattenScene,
  serializeScene,
} from './editor-core.mjs';

/** Who made the change. The UI shows agent edits differently from your own. */
export type EditSource = 'agent' | 'user';

export interface SceneNodeSummary {
  readonly id: string;
  readonly name: string;
  readonly parent: string | null;
  readonly components: readonly string[];
  /** Prefab asset id when this node is an instance root. */
  readonly prefab: string | null;
}

/**
 * Enough of the scene for a UI to redraw, without shipping the whole document.
 *
 * Prefabs are expanded, because a hierarchy panel that shows an instance as one
 * opaque node is not showing the scene the player will see.
 */
export interface SceneSummary {
  readonly name: string;
  readonly revision: number;
  readonly nodes: readonly SceneNodeSummary[];
  readonly issues: readonly SceneIssue[];
}

export interface EditorChange {
  readonly revision: number;
  readonly source: EditSource;
  /** Operation name, or `batch` / `undo` / `redo`. */
  readonly op: string;
  /** One line, written for a person watching it stream past. */
  readonly summary: string;
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
  readonly scene: SceneSummary;
}

export type EditorListener = (change: EditorChange) => void;

export interface EditorSessionOptions {
  readonly scene?: SceneDocument | undefined;
  readonly database?: AssetDatabase | undefined;
  /** Component names this process knows. Omitted means "do not check". */
  readonly isKnownComponent?: ((name: string) => boolean) | undefined;
  readonly historyLimit?: number | undefined;
}

export interface EditorSession {
  /** Apply one command. The only way anything changes. */
  execute(command: AgentCommand, source: EditSource): AgentResult;
  /** Apply several atomically — all of them, or none. */
  batch(commands: readonly AgentCommand[], source: EditSource): AgentResult<readonly unknown[]>;
  /**
   * Run a read-only command.
   *
   * Separate from `execute` because a read must not advance the revision or
   * notify anybody: a viewport that redraws because the agent *looked* at the
   * scene flickers for no reason, and a revision that moves without a change
   * makes every cache downstream useless.
   */
  query(command: AgentCommand): AgentResult;
  undo(source: EditSource): AgentResult<SceneDocument>;
  redo(source: EditSource): AgentResult<SceneDocument>;
  scene(): SceneDocument;
  summary(): SceneSummary;
  revision(): number;
  database(): AssetDatabase;
  /** Operation names both layers may use. */
  operations(): readonly string[];
  /** Watch every change, whoever made it. Returns an unsubscribe. */
  subscribe(listener: EditorListener): () => void;
  /** Serialise the whole session, for persistence or for handing to a client. */
  serialize(): string;
}

/** A readable one-liner for a change, for the activity stream. */
export function describeCommand(command: AgentCommand): string {
  const id = typeof command['id'] === 'string' ? command['id'] : '';
  switch (command.op) {
    case 'scene.addNode':
      return `Add ${typeof command['name'] === 'string' ? command['name'] : id}`;
    case 'scene.removeNode':
      return `Delete ${id}`;
    case 'scene.setField':
      return `Set ${command['component']}.${command['field']} on ${id}`;
    case 'scene.setParent':
      return command['parent'] === null || command['parent'] === undefined
        ? `Unparent ${id}`
        : `Move ${id} under ${command['parent']}`;
    case 'scene.instantiatePrefab':
      return `Place ${typeof command['name'] === 'string' ? command['name'] : id}`;
    case 'scene.setOverride':
      return `Override ${command['component']}.${command['field']} on ${command['instance']}`;
    case 'asset.import':
      return `Import ${command['path']}`;
    case 'asset.move':
      return `Move asset to ${command['path']}`;
    case 'asset.remove':
      return `Remove asset ${id}`;
    default:
      return command.op;
  }
}

export function createEditorSession(options: EditorSessionOptions = {}): EditorSession {
  const database = options.database ?? createAssetDatabase({ idPrefix: 'asset' });

  /**
   * Prefabs resolve out of the asset database's own content.
   *
   * A prefab is a scene document stored as an asset, so instead of a second
   * registry that can disagree with the first, the resolver parses what the
   * database holds. One source of truth, and a prefab that was deleted resolves
   * to `undefined` rather than to a stale copy.
   */
  const prefabDocuments = new Map<string, SceneDocument>();
  const resolvePrefab = (asset: string): SceneDocument | undefined => prefabDocuments.get(asset);

  const session: AgentSession = createAgentSession({
    database,
    scene: options.scene ?? emptyScene('Untitled'),
    resolvePrefab,
    ...(options.isKnownComponent ? { isKnownComponent: options.isKnownComponent } : {}),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
  });

  const listeners = new Set<EditorListener>();
  let revision = 0;

  function summary(): SceneSummary {
    const document = session.scene();
    const { nodes, issues } = flattenScene(document, resolvePrefab);
    return {
      name: document.name,
      revision,
      nodes: nodes.map((node) => ({
        id: node.id,
        name: node.name,
        parent: node.parent,
        components: Object.keys(node.components),
        prefab: node.prefab?.asset ?? null,
      })),
      issues,
    };
  }

  function publish(op: string, label: string, source: EditSource, result: AgentResult): void {
    // The revision advances only on success, so a client that polls it does not
    // re-render because the agent made a mistake.
    if (result.ok) revision++;
    const change: EditorChange = {
      revision,
      source,
      op,
      summary: label,
      ok: result.ok,
      ...(result.ok ? {} : { error: { code: result.error.code, message: result.error.message } }),
      scene: summary(),
    };
    // A throwing listener must not take down the edit that triggered it — the
    // edit already happened, and losing it because a panel had a bad render
    // would be far worse than a dropped notification.
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // Intentionally swallowed; see above.
      }
    }
  }

  /** Keep the prefab index in step with the assets the commands touched. */
  function reindexPrefabs(): void {
    prefabDocuments.clear();
    for (const record of database.ofType('prefab')) {
      const content = prefabSource.get(record.id);
      if (content === undefined) continue;
      try {
        prefabDocuments.set(record.id, JSON.parse(content) as SceneDocument);
      } catch {
        // A prefab whose content is not a scene document is reported by
        // validation rather than crashing the session that imported it.
      }
    }
  }

  /**
   * Prefab bodies, kept beside the database.
   *
   * The asset database stores hashes, not content — it is an index, and holding
   * every byte of every asset in it would make snapshotting a project mean
   * copying the project. Prefabs are the one asset kind this session has to read
   * rather than merely reference, so their source is kept here.
   */
  const prefabSource = new Map<string, string>();

  const editor: EditorSession = {
    execute(command: AgentCommand, source: EditSource): AgentResult {
      const result = session.execute(command);
      if (result.ok && command.op === 'asset.import' && command['type'] === 'prefab') {
        const value = result.value as { id: string };
        if (typeof command['content'] === 'string') prefabSource.set(value.id, command['content']);
        reindexPrefabs();
      }
      publish(command.op, describeCommand(command), source, result);
      return result;
    },

    batch(commands: readonly AgentCommand[], source: EditSource): AgentResult<readonly unknown[]> {
      const result = session.batch(commands);
      if (result.ok) {
        for (const command of commands) {
          if (command.op !== 'asset.import' || command['type'] !== 'prefab') continue;
          const record = database.byPath(String(command['path']));
          if (record && typeof command['content'] === 'string') {
            prefabSource.set(record.id, command['content']);
          }
        }
        reindexPrefabs();
      }
      const label = result.ok
        ? `${commands.length} edit${commands.length === 1 ? '' : 's'}`
        : 'Batch failed';
      publish('batch', label, source, result);
      return result;
    },

    undo(source: EditSource): AgentResult<SceneDocument> {
      const result = session.undo();
      publish('undo', 'Undo', source, result);
      return result;
    },

    redo(source: EditSource): AgentResult<SceneDocument> {
      const result = session.redo();
      publish('redo', 'Redo', source, result);
      return result;
    },

    query(command: AgentCommand): AgentResult {
      return session.execute(command);
    },

    scene: () => session.scene(),
    summary,
    revision: () => revision,
    database: () => database,
    operations: () => session.operations(),

    subscribe(listener: EditorListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    serialize(): string {
      return JSON.stringify({
        version: EDITOR_SESSION_VERSION,
        revision,
        scene: JSON.parse(serializeScene(session.scene())),
        assets: JSON.parse(database.serialize()),
        prefabs: Object.fromEntries(prefabSource),
      });
    },
  };

  return editor;
}

export const EDITOR_SESSION_VERSION = 'editor-session.v1';
