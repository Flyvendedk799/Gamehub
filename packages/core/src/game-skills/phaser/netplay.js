// when_to_use: Same-origin multiplayer / local netplay. The platform hosts a
// /rt WebSocket on the game origin (connect-src 'self'). Use this for 2-player
// vs / co-op that must stay CSP-legal. NEVER open sockets to third-party hosts.
//
// S11 — Summer's SDK is multiplayer-native. We match the useful subset on the
// web under locked CSP: rooms + authoritative tick + setSynced.

/**
 * Minimal same-origin netplay client. Server relay lives at `wss?://<host>/rt`.
 * @param {object} opts
 * @param {string} [opts.path='/rt']
 * @param {string} [opts.room]
 */
export function createNetplay(opts = {}) {
  const path = opts.path ?? '/rt';
  const room = opts.room ?? 'default';
  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {Map<string, unknown>} */
  const synced = new Map();
  /** @type {Set<(state: Record<string, unknown>) => void>} */
  const listeners = new Set();
  let playerId = null;
  let isHost = false;

  function emit() {
    const snap = Object.fromEntries(synced);
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  return {
    connect() {
      if (typeof WebSocket === 'undefined') {
        throw new Error('WebSocket unavailable');
      }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}${path}?room=${encodeURIComponent(room)}`);
      socket.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'welcome') {
          playerId = msg.playerId;
          isHost = !!msg.isHost;
        } else if (msg.type === 'sync' && msg.state && typeof msg.state === 'object') {
          for (const [k, v] of Object.entries(msg.state)) synced.set(k, v);
          emit();
        }
      });
      return new Promise((resolve, reject) => {
        if (!socket) return reject(new Error('no socket'));
        socket.addEventListener('open', () => resolve(undefined));
        socket.addEventListener('error', () => reject(new Error('netplay connect failed')));
      });
    },
    setSynced(key, value) {
      synced.set(key, value);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'sync', key, value }));
      }
      emit();
    },
    getSynced(key) {
      return synced.get(key);
    },
    onSync(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getPlayerId() {
      return playerId;
    },
    isHost() {
      return isHost;
    },
    close() {
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };
}
