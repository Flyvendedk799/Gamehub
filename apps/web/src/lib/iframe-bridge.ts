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
export const TWEAKS_UPDATE_MESSAGE_TYPE = 'playforge:tweaks:update' as const;

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

// ─── Controls protocol (WS-A) — mirrors runtime engines/types.ts ──────────────

export const CONTROLS_MANIFEST_MESSAGE_TYPE = 'playforge:controls:manifest' as const;
export const CONTROLS_REBIND_MESSAGE_TYPE = 'playforge:controls:rebind' as const;
export const CONTROLS_REQUEST_MESSAGE_TYPE = 'playforge:controls:request' as const;

export interface ControlAction {
  id: string;
  label: string;
  description?: string;
  /** KeyboardEvent.code values bound to this action. */
  keys: string[];
}
export interface ControlsManifest {
  actions: ControlAction[];
}

/** Validate + parse an inbound `controls:manifest` message from the game. */
export function parseControlsManifestMessage(
  event: MessageEvent<unknown>,
): ControlsManifest | null {
  if (!isPreviewIframeOrigin(event.origin)) return null;
  const data = event.data as { type?: unknown; manifest?: unknown } | null;
  if (!data || data.type !== CONTROLS_MANIFEST_MESSAGE_TYPE) return null;
  const manifest = data.manifest as { actions?: unknown } | null;
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.actions)) return null;
  const actions: ControlAction[] = [];
  for (const raw of manifest.actions) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'] : null;
    if (!id) continue;
    const keys = Array.isArray(o['keys'])
      ? o['keys'].filter((k): k is string => typeof k === 'string')
      : [];
    actions.push({
      id,
      label: typeof o['label'] === 'string' ? o['label'] : id,
      keys,
      ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
    });
  }
  return { actions };
}

/** Host → game: apply rebound keys (actionId → KeyboardEvent.code[]). */
export function sendControlsRebind(
  iframe: HTMLIFrameElement | null,
  bindings: Record<string, string[]>,
): void {
  iframe?.contentWindow?.postMessage(
    { type: CONTROLS_REBIND_MESSAGE_TYPE, bindings },
    PREVIEW_IFRAME_ORIGIN,
  );
}

/** Host → game: ask the game to re-post its current control manifest. */
export function sendControlsRequest(iframe: HTMLIFrameElement | null): void {
  iframe?.contentWindow?.postMessage(
    { type: CONTROLS_REQUEST_MESSAGE_TYPE },
    PREVIEW_IFRAME_ORIGIN,
  );
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
