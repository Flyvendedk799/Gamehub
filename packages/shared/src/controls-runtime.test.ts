import { describe, expect, it } from 'vitest';
import { ART_RUNTIME_MARKER } from './art-runtime';
import {
  CONTROLS_MANIFEST_BRIDGE_MARKER,
  CONTROLS_RUNTIME_MARKER,
  injectControlsRuntime,
} from './controls-runtime';

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

  it('injects the representational-art runtime (window.__game.art) for a self-authored index.html', () => {
    // A game whose author replaced index.html lost the bootstrap art shim; serve-time
    // injection restores it so window.__game.art is always available.
    const out = injectControlsRuntime(
      '<!doctype html><html><head><title>x</title></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(ART_RUNTIME_MARKER);
    expect(out).toContain('window.__game.art');
    expect(out.indexOf(ART_RUNTIME_MARKER)).toBeLessThan(out.indexOf('src/main.js'));
    // Idempotent: a bootstrap that already embeds the marker isn't double-injected.
    const twice = injectControlsRuntime(out);
    expect(twice.split(ART_RUNTIME_MARKER).length - 1).toBe(1);
  });

  it('installs window.__game.controls with define + rebind', () => {
    const out = injectControlsRuntime('<head></head>');
    expect(out).toMatch(/window\.__game\.controls\s*=/);
    expect(out).toContain('rebind');
    expect(out).toContain('playforge:controls:manifest');
  });

  it('injects the manifest bridge right before </body>, AFTER the game module', () => {
    const out = injectControlsRuntime(
      '<!doctype html><html><head><title>x</title></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(CONTROLS_MANIFEST_BRIDGE_MARKER);
    // The bridge runs after the game's scripts (so a game-bundled controls shim
    // that clobbered the head runtime's define is already in place when we wrap).
    expect(out.indexOf(CONTROLS_MANIFEST_BRIDGE_MARKER)).toBeGreaterThan(
      out.indexOf('src/main.js'),
    );
    expect(out.indexOf(CONTROLS_MANIFEST_BRIDGE_MARKER)).toBeLessThan(out.indexOf('</body>'));
    // It wraps define so the manifest is posted regardless of what won.
    expect(out).toContain('__pfWrapped');
  });

  it('bridge is idempotent and survives an inline shim that overwrites define', () => {
    // Mimic a generated game: an inline controls shim BEFORE the module that
    // overwrites controls.define (no manifest post). The bridge must land after it.
    const game =
      '<!doctype html><html><head></head><body>' +
      '<script>window.__game={controls:{}};window.__game.controls.define=function(){};</script>' +
      '<script type="module" src="src/main.js"></script></body></html>';
    const once = injectControlsRuntime(game);
    expect(once.indexOf(CONTROLS_MANIFEST_BRIDGE_MARKER)).toBeGreaterThan(
      once.lastIndexOf('controls.define=function'),
    );
    const twice = injectControlsRuntime(once);
    expect(twice).toBe(once);
    expect(twice.split(CONTROLS_MANIFEST_BRIDGE_MARKER).length - 1).toBe(1);
  });
});
