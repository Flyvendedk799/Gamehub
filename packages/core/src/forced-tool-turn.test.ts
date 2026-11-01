import { describe, expect, it } from 'vitest';
import {
  FORCE_TOOL_NUDGE,
  appendToolNudge,
  rejectsForcedToolChoice,
  thinkingAlwaysOn,
} from './forced-tool-turn';

describe('rejectsForcedToolChoice', () => {
  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])('%s', (id) => {
    expect(rejectsForcedToolChoice(id)).toBe(true);
  });
  it.each(['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'])(
    '%s still takes a forced choice',
    (id) => {
      expect(rejectsForcedToolChoice(id)).toBe(false);
    },
  );
});

describe('thinkingAlwaysOn', () => {
  it.each(['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5'])('%s', (id) => {
    expect(thinkingAlwaysOn(id)).toBe(true);
  });
  it.each(['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-5'])(
    '%s can switch it off',
    (id) => {
      expect(thinkingAlwaysOn(id)).toBe(false);
    },
  );
});

describe('appendToolNudge', () => {
  it('turns a string user prompt into blocks and adds the nudge last', () => {
    const params = { messages: [{ role: 'user', content: 'make a platformer' }] };
    appendToolNudge(params);
    expect(params.messages[0]?.content).toEqual([
      { type: 'text', text: 'make a platformer' },
      { type: 'text', text: FORCE_TOOL_NUDGE },
    ]);
  });

  it('keeps existing blocks (and their cache_control) in front of the nudge', () => {
    const cached = { type: 'text', text: 'prompt', cache_control: { type: 'ephemeral' } };
    const params = { messages: [{ role: 'user', content: [cached] }] };
    appendToolNudge(params);
    expect(params.messages[0]?.content).toEqual([cached, { type: 'text', text: FORCE_TOOL_NUDGE }]);
  });

  it('leaves a request alone when it does not end on a user message', () => {
    const params = { messages: [{ role: 'assistant', content: 'hi' }] };
    appendToolNudge(params);
    expect(params.messages[0]?.content).toBe('hi');
  });
});
