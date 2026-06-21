// when_to_use: cross-device persistent progress, high scores, and meta-progression
// (idle, RPG, roguelike unlocks) that must survive a different browser or device.
// Uses the window.__game.cloudSave postMessage bridge (injected by the Playforge
// host) when present; transparently falls back to localStorage so the game works
// standalone in any browser without an account. Prefer this over save-state.jsx
// whenever the project is cloud-hosted and per-account persistence matters. Engine-
// agnostic: plain JS, no Three.js dependency — importable via import_skill in any
// generated game. Every cloud + storage call is guarded so a transient error never
// throws into the render/animation loop. Capability tag: hasCloudProgression.

/**
 * Create a cloud-backed save manager for a given key.
 *
 * opts:
 *   key        storage key / cloud document id (required)
 *   version    integer schema version (default 1); bump when save shape changes
 *   defaults   "factory fresh" state object; deep-cloned on load miss
 */
export function createCloudSave(opts = {}) {
  const key = opts.key ?? 'playforge_cloud_save';
  const version = opts.version ?? 1;
  const defaults = opts.defaults ?? {};
  const scoresKey = `${key}:scores`;

  // ---------------------------------------------------------------------------
  // Bridge detection
  // ---------------------------------------------------------------------------

  /** Returns true when the Playforge host cloud bridge is available. */
  function isCloud() {
    return (
      typeof window !== 'undefined' &&
      typeof window.__game?.cloudSave?.get === 'function' &&
      typeof window.__game?.cloudSave?.set === 'function' &&
      typeof window.__game?.cloudSave?.clear === 'function'
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function _cloneDefaults() {
    return JSON.parse(JSON.stringify(defaults));
  }

  function _mergeDefaults(data) {
    // Shallow merge so new default keys appear on old saves without wiping data.
    return { ..._cloneDefaults(), ...data };
  }

  /** Unwrap a stored envelope; returns game-state object or cloned defaults. */
  function _unwrap(envelope) {
    if (!envelope || typeof envelope !== 'object') return _cloneDefaults();
    if (envelope.__version !== version) return _cloneDefaults();
    const { __version: _v, data } = envelope;
    if (!data || typeof data !== 'object') return _cloneDefaults();
    return _mergeDefaults(data);
  }

  // ---------------------------------------------------------------------------
  // Cloud bridge wrappers
  // ---------------------------------------------------------------------------

  async function _cloudGet(k) {
    try {
      return await window.__game.cloudSave.get(k);
    } catch {
      return null;
    }
  }

  async function _cloudSet(k, value) {
    try {
      await window.__game.cloudSave.set(k, value);
    } catch {
      // Cloud write failed — non-fatal; caller has already written localStorage.
    }
  }

  async function _cloudClear(k) {
    try {
      await window.__game.cloudSave.clear(k);
    } catch {
      // Ignore transient errors.
    }
  }

  // ---------------------------------------------------------------------------
  // localStorage fallback wrappers
  // ---------------------------------------------------------------------------

  function _localGet(k) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function _localSet(k, value) {
    try {
      localStorage.setItem(k, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage unavailable — silent.
    }
  }

  function _localClear(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      // Ignore.
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load state from cloud (or localStorage fallback).
   * Always resolves; returns defaults on any miss or error.
   */
  async function load() {
    try {
      const raw = isCloud() ? await _cloudGet(key) : _localGet(key);
      return _unwrap(raw);
    } catch {
      return _cloneDefaults();
    }
  }

  /**
   * Persist `state` to cloud (or localStorage fallback).
   * Stamps with current version. Debounce in the caller if you want to limit
   * write frequency (e.g. at most once per 5 s inside the animation loop).
   */
  async function save(state) {
    const envelope = { __version: version, data: state };
    if (isCloud()) {
      await _cloudSet(key, envelope);
    } else {
      _localSet(key, envelope);
    }
  }

  /**
   * Erase the save for this key on cloud AND localStorage so no stale fallback
   * data lingers after a cloud-connected wipe.
   */
  async function clear() {
    if (isCloud()) {
      await _cloudClear(key);
    }
    _localClear(key);
  }

  /**
   * Load → merge partial → save. Ideal for incremental updates in the game loop.
   * Returns the merged state so you can hand it back to Three.js scene objects.
   */
  async function patch(partial) {
    const current = await load();
    const merged = { ...current, ...partial };
    await save(merged);
    return merged;
  }

  // ---------------------------------------------------------------------------
  // High-score helpers (per-key leaderboard at `<key>:scores`)
  // ---------------------------------------------------------------------------

  const MAX_SCORES = 10;

  async function _loadScores() {
    try {
      const raw = isCloud() ? await _cloudGet(scoresKey) : _localGet(scoresKey);
      if (!Array.isArray(raw)) return [];
      return raw;
    } catch {
      return [];
    }
  }

  async function _saveScores(board) {
    if (isCloud()) {
      await _cloudSet(scoresKey, board);
    } else {
      _localSet(scoresKey, board);
    }
  }

  /**
   * Submit a score. `meta` can be { name, level, … } or omitted.
   * Returns { board, rank } — rank is 1-based, or null if off the board.
   * Never throws; returns { board: [], rank: null } on error.
   */
  async function submitHighScore(score, meta = {}) {
    try {
      const board = await _loadScores();
      const entry = { score, name: meta.name ?? 'Player', meta: meta ?? null, at: Date.now() };
      board.push(entry);
      board.sort((a, b) => b.score - a.score);
      if (board.length > MAX_SCORES) board.length = MAX_SCORES;
      await _saveScores(board);
      const rank = board.indexOf(entry);
      return { board, rank: rank === -1 ? null : rank + 1 };
    } catch {
      return { board: [], rank: null };
    }
  }

  /**
   * Return the stored leaderboard (highest score first).
   * Always resolves; returns [] on error.
   */
  async function getHighScores() {
    return _loadScores();
  }

  return {
    load,
    save,
    clear,
    patch,
    submitHighScore,
    getHighScores,
    isCloud,
  };
}

// Usage:
//   // Via import_skill in a generated game (engine-agnostic — works in both
//   // Phaser and Three.js runtimes):
//   import { createCloudSave } from './engine/cloud-save.jsx';
//
//   // Once at init time (outside the animation loop):
//   const cloud = createCloudSave({
//     key: 'mygame_progress',
//     version: 1,
//     defaults: { level: 1, xp: 0, unlocks: [] },
//   });
//
//   // On game start — restore progress:
//   const saved = await cloud.load();
//   player.level = saved.level;
//   player.xp    = saved.xp;
//
//   // On checkpoint (e.g. level complete, inside async handler):
//   await cloud.patch({ level: player.level, xp: player.xp });
//
//   // On run end — submit score and surface rank:
//   const { rank } = await cloud.submitHighScore(finalScore, { name: 'Alice' });
//   if (rank !== null) overlay.text = `Ranked #${rank} globally!`;
//
//   // Read back the leaderboard:
//   const board = await cloud.getHighScores();
//
//   // Hard reset:
//   await cloud.clear();
//
//   // NOTE: if window.__game.cloudSave is absent (older host or standalone play),
//   // every call silently falls back to localStorage with identical behaviour.
//   // isCloud() lets you adapt UI ("syncing…" vs "local only"):
//   console.log(cloud.isCloud() ? 'cloud-backed' : 'localStorage fallback');
//
//   window.__game.debug.snapshot = () => ({
//     isCloud: cloud.isCloud(),
//   });
