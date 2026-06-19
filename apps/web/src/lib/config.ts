/**
 * Single source of truth for the API base URL (#32). Every module that needs to
 * reach the API imports `API_BASE` (or `API_WS_BASE` for WebSocket relays)
 * instead of re-reading `process.env['NEXT_PUBLIC_API_URL']` and re-deriving the
 * default, which previously drifted across ~6 files.
 */

export const DEFAULT_API_BASE = 'http://localhost:3191';

export const API_BASE: string = process.env['NEXT_PUBLIC_API_URL'] ?? DEFAULT_API_BASE;

/** Same origin as API_BASE but with the ws/wss scheme, for WebSocket routes. */
export const API_WS_BASE: string = API_BASE.replace(/^http/, 'ws');

/** Origin (scheme + host + port) of the API, used for postMessage targetOrigin. */
export const API_ORIGIN: string = (() => {
  try {
    return new URL(API_BASE).origin;
  } catch {
    return DEFAULT_API_BASE;
  }
})();
