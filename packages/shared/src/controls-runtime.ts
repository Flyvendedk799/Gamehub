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
    window.addEventListener('keydown',function(e){if(e.repeat)return;press(e.code);},true);
    window.addEventListener('keyup',function(e){down[e.code]=false;},true);
    window.addEventListener('mousedown',function(e){press('Mouse'+e.button);},true);
    window.addEventListener('mouseup',function(e){down['Mouse'+e.button]=false;},true);
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
  function post(actions){try{var mf={actions:actions||[]};var c=window.__game&&window.__game.controls;if(c)c.manifest=mf;if(window.parent&&window.parent!==window)window.parent.postMessage({type:MT,manifest:mf},'*');}catch(e){}}
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

/**
 * Inject the rebindable controls runtime + the manifest bridge:
 *   - the head runtime right after `<head>` (runs before the game module), and
 *   - the manifest bridge right before `</body>` (runs AFTER any game-bundled
 *     controls shim, so the manifest still reaches the builder's Controls panel).
 * Both are idempotent on their own markers.
 */
export function injectControlsRuntime(html: string): string {
  let out = html;
  if (!out.includes(CONTROLS_RUNTIME_MARKER)) {
    const headOpen = /<head[^>]*>/i.exec(out);
    if (headOpen?.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      out = `${out.slice(0, at)}\n${CONTROLS_RUNTIME_SNIPPET}${out.slice(at)}`;
    } else {
      out = `${CONTROLS_RUNTIME_SNIPPET}\n${out}`;
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
  return out;
}
