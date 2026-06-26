import { describe, expect, it, vi } from 'vitest';
import { keyLabel } from '../../components/ControlsPanel';
import {
  CLOUD_SAVE_MESSAGE_TYPE,
  CLOUD_SAVE_READY_MESSAGE_TYPE,
  CLOUD_SAVE_RESULT_MESSAGE_TYPE,
  CONTROLS_MANIFEST_MESSAGE_TYPE,
  PREVIEW_IFRAME_ORIGIN,
  RUNTIME_ALIVE_MESSAGE_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  TWEAKS_UPDATE_MESSAGE_TYPE,
  isPreviewIframeOrigin,
  parseCloudSaveMessage,
  parseCloudSavePayload,
  parseControlsManifestMessage,
  parseInboundBridgeMessage,
  parseRuntimeAliveMessage,
  parseRuntimeErrorMessage,
  sendCloudSaveReady,
  sendCloudSaveResult,
} from '../iframe-bridge';

// Minimal MessageEvent stand-in so we don't need a DOM environment.
function evt(origin: string, data: unknown): MessageEvent<unknown> {
  return { origin, data } as MessageEvent<unknown>;
}

describe('parseControlsManifestMessage (WS-A)', () => {
  const manifest = {
    type: CONTROLS_MANIFEST_MESSAGE_TYPE,
    manifest: {
      actions: [
        { id: 'jump', label: 'Jump', keys: ['Space'], description: 'Leap' },
        { id: 'bad', keys: 'nope' }, // malformed keys → []
        { label: 'no id' }, // dropped (no id)
      ],
    },
  };

  it('parses a valid manifest from the trusted origin', () => {
    const out = parseControlsManifestMessage(evt(PREVIEW_IFRAME_ORIGIN, manifest));
    expect(out?.actions).toEqual([
      { id: 'jump', label: 'Jump', keys: ['Space'], description: 'Leap' },
      { id: 'bad', label: 'bad', keys: [] },
    ]);
  });

  it('rejects a foreign origin and non-manifest messages', () => {
    expect(parseControlsManifestMessage(evt('https://evil.example', manifest))).toBeNull();
    expect(parseControlsManifestMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: 'other' }))).toBeNull();
  });

  it('ignores an EMPTY manifest so a race-posted {actions:[]} cannot clobber a good one', () => {
    const empty = { type: CONTROLS_MANIFEST_MESSAGE_TYPE, manifest: { actions: [] } };
    expect(parseControlsManifestMessage(evt(PREVIEW_IFRAME_ORIGIN, empty))).toBeNull();
    // actions present but all invalid (no ids) → also effectively empty → null
    const allDropped = {
      type: CONTROLS_MANIFEST_MESSAGE_TYPE,
      manifest: { actions: [{ label: 'x' }, { keys: ['Space'] }] },
    };
    expect(parseControlsManifestMessage(evt(PREVIEW_IFRAME_ORIGIN, allDropped))).toBeNull();
  });
});

describe('runtime beacon parsers', () => {
  it('parses a runtime crash from the trusted origin', () => {
    const msg = {
      type: RUNTIME_ERROR_MESSAGE_TYPE,
      message: "Audio key 'meleeHit' not found in cache",
      stack: 'at PlayScene.melee (main.js:370)',
    };
    const out = parseRuntimeErrorMessage(evt(PREVIEW_IFRAME_ORIGIN, msg));
    expect(out?.message).toContain('meleeHit');
    expect(out?.stack).toContain('melee');
  });

  it('rejects a foreign origin, wrong type, or empty message', () => {
    const msg = { type: RUNTIME_ERROR_MESSAGE_TYPE, message: 'boom' };
    expect(parseRuntimeErrorMessage(evt('https://evil.example', msg))).toBeNull();
    expect(
      parseRuntimeErrorMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: 'other', message: 'x' })),
    ).toBeNull();
    expect(
      parseRuntimeErrorMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: RUNTIME_ERROR_MESSAGE_TYPE })),
    ).toBeNull();
  });

  it('parses a heartbeat with its rAF tick count (defaulting to 0)', () => {
    expect(
      parseRuntimeAliveMessage(
        evt(PREVIEW_IFRAME_ORIGIN, { type: RUNTIME_ALIVE_MESSAGE_TYPE, raf: 42 }),
      ),
    ).toEqual({ raf: 42 });
    expect(
      parseRuntimeAliveMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: RUNTIME_ALIVE_MESSAGE_TYPE })),
    ).toEqual({ raf: 0 });
    expect(
      parseRuntimeAliveMessage(evt('https://evil.example', { type: RUNTIME_ALIVE_MESSAGE_TYPE })),
    ).toBeNull();
  });
});

