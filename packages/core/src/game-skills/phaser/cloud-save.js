// when_to_use: cross-device persistent progress, high scores, and meta-progression
// (idle, RPG, roguelike unlocks) that must survive a different browser or device.
// Uses the window.__game.cloudSave postMessage bridge (injected by the Playforge
// host) when present; transparently falls back to localStorage so the game works
// standalone in any browser without an account. Prefer this over save-state.js
// whenever the project is cloud-hosted and per-account persistence matters. The
// API is fully async; every cloud + storage call is guarded so a transient cloud
// error never throws into the game loop. Capability tag: hasCloudProgression.

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
    // Shallow merge so new default keys appear on old saves.
    return { ..._cloneDefaults(), ...data };
  }

  /** Migrate and merge raw envelope data; returns game-state object. */
  function _unwrap(envelope) {
    if (!envelope || typeof envelope !== 'object') return _cloneDefaults();
    if (envelope.__version !== version) return _cloneDefaults();
    const { __version: _v, data } = envelope;
    if (!data || typeof data !== 'object') return _cloneDefaults();
    return _mergeDefaults(data);
  }

  // ---------------------------------------------------------------------------
  // Cloud bridge wrappers (each try/catch so errors are non-fatal)
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
      // Cloud unavailable — let caller decide whether to fall back.
    }
  }

  async function _cloudClear(k) {
    try {
      await window.__game.cloudSave.clear(k);
    } catch {
      // Ignore.
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
   * Stamps with current version. Safe to call on every checkpoint — debounce
   * in the caller if you need to throttle (e.g. only save every 5 s).
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
   * Erase the save for this key on cloud + localStorage.
   * Pass no argument to clear both; clears the matching store only.
   */
  async function clear() {
    if (isCloud()) {
      await _cloudClear(key);
    }
    // Always clear localStorage too so fallback data doesn't linger.
    _localClear(key);
  }

  /**
   * Load → merge partial → save. Use for incremental progress updates.
   * Returns the merged state.
   */
  async function patch(partial) {
    const current = await load();
    const merged = { ...current, ...partial };
    await save(merged);
    return merged;
  }

  // ---------------------------------------------------------------------------
  // High-score helpers (per-key leaderboard stored under `<key>:scores`)
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
   * Return the stored leaderboard array (highest score first).
   * Always resolves to an array (empty on error).
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
//   import { createCloudSave } from './engine/cloud-save.js';
//   // Once at Phaser scene init, outside create() so it survives scene restarts:
//   const cloud = createCloudSave({
//     key: 'mygame_progress',
//     version: 1,
//     defaults: { level: 1, coins: 0, unlocks: [] },
//   });
//
//   // create(): restore progress from cloud (await works fine in Phaser with an
//   // async create() or by chaining .then()):
//   const saved = await cloud.load();
//   this.level = saved.level;
//   this.coins = saved.coins;
//
//   // On checkpoint / level complete:
//   await cloud.patch({ level: this.level, coins: this.coins });
//
//   // On game over — submit score and show rank:
//   const { rank } = await cloud.submitHighScore(this.score, { name: 'Alice' });
//   if (rank !== null) this.hud.flash(`Ranked #${rank} globally!`);
//
//   // Read the leaderboard:
//   const board = await cloud.getHighScores();
//
//   // New game / wipe save:
//   await cloud.clear();
//
//   // Check which storage is active at runtime:
//   console.log(cloud.isCloud() ? 'cloud-backed' : 'localStorage fallback');
//
//   // NOTE: if window.__game.cloudSave is absent (older host or standalone),
//   // the skill silently falls back to localStorage with identical behaviour.
//
//   window.__game.debug.snapshot = () => ({
//     isCloud: cloud.isCloud(),
//   });
