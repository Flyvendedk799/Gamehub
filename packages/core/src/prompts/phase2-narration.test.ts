/**
 * Narration policy contract.
 *
 * Game builds NOW ask for brief per-step narration (it's the primary way the
 * user follows a build in the builder feed) — this reverses the old "emit ZERO
 * text between tool calls" rule for `artifactType: 'game'`. Design/motion builds
 * keep suppressing inter-tool prose. These assertions pin both halves so a
 * future edit can't silently re-suppress game narration or leak it into design.
 */

import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from './index.js';

describe('Narration policy — game builds narrate, design/motion stay quiet', () => {
  const designAgent = composeSystemPrompt({ mode: 'create', agentMode: true });
  const gameAgent = composeSystemPrompt({
    mode: 'create',
    agentMode: true,
    artifactType: 'game',
    engine: 'three',
  });

  it('game prompt ASKS for one-sentence per-step narration', () => {
    expect(gameAgent).toContain('Narrate each step');
    expect(gameAgent).toContain('think out loud');
    expect(gameAgent).toMatch(/primary way the user follows/i);
  });

  it('game prompt explicitly OVERRIDES the no-inter-tool-text rule for games', () => {
    expect(gameAgent).toContain('OVERRIDES');
    expect(gameAgent).toMatch(/brief running commentary is wanted/);
  });

  it('design prompt still suppresses inter-tool prose (first-line filter + reasoning pill)', () => {
    expect(designAgent).toContain('First-line filter');
    expect(designAgent).toContain('Reasoned for Ns');
    // The game carve-out names design/motion as the ones that stay silent.
    expect(designAgent).toMatch(/DESIGN and MOTION builds the only correct number/);
  });

  it('design prompt does NOT ask for game-style step narration', () => {
    expect(designAgent).not.toContain('Narrate each step');
  });
});
