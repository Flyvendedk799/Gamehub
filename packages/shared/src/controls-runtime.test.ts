import { describe, expect, it } from 'vitest';
import { ART_RUNTIME_MARKER } from './art-runtime';
import {
  CONTROLS_MANIFEST_BRIDGE_MARKER,
  CONTROLS_REMAP_BRIDGE_MARKER,
  CONTROLS_RUNTIME_MARKER,
  DEBUG_RUNTIME_MARKER,
  GAME_GLOBAL_SETUP_MARKER,
  injectControlsRuntime,
  stripPlatformRuntime,
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

  it('installs the debug contract before the game module (so verify/playtest matches the host)', () => {
    const out = injectControlsRuntime(
      '<!doctype html><html><head></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(DEBUG_RUNTIME_MARKER);
    expect(out).toContain('window.__game.debug');
    expect(out.indexOf(DEBUG_RUNTIME_MARKER)).toBeLessThan(out.indexOf('src/main.js'));
    // Idempotent + honest: only a single injection, and the default returns null
    // until state/tracked fields exist (no faked contract).
    const twice = injectControlsRuntime(out);
    expect(twice.split(DEBUG_RUNTIME_MARKER).length - 1).toBe(1);
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

  it('injects the key-remap bridge at </body> so a rebind reaches direct-reading games', () => {
    const out = injectControlsRuntime(
      '<!doctype html><html><head></head><body><script type="module" src="src/main.js"></script></body></html>',
    );
    expect(out).toContain(CONTROLS_REMAP_BRIDGE_MARKER);
    // After the head runtime, so a controls.isDown game still sees the raw key
    // first and its own rebind path keeps working.
    expect(out.indexOf(CONTROLS_REMAP_BRIDGE_MARKER)).toBeGreaterThan(
      out.indexOf(CONTROLS_RUNTIME_MARKER),
    );
    expect(out.indexOf(CONTROLS_REMAP_BRIDGE_MARKER)).toBeLessThan(out.indexOf('</body>'));
    const twice = injectControlsRuntime(out);
    expect(twice.split(CONTROLS_REMAP_BRIDGE_MARKER).length - 1).toBe(1);
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

describe('stripPlatformRuntime', () => {
  it('removes every marked platform script and the import map, keeping the game', () => {
    const page = [
      '<!doctype html><html><head>',
      '<script type="importmap">{"imports":{"phaser":"https://cdn/phaser.js"}}</script>',
      `<script data-pf="${CONTROLS_RUNTIME_MARKER}">var controls = 1;</script>`,
      `<script data-pf="${DEBUG_RUNTIME_MARKER}">document.pointerLockElement;</script>`,
      `<script data-pf="${ART_RUNTIME_MARKER}">var art = 2;</script>`,
      '</head><body>',
      '<script>window.myGame = true;</script>',
      '<script type="module" src="src/main.js"></script>',
      '</body></html>',
    ].join('\n');
    const out = stripPlatformRuntime(page);

    // Platform runtime gone — including the pointerLockElement read that used to
    // make every 2D game look like a mouse-look game to the invariants.
    expect(out).not.toContain(CONTROLS_RUNTIME_MARKER);
    expect(out).not.toContain(DEBUG_RUNTIME_MARKER);
    expect(out).not.toContain(ART_RUNTIME_MARKER);
    expect(out).not.toContain('pointerLockElement');
    expect(out).not.toContain('importmap');

    // The game's own code and module tag survive untouched.
    expect(out).toContain('window.myGame = true;');
    expect(out).toContain('<script type="module" src="src/main.js">');
    expect(out).toContain('<body>');
  });

  it('leaves a page with no platform runtime unchanged', () => {
    const page = '<!doctype html><html><body><script>let a = 1;</script></body></html>';
    expect(stripPlatformRuntime(page)).toBe(page);
  });

  it('strips the bootstrap setup script the engine adapters emit', () => {
    const page = `<head><script data-pf="${GAME_GLOBAL_SETUP_MARKER}">window.__game = {};</script></head>`;
    expect(stripPlatformRuntime(page)).not.toContain('__game');
  });
});
