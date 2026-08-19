'use client';

/**
 * Physical feedback for the jam room — the bits that make a phone feel like a
 * game controller rather than a web page.
 *
 * Two things, both strictly additive: a haptic pulse on the beats that matter,
 * and a screen wake lock so a phone sitting on a table through a 60-second
 * round doesn't dim and lock right as its owner is about to type.
 *
 * Deliberately NO sound. Five phones in one room all chiming on the same event
 * is a cacophony, not atmosphere — and the one device that matters (whatever is
 * playing the finished game) makes its own noise.
 *
 * Every API here is best-effort. `navigator.vibrate` is absent on iOS Safari
 * and the Wake Lock API is absent on older browsers; both degrade to nothing,
 * and no feature depends on either working.
 */

import { useEffect, useRef } from 'react';

/** The beats worth feeling, and the pulse pattern (ms) for each. */
const HAPTIC_PATTERNS = {
  /** A new question just landed — heads up. */
  round: [18, 60, 18],
  /** Your idea is in. A single confident tick. */
  locked: [22],
  /** The last player locked in; the reveal is coming. */
  reveal: [14, 40, 14, 40, 26],
  /** Someone hyped an idea, or you did. Barely there. */
  tap: [8],
  /** The game finished building. The payoff beat. */
  ready: [30, 70, 30, 70, 60],
  /** Something went wrong. Two flat buzzes read as "no". */
  error: [40, 90, 40],
} as const;

export type JamHaptic = keyof typeof HAPTIC_PATTERNS;

/**
 * Fire a haptic pulse. Silently no-ops where vibration is unavailable (iOS
 * Safari, desktop) or where the user has asked for reduced motion — some people
 * set that specifically because motion and buzzing make them ill, and a party
 * game is not a good reason to override them.
 */
export function jamHaptic(beat: JamHaptic): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    navigator.vibrate(HAPTIC_PATTERNS[beat] as unknown as number[]);
  } catch {
    // Some browsers throw when vibration is blocked by a permissions policy.
  }
}

/** True when the viewer has asked the OS to keep motion to a minimum. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface WakeLockLike {
  release(): Promise<void>;
  released: boolean;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> };
}

/**
 * Hold a screen wake lock while `active` is true.
 *
 * A jam is a long stretch of looking at a phone without touching it: reading a
 * question, watching the roster fill, waiting out a build. Default screen
 * timeouts are 30 seconds on plenty of devices, so without this half the room
 * is unlocking their phone every time something happens.
 *
 * Re-acquires on visibility change, because browsers drop the lock whenever the
 * tab is backgrounded and do NOT restore it when you come back.
 */
export function useJamWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockLike | null>(null);

  useEffect(() => {
    if (!active || typeof navigator === 'undefined') return;
    const wakeLock = (navigator as unknown as WakeLockNavigator).wakeLock;
    if (!wakeLock) return;

    let cancelled = false;

    const acquire = async () => {
      if (cancelled || lockRef.current?.released === false) return;
      try {
        lockRef.current = await wakeLock.request('screen');
      } catch {
        // Denied (battery saver, no user gesture yet). The room still works;
        // the screen just dims as it normally would.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [active]);
}

/**
 * Fire a haptic whenever `key` changes to a new non-null value — but never on
 * the first render.
 *
 * The distinction matters: a phone that reconnects mid-jam, or a page that
 * simply mounts on round 3, must not buzz for a round that started minutes ago.
 * Only a transition the player actually witnessed is worth feeling.
 */
export function useJamBeat(key: string | number | null, beat: JamHaptic): void {
  const previous = useRef<string | number | null>(null);
  const primed = useRef(false);

  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      previous.current = key;
      return;
    }
    if (key !== null && key !== previous.current) {
      previous.current = key;
      jamHaptic(beat);
    } else {
      previous.current = key;
    }
  }, [key, beat]);
}
