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
    function buildManifest(){return {actions:order.map(function(id){return {id:id,label:(meta[id]&&meta[id].label)||id,description:(meta[id]&&meta[id].description)||'',keys:(bindings[id]||[]).slice()};})};}
    function postManifest(){try{if(window.parent&&window.parent!==window)window.parent.postMessage({type:${JSON.stringify(MANIFEST_TYPE)},manifest:buildManifest()},'*');}catch(e){}}
    function define(m){bindings={};meta={};order=[];var as=(m&&m.actions)||[];for(var i=0;i<as.length;i++){var a=as[i];if(!a||!a.id)continue;order.push(a.id);bindings[a.id]=(a.keys||[]).slice();meta[a.id]={label:a.label||a.id,description:a.description||''};}api.manifest=buildManifest();postManifest();return api;}
    function rebind(n){if(!n)return;for(var id in n){if(Object.prototype.hasOwnProperty.call(n,id))bindings[id]=(n[id]||[]).slice();}api.manifest=buildManifest();postManifest();}
    window.addEventListener('keydown',function(e){if(e.repeat)return;down[e.code]=true;for(var id in bindings){if(keysFor(id).indexOf(e.code)!==-1){var hs=handlers[id]||[];for(var j=0;j<hs.length;j++){try{hs[j]();}catch(_){}}}}},true);
    window.addEventListener('keyup',function(e){down[e.code]=false;},true);
    var api={manifest:null,define:define,isDown:isDown,on:on,rebind:rebind};
    window.__game.controls=api;
  }
  window.addEventListener('message',function(e){
    if(e.source&&e.source!==window.parent)return;
    if(e&&e.data&&e.data.type===${JSON.stringify(REBIND_TYPE)}&&e.data.bindings){try{window.__game.controls.rebind(e.data.bindings);}catch(_){}}
    if(e&&e.data&&e.data.type===${JSON.stringify(REQUEST_TYPE)}){try{if(window.parent&&window.parent!==window)window.parent.postMessage({type:${JSON.stringify(MANIFEST_TYPE)},manifest:window.__game.controls.manifest},'*');}catch(_){}}
  });
})();</script>`;

/**
 * Insert the controls runtime right after `<head>` (so it runs before any body
 * script, i.e. the game module) — or prepend if there's no head. Idempotent.
 */
export function injectControlsRuntime(html: string): string {
  if (html.includes(CONTROLS_RUNTIME_MARKER)) return html;
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}\n${CONTROLS_RUNTIME_SNIPPET}${html.slice(at)}`;
  }
  return `${CONTROLS_RUNTIME_SNIPPET}\n${html}`;
}
