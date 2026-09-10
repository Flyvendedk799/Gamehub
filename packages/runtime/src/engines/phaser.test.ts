/**
 * gameplan §3 + §7.1 + §7.6 — Phaser engine adapter tests.
 */

import { describe, expect, it } from 'vitest';
import { phaserAdapter } from './phaser';

describe('phaserAdapter shape (gameplan §7.1)', () => {
  it('exposes the gameplan-locked metadata', () => {
    expect(phaserAdapter.id).toBe('phaser');
    expect(phaserAdapter.label).toBe('Phaser');
    expect(phaserAdapter.defaultVersion).toBe('3.88.0');
    expect(phaserAdapter.canonicalEntry).toBe('index.html');
    expect(phaserAdapter.supportsLivePreview()).toBe(true);
  });
});

describe('phaserAdapter.bootstrap (gameplan §3 + §7.3)', () => {
  const opts = {
    designId: 'abc-123',
    gameBaseUrl: 'game-files://designs/abc-123/',
  };

  it('emits a doctype + the pinned phaser@3.88.0 ESM importmap', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('"phaser":');
    expect(html).toContain('https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js');
  });

  it('honours pinnedVersion override', () => {
    const html = phaserAdapter.bootstrap({ ...opts, pinnedVersion: '3.89.0' });
    expect(html).toContain('phaser@3.89.0');
  });

  it('injects <base href> against the game-files:// URL', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html).toContain('<base href="game-files://designs/abc-123/"');
  });

  it('sets up the cross-engine __game global with engine="phaser"', () => {
    const html = phaserAdapter.bootstrap({
      ...opts,
      initialParams: { paddle_speed: 8 },
    });
    expect(html).toContain('window.__game.engine = "phaser"');
    expect(html).toContain('"paddle_speed":8');
  });

  it('mounts a <div id="game"> + module script slot', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html).toContain('<div id="game">');
    expect(html).toContain('<script type="module" src="src/main.js">');
  });

  it('declares the playtest debug contract with a default snapshot getter', () => {
    const html = phaserAdapter.bootstrap(opts);
    expect(html).toContain('window.__game.debug');
    // v2 P2 — a live, trackable contract (still returns null until wired).
    expect(html).toContain('function track(spec)');
    expect(html).toContain('function snapshot()');
    expect(html).toContain('return null;');
  });

  it('#47 — neutralises quotes/angle-brackets in gameBaseUrl', () => {
    const html = phaserAdapter.bootstrap({
      ...opts,
      gameBaseUrl: 'https://evil.example.com/"><script>alert(1)</script>',
    });
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('#47 — rejects javascript:/data: gameBaseUrl bases', () => {
    expect(() =>
      phaserAdapter.bootstrap({ ...opts, gameBaseUrl: 'javascript:alert(1)' }),
    ).toThrow();
    expect(() =>
      phaserAdapter.bootstrap({ ...opts, gameBaseUrl: 'data:text/html,<script>1</script>' }),
    ).toThrow();
  });

  it('#47 — rejects a non-semver pinnedVersion', () => {
    expect(() =>
      phaserAdapter.bootstrap({ ...opts, pinnedVersion: '3.88.0"/></script><script>x</script>' }),
    ).toThrow();
    expect(() => phaserAdapter.bootstrap({ ...opts, pinnedVersion: 'latest' })).toThrow();
  });
});

