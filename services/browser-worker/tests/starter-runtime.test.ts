import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { GAME_SESSION_RUNTIME } from '../../../packages/core/src/game-session-runtime';
import { PREMIUM_STARTER_FILES } from '../../../packages/core/src/premium-starters';
import { runProductionSuite } from '../../../packages/core/src/production-suite';
import { gardenProductionPlan } from '../../../packages/shared/src/testing/production-fixtures';

it('the actual seeded engine renders, resizes its container at capped DPR, and disposes in Chromium', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 3 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const source = PREMIUM_STARTER_FILES.canvas2d['src/engine/core.js']?.replace(
      "export { createGameSession } from '../runtime/session.js';",
      GAME_SESSION_RUNTIME,
    );
    await page.setContent(`<canvas id="game" style="width:320px;height:180px"></canvas>
      <script type="module">
      ${source}
      const stage = createStage();
      window.framesRendered = 0;
      window.loop = runLoop(() => {
        stage.ctx.fillStyle = '#ff0000';
        stage.ctx.fillRect(0, 0, stage.width, stage.height);
        window.framesRendered++;
      });
      window.stage = stage;
      </script>`);
    await page.waitForFunction('window.framesRendered > 2');
    expect(await page.locator('canvas').getAttribute('width')).toBe('640');
    expect(await page.locator('canvas').getAttribute('height')).toBe('360');
    expect(
      await page.evaluate('Array.from(window.stage.ctx.getImageData(10,10,1,1).data)'),
    ).toEqual([255, 0, 0, 255]);
    await page.evaluate("document.getElementById('game').style.width = '240px'");
    await page.waitForFunction("document.getElementById('game').width === 480");
    await page.evaluate(
      'window.loop.dispose(); window.stage.dispose(); window.stoppedAt = window.framesRendered',
    );
    // Observe several real frames, not a guessed timeout.
    await page.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    expect(await page.evaluate('window.framesRendered === window.stoppedAt')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 15000);

it.each([true, false])(
  'runs real pointer actions and reset in independent browser scenarios (reset works=%s)',
  async (resetWorks) => {
    const browser = await chromium.launch({ headless: true });
    const errors: string[] = [];
    try {
      const result = await runProductionSuite(gardenProductionPlan(), async (steps) => {
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
        try {
          const page = await context.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          await page.setContent(`<canvas id="game" width="800" height="600"></canvas><script type="module">
          ${GAME_SESSION_RUNTIME}
          const game = createGameSession({ connections: 0 });
          game.defineAction('connect', (state) => { state.connections++; });
          const ctx = document.getElementById('game').getContext('2d');
          game.subscribe(state => { ctx.clearRect(0,0,800,600); ctx.fillStyle='#58b78e'; ctx.fillRect(10,10,state.connections*30,30); });
          document.addEventListener('pointerdown', () => game.dispatch('connect'));
          document.addEventListener('keydown', event => { if(event.code === 'KeyR' && ${resetWorks}) game.reset(); });
          window.__game = { debug: { snapshot: () => ({ ...game.state }) } };
        </script>`);
          await page.waitForFunction('!!window.__game');
          const baselineSnapshot = await page.evaluate('window.__game.debug.snapshot()');
          const observed = [];
          for (const step of steps) {
            if (step.kind === 'mouseMove') await page.mouse.move(step.x * 800, step.y * 600);
            if (step.kind === 'mouseDown') await page.mouse.down();
            if (step.kind === 'mouseUp') await page.mouse.up();
            if (step.kind === 'key')
              await page.keyboard.press(step.code === 'KeyR' ? 'r' : step.code);
            observed.push({
              snapshotAfter: await page.evaluate('window.__game.debug.snapshot()'),
              errors: [],
            });
          }
          return {
            hasGameContract: true,
            hasDebugContract: true,
            baselineSnapshot,
            bootErrors: [],
            steps: observed,
          };
        } finally {
          await context.close();
        }
      });
      expect(errors).toEqual([]);
      expect(result.verdict.pass).toBe(resetWorks);
      expect(result.evidence[0]?.status).toBe('passed');
      expect(result.evidence[1]?.status).toBe(resetWorks ? 'passed' : 'failed');
    } finally {
      await browser.close();
    }
  },
  15000,
);
