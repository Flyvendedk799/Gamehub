import { describe, expect, it } from 'vitest';
import { assessGame, isVerifiedGame } from './game-quality';
import { GameSpec, applyGameSpecPatch } from './game-spec';

describe('artifact readiness', () => {
  const evidence = {
    filesHash: 'hash',
    booted: true,
    behaviorPassed: true,
    issues: [],
    forceAccepted: false,
  };
  it('requires independent boot and behavior evidence tied to the current bytes', () => {
    const quality = assessGame(evidence);
    expect(isVerifiedGame(quality, 'hash')).toBe(true);
    expect(isVerifiedGame(quality, 'edited-hash')).toBe(false);
    expect(assessGame({ ...evidence, behaviorPassed: false }).status).toBe('unverified');
    expect(assessGame({ ...evidence, booted: false }).status).toBe('unverified');
    expect(isVerifiedGame(undefined, 'hash')).toBe(false);
  });
  it('never upgrades exhaustion or observed errors to verified success', () => {
    expect(assessGame({ ...evidence, forceAccepted: true }).status).toBe('needs_fixes');
    expect(assessGame({ ...evidence, issues: ['Restart failed'] }).status).toBe('needs_fixes');
  });
});

it('persists creative decisions through unrelated follow-up edits', () => {
  const spec = GameSpec.parse({
    genre: 'puzzle',
    dimensions: '2d',
    perspective: 'top_down',
    cameraKind: 'static',
    primaryInputs: ['mouse'],
    numActors: 1,
    winCondition: 'Guide the boats home',
    loseCondition: 'A boat runs aground',
    creativeBrief: {
      hook: 'Change the tide instead of steering boats',
      playerFantasy: 'Be the sea',
      visualDirection: 'Paper charts and warm ink',
      feedback: ['Ripples show the tide direction'],
      avoid: ['Neon dodge arena'],
    },
  });
  expect(
    applyGameSpecPatch(spec, { winCondition: 'Guide three boats home' }).creativeBrief,
  ).toEqual(spec.creativeBrief);
});
