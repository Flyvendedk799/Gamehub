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
  /** KeyboardEvent.code values AND/OR mouse buttons ('Mouse0'/'Mouse1'/'Mouse2'). */
  keys: string[];
  /** Set for a mouse-axis control (camera look / aim / drag) — shown, not rebound. */
  pointer?: 'look' | 'aim' | 'drag';
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
    const pointer = o['pointer'];
    actions.push({
      id,
      label: typeof o['label'] === 'string' ? o['label'] : id,
      keys,
      ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
      ...(pointer === 'look' || pointer === 'aim' || pointer === 'drag' ? { pointer } : {}),
    });
  }
  // Ignore an EMPTY manifest. The game posts its real manifest once it declares
  // controls, but the runtime's request-responders also fire BEFORE that (and on
  // every `controls:request`), posting `{actions: []}`. Accepting an empty
  // manifest would clobber a good one — the "binds flash then disappear" bug. A
  // game with genuinely zero controls simply never declares any, so it has no
  // manifest to show; treat empty exactly like "no manifest yet".
  if (actions.length === 0) return null;
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

/** Mirrors shared `GAMEPAD_STATUS_MESSAGE_TYPE` — game → host controller state. */
export const GAMEPAD_STATUS_MESSAGE_TYPE = 'playforge:controls:gamepad:status' as const;

export interface GamepadStatus {
  connected: boolean;
  /** The controller's id string (e.g. "Xbox Wireless Controller"), '' if none. */
  id: string;
}

/** Validate + parse an inbound `gamepad:status` message from the game iframe. */
export function parseGamepadStatusMessage(event: MessageEvent<unknown>): GamepadStatus | null {
  if (!isPreviewIframeOrigin(event.origin)) return null;
  const data = event.data as { type?: unknown; connected?: unknown; id?: unknown } | null;
  if (!data || data.type !== GAMEPAD_STATUS_MESSAGE_TYPE) return null;
  return {
    connected: data.connected === true,
    id: typeof data.id === 'string' ? data.id : '',
  };
}

// ─── Runtime beacon — live crash / freeze detection (mirrors runtime-beacon.ts) ─

export const RUNTIME_ERROR_MESSAGE_TYPE = 'playforge:runtime:error' as const;
export const RUNTIME_ALIVE_MESSAGE_TYPE = 'playforge:runtime:alive' as const;

export interface RuntimeErrorReport {
  message: string;
  stack: string;
}

/** Parse an inbound `runtime:error` — an uncaught crash in the live preview. */
export function parseRuntimeErrorMessage(event: MessageEvent<unknown>): RuntimeErrorReport | null {
  if (!isPreviewIframeOrigin(event.origin)) return null;
  const data = event.data as { type?: unknown; message?: unknown; stack?: unknown } | null;
  if (!data || data.type !== RUNTIME_ERROR_MESSAGE_TYPE) return null;
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  if (!message) return null;
  return { message, stack: typeof data.stack === 'string' ? data.stack : '' };
}

/** Parse an inbound `runtime:alive` heartbeat (`raf` = rAF ticks since last beat). */
export function parseRuntimeAliveMessage(event: MessageEvent<unknown>): { raf: number } | null {
  if (!isPreviewIframeOrigin(event.origin)) return null;
  const data = event.data as { type?: unknown; raf?: unknown } | null;
  if (!data || data.type !== RUNTIME_ALIVE_MESSAGE_TYPE) return null;
  return { raf: typeof data.raf === 'number' && Number.isFinite(data.raf) ? data.raf : 0 };
}

// ─── Cloud-save protocol — mirrors the in-iframe cloud-save shim ──────────────
//
// The sandboxed game posts these to its parent window; the host relays them to
// the session-authed cloud-save API. As with the controls/tweaks protocols,
// `apps/web` doesn't depend on the runtime package, so these literals are
// mirrored here by hand and kept in lockstep with the shim.

export const CLOUD_SAVE_MESSAGE_TYPE = 'playforge:cloudsave' as const;
export const CLOUD_SAVE_RESULT_MESSAGE_TYPE = 'playforge:cloudsave:result' as const;
export const CLOUD_SAVE_READY_MESSAGE_TYPE = 'playforge:cloudsave:ready' as const;

