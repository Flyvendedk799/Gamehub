/**
 * Controller (Gamepad) support for the rebindable controls system.
 *
 * Generated games read input as keyboard/mouse via `window.__game.controls`
 * (or their own inline shim, or Phaser/Three listeners). Rather than teach every
 * one of those to read the Gamepad API, we add a small serve-time/baked BRIDGE
 * that polls the Gamepad API and **dispatches synthetic keydown/keyup/mousedown**
 * for the key each controller button is mapped to. That works uniformly across
 * the platform runtime, a game-bundled shim, AND Phaser/Three — and survives
 * being baked into a published game (which never gets the serve-time injection).
 *
 * The button↔action mapping is computed ONCE here (`autoMapGamepad`) and shared
 * by the web Controls panel (live) and the `add_controller_support` agent tool
 * (baked). The bridge snippet itself is "dumb": it executes whatever
 * action→codes bindings it's handed (via the existing controls:rebind message,
 * or a baked `window.__pfGamepadBindings` global) — no heuristic lives in the
 * snippet, so there's nothing to drift.
 */

/** game → host: the controller connected/disconnected (for the panel badge). */
export const GAMEPAD_STATUS_MESSAGE_TYPE = 'playforge:controls:gamepad:status';
/** Baked global a published game reads its controller bindings from. */
export const GAMEPAD_BAKED_GLOBAL = '__pfGamepadBindings';

// ─── Standard gamepad vocabulary ──────────────────────────────────────────────
// Pad codes live alongside KeyboardEvent.code / 'Mouse0' in an action's `keys`
// array. Buttons: 'Pad0'..'Pad16' (W3C Standard Gamepad). Left-stick directions:
// 'PadLLeft'/'PadLRight'/'PadLUp'/'PadLDown'.

/** Standard-gamepad button index → friendly label (Xbox naming, DS in mind). */
const PAD_BUTTON_LABELS: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'Back',
  9: 'Start',
  10: 'L3',
  11: 'R3',
  12: 'D-Pad ↑',
  13: 'D-Pad ↓',
  14: 'D-Pad ←',
  15: 'D-Pad →',
  16: 'Guide',
};

const PAD_STICK_LABELS: Record<string, string> = {
  PadLLeft: 'L-Stick ←',
  PadLRight: 'L-Stick →',
  PadLUp: 'L-Stick ↑',
  PadLDown: 'L-Stick ↓',
};

/** True for any controller code ('Pad0'/'PadLLeft'); false for keys/mouse. */
export function isPadCode(code: string): boolean {
  return /^Pad(\d+|L(?:Left|Right|Up|Down))$/.test(code);
}

/** Friendly label for a controller code, or null if it isn't one. */
export function padLabel(code: string): string | null {
  if (code in PAD_STICK_LABELS) return PAD_STICK_LABELS[code] ?? null;
  const m = /^Pad(\d+)$/.exec(code);
  if (m?.[1] !== undefined) {
    const n = Number(m[1]);
    return PAD_BUTTON_LABELS[n] ?? `Button ${n}`;
  }
  return null;
}

// ─── Auto-map heuristic ───────────────────────────────────────────────────────

export interface GamepadMappableAction {
  id: string;
  label?: string;
  keys: string[];
  /** Pointer (mouse-axis) controls can't sensibly map to a button — skipped. */
  pointer?: string;
}

type Direction = 'up' | 'down' | 'left' | 'right';

const DIR_PAD_CODES: Record<Direction, string[]> = {
  up: ['Pad12', 'PadLUp'],
  down: ['Pad13', 'PadLDown'],
  left: ['Pad14', 'PadLLeft'],
  right: ['Pad15', 'PadLRight'],
};