describe('keyLabel', () => {
  it('renders KeyboardEvent.code values for humans', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Digit1')).toBe('1');
  });
  it('renders mouse-button binds', () => {
    expect(keyLabel('Mouse0')).toBe('Left Click');
    expect(keyLabel('Mouse1')).toBe('Middle Click');
    expect(keyLabel('Mouse2')).toBe('Right Click');
  });
});

describe('parseControlsManifestMessage — mouse + pointer', () => {
  it('passes mouse-button binds + a pointer (look) control through', () => {
    const msg = {
      type: CONTROLS_MANIFEST_MESSAGE_TYPE,
      manifest: {
        actions: [
          { id: 'heavy', label: 'Heavy', keys: ['KeyJ', 'Mouse0'] },
          { id: 'look', label: 'Camera look', keys: [], pointer: 'look' },
          { id: 'bad', label: 'Bad', keys: [], pointer: 'nonsense' },
        ],
      },
    };
    const out = parseControlsManifestMessage(evt(PREVIEW_IFRAME_ORIGIN, msg));
    expect(out?.actions[0]?.keys).toEqual(['KeyJ', 'Mouse0']);
    expect(out?.actions[1]?.pointer).toBe('look');
    // invalid pointer value is dropped, not trusted
    expect(out?.actions[2]?.pointer).toBeUndefined();
  });
});

describe('iframe bridge constants', () => {
  it('keeps the tweak protocol literal in lockstep with the runtime bridge', () => {
    // Mirror of runtime TWEAKS_UPDATE_MESSAGE_TYPE / tweaks-bridge.ts listener.
    expect(TWEAKS_UPDATE_MESSAGE_TYPE).toBe('playforge:tweaks:update');
  });

  it('resolves a concrete preview origin (never "*")', () => {
    expect(PREVIEW_IFRAME_ORIGIN).not.toBe('*');
    expect(PREVIEW_IFRAME_ORIGIN).toMatch(/^https?:\/\//);
  });
});

describe('isPreviewIframeOrigin', () => {
  it('accepts only the configured preview origin', () => {
    expect(isPreviewIframeOrigin(PREVIEW_IFRAME_ORIGIN)).toBe(true);
    expect(isPreviewIframeOrigin('https://evil.example')).toBe(false);
    expect(isPreviewIframeOrigin('')).toBe(false);
  });
});

describe('parseInboundBridgeMessage', () => {
  it('rejects messages from an untrusted origin', () => {
    expect(parseInboundBridgeMessage(evt('https://evil.example', { type: 'x' }))).toBeNull();
  });

  it('rejects non-object / malformed payloads from the trusted origin', () => {
    expect(parseInboundBridgeMessage(evt(PREVIEW_IFRAME_ORIGIN, null))).toBeNull();
    expect(parseInboundBridgeMessage(evt(PREVIEW_IFRAME_ORIGIN, 'hello'))).toBeNull();
    expect(parseInboundBridgeMessage(evt(PREVIEW_IFRAME_ORIGIN, { notType: 1 }))).toBeNull();
    expect(parseInboundBridgeMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: 5 }))).toBeNull();
  });

  it('accepts a well-formed message from the trusted origin', () => {
    expect(parseInboundBridgeMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: 'ack' }))).toEqual({
      type: 'ack',
    });
  });
});

// ─── Cloud-save relay (cross-device game saves) ────────────────────────────────

