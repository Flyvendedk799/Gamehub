/**
 * Engine Evolution v2 P8 — canvas2d engine adapter tests.
 *
 * Modelled on phaser.test.ts. Asserts the bootstrap emits a vendor-free
 * <canvas> document with the __game shim and NO importmap, and that validate()
 * enforces the canvas2d contract (rAF loop + getContext('2d')) and the shared
 * no-eval / anti-exfil rails.
 */

import { describe, expect, it } from 'vitest';
import { canvas2dAdapter } from './canvas2d';

describe('canvas2dAdapter shape (gameplan §7.1)', () => {
  it('exposes the locked metadata', () => {
    expect(canvas2dAdapter.id).toBe('canvas2d');
    expect(canvas2dAdapter.label).toBe('Canvas 2D');
    expect(canvas2dAdapter.canonicalEntry).toBe('index.html');
    expect(canvas2dAdapter.fileExtensions).toContain('js');
    expect(canvas2dAdapter.fileExtensions).toContain('html');
    expect(canvas2dAdapter.supportsLivePreview()).toBe(true);
  });
});

describe('canvas2dAdapter.bootstrap (vendor-free 2D)', () => {
  const opts = {
    designId: 'abc-123',
    gameBaseUrl: 'game-files://designs/abc-123/',
  };

  it('emits a doctype + a <canvas id="game"> mount target', () => {
    const html = canvas2dAdapter.bootstrap(opts);
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('<canvas');
    expect(html).toContain('id="game"');
  });

  it('embeds NO importmap and references NO CDN (canvas2d is vendor-free)', () => {
    const html = canvas2dAdapter.bootstrap(opts);
    expect(html).not.toContain('importmap');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('injects <base href> against the game-files:// URL', () => {
    const html = canvas2dAdapter.bootstrap(opts);
    expect(html).toContain('<base href="game-files://designs/abc-123/"');
  });

  it('sets up the cross-engine __game global with engine="canvas2d"', () => {
    const html = canvas2dAdapter.bootstrap({
      ...opts,
      initialParams: { particle_count: 256 },
    });
    expect(html).toContain('window.__game');
    expect(html).toContain('window.__game.engine = "canvas2d"');
    expect(html).toContain('"particle_count":256');
  });

  it('mounts the module script slot', () => {
    const html = canvas2dAdapter.bootstrap(opts);
    expect(html).toContain('<script type="module" src="src/main.js">');
  });

  it('declares the playtest debug contract with a default snapshot getter', () => {
    const html = canvas2dAdapter.bootstrap(opts);
    expect(html).toContain('window.__game.debug');
    expect(html).toContain('function track(spec)');
    expect(html).toContain('function snapshot()');
    expect(html).toContain('return null;');
  });

  it('#47 — neutralises quotes/angle-brackets in gameBaseUrl', () => {
    const html = canvas2dAdapter.bootstrap({
      ...opts,
      gameBaseUrl: 'https://evil.example.com/"><script>alert(1)</script>',
    });
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('#47 — rejects javascript:/data: gameBaseUrl bases', () => {
    expect(() =>
      canvas2dAdapter.bootstrap({ ...opts, gameBaseUrl: 'javascript:alert(1)' }),
    ).toThrow();
    expect(() =>
      canvas2dAdapter.bootstrap({ ...opts, gameBaseUrl: 'data:text/html,<script>1</script>' }),
    ).toThrow();
  });
});

describe('canvas2dAdapter.validate', () => {
  const goodIndex = `<!doctype html><html><head></head>
    <body><canvas id="game"></canvas></body></html>`;
  const goodMain = `
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    let t = 0;
    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((t % 100), 50, 10, 10);
      t += 1;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  `;

  it('returns ok for a minimal valid canvas game (rAF + getContext + draw)', () => {
    const result = canvas2dAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: goodMain },
    ]);
    expect(result.ok).toBe(true);
  });

  it('flags missing index.html as a hard error', () => {
    const result = canvas2dAdapter.validate([{ path: 'src/main.js', content: goodMain }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('index.html is missing'))).toBe(true);
  });

  it('fails a file with no requestAnimationFrame loop', () => {
    const noRaf = `
      const ctx = document.getElementById('game').getContext('2d');
      ctx.fillRect(0, 0, 10, 10);
    `;
    const result = canvas2dAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noRaf },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.message.includes('requestAnimationFrame'));
    expect(issue?.severity).toBe('error');
  });

  it("fails a file with no getContext('2d') call", () => {
    const noCtx = `
      let t = 0;
      function frame() { t += 1; requestAnimationFrame(frame); }
      requestAnimationFrame(frame);
    `;
    const result = canvas2dAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: noCtx },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.message.includes("getContext('2d')"));
    expect(issue?.severity).toBe('error');
  });

  it('fails when both rAF and getContext are missing', () => {
    const empty = 'const x = 1; console.log(x);';
    const result = canvas2dAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: empty },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('requestAnimationFrame'))).toBe(true);
    expect(result.issues.some((i) => i.message.includes("getContext('2d')"))).toBe(true);
  });

  it('flags eval / new Function as a hard error', () => {
    const evilMain = `${goodMain}
      const f = eval('1+1');
    `;
    const result = canvas2dAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: evilMain },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('eval / new Function'))).toBe(true);
  });

  it('#41 — warns (not errors) when code references the network', () => {
    const networky = `${goodMain}
      const ws = new WebSocket('wss://evil.example.com');
    `;
    const result = canvas2dAdapter.validate([
      { path: 'index.html', content: goodIndex },
      { path: 'src/main.js', content: networky },
    ]);
    // goodMain is otherwise valid, so the only issue is the network warning →
    // result is { ok: false } solely because of a warn-severity issue.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('anti_exfil'));
    expect(warn?.severity).toBe('warn');
    expect(
      result.issues.some((i) => i.severity === 'error' && i.message.includes('anti_exfil')),
    ).toBe(false);
  });

  it('flags missing js/ts files as a hard error', () => {
    const result = canvas2dAdapter.validate([{ path: 'index.html', content: goodIndex }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('No .js / .ts files found'))).toBe(true);
  });
});
