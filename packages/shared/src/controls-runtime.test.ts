import { describe, expect, it } from 'vitest';
import { CONTROLS_RUNTIME_MARKER, injectControlsRuntime } from './controls-runtime';

describe('injectControlsRuntime', () => {
  it('inserts the runtime after <head> and BEFORE the game module', () => {
    const out = injectControlsRuntime(
      '<!doctype html><html><head><title>x</title></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(CONTROLS_RUNTIME_MARKER);
    expect(out.indexOf(CONTROLS_RUNTIME_MARKER)).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf(CONTROLS_RUNTIME_MARKER)).toBeLessThan(out.indexOf('src/main.js'));
  });

  it('is idempotent — a second pass injects nothing', () => {
    const once = injectControlsRuntime('<html><head></head><body></body></html>');
    const twice = injectControlsRuntime(once);
    expect(twice).toBe(once);
    expect(twice.split(CONTROLS_RUNTIME_MARKER).length - 1).toBe(1);
  });

  it('prepends when there is no <head>', () => {
    const out = injectControlsRuntime('<body><script src="main.js"></script></body>');
    expect(out).toContain(CONTROLS_RUNTIME_MARKER);
    expect(out.indexOf(CONTROLS_RUNTIME_MARKER)).toBeLessThan(out.indexOf('main.js'));
  });

  it('installs window.__game.controls with define + rebind', () => {
    const out = injectControlsRuntime('<head></head>');
    expect(out).toMatch(/window\.__game\.controls\s*=/);
    expect(out).toContain('rebind');
    expect(out).toContain('playforge:controls:manifest');
  });
});
