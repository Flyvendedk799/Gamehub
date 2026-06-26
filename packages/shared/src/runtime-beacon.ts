/**
 * Runtime error/health BEACON for the builder preview.
 *
 * The boot-and-repair loop boots the game once at generation time, but it can't
 * catch a crash that only fires on a SPECIFIC player input (e.g. a sound played
 * from a key the synthetic playtest never pressed) or a render loop that dies
 * mid-session. This serve-time-injected beacon watches the LIVE preview and
 * reports trouble to the builder, which surfaces a "your game crashed — [Fix it]"
 * affordance.
 *
 * What it catches:
 *  - Uncaught errors + unhandled promise rejections (`window.onerror` /
 *    `unhandledrejection`) → a real runtime CRASH, with message + stack.
 *  - A dead render loop: it counts requestAnimationFrame ticks and heartbeats the
 *    count to the parent. If the game was animating and rAF flatlines while the
 *    thread is still alive, the loop FROZE.
 *
 * What it can't catch: a true main-thread infinite loop. A same-origin preview
 * shares the tab's thread, so a hard hang freezes the builder too — there's no
 * live observer left to report. (Process isolation would be needed; out of scope.)
 *
 * Preview-only: injected by `injectControlsRuntime` (the serving layer), never
 * baked into the published game.
 */

/** game → host: an uncaught runtime error / rejection. */
export const RUNTIME_ERROR_MESSAGE_TYPE = 'playforge:runtime:error';
/** game → host: a periodic health heartbeat (carries the rAF tick count). */
export const RUNTIME_ALIVE_MESSAGE_TYPE = 'playforge:runtime:alive';

export const RUNTIME_BEACON_MARKER = 'pf-runtime-beacon';

/**
 * Self-contained ES5 beacon. Installs error listeners + an rAF counter and
 * heartbeats `{type, raf}` to the parent every ~1.5s. Idempotent (marker) and
 * defensive (every post is wrapped). Errors are de-duplicated and capped so a
 * per-frame throw can't flood the bridge.
 */
export const RUNTIME_BEACON_SNIPPET = `<script data-pf="${RUNTIME_BEACON_MARKER}">(function(){
  var ET=${JSON.stringify(RUNTIME_ERROR_MESSAGE_TYPE)},HT=${JSON.stringify(RUNTIME_ALIVE_MESSAGE_TYPE)};
  var seen={},cap=0,rafCount=0;
  function post(o){try{if(window.parent&&window.parent!==window)window.parent.postMessage(o,'*');}catch(e){}}
  function report(message,stack){
    if(!message)return;
    var key=String(message).slice(0,160);
    if(seen[key]||cap>=25)return;seen[key]=1;cap++;
    post({type:ET,message:String(message).slice(0,500),stack:String(stack||'').slice(0,1200)});
  }
  window.addEventListener('error',function(e){
    // Resource-load failures (img/audio/script 404) have no .message — skip them;
    // they're not a game crash. Only real script errors carry a message.
    if(e&&e.message)report(e.message,e.error&&e.error.stack);
  },true);
  window.addEventListener('unhandledrejection',function(e){
    var r=e&&e.reason;report((r&&r.message)||('Unhandled promise rejection: '+String(r)),r&&r.stack);
  });
  // Count the game's render-loop ticks by wrapping rAF (delegates, never blocks).
  try{var _raf=window.requestAnimationFrame;if(typeof _raf==='function'){window.requestAnimationFrame=function(cb){rafCount++;return _raf.call(window,cb);};}}catch(e){}
  setInterval(function(){post({type:HT,raf:rafCount});rafCount=0;},1500);
})();</script>`;
