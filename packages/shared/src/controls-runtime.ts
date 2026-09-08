/**
 * Serve-time controls runtime injector (WS-A).
 *
 * The rebindable controls runtime (`window.__game.controls`) is also embedded by
 * the engine starters — but an agent that writes its OWN index.html instead of
 * the starter ships WITHOUT it. The game's defensive
 * `window.__game.controls = window.__game.controls || fallback` then lands on a
 * stub that never posts the manifest, and the builder's Controls tab stays empty.
 *
 * Injecting this at the SERVING layer (preview route + export) guarantees the
 * real, manifest-posting, rebindable runtime is present and runs BEFORE the game
 * module, regardless of what HTML the agent wrote. Idempotent: the IIFE only
 * installs when a real runtime (with `rebind`) is absent, and we skip injection
 * when the marker is already present.
 *
 * Message-type constants mirror `packages/runtime/src/engines/types.ts` and
 * `apps/web/src/lib/iframe-bridge.ts` — kept in lockstep by hand.
 */

import { ART_RUNTIME_MARKER, ART_RUNTIME_SNIPPET } from './art-runtime';
import { GAMEPAD_BRIDGE_MARKER, GAMEPAD_BRIDGE_SNIPPET } from './controls-gamepad';
import { GAME_TUNING_BRIDGE_MARKER, GAME_TUNING_BRIDGE_SNIPPET } from './game-tuning';
import { RUNTIME_BEACON_MARKER, RUNTIME_BEACON_SNIPPET } from './runtime-beacon';

const MANIFEST_TYPE = 'playforge:controls:manifest';
const REBIND_TYPE = 'playforge:controls:rebind';
const REQUEST_TYPE = 'playforge:controls:request';

/** Marker so a double pass (or a starter that already embedded it) doesn't inject twice. */
export const CONTROLS_RUNTIME_MARKER = 'pf-controls-runtime';

/** The injectable `<script>` — self-contained, idempotent, ES5. */
export const CONTROLS_RUNTIME_SNIPPET = `<script data-pf="${CONTROLS_RUNTIME_MARKER}">(function(){
  window.__game = window.__game || {};
  var c = window.__game.controls;
  if (!c || typeof c.rebind !== 'function') {
    var bindings={},meta={},order=[],down={},handlers={};
    function keysFor(id){return bindings[id]||[];}
    function isDown(id){var k=keysFor(id);for(var i=0;i<k.length;i++){if(down[k[i]])return true;}return false;}
    function on(id,fn){(handlers[id]=handlers[id]||[]).push(fn);return api;}
    function buildManifest(){return {actions:order.map(function(id){var a={id:id,label:(meta[id]&&meta[id].label)||id,description:(meta[id]&&meta[id].description)||'',keys:(bindings[id]||[]).slice()};if(meta[id]&&meta[id].pointer)a.pointer=meta[id].pointer;return a;})};}
    function postManifest(){try{if(window.parent&&window.parent!==window)window.parent.postMessage({type:${JSON.stringify(MANIFEST_TYPE)},manifest:buildManifest()},'*');}catch(e){}}
    function define(m){bindings={};meta={};order=[];var as=(m&&m.actions)||[];for(var i=0;i<as.length;i++){var a=as[i];if(!a||!a.id)continue;order.push(a.id);bindings[a.id]=(a.keys||[]).slice();meta[a.id]={label:a.label||a.id,description:a.description||'',pointer:a.pointer||''};}api.manifest=buildManifest();postManifest();return api;}
    function rebind(n){if(!n)return;for(var id in n){if(Object.prototype.hasOwnProperty.call(n,id))bindings[id]=(n[id]||[]).slice();}api.manifest=buildManifest();postManifest();}
    function press(code){down[code]=true;for(var id in bindings){if(keysFor(id).indexOf(code)!==-1){var hs=handlers[id]||[];for(var j=0;j<hs.length;j++){try{hs[j]();}catch(_){}}}}}
    window.addEventListener('keydown',function(e){if(e.repeat||e.__pfRemap)return;press(e.code);},true);
    window.addEventListener('keyup',function(e){if(e.__pfRemap)return;down[e.code]=false;},true);
    window.addEventListener('mousedown',function(e){if(e.__pfRemap)return;press('Mouse'+e.button);},true);
    window.addEventListener('mouseup',function(e){if(e.__pfRemap)return;down['Mouse'+e.button]=false;},true);
    window.addEventListener('contextmenu',function(e){e.preventDefault();});
    var api={manifest:null,define:define,isDown:isDown,on:on,rebind:rebind};
    window.__game.controls=api;
  }
  window.addEventListener('message',function(e){
    if(e.source&&e.source!==window.parent)return;
    if(e&&e.data&&e.data.type===${JSON.stringify(REBIND_TYPE)}&&e.data.bindings){try{window.__game.controls.rebind(e.data.bindings);}catch(_){}}
    if(e&&e.data&&e.data.type===${JSON.stringify(REQUEST_TYPE)}){try{if(window.parent&&window.parent!==window)window.parent.postMessage({type:${JSON.stringify(MANIFEST_TYPE)},manifest:window.__game.controls.manifest},'*');}catch(_){}}
  });
})();</script>`;

