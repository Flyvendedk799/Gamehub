import { describe, expect, it } from 'vitest';
import { gardenProductionPlan } from '../../../packages/shared/src/testing/production-fixtures';
import { productionMilestonePrompt } from './production-build';

describe('productionMilestonePrompt', () => {
  it('lists the scenarios that failed at the checkpoint, in the host wording', () => {
    const prompt = productionMilestonePrompt('a garden game', gardenProductionPlan(), 1, [
      {
        id: 'scenario-place-tower',
        failures: ['Expose real game state with window.__game.debug.track', 'field is missing'],
      },
    ]);
    expect(prompt).toContain('these FAILED');
    expect(prompt).toContain(
      '- scenario-place-tower: Expose real game state with window.__game.debug.track | field is missing',
    );
  });

  it('says nothing about failures when the checkpoint passed', () => {
    const prompt = productionMilestonePrompt('a garden game', gardenProductionPlan(), 1);
    expect(prompt).not.toContain('FAILED');
  });
});
