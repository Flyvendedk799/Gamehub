/**
 * Host-side helpers for the sandboxed game-preview iframe postMessage bridge.
 *
 * Protocol source of truth: `packages/runtime/src/engines/types.ts`
 * (`TWEAKS_UPDATE_MESSAGE_TYPE`) and `packages/runtime/src/tweaks-bridge.ts`,
 * which the in-iframe listener implements. `apps/web` does not depend on
 * `@playforge/runtime`, so the literal is mirrored here and kept in lockstep
 * by hand — if it changes there, change it here.
 *
 * Security (#20): the host MUST post tweak updates with an explicit
 * `targetOrigin` (the API/preview origin), never `'*'`, and MUST validate the
 * `origin` + shape of any inbound message before trusting it.
 */

import { API_ORIGIN } from './config';

/** Mirrors runtime `TWEAKS_UPDATE_MESSAGE_TYPE`. */
export const TWEAKS_UPDATE_MESSAGE_TYPE = 'codesign:tweaks:update' as const;

/**
 * The origin the preview/play iframes are served from. Preview and play are
 * served by the API, so its origin is the only origin we will postMessage to or
 * accept inbound bridge messages from.
 */
export const PREVIEW_IFRAME_ORIGIN: string = API_ORIGIN;

/** True when an inbound message event's origin is the trusted preview origin. */
export function isPreviewIframeOrigin(origin: string): boolean {
  return origin === PREVIEW_IFRAME_ORIGIN;
}

/** Shape of an inbound tweak-bridge ack/message we are willing to trust. */
export interface InboundBridgeMessage {
  type: string;
}

/**
 * Validates that an inbound `MessageEvent` came from the trusted preview origin
 * and carries a well-formed `{ type: string }` payload. Returns the typed
 * payload or `null` when the message should be ignored.
 */
export function parseInboundBridgeMessage(
  event: MessageEvent<unknown>,
): InboundBridgeMessage | null {
  if (!isPreviewIframeOrigin(event.origin)) return null;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return { type };
}
