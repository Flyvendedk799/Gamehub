import { describe, expect, it } from 'vitest';
import { extractUserRequest, isResumeRequest } from './user-request';

const NL = String.fromCharCode(10);

describe('extractUserRequest', () => {
  it('returns the user words from the worker edit-mode wrapper', () => {
    const wrapped = [
      '[SYSTEM: You are EDITING ...]',
      '',
      '<prompt>',
      'make the sword glow',
      '</prompt>',
    ].join(NL);
    expect(extractUserRequest(wrapped)).toBe('make the sword glow');
  });

  it('returns a plain prompt unchanged (trimmed)', () => {
    expect(extractUserRequest('  fix the camera  ')).toBe('fix the camera');
  });
});

describe('isResumeRequest', () => {
  it('recognises resume prompts but not change requests', () => {
    expect(isResumeRequest('Continue building from where you paused.')).toBe(true);
    expect(isResumeRequest('continue')).toBe(true);
    expect(isResumeRequest('Continuous attack should be faster')).toBe(false);
    expect(isResumeRequest('make the strike follow the mouse')).toBe(false);
  });
});

describe('extractUserRequest with a continuation recap', () => {
  it('returns only what the user typed after the recap', () => {
    const prompt = [
      '# Continuation',
      '',
      'Pick up from where you left off. The player could not see anything at first.',
      '',
      "## The user's latest message",
      'Combat is hard to read',
    ].join('\n');
    expect(extractUserRequest(prompt)).toBe('Combat is hard to read');
  });

  it('still prefers the <prompt> wrapper and leaves plain prompts alone', () => {
    expect(extractUserRequest('[SYSTEM: x]\n\n<prompt>\nmake it faster\n</prompt>')).toBe(
      'make it faster',
    );
    expect(extractUserRequest('make it faster')).toBe('make it faster');
  });
});