/** Marker so the defensive debug contract isn't installed twice. */
export const DEBUG_RUNTIME_MARKER = 'pf-debug-runtime';

/**
 * Defensive `window.__game.debug` contract — the SAME default the engine
 * starters embed via `gameGlobalSetupSnippet` (packages/runtime types.ts), so
 * the served host and the verify/playtest sandbox agree on the full `__game`
 * shape, not just `controls`+`art`.
 *
 * Why this exists at the serving/verify layer: `injectControlsRuntime` already
 * re-creates `window.__game` and restores `controls`+`art` for an agent-authored
 * index.html that dropped the starter shim — but it left `debug` absent. That
 * asymmetry meant `playtest_game` read `window.__game.debug.snapshot` off an
 * object that had no `debug`, throwing instead of surfacing an honest
 * `no_debug_contract`. Installing the default here closes the gap.
 *
 * Idempotent + honest: it only installs when no real `debug.snapshot` is present
 * (so a game that wires its own contract wins), and `snapshot()` returns `null`
 * until state/tracked fields exist — it never fakes a contract. ES5,
 * self-contained.
 */
export const DEBUG_RUNTIME_SNIPPET = `<script data-pf="${DEBUG_RUNTIME_MARKER}">(function(){
  window.__game = window.__game || {};
  if (window.__game.debug && typeof window.__game.debug.snapshot === 'function') return;
  var tracked = {};
  function read(v){try{return typeof v==='function'?v():v;}catch(e){return null;}}
  function reflectPos(o){if(!o)return undefined;var x=o.x,y=o.y;if((x===undefined||y===undefined)&&o.position){x=o.position.x;y=o.position.y;}if(x===undefined&&y===undefined)return undefined;return {x:x,y:y};}
  function track(spec){if(spec&&typeof spec==='object'){for(var k in spec)tracked[k]=spec[k];}return api;}
  function snapshot(){var st=window.__game.state;var hasState=st&&typeof st==='object'&&Object.keys(st).length>0;var hasTracked=Object.keys(tracked).length>0;if(!hasState&&!hasTracked)return null;var out={};if(hasState){for(var k in st)out[k]=read(st[k]);}for(var t in tracked){if(t==='player'){var p=reflectPos(read(tracked.player));if(p)out.playerPos=p;}else{out[t]=read(tracked[t]);}}return out;}
  var api={track:track,snapshot:snapshot};
  window.__game.debug=api;
})();</script>`;

/** Marker for the end-of-body manifest bridge (separate from the head runtime). */
export const CONTROLS_MANIFEST_BRIDGE_MARKER = 'pf-controls-manifest-bridge';

/**
 * End-of-body manifest BRIDGE. Generated games routinely ship their OWN inline
 * `window.__game.controls` shim (for standalone play) that does
 * `controls.define = ({actions}) => {...}` — UNCONDITIONALLY overwriting the head
 * runtime's `define`. That shim wires input (so the game plays) but never posts
 * the controls manifest, so the builder's Controls panel stays empty even though
 * the game declares controls. The head runtime's `define` (which DOES post) is
 * clobbered.
 *
 * This bridge runs at the END of `<body>` — AFTER any such inline shim — and
 * wraps whatever `controls.define` is current so it ALSO posts the manifest to
 * the parent. A short poll re-wraps if `define` is reassigned later (e.g. a shim
 * that runs inside the deferred game module), so the panel populates regardless
 * of which runtime ends up active. Idempotent (the `__pfWrapped` flag) and ES5.
 */
