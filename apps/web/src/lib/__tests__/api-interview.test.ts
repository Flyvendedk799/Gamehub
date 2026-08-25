import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchInterviewPlan } from '../api';

/**
 * The client half of the design interview.
 *
 * Everything here is about ONE failure: falling back to the generic questions
 * without saying so. A plan that arrives must be used, a plan that does not
 * must leave a trace someone can read in a bug report.
 */

function stubResponse(body: unknown, status = 200): void {
  const fetchStub: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  vi.stubGlobal('fetch', fetchStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchInterviewPlan', () => {
  const plan = {
    settled: [{ layer: 'world', value: 'a flooded neon city' }],
    questions: [
      {
        id: 'cast',
        title: 'Who you play',
        question: 'Who is moving through the flooded city?',
        why: 'Decides the sprites.',
        placeholder: 'A diver…',
        options: [{ id: 'cast-0', label: 'A salvage diver' }],
      },
    ],
  };

  it('returns the drafted plan', async () => {
    stubResponse({ plan, reason: 'ok' });
    await expect(fetchInterviewPlan('a flooded city game')).resolves.toEqual(plan);
  });

  it('reports why it fell back, rather than degrading in silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubResponse({ plan: null, reason: 'model_error' });

    await expect(fetchInterviewPlan('a flooded city game')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('model_error'));
  });

  it('falls back, and says so, when the request itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 401 is the one that mattered: an interview opened without a token got the
    // generic questions and no explanation.
    stubResponse({ error: 'unauthorized' }, 401);

    await expect(fetchInterviewPlan('a flooded city game')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('401'));
  });
});
