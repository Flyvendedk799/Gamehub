import { describe, expect, it, vi } from 'vitest';
import { parsePositiveIntEnv } from './main';

/**
 * Regression for the env-var NaN guard (correctness M1). A typo or empty value
 * must fall back to the default rather than producing NaN, which silently
 * breaks `new Worker({concurrency})`, `setInterval(fn, NaN)` (a 0ms hot loop),
 * and the run token ceiling (`used > NaN` is always false).
 */
describe('parsePositiveIntEnv', () => {
  it('uses the fallback for unset/empty values', () => {
    expect(parsePositiveIntEnv(undefined, 2)).toBe(2);
    expect(parsePositiveIntEnv('', 5)).toBe(5);
    expect(parsePositiveIntEnv('   ', 5)).toBe(5);
  });

  it('parses valid positive integers', () => {
    expect(parsePositiveIntEnv('4', 2)).toBe(4);
    expect(parsePositiveIntEnv('100', 2)).toBe(100);
  });

  it('floors fractional values', () => {
    expect(parsePositiveIntEnv('3.9', 2)).toBe(3);
  });

  it('falls back (with a warning) for non-numeric, NaN, zero, and negative values', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePositiveIntEnv('two', 2)).toBe(2);
    expect(parsePositiveIntEnv('NaN', 2)).toBe(2);
    expect(parsePositiveIntEnv('0', 2)).toBe(2);
    expect(parsePositiveIntEnv('-5', 2)).toBe(2);
    expect(parsePositiveIntEnv('Infinity', 2)).toBe(2);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
