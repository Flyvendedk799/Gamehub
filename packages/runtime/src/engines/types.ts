/**
 * gameplan §7.1 — engine adapter types.
 *
 * Kept in a separate file so adapters can `import type` from here without
 * pulling in the registry side-effects in the entry module.
 */

export type GameEngineId = 'three' | 'phaser' | 'canvas2d';

/**
 * Cross-origin postMessage protocol constant for the host→iframe live-tweak
 * bridge. The host (builder preview pane) posts `{ type: TWEAKS_UPDATE_MESSAGE_TYPE,
 * tokens }` and the in-iframe bridge (see `tweaks-bridge.ts`) listens for the
 * same `type`. Centralizing the literal here keeps the host and the bridge in
 * lockstep so a rename can't silently break the channel (#20). The host must
 * post with an explicit `targetOrigin` (the preview/play API origin), never
 * `'*'`, and the bridge/host must validate `event.origin` on inbound messages.
 */
export const TWEAKS_UPDATE_MESSAGE_TYPE = 'playforge:tweaks:update' as const;
export type TweaksUpdateMessageType = typeof TWEAKS_UPDATE_MESSAGE_TYPE;

/**
 * postMessage protocol constant for the iframe→host leaderboard bridge (Phase
 * 3.8). The generated game calls `window.__game.reportScore(n)` on game-over /
 * score-change; the shim posts `{ type: SCORE_MESSAGE_TYPE, score }` to the
 * parent, which submits it to `POST /v1/play/:slug/score`. CSP-safe: this is a
 * same-window postMessage to the embedder, not a new network origin (the locked
 * `connect-src 'none'` game CSP is untouched).
 *
 * Prompt directive (deferred follow-up): the generation prompt must instruct
 * games to call `window.__game.reportScore(finalScore)` once the run ends and
 * whenever the score changes. That one-line directive lives in
 * `packages/core/src/prompts/` — another agent's boundary — so it lands
 * separately. The shim contract here is the prerequisite; the prompt line can
 * be added later without any change to this code.
 */
export const SCORE_MESSAGE_TYPE = 'playforge:score' as const;
export type ScoreMessageType = typeof SCORE_MESSAGE_TYPE;

/** Frame posted to the host when a game reports a score (Phase 3.8). */
export interface ScoreMessage {
  type: ScoreMessageType;
  /** Final/current score the game reported. Coerced to a finite number. */
  score: number;
}

/**
 * Controls protocol (WS-A). The generated game calls
 * `window.__game.controls.define({ actions: [...] })` at startup to DECLARE its
 * control scheme and reads input through `controls.isDown(id)` / `controls.on(id,
 * fn)`. The runtime layer (in `gameGlobalSetupSnippet`) tracks keys → actions and
 * posts the manifest to the host (`CONTROLS_MANIFEST_MESSAGE_TYPE`). The host's
 * Controls tab renders the manifest, lets the user rebind/add keys, and posts
 * `CONTROLS_REBIND_MESSAGE_TYPE` back so the game remaps live — works for any
 * game that uses the layer, with no per-game wiring. `CONTROLS_REQUEST_MESSAGE_TYPE`
 * lets the host pull the current manifest on demand.
 */
export const CONTROLS_MANIFEST_MESSAGE_TYPE = 'playforge:controls:manifest' as const;
export const CONTROLS_REBIND_MESSAGE_TYPE = 'playforge:controls:rebind' as const;
export const CONTROLS_REQUEST_MESSAGE_TYPE = 'playforge:controls:request' as const;
/** v3 P10b — the game posts cloud-save mutations to the host so a per-account
 *  store can mirror them cross-device (the in-iframe shim persists to localStorage
 *  for the device-local baseline; the host relay is the cloud seam). */
export const CLOUD_SAVE_MESSAGE_TYPE = 'playforge:cloudsave' as const;

/** One rebindable action a game declares (id + human label + bound inputs). */
export interface ControlAction {
  id: string;
  label: string;
  description?: string;
  /** Bound inputs: KeyboardEvent.code values (e.g. 'ArrowUp','KeyW') AND/OR mouse
   *  buttons 'Mouse0' (left), 'Mouse1' (middle), 'Mouse2' (right). An action can
   *  mix them, e.g. ['KeyJ','Mouse0'] for a strike on J or left-click. */
  keys: string[];
  /** Set for a mouse-AXIS control (camera look / aim / drag) rather than a
   *  button bind — it's shown in the Controls tab as a pointer-driven control,
   *  not a rebindable key. */
  pointer?: 'look' | 'aim' | 'drag';
}

