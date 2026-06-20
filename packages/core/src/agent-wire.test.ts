/**
 * Provider/wire smoke tests — the regression guard for the class of bug that bit
 * us three times this cycle (Anthropic wire 404, Codex base 404, Codex model).
 * Each was a never-exercised path. These assert buildPiModel resolves each
 * provider to the right api + base URL, no network needed.
 */
import type { ModelRef } from '@playforge/shared';
import { describe, expect, it } from 'vitest';
import { buildPiModel } from './agent';

const m = (provider: string, modelId: string): ModelRef => ({ provider, modelId });

describe('buildPiModel — provider/wire resolution', () => {
  it('anthropic infers the anthropic wire + api.anthropic.com', () => {
    const pi = buildPiModel(m('anthropic', 'claude-sonnet-4-6'), undefined, undefined);
    expect(pi.api).toBe('anthropic-messages');
    expect(pi.baseUrl).toBe('https://api.anthropic.com');
  });

  it('openai defaults to openai-completions + api.openai.com/v1', () => {
    const pi = buildPiModel(m('openai', 'gpt-5.5'), undefined, undefined);
    expect(pi.api).toBe('openai-completions');
    expect(pi.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('codex subscription wire → openai-codex-responses + chatgpt.com backend (NOT api.openai.com)', () => {
    const pi = buildPiModel(m('openai', 'gpt-5.5'), 'openai-codex-responses', undefined);
    expect(pi.api).toBe('openai-codex-responses');
    expect(pi.baseUrl).toBe('https://chatgpt.com/backend-api');
  });

  it('an explicit baseUrl wins over the inferred default (canonicalized)', () => {
    const pi = buildPiModel(
      m('anthropic', 'claude-sonnet-4-6'),
      'anthropic',
      'https://proxy.example.com/v1',
    );
    expect(pi.baseUrl).toBe('https://proxy.example.com'); // anthropic wire strips /v1
  });
});
