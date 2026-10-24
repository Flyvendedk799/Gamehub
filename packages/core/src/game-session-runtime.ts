/** Engine-neutral browser source, seeded alongside and re-exported by every starter's core module. */
export const GAME_SESSION_RUNTIME = String.raw`
/**
 * Serializable rules state for ANY game. Keep meshes/sprites/audio outside this store.
 * defineAction(name, (draft, payload, { random }) => { ... }) registers a rule.
 * dispatch commits atomically; returning false rejects the action without changing state.
 * advance(dtSeconds) drives managed timers from the game's existing loop (never adds a loop).
 * undo/redo/reset/restore cancel pending timers; re-arm rules timers after recovery as needed.
 */
export function createGameSession(initial, options = {}) {
  const copy = value => structuredClone(value);
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  function serializable(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Rules state must be finite, acyclic JSON data');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error('Keep engine objects outside rules state');
    seen.add(value);
    for (const child of Object.values(value)) serializable(child, seen);
    seen.delete(value);
  }
  function checked(value) {
    serializable(value);
    if (options.validate && options.validate(value) === false) throw new Error('Rules state validation failed');
    return freeze(copy(value));
  }
  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error('Session version must be a positive integer');
  const historyLimit = Math.max(0, Math.min(200, Math.floor(Number.isFinite(options.historyLimit) ? options.historyLimit : 40)));
  const seed = (Number.isFinite(options.seed) ? options.seed : 1) >>> 0;
  let state = checked(typeof initial === 'function' ? initial() : initial);
  const original = copy(state);
  let rng = seed, time = 0, paused = false, disposed = false, dispatching = false, advancing = false;
  let past = [], future = [];
  const actions = new Map(), listeners = new Set(), timers = new Map();
  let timerId = 0;
  const ensure = () => { if (disposed) throw new Error('Game session has been disposed'); };
  const idle = () => { ensure(); if (dispatching) throw new Error('Do not mutate a session from inside an action or subscriber'); };
  function random() {
    rng = (rng + 0x6D2B79F5) >>> 0;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const checkpoint = () => ({ state: copy(state), rng, time });
  function notify(kind, action) {
    const wasDispatching = dispatching; dispatching = true;
    try {
      for (const listener of [...listeners]) {
        try { listener(state, { kind, action }); }
        catch (error) { try { if (options.onError) options.onError(error); else console.error(error); } catch { /* observers cannot roll back committed rules */ } }
      }
    } finally { dispatching = wasDispatching; }
  }
  function restorePoint(point, kind) {
    state = checked(point.state); rng = point.rng; time = point.time;
    timers.clear(); notify(kind);
  }
  const api = {
    get state() { return state; },
    get time() { return time; },
    get paused() { return paused; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    defineAction(name, reducer) {
      idle();
      if (typeof name !== 'string' || !name || typeof reducer !== 'function') throw new Error('An action needs a name and a reducer');
      if (actions.has(name)) throw new Error('Duplicate action: ' + name);
      actions.set(name, reducer); return api;
    },
    dispatch(name, payload) {
      idle();
      if (paused) return false;
      const reducer = actions.get(name);
      if (!reducer) throw new Error('Unknown action: ' + name);
      const before = checkpoint();
      const draft = copy(state);
      dispatching = true;
      try {
        const result = reducer(draft, copy(payload), { random });
        if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw new Error('Actions must be synchronous'); }
        if (result === false) { rng = before.rng; return false; }
        const next = checked(draft);
        if (historyLimit > 0) { past.push(before); if (past.length > historyLimit) past.shift(); }
        future = []; state = next; notify('action', name); return true;
      } catch (error) { rng = before.rng; throw error; }
      finally { dispatching = false; }
    },
    subscribe(listener) {
      idle(); if (typeof listener !== 'function') throw new Error('Subscriber must be a function');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    undo() {
      idle(); if (!past.length) return false;
      future.push(checkpoint()); restorePoint(past.pop(), 'undo'); return true;
    },
    redo() {
      idle(); if (!future.length) return false;
      past.push(checkpoint()); restorePoint(future.pop(), 'redo'); return true;
    },
    reset() {
      idle(); past = []; future = []; paused = false;
      restorePoint({ state: original, rng: seed, time: 0 }, 'reset');
    },
    pause() { idle(); paused = true; },
    resume() { idle(); paused = false; },
    after(seconds, callback) {
      idle();
      if (!Number.isFinite(seconds) || seconds < 0 || typeof callback !== 'function') throw new Error('Timer needs a nonnegative delay and callback');
      const id = ++timerId;
      timers.set(id, { due: time + seconds, callback });
      return () => timers.delete(id);
    },
    advance(dt) {
      idle(); if (paused) return;
      if (advancing) throw new Error('Do not recursively advance a session');
      if (!Number.isFinite(dt) || dt < 0) throw new Error('advance expects nonnegative seconds');
      time += dt;
      // Snapshot due work: callbacks scheduled by a callback run on the next advance,
      // preventing zero-delay recursion from locking the browser.
      const due = [...timers].filter(([, timer]) => timer.due <= time).sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
      advancing = true;
      try {
        for (const [id, timer] of due) {
          if (disposed || paused) break;
          if (!timers.delete(id)) continue;
          timer.callback(api);
        }
      } finally { advancing = false; }
    },
    snapshot() { ensure(); return { schemaVersion: version, ...checkpoint() }; },
    restore(snapshot) {
      idle();
      if (!snapshot || snapshot.schemaVersion !== version || !Number.isInteger(snapshot.rng) || snapshot.rng < 0 || snapshot.rng > 4294967295 || !Number.isFinite(snapshot.time) || snapshot.time < 0) throw new Error('Incompatible or corrupt session snapshot');
      const next = checked(snapshot.state);
      past = []; future = []; paused = false;
      restorePoint({ state: next, rng: snapshot.rng, time: snapshot.time }, 'restore');
    },
    dispose() { if (disposed) return; idle(); disposed = true; timers.clear(); actions.clear(); listeners.clear(); past = []; future = []; },
  };
  return api;
}
`;