const DIR_BY_KEY: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** Classify an action as a movement direction (for dpad/stick) or null. */
function directionOf(a: GamepadMappableAction): Direction | null {
  const id = a.id.toLowerCase();
  if (/(^|[^a-z])(up|north)([^a-z]|$)/.test(id)) return 'up';
  if (/(^|[^a-z])(down|south)([^a-z]|$)/.test(id)) return 'down';
  if (/(^|[^a-z])(left|west)([^a-z]|$)/.test(id)) return 'left';
  if (/(^|[^a-z])(right|east)([^a-z]|$)/.test(id)) return 'right';
  // Fall back to the declared arrow keys (only the unambiguous arrows).
  for (const k of a.keys) {
    const d = DIR_BY_KEY[k];
    if (d) return d;
  }
  return null;
}

/** Actions that should land on Start/Back rather than a face button. */
function isSystemAction(a: GamepadMappableAction): boolean {
  return /(^|[^a-z])(start|pause|menu|restart|retry|begin|resume|continue|select|back|quit|exit)([^a-z]|$)/.test(
    a.id.toLowerCase(),
  );
}

/** Higher = more likely to deserve the primary face button (A). */
function primacyScore(a: GamepadMappableAction): number {
  const id = a.id.toLowerCase();
  if (/(jump|attack|fire|shoot|hit|action|confirm|^ok$|accept|use|interact|primary)/.test(id)) {
    return 2;
  }
  if (/(dash|boost|special|secondary|build|place|grab|throw|block|reload)/.test(id)) return 1;
  return 0;
}

/** Face/shoulder button pool, in assignment priority: A, B, X, Y, RB, LB, RT, LT. */
const FACE_POOL = ['Pad0', 'Pad1', 'Pad2', 'Pad3', 'Pad5', 'Pad4', 'Pad7', 'Pad6'];

/**
 * Map the current controls onto a standard controller. Returns, per action id,
 * the controller codes to ADD (directional → dpad + left stick; the rest →
 * face/shoulder buttons by priority; pause/restart/etc → Start then Back).
 * Pointer-only actions and actions with no inputs are skipped.
 */
export function autoMapGamepad(
  actions: ReadonlyArray<GamepadMappableAction>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const systems: GamepadMappableAction[] = [];
  const buttons: GamepadMappableAction[] = [];

  for (const a of actions) {
    if (a.pointer) continue;
    const dir = directionOf(a);
    if (dir) {
      out[a.id] = [...DIR_PAD_CODES[dir]];
      continue;
    }
    (isSystemAction(a) ? systems : buttons).push(a);
  }

  // Face/shoulder buttons: most "primary" actions first, then declaration order.
  const ordered = buttons
    .map((a, i) => ({ a, i }))
    .sort((x, y) => primacyScore(y.a) - primacyScore(x.a) || x.i - y.i);
  let pool = 0;
  for (const { a } of ordered) {
    const code = FACE_POOL[pool];
    if (code) {
      out[a.id] = [code];
      pool += 1;
    }
  }

  // System actions: Start, then Back, then fall through to remaining face buttons.
  const systemCodes = ['Pad9', 'Pad8'];
  let sysIdx = 0;
  for (const a of systems) {
    const code = systemCodes[sysIdx] ?? FACE_POOL[pool++];
    if (code) {
      out[a.id] = [code];
      sysIdx += 1;
    }
  }

  return out;
}

/**
 * Merge auto-mapped controller codes into an existing bindings set (action id →
 * codes), de-duplicating. Keeps the keyboard/mouse binds; appends pad codes.
 */
export function mergeGamepadBindings(
  bindings: Record<string, string[]>,
  padByAction: Record<string, string[]>,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [id, codes] of Object.entries(bindings)) next[id] = [...codes];
  for (const [id, pads] of Object.entries(padByAction)) {
    const cur = next[id] ?? [];
    next[id] = [...cur, ...pads.filter((p) => !cur.includes(p))];
  }
  return next;
}

/** True if any action's bindings already include a controller code. */
export function hasGamepadBindings(bindings: Record<string, string[]>): boolean {
  return Object.values(bindings).some((codes) => codes.some(isPadCode));
}