export const CONTROLS_MANIFEST_BRIDGE_SNIPPET = `<script data-pf="${CONTROLS_MANIFEST_BRIDGE_MARKER}">(function(){
  var MT=${JSON.stringify(MANIFEST_TYPE)},RT=${JSON.stringify(REQUEST_TYPE)};
  function curActions(c){return (c&&((c.manifest&&c.manifest.actions)||c.actions))||[];}
  function post(actions){if(!actions||!actions.length)return;try{var mf={actions:actions};var c=window.__game&&window.__game.controls;if(c)c.manifest=mf;if(window.parent&&window.parent!==window)window.parent.postMessage({type:MT,manifest:mf},'*');}catch(e){}}
  function wrap(){
    var c=window.__game&&window.__game.controls;
    if(!c||typeof c.define!=='function'||c.define.__pfWrapped)return;
    var orig=c.define;
    function wrapped(m){var r=orig.apply(this,arguments);post((m&&m.actions)||curActions(c));return r;}
    wrapped.__pfWrapped=true;
    c.define=wrapped;
    var cur=curActions(c);if(cur.length)post(cur);
  }
  var iv=setInterval(wrap,100);setTimeout(function(){clearInterval(iv);},15000);wrap();
  window.addEventListener('message',function(e){if(e&&e.data&&e.data.type===RT){post(curActions(window.__game&&window.__game.controls));}});
})();</script>`;

/** Marker for the key-remap bridge (translates rebinds for direct-reading games). */
export const CONTROLS_REMAP_BRIDGE_MARKER = 'pf-controls-remap-bridge';

/**
 * Key-REMAP bridge — what makes the Controls tab actually change the controls.
 *
 * `controls:rebind` only reaches games that read input through
 * `window.__game.controls.isDown()/on()`. In practice most generated games read
 * the keyboard directly (`cursors.left.isDown`, their own `keydown` listener, a
 * bundled shim that overwrote `window.__game.controls` with an object that has
 * no `rebind`) — so rebinding a key in the builder changed a manifest and
 * nothing else. The keys kept doing what the game hard-coded.
 *
 * This bridge closes that gap the same way the gamepad bridge does: it
 * translates input at the EVENT level. Given the game's DECLARED defaults (sent
 * alongside the bindings) it computes, per rebind:
 *
 *   • remap  — a key now bound to an action it isn't a default of dispatches a
 *              synthetic event for that action's declared key, which is the key
 *              the game's own code reads.
 *   • block  — a declared key that no longer drives its own action is swallowed
 *              (preventDefault + stopImmediatePropagation), so an unbound key
 *              goes dead and a swap doesn't fire both sides.
 *
 * Ordering is load-bearing: the head runtime registers its window-capture
 * listeners first, so a `controls.isDown` game still sees the RAW key and its
 * own rebind path keeps working; this bridge runs after and only rewrites what
 * reaches everything downstream. Synthetic events carry `__pfRemap` so the head
 * runtime ignores them (otherwise a swap would trigger both actions) and so the
 * bridge never re-enters itself.
 *
 * Dormant until a rebind arrives WITH defaults, and a no-op while the bindings
 * still match those defaults. Pad codes are left alone — they're the gamepad
 * bridge's job. ES5, self-contained, idempotent.
 */
