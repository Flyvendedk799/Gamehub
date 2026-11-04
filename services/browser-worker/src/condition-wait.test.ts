process.env['BROWSER_WORKER_NO_AUTOSTART'] = '1';

import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type MainModule = typeof import('./main');
let mod: MainModule;
let browser: Browser;

beforeAll(async () => {
  mod = await import('./main');
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] || undefined;
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
}, 60_000);

afterAll(async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
});

describe('evaluateCondition (C3 snapshot expression unit)', () => {
  it('evaluates numeric comparisons (> < >= <= == !=)', () => {
    expect(mod.evaluateCondition('enemiesAlive > 0', { enemiesAlive: 3 })).toBe(true);
    expect(mod.evaluateCondition('enemiesAlive > 0', { enemiesAlive: 0 })).toBe(false);
    expect(mod.evaluateCondition('wave > 1', { wave: 2 })).toBe(true);
    expect(mod.evaluateCondition('wave > 1', { wave: 1 })).toBe(false);
    expect(mod.evaluateCondition('hp <= 50', { hp: 50 })).toBe(true);
    expect(mod.evaluateCondition('hp <= 50', { hp: 51 })).toBe(false);
  });

  it('evaluates boolean and string comparisons', () => {
    expect(mod.evaluateCondition('started === true', { started: true })).toBe(true);
    expect(mod.evaluateCondition('started === true', { started: false })).toBe(false);
    expect(mod.evaluateCondition("state == 'playing'", { state: 'playing' })).toBe(true);
    expect(mod.evaluateCondition("state == 'playing'", { state: 'menu' })).toBe(false);
  });

  it('evaluates OR (||) and AND (&&) compound conditions', () => {
    expect(mod.evaluateCondition('score > 0 || kills > 0', { score: 0, kills: 1 })).toBe(true);
    expect(mod.evaluateCondition('score > 0 || kills > 0', { score: 0, kills: 0 })).toBe(false);
    expect(mod.evaluateCondition('score > 0 && wave > 1', { score: 10, wave: 2 })).toBe(true);
    expect(mod.evaluateCondition('score > 0 && wave > 1', { score: 10, wave: 1 })).toBe(false);
  });

  it('evaluates nested paths safely', () => {
    expect(mod.evaluateCondition('playerPos.x >= 10', { playerPos: { x: 15, y: 0 } })).toBe(true);
    expect(mod.evaluateCondition('playerPos.x >= 10', { playerPos: { x: 5, y: 0 } })).toBe(false);
    expect(mod.evaluateCondition('playerPos.x >= 10', { playerPos: null })).toBe(false);
  });

  it('safely rejects arbitrary code / injection attempts without executing', () => {
    expect(mod.evaluateCondition('process.exit()', { score: 10 })).toBe(false);
    expect(mod.evaluateCondition("require('fs')", { score: 10 })).toBe(false);
    expect(mod.evaluateCondition('__proto__.polluted = 1', { score: 10 })).toBe(false);
    expect(mod.evaluateCondition('', { score: 10 })).toBe(false);
  });
});

describe('runPlaytest wait condition (C3 worker-level)', () => {
  it('condition wait with only until and timeoutFrames advances until condition is satisfied', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        var state = { frameCount: 0, wave: 1 };
        function loop() {
          state.frameCount++;
          if (state.frameCount >= 15) {
            state.wave = 2;
          }
          requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
        window.__game = {
          debug: { snapshot: function () { return { wave: state.wave, frameCount: state.frameCount }; } },
        };
      </script>
    </body></html>`;
    const result = await mod.runPlaytest(browser, {
      kind: 'playtest',
      htmlContent: html,
      bootTimeoutMs: 5_000,
      steps: [{ kind: 'wait', until: 'wave > 1', timeoutFrames: 120 }],
    });
    expect(result.hasGameContract).toBe(true);
    expect(result.hasDebugContract).toBe(true);
    expect(result.steps).toHaveLength(1);
    const after = result.steps[0]!.snapshotAfter as { wave: number; frameCount: number };
    expect(after.wave).toBe(2);
    expect(after.frameCount).toBeGreaterThanOrEqual(15);
  }, 30_000);
});
