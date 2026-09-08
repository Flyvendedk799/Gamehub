/**
 * GAME_TUNING — the game-native live-tuning block, and the bridge that makes it
 * editable while the game runs.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * The builder already ships a "Live tweaks" panel. It was completely inert for
 * games, for three independent reasons, and every one of them had to be fixed
 * for the feature to exist at all:
 *
 *   1. The only tweak bridge was `runtime/tweaks-bridge.ts`, inherited from the
 *      DESIGN product. It bails on line one unless `window.ReactDOM.createRoot`
 *      exists, and it applies an edit by re-running Babel over the agent's
 *      source and re-rendering a React root. A Phaser or Three game has neither.
 *   2. `declare_tweak_schema` could only anchor on a `TWEAK_DEFAULTS` block in
 *      `index.html` — a design-mode construct. A game's code lives in
 *      `src/main.js`, so the tool had nothing to attach to and the agent
 *      declared a schema on 0 of 15 production runs.
 *   3. Even when declared, nothing wrote `tweakSchema` onto the snapshot row, so
 *      the panel could never have received one.
 *
 * The cost of that was paid one prompt at a time. A user asking for a lower jump
 * spent five AI runs and ~15 minutes on a number that a slider changes in a
 * second — and the agent kept mis-hitting it, because the value lived as five
 * separate hard-coded literals (`setVelocityY(-360)`, `(-420)`, `(-340)`, …)
 * scattered through an 1100-line file with no name attached to any of them.
 *
 * ─── How it works ───────────────────────────────────────────────────────────
 *
 * The game declares its feel numbers ONCE, as a named block:
 *
 *   const TUNING = \/*GAME-TUNING-BEGIN*\/{
 *     "jumpVelocity": 360,
 *     "gravity": 1800
 *   }\/*GAME-TUNING-END*\/;
 *   window.__game.tuning = TUNING;
 *
 * ...and reads `TUNING.jumpVelocity` at the point of use. The bridge below
 * MUTATES that same object in place when the host posts a tweak update, so the
 * next frame that reads it sees the new value. No reload, no recompile, no
 * re-render, and — unlike the React bridge — no `new Function` over
 * host-supplied content, so this is not an eval primitive. Only JSON primitives
 * are ever copied across.
 *
 * A game that wants to react to a change (rebuilding a physics body, say) can
 * register `window.__game.onTuningChange(fn)`.
 */

/** Mirrors the host's `TWEAKS_UPDATE_MESSAGE_TYPE`. Kept in lockstep by hand
 *  with `runtime/engines/types.ts` and `apps/web/src/lib/iframe-bridge.ts`. */
const TWEAKS_UPDATE_TYPE = 'playforge:tweaks:update';

/** Marker so a double injection pass doesn't install the bridge twice. */
export const GAME_TUNING_BRIDGE_MARKER = 'pf-game-tuning-bridge';

/**
 * The injectable `<script>`. Self-contained, idempotent, ES5.
 *
 * Installed at `<head>` so `window.__game.tuning` exists before the game module
 * runs — a game may assign its own object over it, which is the expected shape
 * (`window.__game.tuning = TUNING`), and the listener re-reads the live
 * reference on every message rather than capturing one at install time.
 */
export const GAME_TUNING_BRIDGE_SNIPPET = `<script data-pf="${GAME_TUNING_BRIDGE_MARKER}">(function(){
  window.__game = window.__game || {};
  if (window.__game.__tuningBridge) return;
  window.__game.__tuningBridge = true;
  if (!window.__game.tuning) window.__game.tuning = {};
  var subs = [];
  window.__game.onTuningChange = function(fn){ if (typeof fn === 'function') subs.push(fn); return window.__game; };
  window.addEventListener('message', function(e){
    // Same trust rule as every other bridge: only the embedding host may drive
    // this. A foreign frame must not be able to reach into game state.
    if (e.source && e.source !== window.parent) return;
    var d = e && e.data;
    if (!d || d.type !== ${JSON.stringify(TWEAKS_UPDATE_TYPE)}) return;
    if (!d.tokens || typeof d.tokens !== 'object') return;
    // Re-read the LIVE object each time — the game module assigns its own over
    // ours during boot, and that is the one holding the values it reads.
    var t = window.__game.tuning;
    if (!t || typeof t !== 'object') { t = window.__game.tuning = {}; }
    var changed = false;
    for (var k in d.tokens) {
      if (!Object.prototype.hasOwnProperty.call(d.tokens, k)) continue;
      var v = d.tokens[k];
      // Primitives ONLY. This bridge writes straight into live game state, so
      // refusing objects and functions is what keeps it from being an injection
      // vector (the React bridge it replaces re-evaluated source instead).
      var ty = typeof v;
      if (ty !== 'number' && ty !== 'string' && ty !== 'boolean') continue;
      if (ty === 'number' && !isFinite(v)) continue;
      if (t[k] === v) continue;
      t[k] = v;
      changed = true;
    }
    if (!changed) return;
    for (var i = 0; i < subs.length; i++) { try { subs[i](t); } catch (_) {} }
  });
})();</script>`;

// ─── The GAME_TUNING source block ────────────────────────────────────────────

const MARKED_RE = /\/\*\s*GAME-TUNING-BEGIN\s*\*\/([\s\S]*?)\/\*\s*GAME-TUNING-END\s*\*\//;

/** A tuning block value. Deliberately primitives only — the same set the bridge
 *  will copy across at runtime. */
export type TuningValue = number | string | boolean;
export type GameTuning = Record<string, TuningValue>;

/**
 * Extract the declared tuning block from a source file. Returns `null` when the
 * file has no block or the block isn't valid JSON — a malformed block is
 * "absent", never a throw, because this runs at persist time over agent-authored
 * code and must not be able to fail a run.
 */
export function parseGameTuning(source: string): GameTuning | null {
  const m = MARKED_RE.exec(source);
  const body = m?.[1];
  if (body === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: GameTuning = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** True when the source already declares a tuning block. */
export function hasGameTuning(source: string): boolean {
  return MARKED_RE.test(source);
}

/**
 * Derive a default tweak schema from a tuning block, so a game that declared its
 * numbers gets usable sliders even if the agent never called
 * `declare_tweak_schema`. Ranges bracket the declared value (0 → 2×, or ±2× for
 * a negative), which is the right band for feel tuning: enough room to see the
 * change, not so much that the slider is unusable.
 *
 * The agent's explicit schema always wins where it overlaps; this only fills gaps.
 */
export function inferTweakSchema(tuning: GameTuning): Record<string, Record<string, unknown>> {
  const schema: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(tuning)) {
    if (typeof value === 'boolean') {
      schema[key] = { kind: 'boolean' };
      continue;
    }
    if (typeof value === 'string') {
      // A hex colour is far more useful as a swatch than as a text field.
      schema[key] = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
        ? { kind: 'color' }
        : { kind: 'string' };
      continue;
    }
    const magnitude = Math.abs(value);
    const max = magnitude === 0 ? 1 : magnitude * 2;
    const min = value < 0 ? -max : 0;
    // Aim for ~100 steps across the band, snapped to a readable increment.
    const rawStep = (max - min) / 100;
    const step = rawStep >= 1 ? Math.max(1, Math.round(rawStep)) : rawStep >= 0.1 ? 0.1 : 0.01;
    schema[key] = { kind: 'number', min, max, step };
  }
  return schema;
}
