import { describe, expect, it } from 'vitest';
import { DEFAULT_API_PORT, parsePositiveIntEnv } from './main';

describe('API main config', () => {
  it('defaults to the frontend dev API port', () => {
    expect(DEFAULT_API_PORT).toBe(3191);
    expect(parsePositiveIntEnv(undefined, DEFAULT_API_PORT)).toBe(3191);
  });
});
