import { describe, expect, it } from 'vitest';
import { injectControlsRuntime } from './controls-runtime';
import {
  RUNTIME_ALIVE_MESSAGE_TYPE,
  RUNTIME_BEACON_MARKER,
  RUNTIME_BEACON_SNIPPET,
  RUNTIME_ERROR_MESSAGE_TYPE,
} from './runtime-beacon';

describe('runtime beacon', () => {
  it('snippet wires error + rejection listeners and an rAF heartbeat', () => {
    expect(RUNTIME_BEACON_SNIPPET).toContain("addEventListener('error'");
    expect(RUNTIME_BEACON_SNIPPET).toContain("addEventListener('unhandledrejection'");
    expect(RUNTIME_BEACON_SNIPPET).toContain('requestAnimationFrame');
    expect(RUNTIME_BEACON_SNIPPET).toContain(RUNTIME_ERROR_MESSAGE_TYPE);
    expect(RUNTIME_BEACON_SNIPPET).toContain(RUNTIME_ALIVE_MESSAGE_TYPE);
  });

  it('injectControlsRuntime installs the beacon at <head>, BEFORE the game + idempotently', () => {
    const out = injectControlsRuntime(
      '<!doctype html><html><head><title>x</title></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(RUNTIME_BEACON_MARKER);
    // It must run before the game module so its error listeners catch boot crashes.
    expect(out.indexOf(RUNTIME_BEACON_MARKER)).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf(RUNTIME_BEACON_MARKER)).toBeLessThan(out.indexOf('src/main.js'));
    // Idempotent — a second pass doesn't double-inject.
    const twice = injectControlsRuntime(out);
    expect(twice.split(RUNTIME_BEACON_MARKER).length - 1).toBe(1);
  });
});
