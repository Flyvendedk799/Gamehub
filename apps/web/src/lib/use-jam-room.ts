'use client';

/**
 * useJamRoom — the party room's live connection.
 *
 * Opens the room WebSocket and keeps `state` at whatever the server last said.
 * The server broadcasts the FULL room snapshot on every change (a room is a few
 * KB), so there is no client-side merge to get wrong: a phone that wakes from a
 * locked screen is correct on its first frame.
 *
 * ## Why there is a polling fallback
 * The people this is built for are on phones, on other people's wifi, walking
 * between rooms. WebSockets die constantly in that world, and captive portals
 * and some corporate proxies block the upgrade outright. So the socket is an
 * OPTIMIZATION, never a requirement: whenever it is not open, the hook polls
 * `GET /v1/jams/:code` — the identical view — on a slow timer. Nothing in the
 * feature depends on the socket being up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type JamState, getJam, jamRoomSocketUrl } from './jam';

/** A transient nudge worth animating (someone joined, an idea landed). */
export interface JamToast {
  id: number;
  kind: 'join' | 'leave' | 'answer' | 'vote' | 'phase' | 'error';
  message: string;
  playerId: string | null;
}

export interface JamRoomState {
  state: JamState | null;
  /** True while the socket is open. False means the poller is carrying us. */
  live: boolean;
  /** Null until the first snapshot lands; a load error otherwise. */
  error: string | null;
  /** Most recent toasts, newest last. Capped so a long jam can't grow forever. */
  toasts: JamToast[];
  /** Force a refresh — used right after a local action so the UI doesn't wait. */
  refresh: () => void;
}

/** Backoff for socket reconnects: quick at first, then back off, capped at 15s. */
export function jamReconnectDelay(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** Math.max(0, attempt));
}

/** How often to re-read the room when the socket is down. */
const POLL_INTERVAL_MS = 2500;
/** Slow heartbeat even while live, so a silently-dead socket self-heals. */
const LIVE_POLL_INTERVAL_MS = 20_000;
const MAX_TOASTS = 4;

export function useJamRoom(code: string | null, seatToken: string | null): JamRoomState {
  const [state, setState] = useState<JamState | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<JamToast[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const toastSeq = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const liveRef = useRef(false);
  liveRef.current = live;

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const pushToast = useCallback((toast: Omit<JamToast, 'id'>) => {
    toastSeq.current += 1;
    const withId: JamToast = { ...toast, id: toastSeq.current };
    setToasts((prev) => [...prev, withId].slice(-MAX_TOASTS));
    // Toasts are ambient, not modal — they expire on their own so nobody has to
    // dismiss anything mid-round.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== withId.id));
    }, 3200);
  }, []);

  // ── socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!code || typeof window === 'undefined') return;

    let destroyed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (destroyed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(jamRoomSocketUrl(code as string, seatToken));
      } catch {
        // A blocked upgrade must not break the room — the poller has it.
        reconnectTimer = setTimeout(connect, jamReconnectDelay(attempt++));
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        if (destroyed) {
          ws.close();
          return;
        }
        attempt = 0;
        setLive(true);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (destroyed) return;
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            state?: JamState;
            kind?: JamToast['kind'];
            message?: string;
            playerId?: string | null;
          };
          if (msg.type === 'jam_state' && msg.state) {
            setState(msg.state);
            setError(null);
          } else if (msg.type === 'jam_toast' && msg.message) {
            pushToast({
              kind: msg.kind ?? 'phase',
              message: msg.message,
              playerId: msg.playerId ?? null,
            });
          }
        } catch {
          // A malformed frame is not worth breaking the room over.
        }
      };

      ws.onclose = () => {
        setLive(false);
        socketRef.current = null;
        if (!destroyed) reconnectTimer = setTimeout(connect, jamReconnectDelay(attempt++));
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [code, seatToken, pushToast]);

  // ── poller ────────────────────────────────────────────────────────────────
  // Runs always: fast while the socket is down (it IS the transport then), slow
  // while live (a heartbeat that heals a socket which died without an event).
  // refreshTick is not read in the body — bumping it IS the trigger: a local
  // action (answer, vote, next) re-runs this effect so the room updates on the
  // actor's own screen instead of waiting a poll interval for the server's echo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a deliberate re-run trigger, not a read dependency.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      try {
        const { state: next } = await getJam(code as string, seatToken);
        if (!cancelled) {
          setState(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled && !liveRef.current) {
          setError(err instanceof Error ? err.message : 'Lost the room');
        }
      }
      if (!cancelled) {
        timer = setTimeout(tick, liveRef.current ? LIVE_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [code, seatToken, refreshTick]);

  return useMemo(
    () => ({ state, live, error, toasts, refresh }),
    [state, live, error, toasts, refresh],
  );
}

/**
 * Seconds left on the current round, ticking locally.
 *
 * The server owns the deadline (an epoch ms), so every phone counts down to the
 * same instant regardless of clock skew in the render loop. Returns null when
 * the jam is untimed — the host advances by hand then.
 */
export function useJamCountdown(deadlineAt: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (deadlineAt === null) {
      setRemaining(null);
      return;
    }
    const compute = () => setRemaining(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
    compute();
    const id = setInterval(compute, 250);
    return () => clearInterval(id);
  }, [deadlineAt]);

  return remaining;
}