/**
 * Build the BAKED bindings map a published game ships in `window.__pfGamepadBindings`
 * — for each mappable action, its keyboard/mouse keys (the dispatch targets) plus
 * the auto-mapped controller codes. Actions the heuristic skips are omitted.
 */
export function buildBakedGamepadBindings(
  actions: ReadonlyArray<GamepadMappableAction>,
): Record<string, string[]> {
  const padMap = autoMapGamepad(actions);
  const out: Record<string, string[]> = {};
  for (const a of actions) {
    const pads = padMap[a.id];
    if (pads?.length) out[a.id] = [...a.keys, ...pads];
  }
  return out;
}

/** Marker for the baked bindings global `<script>` (distinct from the bridge). */
export const GAMEPAD_BINDINGS_MARKER = 'pf-gamepad-bindings';

/**
 * Bake controller support into a game's HTML so it works in published/shared
 * games (which never get the serve-time injection): writes the `window.__pf
 * GamepadBindings` global + the bridge snippet before `</body>`. Idempotent —
 * re-baking replaces the bindings global, and the bridge is only added if it
 * isn't already present (serve-time or a prior bake).
 */
export function bakeGamepadIntoHtml(html: string, bindings: Record<string, string[]>): string {
  const out = html.replace(
    new RegExp(`<script data-pf="${GAMEPAD_BINDINGS_MARKER}">[\\s\\S]*?<\\/script>\\s*`, 'g'),
    '',
  );
  const globalScript = `<script data-pf="${GAMEPAD_BINDINGS_MARKER}">window.${GAMEPAD_BAKED_GLOBAL}=${JSON.stringify(bindings)};</script>`;
  const inject = out.includes(GAMEPAD_BRIDGE_MARKER)
    ? globalScript
    : `${globalScript}\n${GAMEPAD_BRIDGE_SNIPPET}`;
  const bodyClose = /<\/body\s*>/i.exec(out);
  if (bodyClose?.index !== undefined) {
    return `${out.slice(0, bodyClose.index)}${inject}\n${out.slice(bodyClose.index)}`;
  }
  return `${out}\n${inject}`;
}

// ─── The bridge snippet (ES5, self-contained, idempotent) ─────────────────────

export const GAMEPAD_BRIDGE_MARKER = 'pf-gamepad-bridge';

/**
 * Polls the Gamepad API and translates controller input into the synthetic
 * keyboard/mouse events the game already listens for. Bindings (action id →
 * codes, pad codes mixed in with keys) arrive via the `controls:rebind` message
 * (builder preview) or a baked `window.__pfGamepadBindings` global (published).
 * Dormant until it has at least one pad-coded binding, so it's strictly opt-in.
 */
