/**
 * Iteration-request classification. The corpus is what users actually send:
 * project 687f2ddb's follow-up was the four words "Game  does not run", and the
 * change-side cases are the ones that must NOT be pulled into a diagnosis pass.
 */
import { describe, expect, it } from 'vitest';
import { buildBreakageDiagnosisPrompt, classifyEditRequest } from './edit-request.js';

describe('classifyEditRequest — breakage reports', () => {
  const breakage = [
    'Game  does not run', // the production message, double space and all
    "game doesn't run",
    'it doesnt work',
    'the game wont start',
    'It will not load',
    'cant play it',
    'the jump does not work now',
    'this is broken',
    'totally bugged',
    'nothing happens when I press anything',
    'i just get a black screen',
    'blank canvas',
    'stuck on the loading screen',
    'it crashes after a few seconds',
    'the whole thing freezes',
    "I can't see anything",
    'unplayable',
    'there is no hud at all',
  ];

  for (const prompt of breakage) {
    it(`reads "${prompt}" as a breakage report`, () => {
      const c = classifyEditRequest(prompt);
      expect(c.kind).toBe('breakage');
      expect(c.matched).toBeTruthy();
    });
  }
});

describe('classifyEditRequest — ordinary changes', () => {
  const changes = [
    'The jump is way too high',
    'cut it down to 1/4',
    'disable auto run',
    'make the enemies faster',
    'add a second level',
    'I dont like the colours, use something warmer',
    'remove the timer',
    'can you make the soldiers bigger',
    'more enemies please',
    'the difficulty ramps too fast',
    '',
    '   ',
  ];

  for (const prompt of changes) {
    it(`reads ${JSON.stringify(prompt)} as an ordinary change`, () => {
      expect(classifyEditRequest(prompt).kind).toBe('change');
    });
  }

  it('does not misread a brief that merely mentions crashing as a bug report', () => {
    // The initial-run prompt carries a "Decided with the player" recap; only the
    // user's own request above it is examined.
    const prompt = [
      'Make the cars spark when they scrape the wall',
      '',
      'Decided with the player:',
      '- Core loop: race, crash, respawn',
    ].join('\n');
    expect(classifyEditRequest(prompt).kind).toBe('change');
  });
});

describe('buildBreakageDiagnosisPrompt', () => {
  it('quotes the user verbatim and forbids the tweak reflex', () => {
    const p = buildBreakageDiagnosisPrompt('  Game  does not run  ');
    expect(p).toContain('Game  does not run');
    expect(p).toMatch(/not a tweak/i);
    expect(p).toMatch(/reproduce/i);
  });

  it('names the defect classes that survive every automated gate', () => {
    const p = buildBreakageDiagnosisPrompt('broken');
    expect(p).toContain('setScrollFactor(0, 0, true)');
    expect(p).toMatch(/camera zoom/i);
    expect(p).toMatch(/player cannot be identified/i);
    expect(p).toMatch(/controls that never reach the scene/i);
  });
});
