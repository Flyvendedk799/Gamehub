import { describe, expect, it } from 'vitest';
import { echoEditedRegion, formatEditEcho } from './edit-echo.js';

const file = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

describe('echoEditedRegion', () => {
  it('shows the edited lines with context either side', () => {
    const out = echoEditedRegion(file(20), 10, 11, { context: 2 });
    expect(out).toContain(' 8 | line 8');
    expect(out).toContain('10 | line 10');
    expect(out).toContain('11 | line 11');
    expect(out).toContain('13 | line 13');
    expect(out).not.toContain('line 7');
    expect(out).not.toContain('line 14');
  });

  it('numbers lines so the next edit can target them', () => {
    // The whole point: the model should be able to compose the next
    // str_replace from this without re-reading.
    expect(echoEditedRegion(file(5), 3, 3, { context: 0 })).toBe('3 | line 3');
  });

  it('clamps to the start and end of the file', () => {
    expect(echoEditedRegion(file(5), 1, 1, { context: 5 })).toContain('1 | line 1');
    const tail = echoEditedRegion(file(5), 5, 5, { context: 5 });
    expect(tail).toContain('5 | line 5');
    expect(tail.split('\n')).toHaveLength(5);
  });

  it('elides the middle of a large edit, keeping both ends', () => {
    const out = echoEditedRegion(file(500), 100, 300, {
      context: 0,
      maxLines: 20,
      maxBytes: 99999,
    });
    const rendered = out.split('\n');
    expect(rendered.length).toBeLessThanOrEqual(21);
    expect(out).toContain('lines not shown');
    // Head and tail both survive — anchors live at the top, unbalanced braces
    // at the bottom.
    expect(out).toContain('line 100');
    expect(out).toContain('line 300');
  });

  it('drops the echo entirely when it would cost more than the round trip', () => {
    const wide = Array.from({ length: 50 }, () => 'x'.repeat(500)).join('\n');
    expect(echoEditedRegion(wide, 1, 50, { maxBytes: 1024 })).toBe('');
  });

  it('returns empty for nonsense rather than throwing', () => {
    expect(echoEditedRegion('', 1, 2)).toBe('');
    expect(echoEditedRegion(file(5), Number.NaN, 2)).toBe('');
    expect(echoEditedRegion(file(5), 99, 120)).toContain('5 | line 5');
  });
});

describe('formatEditEcho', () => {
  it('tells the model not to re-read', () => {
    const out = formatEditEcho('src/main.js', file(20), 10, 11);
    // Saying so at the moment it would decide is the cheapest way to stop the
    // confirming view.
    expect(out).toContain('no need to `view`');
    expect(out).toContain('src/main.js');
    expect(out).toContain('line 10');
  });

  it('is empty when the edit reported no line range', () => {
    expect(formatEditEcho('a.js', file(10), undefined, undefined)).toBe('');
    expect(formatEditEcho('a.js', file(10), 1, undefined)).toBe('');
  });

  it('is empty when the file is unreadable, so callers can append blindly', () => {
    expect(formatEditEcho('a.js', '', 1, 2)).toBe('');
  });
});
