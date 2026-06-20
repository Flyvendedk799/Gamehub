/**
 * Agent-authored playtest contract — converter + tool validation tests.
 *
 * Proves the genre-LESS verification path: a contract maps to the SAME
 * { steps, predicates } the genre playbooks produce, scored by the SAME pure
 * scorePlaytest — so a novel game (the wind/boat case) is verified against its
 * own declared input→state behaviour instead of shipping unverified.
 */
import { describe, expect, it } from 'vitest';
import { type PlaytestTrace, scorePlaytest } from './eval/playtest-score';
import { type AuthoredContract, planFromContract } from './playtest-planner';
import { makeDeclarePlaytestContractTool } from './tools/declare-playtest-contract';

describe('planFromContract', () => {
  it('projects actions to synthetic-input steps + assertions to baseline predicates', () => {
    const contract: AuthoredContract = {
      intent: 'Dragging blows the boat downriver; progress rises.',
      checks: [
        { action: 'pointerDown' },
        { action: 'pointerMove', x: 0.7, y: 0.5, assertField: 'progress', assertOp: 'increases' },
        { action: 'pointerUp' },
      ],
    };
    const plan = planFromContract(contract);
    expect(plan.steps).toEqual([
      { kind: 'mouseDown' },
      { kind: 'mouseMove', x: 0.7, y: 0.5 },
      { kind: 'mouseUp' },
    ]);
    expect(plan.predicates).toHaveLength(1);
    expect(plan.predicates[0]).toMatchObject({
      field: 'progress',
      op: 'increased',
      frame: { step: 1 },
      against: 'baseline',
    });
  });

  it('maps key checks, literal ops, and vsPrevious comparison frames', () => {
    const contract: AuthoredContract = {
      intent: 'lateral move + fire',
      checks: [
        {
          action: 'key',
          key: 'ArrowLeft',
          holdFrames: 20,
          assertField: 'playerPos.x',
          assertOp: 'decreases',
        },
        {
          action: 'key',
          key: 'ArrowRight',
          holdFrames: 20,
          assertField: 'playerPos.x',
          assertOp: 'increases',
          assertVsPrevious: true,
        },
        {
          action: 'key',
          key: 'Space',
          assertField: 'score',
          assertOp: 'greaterThan',
          assertValue: 0,
        },
      ],
    };
    const plan = planFromContract(contract);
    expect(plan.steps[0]).toEqual({ kind: 'key', code: 'ArrowLeft', frames: 20 });
    expect(plan.predicates[1]).toMatchObject({
      field: 'playerPos.x',
      op: 'increased',
      frame: { step: 1 },
      against: { step: 0 }, // vsPrevious → prior asserting step
    });
    expect(plan.predicates[2]).toMatchObject({ field: 'score', op: 'gt', value: 0 });
  });

  it('the contract predicate set passes a conforming trace + fails a broken one', () => {
    const contract: AuthoredContract = {
      intent: 'wind moves the boat',
      checks: [
        { action: 'pointerMove', x: 0.7, y: 0.5, assertField: 'progress', assertOp: 'increases' },
      ],
    };
    const { predicates } = planFromContract(contract);
    const works: PlaytestTrace = {
      baseline: { progress: 0.1 },
      frames: [{ stepIndex: 0, snapshot: { progress: 0.3 } }],
    };
    const broken: PlaytestTrace = {
      baseline: { progress: 0.1 },
      frames: [{ stepIndex: 0, snapshot: { progress: 0.1 } }], // gust did nothing
    };
    expect(scorePlaytest(works, predicates).pass).toBe(true);
    expect(scorePlaytest(broken, predicates).pass).toBe(false);
  });
});

describe('declare_playtest_contract tool', () => {
  it('rejects a contract with no assertion (nothing to verify)', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined);
    await expect(
      tool.execute('t', { intent: 'x', checks: [{ action: 'wait' }, { action: 'wait' }] }),
    ).rejects.toThrow(/at least ONE check/);
  });

  it('rejects a key check missing its code', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined);
    await expect(
      tool.execute('t', {
        intent: 'x',
        checks: [
          { action: 'key', assertField: 'score', assertOp: 'increases' },
          { action: 'wait' },
        ],
      }),
    ).rejects.toThrow(/must provide "key"/);
  });

  it('rejects a literal op without a comparison value', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined);
    await expect(
      tool.execute('t', {
        intent: 'x',
        checks: [
          { action: 'key', key: 'Space', assertField: 'score', assertOp: 'greaterThan' },
          { action: 'wait' },
        ],
      }),
    ).rejects.toThrow(/must include assertValue/);
  });

  it('accepts a valid contract and stores the projected plan', async () => {
    let stored: { predicates: unknown[] } | null = null;
    const tool = makeDeclarePlaytestContractTool((plan) => {
      stored = plan as unknown as { predicates: unknown[] };
    });
    const res = await tool.execute('t', {
      intent: 'wind guides the boat',
      checks: [
        { action: 'pointerMove', x: 0.7, y: 0.5, assertField: 'progress', assertOp: 'increases' },
        { action: 'wait', holdFrames: 30 },
      ],
    });
    expect((stored as { predicates: unknown[] } | null)?.predicates).toHaveLength(1);
    expect(res.details.fields).toContain('progress');
  });
});