describe('parseCloudSaveMessage', () => {
  it('keeps the cloud-save protocol literals in lockstep with the shim', () => {
    // Mirror of runtime engines/types.ts CLOUD_SAVE_* constants.
    expect(CLOUD_SAVE_MESSAGE_TYPE).toBe('playforge:cloudsave');
    expect(CLOUD_SAVE_RESULT_MESSAGE_TYPE).toBe('playforge:cloudsave:result');
    expect(CLOUD_SAVE_READY_MESSAGE_TYPE).toBe('playforge:cloudsave:ready');
  });

  it('accepts a valid get op from the preview origin', () => {
    const msg = { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'get', key: 'save1', requestId: 'cs1' };
    expect(parseCloudSaveMessage(evt(PREVIEW_IFRAME_ORIGIN, msg))).toEqual({
      op: 'get',
      key: 'save1',
      requestId: 'cs1',
    });
  });

  it('accepts a valid set op (value passed through verbatim, incl. null)', () => {
    const set = {
      type: CLOUD_SAVE_MESSAGE_TYPE,
      op: 'set',
      key: 'save1',
      value: { level: 3, coins: 12 },
    };
    expect(parseCloudSaveMessage(evt(PREVIEW_IFRAME_ORIGIN, set))).toEqual({
      op: 'set',
      key: 'save1',
      value: { level: 3, coins: 12 },
    });
    const setNull = { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'set', key: 'k', value: null };
    expect(parseCloudSaveMessage(evt(PREVIEW_IFRAME_ORIGIN, setNull))).toEqual({
      op: 'set',
      key: 'k',
      value: null,
    });
  });

  it('accepts a clear op with a key OR null (= clear all for the project)', () => {
    const clearKey = { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'clear', key: 'save1' };
    expect(parseCloudSaveMessage(evt(PREVIEW_IFRAME_ORIGIN, clearKey))).toEqual({
      op: 'clear',
      key: 'save1',
    });
    const clearAll = { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'clear', key: null };
    expect(parseCloudSaveMessage(evt(PREVIEW_IFRAME_ORIGIN, clearAll))).toEqual({
      op: 'clear',
      key: null,
    });
  });

  it('REJECTS a cloud-save message from a foreign origin', () => {
    const msg = { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'get', key: 'save1', requestId: 'cs1' };
    expect(parseCloudSaveMessage(evt('https://evil.example', msg))).toBeNull();
  });

  it('rejects malformed shapes (missing fields, bad op, wrong types)', () => {
    const cases: unknown[] = [
      null,
      'string',
      { type: 'other', op: 'get', key: 'k', requestId: 'r' }, // wrong type
      { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'nope', key: 'k' }, // unknown op
      { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'get', key: 'k' }, // get missing requestId
      { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'get', requestId: 'r' }, // get missing key
      { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'get', key: 5, requestId: 'r' }, // non-string key
      { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'set' }, // set missing key
      { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'clear', key: 5 }, // clear non-string/non-null key
    ];
    for (const data of cases) {
      expect(parseCloudSaveMessage(evt(PREVIEW_IFRAME_ORIGIN, data))).toBeNull();
    }
  });
});

describe('parseCloudSavePayload (origin-agnostic shape check for the opaque play iframe)', () => {
  it('parses a valid op regardless of origin (relay layers source-window trust)', () => {
    const msg = { type: CLOUD_SAVE_MESSAGE_TYPE, op: 'set', key: 'k', value: 1 };
    // No origin involved — the opaque play iframe's source identity is the gate.
    expect(parseCloudSavePayload(msg)).toEqual({ op: 'set', key: 'k', value: 1 });
  });

  it('still rejects malformed payloads', () => {
    expect(parseCloudSavePayload({ type: 'other' })).toBeNull();
    expect(parseCloudSavePayload(null)).toBeNull();
  });
});

describe('sendCloudSaveResult / sendCloudSaveReady', () => {
  // Mock the iframe's contentWindow.postMessage to capture (message, targetOrigin).
  function mockIframe() {
    const postMessage = vi.fn();
    const iframe = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;
    return { iframe, postMessage };
  }

  it('posts a result with the correct type, requestId, value + default target origin', () => {
    const { iframe, postMessage } = mockIframe();
    sendCloudSaveResult(iframe, 'cs1', { level: 2 });
    expect(postMessage).toHaveBeenCalledWith(
      { type: CLOUD_SAVE_RESULT_MESSAGE_TYPE, requestId: 'cs1', value: { level: 2 } },
      PREVIEW_IFRAME_ORIGIN,
    );
  });

  it('posts a result with a null value (no save stored)', () => {
    const { iframe, postMessage } = mockIframe();
    sendCloudSaveResult(iframe, 'cs2', null);
    expect(postMessage).toHaveBeenCalledWith(
      { type: CLOUD_SAVE_RESULT_MESSAGE_TYPE, requestId: 'cs2', value: null },
      PREVIEW_IFRAME_ORIGIN,
    );
  });

  it('posts ready with the correct type + default target origin (never "*")', () => {
    const { iframe, postMessage } = mockIframe();
    sendCloudSaveReady(iframe);
    expect(postMessage).toHaveBeenCalledWith(
      { type: CLOUD_SAVE_READY_MESSAGE_TYPE },
      PREVIEW_IFRAME_ORIGIN,
    );
  });

  it('honors an explicit target origin for the opaque play iframe', () => {
    const { iframe, postMessage } = mockIframe();
    sendCloudSaveResult(iframe, 'cs3', 1, '*');
    sendCloudSaveReady(iframe, '*');
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { type: CLOUD_SAVE_RESULT_MESSAGE_TYPE, requestId: 'cs3', value: 1 },
      '*',
    );
    expect(postMessage).toHaveBeenNthCalledWith(2, { type: CLOUD_SAVE_READY_MESSAGE_TYPE }, '*');
  });

  it('is a no-op when the iframe (or its contentWindow) is null', () => {
    expect(() => sendCloudSaveResult(null, 'cs1', 1)).not.toThrow();
    expect(() => sendCloudSaveReady(null)).not.toThrow();
  });
});