export interface ControlsManifest {
  actions: ControlAction[];
}

/** Game → host: the current control manifest. */
export interface ControlsManifestMessage {
  type: typeof CONTROLS_MANIFEST_MESSAGE_TYPE;
  manifest: ControlsManifest | null;
}

/** Host → game: apply new key bindings (actionId → key codes). */
export interface ControlsRebindMessage {
  type: typeof CONTROLS_REBIND_MESSAGE_TYPE;
  bindings: Record<string, string[]>;
}

/** Type guard for an inbound score frame on the host's `message` listener. */
export function isScoreMessage(data: unknown): data is ScoreMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === SCORE_MESSAGE_TYPE &&
    typeof (data as { score?: unknown }).score === 'number' &&
    Number.isFinite((data as { score: number }).score)
  );
}

export interface BootstrapOptions {
  /** UUID of the design row this game belongs to. Used to build the
   *  game-files:// base URL the iframe resolves relative imports against. */
  designId: string;
  /** Fully-qualified base URL the starter template injects as `<base href>`.
   *  Re-spec (#47): must be `https://…`, `about:blank`, or the privileged
   *  `game-files://designs/{designId}/` protocol. `javascript:`/`data:`/
   *  `file:`/`blob:` bases are rejected by the bootstrap, and the value is
   *  HTML-attribute-escaped before interpolation. */
  gameBaseUrl: string;
  /** Optional engine version override. Falls back to `adapter.defaultVersion`.
   *  Must be a strict semver (#47): non-semver values are rejected by the
   *  bootstrap before they reach the import-map URL. */
  pinnedVersion?: string | undefined;
  /** When true, the bootstrap injects `window.__game.config.startMuted = true`
   *  so engines can avoid the autoplay-policy warning on first preview. */
  startMuted?: boolean | undefined;
  /** Initial values for `window.__game.params`. Subsequent live tweaks
   *  arrive via postMessage `{ type: 'game:setParams', params }`. */
  initialParams?: Record<string, unknown> | undefined;
}

export interface ValidationIssue {
  path: string;
  line?: number | undefined;
  message: string;
  severity: 'error' | 'warn';
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface InputFile {
  path: string;
  content: string;
}

export interface GameEngineAdapter {
  /** Identifier matching design_snapshots.engine. */
  readonly id: GameEngineId;
  /** Human-readable label for UI surfaces. */
  readonly label: string;
  /** Pinned default engine version (gameplan §1, Appendix). */
  readonly defaultVersion: string;
  /** The single entry-point file the runtime expects when previewing or
   *  exporting. `index.html` for both web engines (three + phaser). */
  readonly canonicalEntry: string;
  /** Lowercase file extensions (no leading dot) the engine guide tells the
   *  agent to author. Used by validators + the path-aware byte-cap helper. */
  readonly fileExtensions: readonly string[];

  /** Returns the starter HTML/scaffolding the agent should `text_editor.create`
   *  as the project's `canonicalEntry`. For both web engines this is a full
   *  index.html with the engine ESM import-map and the `__game` global shim.
   *  The agent may then iterate via str_replace. */
  bootstrap(opts: BootstrapOptions): string;

  /** True when the engine produces a runnable iframe preview today. Both
   *  web engines (three + phaser) preview live in the sandboxed iframe. */
  supportsLivePreview(): boolean;

