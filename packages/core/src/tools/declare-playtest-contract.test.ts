/**
 * A genre-less game's contract must check the state that decides how it ends.
 *
 * Run 550cef11 (Pong, "first to 7 points") declared two checks — the paddle
 * follows the mouse, the ball moves — and passed. Neither score changed across
 * the whole playtest, so a Pong where nobody can ever score would have passed too.
 */
import { describe, expect, it } from 'vitest';
import { makeDeclarePlaytestContractTool } from './declare-playtest-contract.js';

const PONG_SPEC = {
  winCondition: 'First to 7 points wins',
  loseCondition: 'Opponent reaches 7 points first',
};

/** The contract run 550cef11 actually declared. */
const MOTION_ONLY = [
  { action: 'wait' as const, holdFrames: 30 },
  {
    action: 'pointerMove' as const,
    x: 0.1,
    y: 0.2,
    assertField: 'playerY',
    assertOp: 'changes' as const,
  },
  { action: 'wait' as const, holdFrames: 60, assertField: 'ballX', assertOp: 'changes' as const },
];

describe('declare_playtest_contract — outcome coverage', () => {
  it('refuses a contract that never checks score/lives/progress when the game can be won', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined, () => PONG_SPEC);
    await expect(
      tool.execute('1', { intent: 'mouse moves the paddle', checks: MOTION_ONLY }),
    ).rejects.toThrow(/won or lost/);
  });

  it('accepts the same contract once one check watches the score', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined, () => PONG_SPEC);
    const result = await tool.execute('1', {
      intent: 'mouse moves the paddle and the opponent scores past a still paddle',
      checks: [
        ...MOTION_ONLY,
        { action: 'wait', holdFrames: 240, assertField: 'aiScore', assertOp: 'increases' },
      ],
    });
    expect(result.details.fields).toContain('aiScore');
  });

  it('does not ask an endless toy with no win or lose condition for one', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined, () => ({
      winCondition: '—',
      loseCondition: '—',
    }));
    const result = await tool.execute('1', { intent: 'drag the fluid', checks: MOTION_ONLY });
    expect(result.details.predicates).toBe(2);
  });

  it('stays permissive when the host exposes no spec', async () => {
    const tool = makeDeclarePlaytestContractTool(undefined);
    const result = await tool.execute('1', {
      intent: 'mouse moves the paddle',
      checks: MOTION_ONLY,
    });
    expect(result.details.predicates).toBe(2);
  });
});
