import { getModel } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import { resolveModelProfile } from './model-profile';

describe('shared model capabilities', () => {
  it('uses the installed registry limits instead of an inflated universal budget', () => {
    const registered = getModel('anthropic', 'claude-sonnet-4-5');
    const profile = resolveModelProfile('anthropic', 'claude-sonnet-4-5', 'anthropic');
    expect(registered).toBeDefined();
    expect(profile.maxTokens).toBe(registered.maxTokens);
    expect(profile.contextWindow).toBe(registered.contextWindow);
    expect(profile.input).toEqual(registered.input);
  });
  it('does not invent large limits or reasoning for an unknown gateway model', () => {
    expect(resolveModelProfile('custom', 'unknown')).toMatchObject({
      maxTokens: 8192,
      contextWindow: 32768,
      reasoning: false,
      input: ['text'],
    });
  });
});
