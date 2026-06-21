// when_to_use: localStorage save/load for game state — reach for this whenever
// the game needs to persist progress, high scores, checkpoints, or settings
// across page reloads. All reads/writes are wrapped in try/catch so corrupt or
// missing data never crashes the game. The schema is versioned: if the stored
// version doesn't match the current one the save is discarded and a fresh
// default is returned. Capability tag: hasProgression.

/**
 * Create a save-state manager for a given storage key.
 *
 * config:
 *   key          localStorage key (default 'playforge_save')
 *   version      integer schema version (default 1); bump when save shape changes
 *   defaults     the "factory fresh" state object (gets deep-cloned on load miss)
 */
export function createSaveState(config = {}) {
  const storageKey = config.key ?? 'playforge_save';
  const version = config.version ?? 1;
  const defaults = config.defaults ?? {};

  function _cloneDefaults() {
    return JSON.parse(JSON.stringify(defaults));
  }

  /**
   * Load and return the saved state object.
   * Returns a deep-clone of `defaults` when nothing is saved or the version
   * doesn't match (treats version mismatch as a clean slate).
   */
  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return _cloneDefaults();
      const parsed = JSON.parse(raw);
      if (parsed?.__version !== version) return _cloneDefaults();
      const { __version: _v, ...data } = parsed;
      return data;
    } catch {
      return _cloneDefaults();
    }
  }

  /**
   * Persist `data` under the storage key, stamping it with the current version.
   * Returns true on success, false if localStorage is unavailable or full.
   */
  function save(data) {
    try {
      const payload = { __version: version, ...data };
      localStorage.setItem(storageKey, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear the save for this key (fresh start / delete-save feature).
   */
  function clear() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // localStorage unavailable — nothing to do.
    }
  }

  /**
   * Check whether a save exists and matches the current version.
   */
  function hasSave() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return parsed?.__version === version;
    } catch {
      return false;
    }
  }

  /**
   * High-score helper: compare `score` to the stored best and update if better.
   * `scoreKey` is the property name inside the save object (default 'highScore').
   * Returns { isNew: boolean, best: number }.
   */
  function checkHighScore(score, scoreKey = 'highScore') {
    const current = load();
    const prev = typeof current[scoreKey] === 'number' ? current[scoreKey] : 0;
    if (score > prev) {
      current[scoreKey] = score;
      save(current);
      return { isNew: true, best: score };
    }
    return { isNew: false, best: prev };
  }

  /**
   * Merge a partial update into the existing save without overwriting unrelated
   * fields. Equivalent to Object.assign(load(), patch) → save().
   */
  function patch(partial) {
    const current = load();
    save({ ...current, ...partial });
  }

  return {
    load,
    save,
    clear,
    hasSave,
    patch,
    checkHighScore,
  };
}

// Usage:
//   import { createSaveState } from './engine/save-state.js';
//   // Once at app/scene init — outside create() so it persists scene restarts:
//   const saveState = createSaveState({
//     key: 'mygame_v1',
//     version: 1,
//     defaults: { level: 0, coins: 0, highScore: 0, settings: { sfxVol: 0.8 } },
//   });
//
//   // create(): restore progress
//   const saved = saveState.load();
//   this.level    = saved.level;
//   this.coins    = saved.coins;
//
//   // On checkpoint / level complete:
//   saveState.patch({ level: this.level, coins: this.coins });
//
//   // On game over:
//   const { isNew, best } = saveState.checkHighScore(this.score);
//   if (isNew) this.hud.flash(`New best: ${best}!`);
//
//   // Settings toggle:
//   saveState.patch({ settings: { sfxVol: 0.5 } });
//
//   // New game / wipe save:
//   saveState.clear();
//
//   //   window.__game.debug.snapshot = () => ({ save: saveState.load() });
