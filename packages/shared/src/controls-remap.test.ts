/**
 * Behavioural tests for the key-REMAP bridge.
 *
 * The Controls tab "had no effect" for most generated games: `controls:rebind`
 * only reaches a game that reads input through `window.__game.controls`, and
 * most read the keyboard directly (Phaser cursors, their own keydown listener, a
 * bundled shim that replaced `window.__game.controls` with an object that has no
 * `rebind`). The bridge fixes that by rewriting input at the EVENT level, so
 * these tests assert on what a directly-reading game would actually observe.
 *
 * Each test runs the snippet in its OWN happy-dom window: the bridge installs
 * window listeners that never come off, so sharing a window would leak one
 * test's bindings — and its listener ordering — into the next.
 */
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { CONTROLS_REMAP_BRIDGE_SNIPPET, CONTROLS_RUNTIME_SNIPPET } from './controls-runtime';

const REBIND = 'playforge:controls:rebind';

type Bindings = Record<string, string[]>;

interface Sandbox {
  /** Evaluate a `<script data-pf="…">(function(){…})();</script>` snippet in this window. */
  run: (snippet: string) => void;
  /** What a game reading the keyboard directly sees, in order. */
  keysDown: string[];
  keysUp: string[];
  press: (code: string) => void;
  release: (code: string) => void;
  rebind: (bindings: Bindings, defaults?: Bindings) => void;
  window: Window;
}