/** A validated, parsed inbound cloud-save op from the game iframe. */
export interface CloudSaveMessage {
  op: 'get' | 'set' | 'clear';
  /** `null` is only valid for `clear` (= clear all keys for the project). */
  key: string | null;
  /** Present for `set` — the value to persist (arbitrary JSON). */
  value?: unknown;
  /** Present for `get` — correlates the async `result` reply. */
  requestId?: string;
}

/**
 * Validate the SHAPE of an inbound cloud-save payload (origin-agnostic). Returns
 * the typed op or `null` for a malformed payload. Origin/source trust is layered
 * on by the callers (`parseCloudSaveMessage` for the same-origin preview iframe;
 * the relay's source-window check for the opaque-origin public play iframe).
 *
 * NEVER trusts any identity from the payload — the relay is authed by the host
 * session only; this only carries the projectId-scoped key/value.
 */
export function parseCloudSavePayload(data: unknown): CloudSaveMessage | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  if (o['type'] !== CLOUD_SAVE_MESSAGE_TYPE) return null;
  const op = o['op'];

  if (op === 'get') {
    if (typeof o['key'] !== 'string') return null;
    if (typeof o['requestId'] !== 'string') return null;
    return { op: 'get', key: o['key'], requestId: o['requestId'] };
  }

  if (op === 'set') {
    if (typeof o['key'] !== 'string') return null;
    // `value` may be any JSON value, including `undefined`/`null`; keep as-is.
    return { op: 'set', key: o['key'], value: o['value'] };
  }

  if (op === 'clear') {
    // `clear` accepts a specific key OR null (= clear all for the project).
    const key = o['key'];
    if (typeof key !== 'string' && key !== null) return null;
    return { op: 'clear', key };
  }

  return null;
}

/**
 * Validate + parse an inbound `cloudsave` message from the game. Returns the
 * typed op or `null` when the message should be ignored:
 *  - origin must be the trusted preview origin (#20);
 *  - shape must match the protocol exactly (op-specific required fields).
 *
 * This is the same-origin (builder preview) path. The public play iframe runs at
 * an opaque origin (no `allow-same-origin`), so its messages report
 * `origin === "null"`; the relay validates those by source-window identity and
 * calls `parseCloudSavePayload` directly (mirroring the score listener, CSP H2).
 */
export function parseCloudSaveMessage(event: MessageEvent<unknown>): CloudSaveMessage | null {
  if (!isPreviewIframeOrigin(event.origin)) return null;
  return parseCloudSavePayload(event.data);
}

/**
 * Host → game: reply to a `get` op with the fetched value (or `null` when no
 * value is stored / the relay failed).
 *
 * `targetOrigin` is explicit and defaults to the trusted preview origin — never
 * `'*'` (#20). The opaque-origin public play iframe is unreachable with a
 * concrete origin, so the relay passes `'*'` for that frame only (the payload is
 * the game's own save data — no secret — and the shim ignores message origin).
 */
export function sendCloudSaveResult(
  iframe: HTMLIFrameElement | null,
  requestId: string,
  value: unknown,
  targetOrigin: string = PREVIEW_IFRAME_ORIGIN,
): void {
  iframe?.contentWindow?.postMessage(
    { type: CLOUD_SAVE_RESULT_MESSAGE_TYPE, requestId, value },
    targetOrigin,
  );
}

/**
 * Host → game: signal that a relay-capable (logged-in) host is present so the
 * shim flips its `hosted` flag. `targetOrigin` defaults to the preview origin
 * (#20); the relay passes `'*'` for the opaque play iframe only (see
 * `sendCloudSaveResult`).
 */
export function sendCloudSaveReady(
  iframe: HTMLIFrameElement | null,
  targetOrigin: string = PREVIEW_IFRAME_ORIGIN,
): void {
  iframe?.contentWindow?.postMessage({ type: CLOUD_SAVE_READY_MESSAGE_TYPE }, targetOrigin);
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