export const GAMEPAD_BRIDGE_SNIPPET = `<script data-pf="${GAMEPAD_BRIDGE_MARKER}">(function(){
  var DZ=0.3, REBIND=${JSON.stringify('playforge:controls:rebind')}, STATUS=${JSON.stringify(GAMEPAD_STATUS_MESSAGE_TYPE)}, BAKED=${JSON.stringify(GAMEPAD_BAKED_GLOBAL)};
  var bindings=null, active={}, lastConnected=false, lastId='';
  var KEYVAL={Space:' ',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Enter:'Enter',Escape:'Escape',ShiftLeft:'Shift',ShiftRight:'Shift',Tab:'Tab'};
  function keyVal(code){ if(KEYVAL[code])return KEYVAL[code]; if(/^Key([A-Z])$/.test(code))return code.slice(3).toLowerCase(); if(/^Digit(\\d)$/.test(code))return code.slice(5); return code; }
  function target(){ return document.querySelector('canvas') || document; }
  function isPad(c){ return /^Pad(\\d+|L(?:Left|Right|Up|Down))$/.test(c); }
  function dispatch(code, down){
    try{
      var t=target(), m=/^Mouse(\\d+)$/.exec(code);
      if(m){ t.dispatchEvent(new MouseEvent(down?'mousedown':'mouseup',{button:+m[1],bubbles:true,cancelable:true})); return; }
      t.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code:code,key:keyVal(code),bubbles:true,cancelable:true}));
    }catch(e){}
  }
  function setBindings(b){
    // release anything currently held before swapping maps (no stuck keys)
    for(var id in active){ if(active[id]&&active[id].out) dispatch(active[id].out,false); }
    active={}; bindings=b||null;
  }
  function bakedBindings(){ try{ return window[BAKED]||null; }catch(e){ return null; } }
  function pick(){
    var pads; try{ pads=navigator.getGamepads&&navigator.getGamepads(); }catch(e){ return null; }
    if(!pads) return null;
    var best=null,score=-1;
    for(var i=0;i<pads.length;i++){ var p=pads[i]; if(!p||!p.connected) continue;
      var s=(p.mapping==='standard'?1e6:0)+p.buttons.length*1000+p.axes.length;
      if(s>score){ score=s; best=p; } }
    return best;
  }
  function btnDown(gp,n){ var b=gp.buttons[n]; return !!b&&(b.pressed||b.value>0.5); }
  function hat(gp,dir){ // axis-9 hat fallback for non-standard dpads
    if(gp.axes.length<=9) return false; var h=gp.axes[9]; if(h<-1.1||h>1.1) return false;
    if(dir==='up') return h<=-0.7||h>=0.95; if(dir==='right') return h>=-0.55&&h<=-0.1;
    if(dir==='down') return h>=-0.3&&h<=0.3; if(dir==='left') return h>=0.3&&h<=0.95; return false;
  }
  function codeActive(gp,c){
    var m=/^Pad(\\d+)$/.exec(c);
    if(m){ var n=+m[1]; if(btnDown(gp,n)) return true;
      if(n===12) return hat(gp,'up'); if(n===13) return hat(gp,'down'); if(n===14) return hat(gp,'left'); if(n===15) return hat(gp,'right'); return false; }
    if(c==='PadLLeft') return (gp.axes[0]||0)<-DZ; if(c==='PadLRight') return (gp.axes[0]||0)>DZ;
    if(c==='PadLUp') return (gp.axes[1]||0)<-DZ; if(c==='PadLDown') return (gp.axes[1]||0)>DZ;
    return false;
  }
  function postStatus(connected,id){
    try{ if(window.parent&&window.parent!==window) window.parent.postMessage({type:STATUS,connected:connected,id:id||''},'*'); }catch(e){}
  }
  function poll(){
    requestAnimationFrame(poll);
    var b=bindings||bakedBindings(); if(!b) return;
    var gp=pick();
    var connected=!!gp;
    if(connected!==lastConnected||(gp&&gp.id!==lastId)){ lastConnected=connected; lastId=gp?gp.id:''; postStatus(connected,lastId); }
    if(!gp) return;
    for(var id in b){ if(!Object.prototype.hasOwnProperty.call(b,id)) continue;
      var codes=b[id]||[], pads=[], out=null;
      for(var i=0;i<codes.length;i++){ if(isPad(codes[i])) pads.push(codes[i]); else if(out===null) out=codes[i]; }
      if(!pads.length||out===null) continue;
      var on=false; for(var j=0;j<pads.length;j++){ if(codeActive(gp,pads[j])){ on=true; break; } }
      var prev=active[id]; var wasOn=prev&&prev.on;
      if(on&&!wasOn) dispatch(out,true); else if(!on&&wasOn) dispatch(out,false);
      active[id]={on:on,out:out};
    }
  }
  window.addEventListener('message',function(e){ if(e&&e.data&&e.data.type===REBIND&&e.data.bindings) setBindings(e.data.bindings); });
  window.addEventListener('gamepadconnected',function(){});
  window.addEventListener('gamepaddisconnected',function(){});
  requestAnimationFrame(poll);
})();</script>`;