function sandbox(): Sandbox {
  const w = new Window();
  const doc = w.document;
  const keysDown: string[] = [];
  const keysUp: string[] = [];
  // The game's own listeners — on document, downstream of the bridge's
  // window-capture hook, exactly where a real game's would sit.
  doc.addEventListener('keydown', (e) => keysDown.push((e as unknown as KeyboardEvent).code));
  doc.addEventListener('keyup', (e) => keysUp.push((e as unknown as KeyboardEvent).code));

  const run = (snippet: string): void => {
    const body = snippet.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    // The snippet is authored against browser globals; hand it this window's.
    new Function('window', 'document', 'KeyboardEvent', 'MouseEvent', body)(
      w,
      doc,
      w.KeyboardEvent,
      w.MouseEvent,
    );
  };

  // A real key event targets the focused element and BUBBLES to window, so the
  // bridge's window-capture listener runs first and the game's run after — the
  // ordering the bridge depends on.
  const key = (type: 'keydown' | 'keyup', code: string): void => {
    doc.body.dispatchEvent(new w.KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  };

  return {
    run,
    keysDown,
    keysUp,
    press: (code) => key('keydown', code),
    release: (code) => key('keyup', code),
    rebind: (bindings, defaults) => {
      w.dispatchEvent(
        new w.MessageEvent('message', {
          data: { type: REBIND, bindings, ...(defaults ? { defaults } : {}) },
        }),
      );
    },
    window: w,
  };
}

/** A sandbox with only the remap bridge installed. */
function remapOnly(): Sandbox {
  const s = sandbox();
  s.run(CONTROLS_REMAP_BRIDGE_SNIPPET);
  return s;
}

describe('key-remap bridge', () => {
  it('is inert before any rebind — every key reaches the game untouched', () => {
    const s = remapOnly();
    s.press('KeyW');
    s.press('ArrowUp');
    expect(s.keysDown).toEqual(['KeyW', 'ArrowUp']);
  });

  it('is inert while the bindings still match the declared defaults', () => {
    const s = remapOnly();
    s.rebind({ up: ['KeyW'] }, { up: ['KeyW'] });
    s.press('KeyW');
    expect(s.keysDown).toEqual(['KeyW']);
  });

  it('delivers a newly bound key as the key the game actually reads', () => {
    const s = remapOnly();
    // The game hard-codes KeyW for "up"; the user adds ArrowUp.
    s.rebind({ up: ['KeyW', 'ArrowUp'] }, { up: ['KeyW'] });
    s.press('ArrowUp');
    // The game sees its own KeyW. (ArrowUp reaches it too — it means nothing to a
    // game that only reads KeyW, and swallowing it would break a game that also
    // listens for arrows for something else.)
    expect(s.keysDown).toContain('KeyW');
  });

  it('a key the user unbound stops reaching the game', () => {
    const s = remapOnly();
    s.rebind({ up: ['ArrowUp'] }, { up: ['KeyW'] });
    s.press('KeyW');
    expect(s.keysDown).toEqual([]);
  });

  it('a swap fires exactly the swapped action, never both', () => {
    const s = remapOnly();
    s.rebind({ up: ['KeyS'], down: ['KeyW'] }, { up: ['KeyW'], down: ['KeyS'] });
    s.press('KeyS');
    expect(s.keysDown).toEqual(['KeyW']);
    s.keysDown.length = 0;
    s.press('KeyW');
    expect(s.keysDown).toEqual(['KeyS']);
  });

  it('keeps a shared key alive while any action still uses it', () => {
    const s = remapOnly();
    // Space drives both jump and confirm; the user unbinds it from jump only.
    s.rebind({ jump: ['KeyZ'], confirm: ['Space'] }, { jump: ['Space'], confirm: ['Space'] });
    s.press('Space');
    expect(s.keysDown).toEqual(['Space']);
  });

  it('leaves controller codes to the gamepad bridge', () => {
    const s = remapOnly();
    s.rebind({ jump: ['Space', 'Pad0'] }, { jump: ['Space'] });
    s.press('Space');
    expect(s.keysDown).toEqual(['Space']);
  });

  it('stays dormant when the host sends no defaults (nothing to translate to)', () => {
    const s = remapOnly();
    s.rebind({ up: ['ArrowUp'] });
    s.press('KeyW');
    s.press('ArrowUp');
    expect(s.keysDown).toEqual(['KeyW', 'ArrowUp']);
  });

  it('releases the remapped key on keyup, so nothing sticks down', () => {
    const s = remapOnly();
    s.rebind({ up: ['ArrowUp'] }, { up: ['KeyW'] });
    s.release('ArrowUp');
    expect(s.keysUp).toContain('KeyW');
  });

  it('a later rebind replaces the previous translation rather than stacking', () => {
    const s = remapOnly();
    s.rebind({ up: ['KeyJ'] }, { up: ['KeyW'] });
    s.rebind({ up: ['KeyW'] }, { up: ['KeyW'] }); // back to the declared default
    s.press('KeyJ');
    s.press('KeyW');
    expect(s.keysDown).toEqual(['KeyJ', 'KeyW']);
  });
});

describe('key-remap bridge alongside the head controls runtime', () => {
  // The head runtime is the OTHER rebind path (games reading
  // window.__game.controls.isDown). A served preview has both, in this order, so
  // a swap must fire the action once — not once through each.
  function bothInstalled(): Sandbox {
    const s = sandbox();
    s.run(CONTROLS_RUNTIME_SNIPPET); // <head>: its listeners register first
    s.run(CONTROLS_REMAP_BRIDGE_SNIPPET); // </body>: registers after
    return s;
  }

  interface Controls {
    define: (m: { actions: Array<{ id: string; label: string; keys: string[] }> }) => void;
    on: (id: string, fn: () => void) => void;
    isDown: (id: string) => boolean;
  }

  function declareWasd(s: Sandbox): { controls: Controls; fired: string[] } {
    const controls = (s.window as unknown as { __game: { controls: Controls } }).__game.controls;
    const fired: string[] = [];
    controls.define({
      actions: [
        { id: 'up', label: 'Up', keys: ['KeyW'] },
        { id: 'down', label: 'Down', keys: ['KeyS'] },
      ],
    });
    controls.on('up', () => fired.push('up'));
    controls.on('down', () => fired.push('down'));
    return { controls, fired };
  }

  it('a controls.isDown game sees a swap once, not twice', () => {
    const s = bothInstalled();
    const { fired } = declareWasd(s);
    s.rebind({ up: ['KeyS'], down: ['KeyW'] }, { up: ['KeyW'], down: ['KeyS'] });
    s.press('KeyS');
    expect(fired).toEqual(['up']);
  });

  it('and a directly-reading game in the SAME page still sees its own key', () => {
    const s = bothInstalled();
    declareWasd(s);
    s.rebind({ up: ['KeyS'], down: ['KeyW'] }, { up: ['KeyW'], down: ['KeyS'] });
    s.press('KeyS');
    expect(s.keysDown).toEqual(['KeyW']);
  });
});
