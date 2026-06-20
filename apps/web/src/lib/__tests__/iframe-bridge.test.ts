import { describe, expect, it } from 'vitest';
import { keyLabel } from '../../components/ControlsPanel';
import {
  CONTROLS_MANIFEST_MESSAGE_TYPE,
  PREVIEW_IFRAME_ORIGIN,
  TWEAKS_UPDATE_MESSAGE_TYPE,
  isPreviewIframeOrigin,
  parseControlsManifestMessage,
  parseInboundBridgeMessage,
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
