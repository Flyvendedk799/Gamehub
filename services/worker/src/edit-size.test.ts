import { describe, expect, it } from 'vitest';
import { SMALL_EDIT_LINES, countChangedLines } from './edit-size';

const A = ['one', 'two', 'three', 'four'].join('\n');

describe('countChangedLines', () => {
  it('is zero for identical files', () => {
    expect(countChangedLines(new Map([['a.js', A]]), [{ path: 'a.js', content: A }])).toBe(0);
  });

  it('counts a one-line change as a removal plus an addition', () => {
    const after = A.replace('two', 'TWO');
    expect(countChangedLines(new Map([['a.js', A]]), [{ path: 'a.js', content: after }])).toBe(2);
  });

  it('ignores a line that only moved', () => {
    const after = ['two', 'one', 'three', 'four'].join('\n');
    expect(countChangedLines(new Map([['a.js', A]]), [{ path: 'a.js', content: after }])).toBe(0);
  });

  it('counts new and deleted files in full', () => {
    const before = new Map([
      ['a.js', A],
      ['old.js', 'x\ny'],
    ]);
    const after = [
      { path: 'a.js', content: A },
      { path: 'new.js', content: 'p\nq\nr' },
    ];
    expect(countChangedLines(before, after)).toBe(3 + 2);
  });

  it('treats the movement fix from run 63a9a036 as small, and a rewrite as not small', () => {
    const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const fix = body.replace('line 10', 'line ten').replace('line 200', 'line two hundred');
    expect(
      countChangedLines(new Map([['m.js', body]]), [{ path: 'm.js', content: fix }]),
    ).toBeLessThanOrEqual(SMALL_EDIT_LINES);
    const rewrite = Array.from({ length: 300 }, (_, i) => `changed ${i}`).join('\n');
    expect(
      countChangedLines(new Map([['m.js', body]]), [{ path: 'm.js', content: rewrite }]),
    ).toBeGreaterThan(SMALL_EDIT_LINES);
  });
});
