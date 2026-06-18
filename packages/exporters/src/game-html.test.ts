/**
 * gameplan §A7 — game-html exporter tests.
 *
 * Mocks the global `fetch` to avoid hitting cdn.jsdelivr.net during CI.
 * The exporter's offline-bundling logic is what we want to verify; the
 * actual network shape is exercised by the manual smoke checklist.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportGameHtml } from './game-html';

const FAKE_THREE_SOURCE = '/* three.js stub */\nexport const THREE = {};';
const FAKE_PHASER_SOURCE = '/* phaser stub */\nexport default class Phaser {}';
const FAKE_ADDON_SOURCE =
  "/* orbit-controls stub */\nimport * as THREE from 'three';\nexport class OrbitControls {}";

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'playforge-game-html-')));
  // Stub fetch so tests don't hit the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const body = u.includes('/examples/jsm/')
        ? FAKE_ADDON_SOURCE
        : u.includes('three@')
          ? FAKE_THREE_SOURCE
          : FAKE_PHASER_SOURCE;
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
      } as Response;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('exportGameHtml', () => {
  it('produces a single offline file with the engine inlined as a data: URL', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html>
<html><head>
<base href="game-files://designs/abc-123/" />
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    const result = await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        {
          path: 'src/main.js',
          content: "import * as THREE from 'three'; const scene = new THREE();",
        },
      ],
      engine: 'three',
    });
    expect(result.path).toBe(dest);
    const written = readFileSync(dest, 'utf8');
    // Engine library inlined as data: URL — original CDN URL is gone.
    expect(written).not.toContain('cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js');
    expect(written).toContain('data:text/javascript;base64,');
    // Module script for src/main.js was rewritten to a data: URL.
    expect(written).toMatch(/<script type="module" src="data:text\/javascript;base64,/);
    // <base href> was stripped — file: URLs need none.
    expect(written).not.toContain('<base ');
  });

  it('rejects engines other than three / phaser', async () => {
    const dest = join(workDir, 'game.html');
    await expect(
      exportGameHtml(dest, {
        files: [{ path: 'index.html', content: '<html></html>' }],
        engine: 'native' as never,
      }),
    ).rejects.toThrow(/browser-engine-only|game-html.*only supports browser engines/);
  });

  it('throws when the file bundle is missing index.html', async () => {
    const dest = join(workDir, 'game.html');
    await expect(
      exportGameHtml(dest, {
        files: [{ path: 'src/main.js', content: 'console.log(1);' }],
        engine: 'phaser',
      }),
    ).rejects.toThrow(/index\.html entry point/);
  });

  it('inlines binary assets as data: URLs and rewrites path references', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>
</head><body>
<img src="assets/logo.png" />
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        { path: 'src/main.js', content: "this.load.image('logo', 'assets/logo.png');" },
        { path: 'assets/logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      engine: 'phaser',
    });
    const written = readFileSync(dest, 'utf8');
    expect(written).toContain('data:image/png;base64,iVBORw==');
    // The asset path string in the HTML body was replaced with the data URL.
    expect(written).not.toMatch(/<img[^>]*src=["']assets\/logo\.png["']/);
  });

  it('honours pinnedVersion override when fetching the engine', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas></body></html>`;
    await exportGameHtml(dest, {
      files: [{ path: 'index.html', content: indexHtml }],
      engine: 'three',
      engineVersion: '0.171.0',
    });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js',
    );
  });

  it('injects the hardened anti-exfil CSP meta (#13) and denies network egress', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        { path: 'src/main.js', content: "import * as THREE from 'three';" },
      ],
      engine: 'three',
    });
    const written = readFileSync(dest, 'utf8');
    // CSP meta present.
    expect(written).toMatch(/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*>/i);
    // No network egress allowed.
    expect(written).toContain("connect-src 'none'");
    // default-src locked down.
    expect(written).toContain("default-src 'none'");
    // img-src must NOT contain a wildcard.
    const cspMatch = written.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i,
    );
    expect(cspMatch).not.toBeNull();
    const policy = cspMatch?.[1] ?? '';
    const imgDirective = policy.split(';').find((d) => d.trim().startsWith('img-src')) ?? '';
    expect(imgDirective).not.toContain('*');
    expect(imgDirective).toContain("'self'");
    // The engine is inlined (no live CDN), so script-src must NOT pin a CDN host.
    const scriptDirective = policy.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptDirective).not.toContain('cdn.jsdelivr.net');
    expect(scriptDirective).toContain("'unsafe-inline'");
  });

  it('strips an author-supplied CSP meta and overrides it with the hardened policy', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src *; connect-src https://evil.example img-src *">
<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>
</head><body><canvas id="game"></canvas></body></html>`;
    await exportGameHtml(dest, {
      files: [{ path: 'index.html', content: indexHtml }],
      engine: 'phaser',
    });
    const written = readFileSync(dest, 'utf8');
    // The weak author policy must be gone.
    expect(written).not.toContain('default-src *');
    expect(written).not.toContain('https://evil.example');
    // Exactly one CSP meta remains — ours.
    const cspMetas = written.match(/http-equiv="Content-Security-Policy"/gi) ?? [];
    expect(cspMetas).toHaveLength(1);
    expect(written).toContain("connect-src 'none'");
    expect(written).toContain("default-src 'none'");
  });

  it('surfaces a clear error when the engine fetch fails (network down)', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: () => Promise.resolve('') }) as Response),
    );
    const dest = join(workDir, 'game.html');
    await expect(
      exportGameHtml(dest, {
        files: [
          {
            path: 'index.html',
            content:
              '<html><head><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script></head><body></body></html>',
          },
        ],
        engine: 'three',
      }),
    ).rejects.toThrow(/Failed to fetch the three library/);
  });

  it('rewrites ALL importmap entries — bare engine + addons prefix — to inlined sources (#43a)', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html>
<html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
</head><body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        {
          path: 'src/main.js',
          content:
            "import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nnew OrbitControls();",
        },
      ],
      engine: 'three',
    });
    const written = readFileSync(dest, 'utf8');
    // No CDN reference remains anywhere — neither the bare engine URL nor the
    // addons directory prefix URL.
    expect(written).not.toContain('cdn.jsdelivr.net');
    // The addons prefix mapping must be expanded to an explicit per-module
    // data: URL keyed by the specifier the project actually imported.
    expect(written).toMatch(
      /"three\/addons\/controls\/OrbitControls\.js"\s*:\s*"data:text\/javascript;base64,/,
    );
    // The bare `three` entry is the inlined engine data: URL.
    expect(written).toMatch(/"three"\s*:\s*"data:text\/javascript;base64,/);
    // No remaining bare prefix entry (a live CDN dir the CSP would block).
    expect(written).not.toMatch(/"three\/addons\/"\s*:/);
    // The inlined addon source was actually fetched + embedded.
    const addonB64 = Buffer.from(FAKE_ADDON_SOURCE, 'utf8').toString('base64');
    expect(written).toContain(addonB64);
  });

  it('inlines a CSS url() asset so no local path survives (#43b)', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>
<link rel="stylesheet" href="styles/game.css" />
</head><body>
<div id="bg" style="background: url('assets/tile.png')"></div>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        { path: 'src/main.js', content: 'console.log("game");' },
        {
          path: 'styles/game.css',
          content:
            'body { background: url(assets/tile.png); }\n#hud { background: url("assets/hud.png"); }',
        },
        { path: 'assets/tile.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { path: 'assets/hud.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x48]) },
      ],
      engine: 'phaser',
    });
    const written = readFileSync(dest, 'utf8');
    // The stylesheet href was inlined to a data:text/css URL.
    expect(written).toMatch(/href=["']data:text\/css;base64,/);
    // No remaining un-inlined local asset paths anywhere in the output —
    // inline-style url(), css url() (bare + quoted), and the css href.
    assertNoLocalRefs(written, [
      'assets/tile.png',
      'assets/hud.png',
      'styles/game.css',
      'src/main.js',
    ]);
    // Both pngs were embedded.
    expect(written).toContain('data:image/png;base64,');
  });

  it('inlines dynamic import() of a local module (#43c)', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body>
<canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        {
          path: 'src/main.js',
          content:
            "async function boot() {\n  const level = await import('./levels/level1.js');\n  const boss = await import('src/levels/boss.js');\n  level.start(); boss.start();\n}\nboot();",
        },
        { path: 'src/levels/level1.js', content: 'export function start() { return 1; }' },
        { path: 'src/levels/boss.js', content: 'export function start() { return 2; }' },
      ],
      engine: 'three',
    });
    const written = readFileSync(dest, 'utf8');
    // No remaining local module paths — the dynamic import() specifiers were
    // rewritten to data: URLs inside the inlined entry module.
    assertNoLocalRefs(written, [
      'src/levels/level1.js',
      './levels/level1.js',
      'src/levels/boss.js',
      'src/main.js',
    ]);
  });

  it('injects the configurable "Remix this" CTA and still locks connect-src to none (#3.2)', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas>
<script type="module" src="src/main.js"></script>
</body></html>`;
    await exportGameHtml(dest, {
      files: [
        { path: 'index.html', content: indexHtml },
        { path: 'src/main.js', content: "import * as THREE from 'three';" },
      ],
      engine: 'three',
      appBaseUrl: 'https://play.example.app',
      publishSlug: 'cool-game',
    });
    const written = readFileSync(dest, 'utf8');
    // CTA anchor present, with the configurable deep link + ref=embed, opening
    // in a new tab so it survives the hardened CSP.
    expect(written).toContain('Made with');
    expect(written).toContain('https://play.example.app/p/cool-game?ref=embed');
    expect(written).toMatch(/target="_blank"[^>]*rel="noopener/);
    // The anti-exfil boundary is untouched — no network egress, default-src none.
    expect(written).toContain("connect-src 'none'");
    expect(written).toContain("default-src 'none'");
    // No hardcoded host: the only base URL present is the one we configured.
    expect(written).not.toContain('playforge.app/p/');
  });

  it('omits the CTA when appBaseUrl is not configured', async () => {
    const dest = join(workDir, 'game.html');
    const indexHtml = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas></body></html>`;
    await exportGameHtml(dest, {
      files: [{ path: 'index.html', content: indexHtml }],
      engine: 'three',
    });
    const written = readFileSync(dest, 'utf8');
    expect(written).not.toContain('pf-remix-cta');
    expect(written).not.toContain('?ref=embed');
  });
});

/**
 * Assert none of the given local bundle paths survive as un-inlined
 * references in the exported HTML. Checks quoted specifiers, css url(...),
 * and src=/href= attribute values — the surfaces the inliner must cover.
 */
function assertNoLocalRefs(html: string, paths: string[]): void {
  for (const p of paths) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(html).not.toMatch(new RegExp(`(['"\`])${esc}\\1`));
    expect(html).not.toMatch(new RegExp(`url\\(\\s*['"\`]?${esc}`));
    expect(html).not.toMatch(new RegExp(`(?:src|href)\\s*=\\s*['"\`]${esc}`));
  }
}
