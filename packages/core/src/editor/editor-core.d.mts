/**
 * Types for the vendored `editor-core.mjs` bundle.
 *
 * The bundle is generated JavaScript with no declarations of its own, so this
 * describes it by hand — which means it can drift from what the bundle actually
 * exports. `editor-core.test.ts` compares the two mechanically and fails when
 * they disagree, so the drift is caught here rather than as a runtime
 * `undefined is not a function` somewhere downstream.
 *
 * Refresh the bundle with `node scripts/sync-engine-skill.mjs`.
 */

// ── asset database ────────────────────────────────────────────────────────

export type AssetId = string;

export type AssetType =
  | 'scene'
  | 'prefab'
  | 'mesh'
  | 'texture'
  | 'material'
  | 'script'
  | 'audio'
  | 'animation'
  | 'font'
  | 'data';

export interface AssetRecord {
  readonly id: AssetId;
  readonly path: string;
  readonly type: AssetType;
  readonly contentHash: string;
  readonly settingsHash: string;
  readonly dependencies: readonly AssetId[];
  readonly revision: number;
}

export interface ImportRequest {
  readonly path: string;
  readonly type: AssetType;
  readonly content: string | Uint8Array;
  readonly settings?: Record<string, unknown> | undefined;
  readonly dependencies?: readonly AssetId[] | undefined;
  readonly id?: AssetId | undefined;
}

export interface AssetIssue {
  readonly severity: 'error' | 'warning';
  readonly asset: AssetId;
  readonly message: string;
}

export interface RemovalResult {
  readonly removed: boolean;
  readonly dangling: readonly AssetId[];
}

export interface AssetDatabase {
  import(request: ImportRequest): AssetRecord;
  move(id: AssetId, path: string): boolean;
  remove(id: AssetId, options?: { readonly force?: boolean | undefined }): RemovalResult;
  get(id: AssetId): AssetRecord | undefined;
  byPath(path: string): AssetRecord | undefined;
  all(): readonly AssetRecord[];
  ofType(type: AssetType): readonly AssetRecord[];
  dependents(id: AssetId): readonly AssetId[];
  closure(id: AssetId): readonly AssetId[];
  needsReimport(
    id: AssetId,
    content: string | Uint8Array,
    settings?: Record<string, unknown>,
  ): boolean;
  validate(): readonly AssetIssue[];
  serialize(): string;
  readonly revision: number;
}

export interface AssetDatabaseOptions {
  readonly idPrefix?: string | undefined;
  readonly caseInsensitivePaths?: boolean | undefined;
  readonly initial?: readonly AssetRecord[] | undefined;
}

export const ASSET_DB_VERSION: string;
export function createAssetDatabase(options?: AssetDatabaseOptions): AssetDatabase;
export function deserializeAssetDatabase(
  json: string,
  options?: AssetDatabaseOptions,
): AssetDatabase;
export function hashContent(content: string | Uint8Array): string;
export function hashSettings(settings: Record<string, unknown> | undefined): string;
export function normalizePath(path: string): string;

// ── scene documents ───────────────────────────────────────────────────────

export type NodeId = string;

export interface PrefabOverride {
  readonly node: NodeId;
  readonly component: string;
  readonly field: string;
  readonly value: unknown;
}

export interface PrefabInstance {
  readonly asset: AssetId;
  readonly overrides: readonly PrefabOverride[];
  readonly removed?: readonly NodeId[] | undefined;
}

export interface SceneDocumentNode {
  readonly id: NodeId;
  readonly name: string;
  readonly parent: NodeId | null;
  readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly prefab?: PrefabInstance | undefined;
}

export interface SceneDocument {
  readonly version: string;
  readonly name: string;
  readonly order: readonly NodeId[];
  readonly nodes: Readonly<Record<NodeId, SceneDocumentNode>>;
}

export interface SceneIssue {
  readonly severity: 'error' | 'warning';
  readonly node: NodeId;
  readonly message: string;
}

export type PrefabResolver = (asset: AssetId) => SceneDocument | undefined;
export type ComponentPredicate = (name: string) => boolean;

export interface ValidateSceneOptions {
  readonly resolvePrefab?: PrefabResolver | undefined;
  readonly isKnownComponent?: ComponentPredicate | undefined;
}

export const SCENE_DOCUMENT_VERSION: string;
export function emptyScene(name?: string): SceneDocument;
export function prefabChildId(instance: NodeId, inner: NodeId): NodeId;
export function validateScene(
  document: SceneDocument,
  options?: ValidateSceneOptions,
): SceneIssue[];
export function flattenScene(
  document: SceneDocument,
  resolve?: PrefabResolver,
): { nodes: SceneDocumentNode[]; issues: SceneIssue[] };
export function addNode(
  document: SceneDocument,
  node: Omit<SceneDocumentNode, 'parent'> & { parent?: NodeId | null },
): SceneDocument;
export function removeNode(document: SceneDocument, id: NodeId): SceneDocument;
export function setNodeParent(
  document: SceneDocument,
  id: NodeId,
  parent: NodeId | null,
): SceneDocument;
export function setNodeField(
  document: SceneDocument,
  id: NodeId,
  component: string,
  field: string,
  value: unknown,
): SceneDocument;
export function setPrefabOverride(
  document: SceneDocument,
  instanceId: NodeId,
  override: PrefabOverride,
): SceneDocument;
export function clearPrefabOverride(
  document: SceneDocument,
  instanceId: NodeId,
  target: { node: NodeId; component: string; field: string },
): SceneDocument;
export function danglingOverrides(
  document: SceneDocument,
  resolve: PrefabResolver,
): readonly (PrefabOverride & { instance: NodeId })[];
export function serializeScene(document: SceneDocument): string;
export function deserializeScene(json: string): SceneDocument;

// ── agent command surface ─────────────────────────────────────────────────

export type AgentErrorCode =
  | 'unknown_operation'
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'unsafe_path'
  | 'validation_failed'
  | 'nothing_to_undo'
  | 'nothing_to_redo';

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export type AgentResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentError };

export interface AgentCommand {
  readonly op: string;
  readonly [key: string]: unknown;
}

export interface AgentSessionOptions {
  readonly database: AssetDatabase;
  readonly scene?: SceneDocument | undefined;
  readonly resolvePrefab?: PrefabResolver | undefined;
  readonly isKnownComponent?: ComponentPredicate | undefined;
  readonly historyLimit?: number | undefined;
}

export interface AgentSession {
  execute(command: AgentCommand): AgentResult;
  batch(commands: readonly AgentCommand[]): AgentResult<readonly unknown[]>;
  scene(): SceneDocument;
  undo(): AgentResult<SceneDocument>;
  redo(): AgentResult<SceneDocument>;
  operations(): readonly string[];
}

export function createAgentSession(options: AgentSessionOptions): AgentSession;
export function isSafeProjectPath(path: string): boolean;