export const CONTROLS_REMAP_BRIDGE_SNIPPET = `<script data-pf="${CONTROLS_REMAP_BRIDGE_MARKER}">(function(){
  var REBIND=${JSON.stringify(REBIND_TYPE)};
  var defaults=null, remap={}, block={}, busy=false;
  var KEYVAL={Space:' ',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',Enter:'Enter',Escape:'Escape',ShiftLeft:'Shift',ShiftRight:'Shift',Tab:'Tab'};
  function keyVal(code){ if(KEYVAL[code])return KEYVAL[code]; if(/^Key([A-Z])$/.test(code))return code.slice(3).toLowerCase(); if(/^Digit(\\d)$/.test(code))return code.slice(5); return code; }
  function isPad(c){ return /^Pad(\\d+|L(?:Left|Right|Up|Down))$/.test(c); }
  function has(o,k){ return Object.prototype.hasOwnProperty.call(o,k); }
  function target(){ return document.querySelector('canvas') || document; }
  function build(bindings){
    remap={}; block={};
    if(!defaults||!bindings) return;
    for(var id in bindings){ if(!has(bindings,id)) continue;
      var decl=defaults[id]||[], canon=null;
      for(var i=0;i<decl.length;i++){ if(!isPad(decl[i])){ canon=decl[i]; break; } }
      if(canon===null) continue;               // action the game declared no key for
      var cur=bindings[id]||[];
      for(var j=0;j<cur.length;j++){
        var c=cur[j];
        if(isPad(c)) continue;                 // controller codes: gamepad bridge's job
        if(decl.indexOf(c)!==-1) continue;     // still one of its own declared keys
        (remap[c]=remap[c]||[]).push(canon);
      }
    }
    // A declared key that no longer drives its own action must stop reaching the
    // game — otherwise an unbound key keeps working and a swap fires both sides.
    for(var id2 in defaults){ if(!has(defaults,id2)) continue;
      var ks=defaults[id2]||[], now=bindings[id2]||[];
      for(var k=0;k<ks.length;k++){ if(!isPad(ks[k])&&now.indexOf(ks[k])===-1) block[ks[k]]=true; }
    }
    // Never block a key that is still a live default of some OTHER action.
    for(var id3 in bindings){ if(!has(bindings,id3)) continue;
      var live=bindings[id3]||[];
      for(var m=0;m<live.length;m++){ var lc=live[m]; if((defaults[id3]||[]).indexOf(lc)!==-1) delete block[lc]; }
    }
  }
  function fire(code,down){
    try{
      busy=true;
      var t=target(), mm=/^Mouse(\\d+)$/.exec(code), ev;
      if(mm) ev=new MouseEvent(down?'mousedown':'mouseup',{button:+mm[1],bubbles:true,cancelable:true});
      else ev=new KeyboardEvent(down?'keydown':'keyup',{code:code,key:keyVal(code),bubbles:true,cancelable:true});
      try{ ev.__pfRemap=true; }catch(_){}
      t.dispatchEvent(ev);
    }catch(e){}finally{ busy=false; }
  }
  function handle(e,code,down){
    if(busy||e.__pfRemap) return;
    var outs=remap[code], blocked=block[code];
    if(!outs&&!blocked) return;
    if(blocked){ if(e.cancelable)e.preventDefault(); e.stopImmediatePropagation(); }
    if(outs){ for(var i=0;i<outs.length;i++) fire(outs[i],down); }
  }
  window.addEventListener('keydown',function(e){ handle(e,e.code,true); },true);
  window.addEventListener('keyup',function(e){ handle(e,e.code,false); },true);
  window.addEventListener('mousedown',function(e){ handle(e,'Mouse'+e.button,true); },true);
  window.addEventListener('mouseup',function(e){ handle(e,'Mouse'+e.button,false); },true);
  window.addEventListener('message',function(e){
    if(!e||!e.data||e.data.type!==REBIND) return;
    if(e.data.defaults) defaults=e.data.defaults;   // the game's DECLARED keys
    build(e.data.bindings);
  });
})();</script>`;

/**
 * Inject the rebindable controls runtime + the bridges:
 *   - the head runtime right after `<head>` (runs before the game module),
 *   - the manifest bridge right before `</body>` (runs AFTER any game-bundled
 *     controls shim, so the manifest still reaches the builder's Controls panel), and
 *   - the key-remap bridge right before `</body>` (translates a rebind into the
 *     keys a directly-reading game actually listens for).
 * All are idempotent on their own markers.
 */
