import { type GenerateOutput, planFromContract } from '@playforge/agent-core';
import type { GameSpec } from '@playforge/shared';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import { gardenProductionPlan } from '../../../packages/shared/src/testing/production-fixtures';
import { type BrowserJobsPort, runGeneration } from './run-generation';

const SPEC = {
  schemaVersion: 1,
  genre: 'topdown_arcade',
  dimensions: '2d',
  perspective: 'top_down',
  cameraKind: 'static',
  primaryInputs: ['mouse'],
  numActors: 0,
  winCondition: 'Connect the garden',
  loseCondition: '—',
  features: {},
} as GameSpec;
const PLAN = planFromContract({
  intent: 'Grow a connected musical garden using the pointer',
  checks: [
    { action: 'pointerMove', x: 0.4, y: 0.5 },
    { action: 'pointerDown', assertField: 'connections', assertOp: 'increases' },
  ],
});
const REQUEST = {
  prompt: 'A musical garden where connecting plants makes a melody',
  model: { provider: 'anthropic' as const, modelId: 'claude-opus-4-8' },
  apiKey: 'test',
};
const output = (): GenerateOutput => ({
  message: 'Built a musical garden',
  artifacts: [],
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
  interrupted: false,
});

describe('creative game verification and repair rollback', () => {
  it('preserves a playable foundation when a later milestone breaks syntax, without claiming missing recovery works', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    let builds = 0;
    const result = await runGeneration(REQUEST, {
      store,
      maxRepairRounds: 0,
      browserJobs: {
        async runtimeVerify() {
          return { hasGameContract: true, fatalErrors: [] };
        },
        async playtest(_html, steps) {
          return {
            hasGameContract: true,
            hasDebugContract: true,
            bootErrors: [],
            baselineSnapshot: { connections: 0 },
            steps: steps.map((step) => ({ step, errors: [], snapshotAfter: { connections: 1 } })),
          };
        },
      },
      async generate(_input, deps) {
        if (++builds === 1) {
          await deps.gameMode?.setSpec?.({ ...SPEC, productionPlan: gardenProductionPlan() });
          await deps.fs?.create('index.html', '<html><body>PLAYABLE FOUNDATION</body></html>');
        } else {
          await deps.fs?.create('index.html', '<html><script>const broken = ;</script></html>');
        }
        return output();
      },
    });
    expect(builds).toBe(2);
    expect(
      new TextDecoder().decode(await store.readFile(result.snapshot.manifest, 'index.html')),
    ).toContain('PLAYABLE FOUNDATION');
    expect(result.quality?.status).toBe('needs_fixes');
    expect(result.quality?.booted).toBe(true);
    expect(result.quality?.production?.scenarios.map((s) => s.status)).toEqual([
      'passed',
      'failed',
    ]);
  });

  it('still repairs a failing game when the first pass ran out of tool calls', async () => {
    // Run 489e99ec: the pass spent its cap reading, the game still failed, and the run shipped
    // as budget_exhausted without one repair round. The cap belongs to that pass, not the run.
    const store = new SnapshotStore(new InMemoryBlobStore());
    let builds = 0;
    const result = await runGeneration(REQUEST, {
      store,
      browserJobs: {
        async runtimeVerify() {
          return { hasGameContract: true, fatalErrors: [] };
        },
        async playtest(html, steps) {
          const recovery = steps.some((s) => s.kind === 'key' && s.code === 'KeyR');
          return {
            hasGameContract: true,
            hasDebugContract: true,
            bootErrors: [],
            baselineSnapshot: { connections: 0 },
            steps: steps.map((step, index) => ({
              step,
              errors: [],
              snapshotAfter: {
                connections: recovery && index === 2 && html.includes('RECOVERED') ? 0 : 1,
              },
            })),
          };
        },
      },
      async generate(_input, deps) {
        builds += 1;
        if (builds === 1) {
          await deps.gameMode?.setSpec?.({ ...SPEC, productionPlan: gardenProductionPlan() });
          await deps.fs?.create('index.html', '<html><body>STILL BROKEN</body></html>');
          return { ...output(), stoppedAtToolBudget: true };
        }
        await deps.fs?.create('index.html', '<html><body>RECOVERED</body></html>');
        return output();
      },
    });
    expect(result.repairRounds).toBe(1);
    expect(result.quality?.status).toBe('verified');
  });

  it('builds the declared milestones, verifies every scenario, repairs recovery, and locks requirements', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const plan = gardenProductionPlan();
    const phases: string[] = [];
    const driven: string[] = [];
    let locked = false;
    const result = await runGeneration(REQUEST, {
      store,
      browserJobs: {
        async runtimeVerify() {
          return { hasGameContract: true, fatalErrors: [] };
        },
        async playtest(html, steps) {
          const recovery = steps.some((s) => s.kind === 'key' && s.code === 'KeyR');
          driven.push(recovery ? 'recovery' : 'core');
          return {
            hasGameContract: true,
            hasDebugContract: true,
            bootErrors: [],
            baselineSnapshot: { connections: 0 },
            steps: steps.map((step, index) => ({
              step,
              errors: [],
              snapshotAfter: {
                connections: recovery && index === 2 && html.includes('RECOVERED') ? 0 : 1,
              },
            })),
          };
        },
      },
      async generate(input, deps) {
        phases.push(input.prompt);
        if (phases.length === 1) {
          await deps.gameMode?.setSpec?.({ ...SPEC, productionPlan: plan });
          await deps.fs?.create('index.html', '<html><body>FOUNDATION</body></html>');
        } else if (phases.length === 2) {
          expect(input.editMode).toBe(true);
          expect(input.fastDraft).toBe(false);
          expect(input.fastEdit).toBe(false);
          expect(input.buildPass).toBe(true);
          try {
            await deps.gameMode?.setSpec?.(SPEC);
          } catch {
            locked = true;
          }
          await deps.fs?.create(
            'index.html',
            '<html><body>COMPLETE MECHANICS, BROKEN RESET</body></html>',
          );
        } else {
          await deps.fs?.create(
            'index.html',
            '<html><body>COMPLETE MECHANICS AND RECOVERED</body></html>',
          );
        }
        return output();
      },
    });
    expect(phases).toHaveLength(3);
    expect(phases[1]).toContain('PRODUCTION MILESTONE 2/2');
    expect(phases[2]).toContain('Reset the composition');
    expect(locked).toBe(true);
    expect(driven).toEqual(['core', 'recovery', 'core', 'recovery', 'core', 'recovery']);
    expect(result.repairRounds).toBe(1);
    expect(result.quality?.status).toBe('verified');
    expect(result.quality?.production?.buildPasses).toBe(2);
    expect(result.quality?.production?.scenarios.map((s) => s.status)).toEqual([
      'passed',
      'passed',
    ]);
    expect(result.quality?.verificationPlan).toBeUndefined();
  });

  it('preserves the production suite on follow-up edits without rerunning build milestones', async () => {
    const plan = gardenProductionPlan();
    let calls = 0;
    const result = await runGeneration(
      {
        ...REQUEST,
        initialFiles: new Map([['index.html', '<html><body>garden</body></html>']]),
        spec: { ...SPEC, productionPlan: plan },
      },
      {
        store: new SnapshotStore(new InMemoryBlobStore()),
        browserJobs: {
          async runtimeVerify() {
            return { hasGameContract: true, fatalErrors: [] };
          },
          async playtest(_html, steps) {
            return {
              hasGameContract: true,
              hasDebugContract: true,
              bootErrors: [],
              baselineSnapshot: { connections: 0 },
              steps: steps.map((step) => ({
                step,
                errors: [],
                snapshotAfter: { connections: step.kind === 'key' ? 0 : 1 },
              })),
            };
          },
        },
        async generate() {
          calls++;
          return output();
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.quality?.status).toBe('verified');
    expect(result.quality?.production?.scenarios).toHaveLength(2);
  });

  it('uses custom mechanics instead of WASD defaults even under a known genre label', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const seenSteps: unknown[] = [];
    const browserJobs: BrowserJobsPort = {
      async runtimeVerify() {
        return { hasGameContract: true, fatalErrors: [] };
      },
      async playtest(_html, steps) {
        seenSteps.push(steps);
        return {
          hasGameContract: true,
          hasDebugContract: true,
          baselineSnapshot: { connections: 0 },
          bootErrors: [],
          steps: steps.map((step) => ({ step, snapshotAfter: { connections: 1 }, errors: [] })),
        };
      },
    };
    const result = await runGeneration(REQUEST, {
      store,
      browserJobs,
      async generate(_input, deps) {
        await deps.gameMode?.setSpec?.(SPEC);
        await deps.gameMode?.setContract?.(PLAN);
        await deps.fs?.create('index.html', '<html><body>garden</body></html>');
        return output();
      },
    });
    expect(result.shipReason).toBe('passed');
    expect(result.repairRounds).toBe(0);
    expect(seenSteps).toEqual([PLAN.steps]);
    expect(result.quality?.verificationPlan?.predicates).toEqual(PLAN.predicates);
    expect(result.quality?.status).toBe('unverified');
    expect(result.quality?.issues.join(' ')).toContain('production plan');
  });

  it.each(['runtime', 'syntax'] as const)(
    'recovers the tested game when visual polish introduces a %s error',
    async (fault) => {
      const store = new SnapshotStore(new InMemoryBlobStore());
      let rounds = 0;
      let contractLocked = false;
      const browserJobs: BrowserJobsPort = {
        async runtimeVerify(html) {
          return {
            hasGameContract: !html.includes('BROKEN'),
            fatalErrors: html.includes('BROKEN') ? ['broken repair'] : [],
          };
        },
        async playtest(_html, steps) {
          return {
            hasGameContract: true,
            hasDebugContract: true,
            baselineSnapshot: { connections: 0 },
            bootErrors: [],
            steps: steps.map((step) => ({ step, snapshotAfter: { connections: 1 }, errors: [] })),
          };
        },
        async screenshot() {
          return { pngBase64: 'aGVsbG8=', width: 640, height: 360 };
        },
      };
      const result = await runGeneration(REQUEST, {
        store,
        browserJobs,
        maxRepairRounds: 0,
        visionCritic: async () => 'FINDING: controls text is unreadable\nVERDICT: FIX',
        async generate(_input, deps) {
          rounds++;
          if (rounds === 1) {
            await deps.gameMode?.setSpec?.(SPEC);
            await deps.gameMode?.setContract?.(PLAN);
            await deps.fs?.create('index.html', '<html><body>WORKING GARDEN</body></html>');
          } else {
            try {
              await deps.gameMode?.setContract?.({ ...PLAN, predicates: [] });
            } catch {
              contractLocked = true;
            }
            await deps.fs?.create(
              'index.html',
              fault === 'syntax'
                ? '<html><body><script>const x = ;</script></body></html>'
                : '<html><body>BROKEN</body></html>',
            );
            await deps.fs?.create('src/repair-only.js', 'export const unused = true;');
          }
          return output();
        },
      });
      const html = new TextDecoder().decode(
        await store.readFile(result.snapshot.manifest, 'index.html'),
      );
      expect(rounds).toBe(2);
      expect(contractLocked).toBe(true);
      expect(html).toContain('WORKING GARDEN');
      expect(html).not.toContain('BROKEN');
      expect(result.runtimeVerify?.booted).toBe(true);
      expect(result.quality?.verificationPlan?.predicates).toEqual(PLAN.predicates);
    },
  );
});
