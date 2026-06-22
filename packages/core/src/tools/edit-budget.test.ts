import { describe, expect, it } from 'vitest';
import { createEditBudget } from './edit-budget.js';

describe('createEditBudget', () => {
  it('returns null until the threshold is reached', () => {
    const budget = createEditBudget(5);
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.countFor('index.html')).toBe(4);
    const warn = budget.recordEdit('index.html');
    expect(warn).not.toBeNull();
    expect(warn).toContain('[edit-budget]');
    expect(warn).toContain('5 consecutive str_replace calls against index.html');
  });

  it('keeps emitting warnings on subsequent edits past the threshold (the next one matters too)', () => {
    const budget = createEditBudget(3);
    budget.recordEdit('a');
    budget.recordEdit('a');
    expect(budget.recordEdit('a')).toContain('3 consecutive');
    expect(budget.recordEdit('a')).toContain('4 consecutive');
  });

  it('counts each path independently', () => {
    const budget = createEditBudget(3);
    budget.recordEdit('a');
    budget.recordEdit('a');
    budget.recordEdit('b');
    expect(budget.countFor('a')).toBe(2);
    expect(budget.countFor('b')).toBe(1);
    expect(budget.recordEdit('a')).toContain('against a');
  });

  it('reset() clears every path', () => {
    const budget = createEditBudget(3);
    budget.recordEdit('a');
    budget.recordEdit('b');
    budget.reset();
    expect(budget.countFor('a')).toBe(0);
    expect(budget.countFor('b')).toBe(0);
    expect(budget.recordEdit('a')).toBeNull();
  });

  it('default threshold is 5', () => {
    const budget = createEditBudget();
    for (let i = 0; i < 4; i += 1) {
      expect(budget.recordEdit('p')).toBeNull();
    }
    expect(budget.recordEdit('p')).toContain('5 consecutive');
  });

  it('cumulative warning SURVIVES verifies (reset) and fires once at the cumulative threshold', () => {
    // The incremental-edit thrash: edit a few, verify (reset), repeat. The
    // consecutive counter never trips, but the cumulative one must.
    const budget = createEditBudget(5, 12);
    let warned: string | null = null;
    for (let i = 0; i < 12; i += 1) {
      const w = budget.recordEdit('main.js');
      if (w?.includes('separate edits')) warned = w;
      if ((i + 1) % 3 === 0) budget.reset(); // "verify" between edits → resets consecutive only
    }
    expect(warned).toContain('12 separate edits to main.js');
    // One-shot: a further edit does not re-warn cumulatively.
    const after = budget.recordEdit('main.js');
    expect(after === null || !after.includes('separate edits')).toBe(true);
  });

  it('cumulative counter is per-path (one busy file does not flag a quiet one)', () => {
    const budget = createEditBudget(5, 12);
    for (let i = 0; i < 12; i += 1) budget.recordEdit('busy.js');
    expect(budget.recordEdit('quiet.js')).toBeNull();
  });
});
