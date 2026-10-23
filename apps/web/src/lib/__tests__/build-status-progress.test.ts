import { describe, expect, it } from 'vitest';
import { phaseOfProgressMessage } from '../build-status';

describe('phaseOfProgressMessage', () => {
  it('puts editing messages in Build and testing messages in Test', () => {
    expect(
      phaseOfProgressMessage('Found where this lives (src/combat.js). Rewriting it now…'),
    ).toBe(1);
    expect(phaseOfProgressMessage('Testing the game in a real browser: boot, controls…')).toBe(2);
    expect(phaseOfProgressMessage('One play check did not pass. Running it again…')).toBe(2);
    expect(phaseOfProgressMessage('Taking a look at a frame of the running game…')).toBe(2);
  });

  it('leaves unrelated text alone', () => {
    expect(
      phaseOfProgressMessage('Reading through the game to find where this belongs…'),
    ).toBeNull();
    expect(phaseOfProgressMessage('I think the camera is the problem.')).toBeNull();
  });
});
