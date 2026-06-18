import { describe, expect, it } from 'vitest';
import { ApiError, describeApiError } from '../api';

describe('describeApiError', () => {
  it('maps 402 insufficient_credits to an out-of-credits message with balance', () => {
    const err = new ApiError(402, 'API 402', 'insufficient_credits', {
      error: 'insufficient_credits',
      balance: 3,
      required: 10,
    });
    expect(describeApiError(err)).toMatch(/out of credits/i);
    expect(describeApiError(err)).toMatch(/3/);
  });

  it('maps 402 without a balance to a generic out-of-credits message', () => {
    const err = new ApiError(402, 'API 402', 'insufficient_credits', {
      error: 'insufficient_credits',
    });
    expect(describeApiError(err)).toMatch(/out of credits/i);
  });

  it('maps 429 concurrent_run_limit to a too-many-builds message', () => {
    const err = new ApiError(429, 'API 429', 'concurrent_run_limit', {
      error: 'concurrent_run_limit',
    });
    expect(describeApiError(err)).toMatch(/too many builds/i);
  });

  it('maps a generic 429 to a slow-down message', () => {
    const err = new ApiError(429, 'API 429', 'too_many_attempts', { error: 'too_many_attempts' });
    expect(describeApiError(err)).toMatch(/slow down/i);
  });

  it('maps 401/403 to a sign-in message', () => {
    expect(describeApiError(new ApiError(401, 'x', undefined, null))).toMatch(/sign in/i);
    expect(describeApiError(new ApiError(403, 'x', undefined, null))).toMatch(/sign in/i);
  });

  it('maps 5xx to a generic server-error message', () => {
    expect(describeApiError(new ApiError(500, 'x', undefined, null))).toMatch(/our side/i);
  });

  it('falls back to the error message for plain Errors', () => {
    expect(describeApiError(new Error('boom'))).toBe('boom');
  });

  it('handles non-Error throwables', () => {
    expect(describeApiError('weird')).toBe('Something went wrong.');
  });
});