  /** Engine-specific lint over the current file bundle. Called by the
   *  `validate_game_scene` tool before `done`. Implementation may be regex-
   *  level for v1 — no AST dep — and is upgraded later as needed. */
  validate(files: ReadonlyArray<InputFile>): ValidationResult;
}

/** Snippet shared by all JS-engine bootstraps — sets up `window.__game` with
 *  the cross-engine tweak bridge described in gameplan §7.3 and the playtest
 *  debug contract used by `playtest_game`. Receives encoded JSON of the
 *  engine id + initial params + startMuted hint.
 *
 *  The `__game.debug.snapshot()` default returns `null`; agents are expected
 *  to override with a small getter that exposes whatever fields the
 *  playtest scenario asserts on (player position, angle, hp, score, …).
 *  Keeping the default in the bootstrap means `playtest_game` never throws
 *  on missing-symbol — it surfaces a `no_debug_contract` outcome instead. */
export function gameGlobalSetupSnippet(opts: {
  engine: GameEngineId;
  initialParams: Record<string, unknown>;
  startMuted: boolean;
}): string {
  const params = JSON.stringify(opts.initialParams);
  const config = JSON.stringify({ startMuted: opts.startMuted, initialAspect: '16:9' });
  const scoreType = JSON.stringify(SCORE_MESSAGE_TYPE);
  const ctrlManifestType = JSON.stringify(CONTROLS_MANIFEST_MESSAGE_TYPE);
  const ctrlRebindType = JSON.stringify(CONTROLS_REBIND_MESSAGE_TYPE);
  const ctrlRequestType = JSON.stringify(CONTROLS_REQUEST_MESSAGE_TYPE);
  const cloudSaveType = JSON.stringify(CLOUD_SAVE_MESSAGE_TYPE);
  return `<script>
window.__game = window.__game || {};
window.__game.engine = ${JSON.stringify(opts.engine)};
window.__game.params = ${params};
window.__game.config = ${config};
// v2 P2 — a live debug contract the deterministic verdict layer can actually
// read. The old default returned null, so EVERY predicate reported "field
// missing" and known-genre games could never earn a play verdict. Now the agent
// (or an imported skill) wires real values in ONE line — debug.track({ player,
// score: () => score, wave: () => wave }) — or sets window.__game.state.*, and
// snapshot() merges them. It still returns null when NOTHING is wired, so the
// no_debug_contract outcome is preserved (we don't fake a contract).
window.__game.debug = window.__game.debug || (function () {
  var tracked = {};
  function read(v) { try { return typeof v === 'function' ? v() : v; } catch (e) { return null; } }
  function reflectPos(o) {
    if (!o) return undefined;
    var x = o.x, y = o.y;
    if ((x === undefined || y === undefined) && o.position) { x = o.position.x; y = o.position.y; }
    if (x === undefined && y === undefined) return undefined;
    return { x: x, y: y };
  }
  function track(spec) { if (spec && typeof spec === 'object') { for (var k in spec) tracked[k] = spec[k]; } return api; }
  function snapshot() {
    var st = window.__game.state;
    var hasState = st && typeof st === 'object' && Object.keys(st).length > 0;
    var hasTracked = Object.keys(tracked).length > 0;
    if (!hasState && !hasTracked) return null; // nothing wired → honest no_debug_contract
    var out = {};
    if (hasState) { for (var k in st) out[k] = read(st[k]); }
    for (var t in tracked) {
      if (t === 'player') { var p = reflectPos(read(tracked.player)); if (p) out.playerPos = p; }
      else { out[t] = read(tracked[t]); }
    }
    return out;
  }
  var api = { track: track, snapshot: snapshot };
  return api;
})();
// v3 P10b — cloud-save bridge. The cloud-save skill (import_skill) calls
// window.__game.cloudSave.get/set/clear. This shim persists to localStorage for a
// device-local baseline AND posts a cloud-save message to the host so a per-account
// store can mirror it cross-device (CSP connect-src 'self' safe — no direct net).
window.__game.cloudSave = window.__game.cloudSave || (function () {
  var PREFIX = 'pf:cloud:';
  function lsGet(key) { try { var v = localStorage.getItem(PREFIX + key); return v === null ? null : JSON.parse(v); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) {} }
  function relay(op, key, value) { try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: ${cloudSaveType}, op: op, key: key, value: value }, '*'); } catch (e) {} }
  return {
    get: function (key) { return Promise.resolve(lsGet(key)); },
    set: function (key, value) { lsSet(key, value); relay('set', key, value); return Promise.resolve(); },
    clear: function (key) { try { if (key) { localStorage.removeItem(PREFIX + key); } } catch (e) {} relay('clear', key || null, null); return Promise.resolve(); }
  };
})();
// WS-A — rebindable input layer. The game DECLARES its controls via
// window.__game.controls.define({ actions:[{id,label,description,keys:[...]}] })
// and reads input via controls.isDown(id) (held) / controls.on(id, fn) (pressed).
// The runtime maps physical keys → actions, so the host can rebind keys live by
// posting CONTROLS_REBIND without the game knowing. Keys are KeyboardEvent.code.
window.__game.controls = window.__game.controls || (function () {
  var bindings = {}, meta = {}, order = [], down = {}, handlers = {};
  function keysFor(id) { return bindings[id] || []; }
  function isDown(id) { var k = keysFor(id); for (var i = 0; i < k.length; i++) { if (down[k[i]]) return true; } return false; }
  function on(id, fn) { (handlers[id] = handlers[id] || []).push(fn); return api; }
  function buildManifest() {
    return { actions: order.map(function (id) {
      var a = { id: id, label: (meta[id] && meta[id].label) || id, description: (meta[id] && meta[id].description) || '', keys: (bindings[id] || []).slice() };
      if (meta[id] && meta[id].pointer) a.pointer = meta[id].pointer; // 'look'/'aim'/'drag' — a mouse-axis control, shown not key-rebound
      return a;
    }) };
  }
  function postManifest() {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: ${ctrlManifestType}, manifest: buildManifest() }, '*'); } catch (e) {}
  }
  function define(manifest) {
    bindings = {}; meta = {}; order = [];
    var actions = (manifest && manifest.actions) || [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i]; if (!a || !a.id) continue;
      order.push(a.id); bindings[a.id] = (a.keys || []).slice(); meta[a.id] = { label: a.label || a.id, description: a.description || '', pointer: a.pointer || '' };
    }
    api.manifest = buildManifest(); postManifest(); return api;
  }
  function rebind(next) {
    if (!next) return; for (var id in next) { if (Object.prototype.hasOwnProperty.call(next, id)) bindings[id] = (next[id] || []).slice(); }
    api.manifest = buildManifest();
  }
  function press(code) { down[code] = true; for (var id in bindings) { if (keysFor(id).indexOf(code) !== -1) { var hs = handlers[id] || []; for (var j = 0; j < hs.length; j++) { try { hs[j](); } catch (_) {} } } } }
  function release(code) { down[code] = false; }
  window.addEventListener('keydown', function (e) { if (e.repeat) return; press(e.code); });
  window.addEventListener('keyup', function (e) { release(e.code); });
  // Mouse BUTTON binds share the same keys[] as KeyboardEvent.code: 'Mouse0' (left),
  // 'Mouse1' (middle), 'Mouse2' (right). So an action can bind e.g. ['KeyJ','Mouse0'].
  window.addEventListener('mousedown', function (e) { press('Mouse' + e.button); });
  window.addEventListener('mouseup', function (e) { release('Mouse' + e.button); });
  // Suppress the browser context menu so a right-click (Mouse2) bind is usable.
  window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  var api = { manifest: null, define: define, isDown: isDown, on: on, rebind: rebind };
  return api;
})();
// Phase 3.8 — per-game leaderboards. Games call window.__game.reportScore(n)
// on game-over / score-change. We post a same-window frame to the embedder,
// which submits it to POST /v1/play/:slug/score. CSP-safe: a postMessage to the
// parent is not a network connection, so connect-src 'none' is untouched.
window.__game.reportScore = window.__game.reportScore || function (score) {
  var n = Number(score);
  if (!isFinite(n)) return;
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: ${scoreType}, score: n }, '*');
    }
  } catch (e) { /* cross-origin parent may throw; ignore */ }
};
window.addEventListener('message', function (e) {
  // Only the embedding parent may drive runtime params. Reject any message from
  // a real window that is NOT the parent (a third-party embedder/foreign frame
  // trying to mutate gameplay state / cheat). A same-document synthetic dispatch
  // has source null — the game's own already-trusted code. (CSP H1)
  if (e.source && e.source !== window.parent) return;
  if (e && e.data && e.data.type === 'game:setParams' && e.data.params) {
    Object.assign(window.__game.params, e.data.params);
    window.dispatchEvent(new CustomEvent('game:params-changed', { detail: e.data.params }));
  }
  // WS-A controls: host pushes a rebind, or asks the game to re-post its manifest.
  if (e && e.data && e.data.type === ${ctrlRebindType} && e.data.bindings) {
    window.__game.controls.rebind(e.data.bindings);
  }
  if (e && e.data && e.data.type === ${ctrlRequestType}) {
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: ${ctrlManifestType}, manifest: window.__game.controls.manifest }, '*'); } catch (err) {}
  }
});
</script>`;
}
