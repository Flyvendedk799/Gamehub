'use client';

/**
 * Host-side (parent window) relay for cross-device game cloud-saves.
 *
 * The sandboxed game iframe posts `playforge:cloudsave` ops to its parent (this
 * window). This hook sits between that in-iframe shim and the session-authed
 * cloud-save API: it validates+parses each op (origin + source-window + shape),
 * calls the API, and replies to `get` ops with a `playforge:cloudsave:result`.
 * When a relay-capable (logged-in) host is present it posts
 * `playforge:cloudsave:ready` so the shim flips its `hosted` flag.
 *
 * Security (mirrors iframe-bridge.ts conventions):
 *  - REJECT any inbound message whose `source` isn't the iframe's contentWindow
 *    (the load-bearing gate, same as the score listener) — and additionally pin
 *    the origin to the preview origin for the same-origin builder preview. The
 *    public play iframe runs at an opaque origin (`origin === "null"`), so for it
 *    the source-window identity is the trust anchor.
 *  - NEVER trust any identity from the message — the API call is authed by the
 *    session token only; the iframe only supplies projectId-scoped key/value.
 *  - Post `result`/`ready` with `targetOrigin = PREVIEW_IFRAME_ORIGIN` for the
 *    same-origin preview; `'*'` is used ONLY for the opaque play iframe (a
 *    concrete origin can't reach it; the payload is the game's own save data).
 *  - Enforce the 100KB value cap parent-side too, so a malicious game can't spam
 *    the API with oversized `set`s.
 *  - Every handler is wrapped so a relay error can never break the host page.
 */

import { type RefObject, useEffect } from 'react';
import { CLOUD_SAVE_MAX_VALUE_BYTES, clearCloudSave, getCloudSave, setCloudSave } from './api';
import {
  type CloudSaveMessage,
  PREVIEW_IFRAME_ORIGIN,
  isPreviewIframeOrigin,
  parseCloudSavePayload,
  sendCloudSaveReady,
  sendCloudSaveResult,
} from './iframe-bridge';

/**
 * Delays (ms) at which we (re-)post `ready` to the iframe. The first fires
 * immediately; the later ones cover an iframe that attaches its listener late
 * (a Three.js game can take a moment to load its engine module), mirroring the
 * controls-request retry in PreviewPane.
 */
const READY_RETRY_DELAYS_MS = [0, 700, 1500, 3000] as const;

/**
 * Whether the iframe runs at an OPAQUE origin (the public play iframe: no
 * `allow-same-origin` in its sandbox). Opaque frames report `origin === "null"`
 * and can only be reached with a `'*'` targetOrigin. The same-origin builder
 * preview iframe (`allow-same-origin`) reports the API origin and is reached
 * with a concrete origin. Defaults to opaque (the safer parse path) when the
 * sandbox can't be read.
 */
function isOpaqueIframe(iframe: HTMLIFrameElement | null): boolean {
  if (!iframe) return true;
  try {
    return !iframe.sandbox.contains('allow-same-origin');
  } catch {
    return true;
  }
}

/** Approximate the JSON byte size of a value for the parent-side 100KB cap. */
function jsonByteSize(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    // `undefined` (and functions/symbols) stringify to `undefined` → no bytes.
    if (json === undefined) return 0;
    // TextEncoder is available in the browser; fall back to char length.
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
    return json.length;
  } catch {
    // Circular / non-serializable → treat as oversized so we skip the relay.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Wire the cloud-save relay onto the window `message` listener for one iframe.
 *
 * When `enabled && projectId`, this:
 *  - posts `ready` to the iframe (with a short retry for late attach);
 *  - relays each validated op to the API (get → fetch + result; set → PUT;
 *    clear → DELETE).
 *
 * @param iframeRef  Ref to the game `<iframe>` (its contentWindow is the relay peer).
 * @param projectId  Project the saves are scoped to; the relay is inert without it.
 * @param enabled    Gate on a logged-in, relay-capable host (e.g. `isLoggedIn()`).
 * @returns nothing — the effect's own cleanup tears the listener/timers down.
 */
export function useCloudSaveRelay(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  projectId: string | undefined,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || !projectId) return;

    let cancelled = false;

    async function handleOp(msg: CloudSaveMessage): Promise<void> {
      // `projectId` is captured non-null here (guarded above).
      const pid = projectId as string;
      const iframe = iframeRef.current;
      // Opaque (public play) iframes are only reachable with a '*' targetOrigin;
      // the same-origin builder preview uses the concrete preview origin (#20).
      const targetOrigin = isOpaqueIframe(iframe) ? '*' : PREVIEW_IFRAME_ORIGIN;

      if (msg.op === 'get') {
        // No requestId means we can't correlate a reply — drop it.
        if (msg.requestId === undefined) return;
        let value: unknown = null;
        try {
          const res = await getCloudSave(pid, msg.key as string);
          value = res.value;
        } catch {
          // Relay failure must look like "no value" to the game, not a hang.
          value = null;
        }
        if (cancelled) return;
        sendCloudSaveResult(iframe, msg.requestId, value, targetOrigin);
        return;
      }

      if (msg.op === 'set') {
        if (typeof msg.key !== 'string') return;
        // Parent-side 100KB cap so an oversized value never reaches the API.
        if (jsonByteSize(msg.value) > CLOUD_SAVE_MAX_VALUE_BYTES) return;
        try {
          await setCloudSave(pid, msg.key, msg.value);
        } catch {
          // best-effort — a failed save must not break the host page.
        }
        return;
      }

      if (msg.op === 'clear') {
        try {
          await clearCloudSave(pid, msg.key);
        } catch {
          // best-effort.
        }
      }
    }

    function onMessage(event: MessageEvent<unknown>): void {
      try {
        const iframe = iframeRef.current;
        // PRIMARY trust gate: the message must come from THIS iframe's window so
        // no other script / embed on the page can drive the relay as the
        // signed-in user (CSP H2 — the same check the score listener relies on).
        if (!iframe || event.source !== iframe.contentWindow) return;
        // SECONDARY (defense-in-depth): the same-origin builder preview reports a
        // real origin we can pin to PREVIEW_IFRAME_ORIGIN. The opaque public play
        // iframe reports `origin === "null"`, which a concrete-origin check can't
        // pin — for that frame, source-window identity above is the trust anchor.
        if (!isOpaqueIframe(iframe) && !isPreviewIframeOrigin(event.origin)) return;
        const msg = parseCloudSavePayload(event.data);
        if (!msg) return;
        void handleOp(msg);
      } catch {
        // A relay error must never break the host page.
      }
    }

    window.addEventListener('message', onMessage);

    // Announce a relay-capable host. Retry briefly in case the iframe attaches
    // its listener after we mount (like the controls-request retry).
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of READY_RETRY_DELAYS_MS) {
      timers.push(
        setTimeout(() => {
          if (!cancelled) {
            try {
              const iframe = iframeRef.current;
              const targetOrigin = isOpaqueIframe(iframe) ? '*' : PREVIEW_IFRAME_ORIGIN;
              sendCloudSaveReady(iframe, targetOrigin);
            } catch {
              // ignore — best-effort handshake.
            }
          }
        }, delay),
      );
    }

    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      for (const t of timers) clearTimeout(t);
    };
  }, [iframeRef, projectId, enabled]);
}
