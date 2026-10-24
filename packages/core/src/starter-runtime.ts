/** Browser source embedded in every new project's engine. Kept in one place
 * so 2D and 3D starters cannot silently diverge in timing/audio behavior. */
export const STARTER_LOOP = String.raw`
/** One frame callback; optional fixedUpdate runs before it at a bounded fixed rate.
 * step(dtSeconds, activeTimeMs, interpolationAlpha). pause/resume preserve manual pause. */
export function runLoop(step, options = {}) {
  const fixedStep = Number.isFinite(options.fixedStep) && options.fixedStep > 0
    ? Math.max(0.001, options.fixedStep) : 1 / 60;
  const maxSubSteps = Number.isFinite(options.maxSubSteps)
    ? Math.max(1, Math.min(10, Math.floor(options.maxSubSteps))) : 5;
  let last = null, elapsed = 0, accumulator = 0, raf = 0;
  let paused = false, disposed = false;
  function schedule() {
    if (!disposed && !paused && !document.hidden && !raf) raf = requestAnimationFrame(frame);
  }
  function resetDelta() {
    last = null; accumulator = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function frame(t) {
    raf = 0;
    if (disposed || paused || document.hidden) { resetDelta(); return; }
    const dt = last === null ? 0 : Math.max(0, Math.min((t - last) / 1000, 0.05));
    last = t; elapsed += dt;
    if (typeof options.fixedUpdate === 'function') {
      accumulator += dt;
      let count = 0;
      while (accumulator + 1e-10 >= fixedStep && count < maxSubSteps) {
        options.fixedUpdate(fixedStep);
        if (disposed || paused) return;
        accumulator = Math.max(0, accumulator - fixedStep);
        count++;
      }
      if (accumulator >= fixedStep) accumulator %= fixedStep;
    }
    step(dt, elapsed * 1000, accumulator / fixedStep);
    schedule();
  }
  function visibility() { resetDelta(); schedule(); }
  function dispose() {
    if (disposed) return;
    disposed = true; resetDelta();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', dispose);
  }
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', dispose);
  schedule();
  return {
    pause() { paused = true; resetDelta(); },
    resume() { if (!paused || disposed) return; paused = false; resetDelta(); schedule(); },
    dispose,
  };
}
`;

export const STARTER_RESIZE = String.raw`
/** Observe the actual canvas container, including editor panel/layout changes. */
export function watchStageSize(canvas, resize) {
  let width = 0, height = 0, ratio = 0, disposed = false;
  function measure() {
    if (disposed) return;
    const w = Math.max(1, canvas.clientWidth || 1);
    const h = Math.max(1, canvas.clientHeight || 1);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    if (w === width && h === height && dpr === ratio) return;
    width = w; height = h; ratio = dpr;
    resize(w, h, dpr);
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', measure);
  measure();
  return () => {
    disposed = true;
    observer?.disconnect();
    window.removeEventListener('resize', measure);
  };
}
`;

export const STARTER_AUDIO = String.raw`
// One bounded audio graph for the whole game, including scene changes/restarts.
let audioCtx, audioMaster, audioMuted = false;
const audioVoices = new Set();
function unlockAudio() {
  if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);
export function setMuted(muted) {
  audioMuted = !!muted;
  if (audioMaster) audioMaster.gain.value = audioMuted ? 0 : 0.35;
}
export function disposeAudio() {
  for (const voice of audioVoices) {
    try { voice.oscillator.stop(); } catch {}
    voice.oscillator.disconnect(); voice.gain.disconnect();
  }
  audioVoices.clear();
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
  audioCtx = undefined; audioMaster = undefined;
}
window.addEventListener('pagehide', disposeAudio);
export function sfx(freq = 440, dur = 0.08, type = 'square') {
  if (audioMuted || document.hidden || audioVoices.size >= 16) return;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return;
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioCtor();
      audioMaster = audioCtx.createGain();
      audioMaster.gain.value = 0.35;
      audioMaster.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const oscillator = audioCtx.createOscillator(), gain = audioCtx.createGain();
    const duration = Number.isFinite(dur) ? Math.max(0.01, Math.min(2, dur)) : 0.08;
    oscillator.type = ['sine', 'square', 'sawtooth', 'triangle'].includes(type) ? type : 'sine';
    oscillator.frequency.value = Number.isFinite(freq) ? Math.max(20, Math.min(16000, freq)) : 440;
    oscillator.connect(gain); gain.connect(audioMaster);
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    const voice = { oscillator, gain };
    audioVoices.add(voice);
    oscillator.onended = () => {
      oscillator.disconnect(); gain.disconnect(); audioVoices.delete(voice);
    };
    oscillator.start(); oscillator.stop(now + duration);
  } catch {
    // Audio availability or autoplay policy must never abort gameplay.
    disposeAudio();
  }
}
`;
