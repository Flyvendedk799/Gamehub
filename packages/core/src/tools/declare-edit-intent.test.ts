import { describe, expect, it } from 'vitest';
import { type EditIntent, makeDeclareEditIntentTool } from './declare-edit-intent';

function capture() {
  const seen: EditIntent[] = [];
  const tool = makeDeclareEditIntentTool((intent) => {
    seen.push(intent);
  });
  return { tool, seen };
}

/** The real request that took six runs in production. */
const JUMP_CHECKS = [
  // A settling step with no assertion — the predicate below compares against the
  // pre-input baseline frame, so no explicit baseline assertion is needed.
  { action: 'wait' as const, holdFrames: 30 },
  {
    action: 'key' as const,
    key: 'Space',
    holdFrames: 8,
    assertField: 'playerPos.y',
    assertOp: 'greaterThan' as const,
    assertValue: 260,
  },
];

describe('declare_edit_intent', () => {
  it('records a checkable intent and reports its predicates', async () => {
    const { tool, seen } = capture();
    const res = await tool.execute('t1', {
      request: 'make the jump about a quarter as high',
      observable: 'holding Space lifts the player far less far off the ground',
      checks: JUMP_CHECKS,
    });
    expect(res.details.unobservable).toBe(false);
    expect(res.details.predicates).toBeGreaterThan(0);
    expect(res.details.fields).toContain('playerPos.y');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request).toBe('make the jump about a quarter as high');
    expect(seen[0]?.plan?.predicates.length).toBeGreaterThan(0);
  });

  it('rejects checks that assert nothing — the whole point is a measurement', async () => {
    const { tool } = capture();
    await expect(
      tool.execute('t1', {
        request: 'make the jump lower',
        observable: 'the jump is lower',
        // Inputs but no assertion: this would ship exactly the way the
        // un-gated runs did — looking verified while checking nothing.
        checks: [{ action: 'key', key: 'Space', holdFrames: 8 }],
      }),
    ).rejects.toThrow(/at least ONE check with assertField/);
  });

  it('requires a key for a key action', async () => {
    const { tool } = capture();
    await expect(
      tool.execute('t1', {
        request: 'x',
        observable: 'y',
        checks: [{ action: 'key', assertField: 'score', assertOp: 'increases' }],
      }),
    ).rejects.toThrow(/must provide "key"/);
  });

  it('requires assertValue for a literal comparison', async () => {
    const { tool } = capture();
    await expect(
      tool.execute('t1', {
        request: 'x',
        observable: 'y',
        checks: [{ action: 'key', key: 'Space', assertField: 'playerPos.y', assertOp: 'lessThan' }],
      }),
    ).rejects.toThrow(/must include assertValue/);
  });

  it('accepts an explicitly unobservable edit, and records it as such', async () => {
    const { tool, seen } = capture();
    const res = await tool.execute('t1', {
      request: 'rename the enemy variable',
      observable: 'nothing — pure refactor',
      checks: [],
    });
    expect(res.details.unobservable).toBe(true);
    expect(seen[0]?.plan).toBeNull();
    // It must still be a deliberate statement that got recorded, not silence.
    expect(seen).toHaveLength(1);
  });

  it('no-ops safely when the host wires no setter', async () => {
    const tool = makeDeclareEditIntentTool(undefined);
    const res = await tool.execute('t1', {
      request: 'make the jump lower',
      observable: 'lower apex',
      checks: JUMP_CHECKS,
    });
    expect(res.details.predicates).toBeGreaterThan(0);
  });
});
