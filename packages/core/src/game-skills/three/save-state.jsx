// when_to_use: localStorage save/load system for browser games — versioned JSON
// blobs so you can evolve the schema without corrupting older saves. Reach for
// this whenever a game needs to persist progress, settings, or inventory across
// page refreshes. Wraps every read/write in try/catch so a quota error or
// corrupted entry never crashes the game. Includes a highscore helper (keep
// best N scores with metadata) and a slot system so multiple save files coexist
// under different keys. Engine-agnostic: plain JS, no Three.js dependency.

// ---------------------------------------------------------------------------
// Core save/load.
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 1;

/** Create a save-state manager for a named `slotKey`.
 *
 *  opts:
 *    version   -> integer schema version (default 1); bumping triggers migrate
 *    migrate   -> (oldVersion, data) => newData; transform legacy saves
 *    prefix    -> localStorage key prefix (default 'pf_save')
 */
export function createSaveState(slotKey, opts = {}) {
  const version = opts.version ?? CURRENT_VERSION;
  const prefix = opts.prefix ?? 'pf_save';
  const storageKey = `${prefix}__${slotKey}`;

  function _read() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      return parsed;
    } catch {
      return null;
    }
  }

  function _write(envelope) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /** Save `data` (any JSON-serialisable object). Stamps version + timestamp.
   *  Returns true on success. */
  function save(data) {
    return _write({ version, savedAt: Date.now(), data });
  }

  /** Load saved data. Returns the data object, or `defaultValue` if nothing
   *  is stored or the stored version is incompatible and no migrate fn is set. */
  function load(defaultValue = null) {
    const envelope = _read();
    if (envelope === null || envelope === undefined) return defaultValue;
    if (typeof envelope !== 'object') return defaultValue;

    if (envelope.version !== version) {
      if (opts.migrate) {
        try {
          const migrated = opts.migrate(envelope.version, envelope.data);
          return migrated ?? defaultValue;
        } catch {
          return defaultValue;
        }
      }
      // No migrate fn — discard stale save.
      return defaultValue;
    }
    return envelope.data ?? defaultValue;
  }

  /** Erase this slot. */
  function clear() {
    try {
      localStorage.removeItem(storageKey);
      return true;
    } catch {
      return false;
    }
  }

  /** Check whether a save exists (any version). */
  function exists() {
    return _read() !== null;
  }

  /** Metadata about the saved slot (timestamp, version) without full parse. */
  function meta() {
    const envelope = _read();
    if (!envelope) return null;
    return { version: envelope.version, savedAt: envelope.savedAt };
  }

  return { save, load, clear, exists, meta };
}

// ---------------------------------------------------------------------------
// Multi-slot manager — list / delete named slots sharing a prefix.
// ---------------------------------------------------------------------------

/** Manage multiple save slots under a shared `prefix`. */
export function createSaveSlotManager(prefix = 'pf_save') {
  /** List all slot keys that exist under this prefix. */
  function listSlots() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(`${prefix}__`)) {
          keys.push(k.slice(prefix.length + 2));
        }
      }
    } catch {
      /* storage unavailable */
    }
    return keys;
  }

  function deleteSlot(slotKey) {
    try {
      localStorage.removeItem(`${prefix}__${slotKey}`);
      return true;
    } catch {
      return false;
    }
  }

  function clearAll() {
    const slots = listSlots();
    for (const s of slots) deleteSlot(s);
  }

  return { listSlots, deleteSlot, clearAll };
}

// ---------------------------------------------------------------------------
// Highscore helper — persists the best N entries with metadata.
// ---------------------------------------------------------------------------

/** Store and retrieve the best `maxEntries` scores (highest first).
 *
 *  Each entry: { score: number, name?: string, meta?: any, at: timestamp }
 *  Submit via addScore(score, extra?). Returns the leaderboard array. */
export function createHighscores(storageKey = 'pf_highscores', maxEntries = 10) {
  function _load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function _save(board) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(board));
    } catch {
      /* quota */
    }
  }

  /** Get the current leaderboard (sorted best → worst). */
  function getScores() {
    return _load();
  }

  /** Submit a new score. `extra` can be { name, meta } or omitted.
   *  Returns the new board and the rank (1-based) of the submitted entry,
   *  or null if it didn't make the board. */
  function addScore(score, extra = {}) {
    const board = _load();
    const entry = { score, name: extra.name ?? 'Player', meta: extra.meta ?? null, at: Date.now() };
    board.push(entry);
    board.sort((a, b) => b.score - a.score);
    if (board.length > maxEntries) board.length = maxEntries;
    _save(board);
    const rank = board.findIndex((e) => e === entry);
    return { board, rank: rank === -1 ? null : rank + 1 };
  }

  /** Return the single best score (number), or 0 if none. */
  function getBest() {
    const board = _load();
    return board[0]?.score ?? 0;
  }

  /** Wipe all highscores. */
  function clear() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }

  return { getScores, addScore, getBest, clear };
}

// ---------------------------------------------------------------------------
// Settings helper — thin typed key/value store backed by localStorage.
// ---------------------------------------------------------------------------

/** Persist user settings (volume, graphics quality, key binds, etc.) as a
 *  single JSON object. Merges with `defaults` on load so new keys are safe. */
export function createSettings(storageKey = 'pf_settings', defaults = {}) {
  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return { ...defaults };
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return { ...defaults };
    }
  }

  function save(settings) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings));
      return true;
    } catch {
      return false;
    }
  }

  function reset() {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    return { ...defaults };
  }

  return { load, save, reset };
}

// Usage:
//   import { createSaveState, createHighscores, createSettings } from './save-state.jsx';
//
//   // Per-run progress save.
//   const save = createSaveState('run1', {
//     version: 2,
//     migrate: (oldV, data) => oldV === 1 ? { ...data, newField: 0 } : data,
//   });
//   save.save({ level: 3, coins: 180, inventory: ['sword', 'shield'] });
//   const progress = save.load({ level: 1, coins: 0, inventory: [] });
//
//   // Highscores (top 5).
//   const hs = createHighscores('pf_arcade_scores', 5);
//   const { board, rank } = hs.addScore(4200, { name: 'Alice' });
//   console.log(`Ranked #${rank} with score 4200`);
//
//   // Settings.
//   const settings = createSettings('pf_settings', { volume: 0.8, quality: 'medium' });
//   const s = settings.load();
//   s.volume = 0.5;
//   settings.save(s);
//
//   window.__game.debug.snapshot = () => ({
//     saveExists: save.exists(),
//     saveMeta: save.meta(),
//     bestScore: hs.getBest(),
//   });