describe('phaserAdapter.validate (gameplan §7.6)', () => {
  const goodIndex = `<!doctype html><html><head>
    <script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>
    </head><body><div id="game"></div></body></html>`;
  const goodMain = `
    import * as Phaser from 'phaser';
    class PlayScene extends Phaser.Scene {
      preload() { this.load.image('paddle', 'assets/paddle.png'); }
      create() { this.add.image(100, 100, 'paddle'); }
      update() {}
    }
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      width: 800, height: 600,
      physics: { default: 'arcade', arcade: { gravity: { y: 300 } } },
      scene: [PlayScene],
    });
  `;

  it('returns ok for a well-formed Phaser project', () => {
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(true);
  });

  it('flags missing index.html as a hard error', () => {
    const result = phaserAdapter.validate([{ path: 'src/main.js', content: goodMain }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('index.html is missing'))).toBe(true);
  });

  it('warns when the Phaser version drifts off 3.88.x', () => {
    const driftedIndex = `<!doctype html><html><head>
      <script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@4.0.0-alpha.1/dist/phaser.esm.js"}}</script>
      </head><body><div id="game"></div></body></html>`;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: driftedIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const drift = result.issues.find((i) => i.message.includes('phaser@3.88.x'));
    expect(drift?.severity).toBe('warn');
  });

  it('flags missing Phaser.Game/Scene as a hard error', () => {
    const noPhaser = `
      const x = 1;
      console.log(x);
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noPhaser },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('Phaser.Scene'))).toBe(true);
  });

  it('flags the default Phaser ESM import as a runtime-breaking error', () => {
    const defaultImport = goodMain.replace(
      "import * as Phaser from 'phaser';",
      "import Phaser from 'phaser';",
    );
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: defaultImport },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('does not provide a default export'))).toBe(
      true,
    );
  });

  it('warns when a scene declares no lifecycle methods', () => {
    const noLifecycle = `
      import * as Phaser from 'phaser';
      class HollowScene extends Phaser.Scene { constructor() { super(); } }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        physics: { default: 'arcade' },
        scene: [HollowScene],
      });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noLifecycle },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('lifecycle methods'));
    expect(warn?.severity).toBe('warn');
  });

  it('flags this.physics.add.* without a physics block in the game config', () => {
    const physicsMissing = `
      import * as Phaser from 'phaser';
      class PlayScene extends Phaser.Scene {
        create() { this.physics.add.sprite(100, 100, 'player'); }
        update() {}
      }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        scene: [PlayScene],
      });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: physicsMissing },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('physics: { default'))).toBe(true);
  });

  it('flags this.add.image with an unloaded asset key', () => {
    const orphanKey = `
      import * as Phaser from 'phaser';
      class PlayScene extends Phaser.Scene {
        preload() { this.load.image('paddle', 'assets/paddle.png'); }
        create() {
          this.add.image(100, 100, 'paddle');
          this.add.image(200, 200, 'ghost-asset');
        }
        update() {}
      }
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        physics: { default: 'arcade' },
        scene: [PlayScene],
      });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: orphanKey },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some(
        (i) => i.message.includes('"ghost-asset"') && i.message.includes('no texture source'),
      ),
    ).toBe(true);
  });

  it('does NOT flag this.add.image for a runtime-baked (canvas / generated) texture', () => {
    const baked = `
      import * as Phaser from 'phaser';
      class PlayScene extends Phaser.Scene {
        create() {
          // Textures baked at runtime — valid sources the old lint rejected,
          // forcing a rewrite to immediate-mode Graphics.
          const cv = this.textures.createCanvas('chicken', 32, 32);
          this.textures.addCanvas('terrorist', document.createElement('canvas'));
          this.make.graphics({ add: false }).fillRect(0, 0, 8, 8).generateTexture('bullet', 8, 8);
          this.add.image(100, 100, 'chicken');
          this.add.sprite(200, 200, 'terrorist');
          this.add.image(50, 50, 'bullet');
        }
        update() {}
      }
      const game = new Phaser.Game({ type: Phaser.AUTO, scene: [PlayScene] });
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: baked },
    ]);
    // No "no texture source" error for any baked key (other advisory issues, if
    // any, are irrelevant to this check).
    const textureErrors = result.ok
      ? []
      : result.issues.filter((i) => i.message.includes('texture source'));
    expect(textureErrors).toEqual([]);
  });

  it('#41 — warns (not errors) when scene code references the network', () => {
    const networky = `${goodMain}
      const ws = new WebSocket('wss://evil.example.com');
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: networky },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('anti_exfil'));
    expect(warn?.severity).toBe('warn');
    expect(
      result.issues.some((i) => i.severity === 'error' && i.message.includes('anti_exfil')),
    ).toBe(false);
  });

  it('flags eval / new Function as a hard error', () => {
    const evilMain = `${goodMain}
      const f = eval('1+1');
    `;
    const result = phaserAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: evilMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('eval / new Function'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Screen-space UI that scrolls off with the camera. Regression corpus taken
// from production run e2bd3b58 ("Operation: Fractured Front"), which shipped a
// complete HUD that was invisible from the first camera scroll onward and drew
// the follow-up "Game does not run".
// ---------------------------------------------------------------------------

const HTML_OK = [
  '<!doctype html><html><head>',
  '<script type="importmap">{"imports":{"phaser":',
  '"https://cdn.jsdelivr.net/npm/phaser@3.88.2/dist/phaser.esm.js"}}</script>',
  '</head><body><div id="game"></div></body></html>',
].join('');

function validateJs(js: string) {
  const result = phaserAdapter.validate([
    { path: 'index.html', content: HTML_OK },
    { path: 'src/game.js', content: js },
  ]);
  return result.ok ? [] : (result.issues ?? []);
}

const SCENE_PREAMBLE = [
  'import * as Phaser from "phaser";',
  'class PlayScene extends Phaser.Scene {',
  '  create() {',
  '    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);',
].join('\n');

describe('phaserAdapter.validate — screen-space UI pinning', () => {
  it('flags a Container pinned without updateChildren (the shipped bug)', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    this._hud = this.add.container(0, 0).setScrollFactor(0).setDepth(100);',
        '    this._hudHp = this.add.text(12, 566, "HP");',
        '    this._hud.add([this._hudHp]);',
        '  }',
        '}',
        'new Phaser.Game({ scene: [PlayScene] });',
      ].join('\n'),
    );
    const hit = issues.find((i) => i.message.includes('ui.container_children_scroll'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
    expect(hit?.path).toBe('src/game.js');
    expect(hit?.message).toContain('setScrollFactor(0, 0, true)');
  });

  it('flags the same bug when the container is held in a local', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    const panel = this.add.container(400, 300);',
        '    panel.setScrollFactor(0);',
        '    panel.add([this.add.text(0, 0, "CHOOSE YOUR ROLE")]);',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.container_children_scroll'))).toHaveLength(
      1,
    );
  });

  it('accepts the corrected three-argument form', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    this._hud = this.add.container(0, 0).setScrollFactor(0, 0, true).setDepth(100);',
        '    this._hud.add([this.add.text(12, 566, "HP")]);',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.container_children_scroll'))).toEqual([]);
  });

  it('walks back through intermediate chained calls to find the container', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    this.add.container(0, 0).setName("hud").setDepth(200).setScrollFactor(0, 0);',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.container_children_scroll'))).toHaveLength(
      1,
    );
  });

  it('does not flag a pinned Text / Graphics — only Containers have the trap', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    this.add.text(12, 8, "SCORE").setScrollFactor(0);',
        '    const gfx = this.add.graphics();',
        '    gfx.setScrollFactor(0);',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.container_children_scroll'))).toEqual([]);
  });

  it('does not flag a world-space container (scrollFactor left at 1)', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    const squad = this.add.container(200, 200);',
        '    squad.setScrollFactor(1);',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.container_children_scroll'))).toEqual([]);
  });

  it('warns when the camera scrolls, text is drawn, and nothing is pinned at all', () => {
    const issues = validateJs(
      [SCENE_PREAMBLE, '    this.add.text(12, 8, "SCORE: 0");', '  }', '}'].join('\n'),
    );
    const hit = issues.find((i) => i.message.includes('ui.no_pinned_hud'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('warn');
  });

  it('does not warn about an unpinned HUD in a fixed-camera game', () => {
    const issues = validateJs(
      [
        'import * as Phaser from "phaser";',
        'class PlayScene extends Phaser.Scene {',
        '  create() {',
        '    this.add.text(12, 8, "SCORE: 0");',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.no_pinned_hud'))).toEqual([]);
  });

  it('does not warn when at least one object is pinned', () => {
    const issues = validateJs(
      [SCENE_PREAMBLE, '    this.add.text(12, 8, "SCORE: 0").setScrollFactor(0);', '  }', '}'].join(
        '\n',
      ),
    );
    expect(issues.filter((i) => i.message.includes('ui.no_pinned_hud'))).toEqual([]);
  });
});

describe('phaserAdapter.validate — camera zoom vs screen-space UI', () => {
  it('flags setZoom on the camera that also renders pinned UI', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    this.cameras.main.setZoom(1.25);',
        '    this.add.text(12, 566, "HP").setScrollFactor(0);',
        '  }',
        '}',
      ].join('\n'),
    );
    const hit = issues.find((i) => i.message.includes('ui.zoomed_screen_space'));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
    // 300 + (566 - 300) * 1.25 = 632.5 -> 633, off a 600px canvas.
    expect(hit?.message).toContain('633');
  });

  it('says nothing when the scene builds a dedicated UI camera', () => {
    const issues = validateJs(
      [
        SCENE_PREAMBLE,
        '    this.cameras.main.setZoom(1.25);',
        '    const ui = this.cameras.add(0, 0, 800, 600);',
        '    ui.ignore(this.worldLayer);',
        '    this.add.text(12, 566, "HP").setScrollFactor(0);',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(issues.filter((i) => i.message.includes('ui.zoomed_screen_space'))).toEqual([]);
  });

  it('says nothing at zoom 1, or when there is no screen-space UI at all', () => {
    expect(
      validateJs(
        [
          SCENE_PREAMBLE,
          '    this.cameras.main.setZoom(1);',
          '    this.add.text(12, 566, "HP").setScrollFactor(0);',
          '  }',
          '}',
        ].join('\n'),
      ).filter((i) => i.message.includes('ui.zoomed_screen_space')),
    ).toEqual([]);
    expect(
      validateJs(
        [SCENE_PREAMBLE, '    this.cameras.main.setZoom(2);', '  }', '}'].join('\n'),
      ).filter((i) => i.message.includes('ui.zoomed_screen_space')),
    ).toEqual([]);
  });
});