export function injectControlsRuntime(html: string): string {
  let out = html;
  // Runtime beacon FIRST at <head> — installed before any other script so its
  // error listeners catch crashes anywhere (including a boot crash) and its rAF
  // wrapper is in place before the game schedules a frame. Preview-only.
  if (!out.includes(RUNTIME_BEACON_MARKER)) {
    const headOpen = /<head[^>]*>/i.exec(out);
    if (headOpen?.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      out = `${out.slice(0, at)}\n${RUNTIME_BEACON_SNIPPET}${out.slice(at)}`;
    } else {
      out = `${RUNTIME_BEACON_SNIPPET}\n${out}`;
    }
  }
  if (!out.includes(CONTROLS_RUNTIME_MARKER)) {
    const headOpen = /<head[^>]*>/i.exec(out);
    if (headOpen?.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      out = `${out.slice(0, at)}\n${CONTROLS_RUNTIME_SNIPPET}${out.slice(at)}`;
    } else {
      out = `${CONTROLS_RUNTIME_SNIPPET}\n${out}`;
    }
  }
  // Debug contract (window.__game.debug.snapshot/track). Restores the same
  // default the engine starter embeds, so an agent-authored index.html that
  // dropped the starter — and the verify/playtest sandbox that loads it — still
  // expose a readable (honest-null) debug contract instead of throwing on a
  // missing `debug`. Runs before the game module; idempotent via marker + the
  // inner "real snapshot already present" guard.
  if (!out.includes(DEBUG_RUNTIME_MARKER)) {
    const headOpen = /<head[^>]*>/i.exec(out);
    if (headOpen?.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      out = `${out.slice(0, at)}\n${DEBUG_RUNTIME_SNIPPET}${out.slice(at)}`;
    } else {
      out = `${DEBUG_RUNTIME_SNIPPET}\n${out}`;
    }
  }
  // Representational-art runtime (window.__game.art). Like the controls runtime, a
  // game whose author REPLACED index.html ships without the bootstrap art shim, so
  // re-inject it here at <head> (before the game module) — idempotent via its marker
  // + the inner `if (window.__game.art) return` guard.
  if (!out.includes(ART_RUNTIME_MARKER)) {
    const headOpen = /<head[^>]*>/i.exec(out);
    if (headOpen?.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      out = `${out.slice(0, at)}\n${ART_RUNTIME_SNIPPET}${out.slice(at)}`;
    } else {
      out = `${ART_RUNTIME_SNIPPET}\n${out}`;
    }
  }
  // Live-tuning bridge (window.__game.tuning). At <head> so the object exists
  // before the game module runs and can assign its own GAME_TUNING block over
  // it. This is what makes the builder's "Live tweaks" panel actually move a
  // game: the React/Babel tweaks-bridge it replaces is inert without ReactDOM,
  // so for Phaser/Three games nothing was listening at all. See game-tuning.ts.
  if (!out.includes(GAME_TUNING_BRIDGE_MARKER)) {
    const headOpen = /<head[^>]*>/i.exec(out);
    if (headOpen?.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      out = `${out.slice(0, at)}\n${GAME_TUNING_BRIDGE_SNIPPET}${out.slice(at)}`;
    } else {
      out = `${GAME_TUNING_BRIDGE_SNIPPET}\n${out}`;
    }
  }
  if (!out.includes(CONTROLS_MANIFEST_BRIDGE_MARKER)) {
    const bodyClose = /<\/body\s*>/i.exec(out);
    if (bodyClose?.index !== undefined) {
      out = `${out.slice(0, bodyClose.index)}${CONTROLS_MANIFEST_BRIDGE_SNIPPET}\n${out.slice(bodyClose.index)}`;
    } else {
      out = `${out}\n${CONTROLS_MANIFEST_BRIDGE_SNIPPET}`;
    }
  }
  // Key-remap bridge — makes a rebind reach games that read the keyboard
  // directly instead of through `window.__game.controls`. Must come AFTER the
  // head runtime's listeners (it is injected at </body>) so a controls-reading
  // game still sees the raw key first. Dormant until a rebind carries defaults.
  if (!out.includes(CONTROLS_REMAP_BRIDGE_MARKER)) {
    const bodyClose = /<\/body\s*>/i.exec(out);
    if (bodyClose?.index !== undefined) {
      out = `${out.slice(0, bodyClose.index)}${CONTROLS_REMAP_BRIDGE_SNIPPET}\n${out.slice(bodyClose.index)}`;
    } else {
      out = `${out}\n${CONTROLS_REMAP_BRIDGE_SNIPPET}`;
    }
  }
  // Gamepad bridge — translates controller input into the synthetic key/mouse
  // events the game already listens for. Dormant until handed pad-coded bindings
  // (via controls:rebind), so it's strictly opt-in: preview games are unaffected
  // until the user clicks "Add controller support". Published games bake their own
  // copy (the add_controller_support tool); the marker prevents a double-inject.
  if (!out.includes(GAMEPAD_BRIDGE_MARKER)) {
    const bodyClose = /<\/body\s*>/i.exec(out);
    if (bodyClose?.index !== undefined) {
      out = `${out.slice(0, bodyClose.index)}${GAMEPAD_BRIDGE_SNIPPET}\n${out.slice(bodyClose.index)}`;
    } else {
      out = `${out}\n${GAMEPAD_BRIDGE_SNIPPET}`;
    }
  }
  return out;
}
