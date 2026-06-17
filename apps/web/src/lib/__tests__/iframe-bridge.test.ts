import { describe, expect, it } from 'vitest';
import {
  PREVIEW_IFRAME_ORIGIN,
  TWEAKS_UPDATE_MESSAGE_TYPE,
  isPreviewIframeOrigin,
  parseInboundBridgeMessage,
} from '../iframe-bridge';

// Minimal MessageEvent stand-in so we don't need a DOM environment.
function evt(origin: string, data: unknown): MessageEvent<unknown> {
  return { origin, data } as MessageEvent<unknown>;
}

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
    expect(parseInboundBridgeMessage(evt(PREVIEW_IFRAME_ORIGIN, { type: 'ack' }))).toEqual({ type: 'ack' });
  });
});
