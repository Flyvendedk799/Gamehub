import { describe, expect, it } from 'vitest';
import { controlsPanelState } from '../controls-panel-state';

describe('controlsPanelState', () => {
  it('shows the binding list once a manifest has arrived', () => {
    expect(controlsPanelState(true, false)).toBe('ready');
    expect(controlsPanelState(true, true)).toBe('ready');
  });

  it('waits for the player to start a game that has not rendered yet', () => {
    // The regression this guards: a game that declares its controls inside its
    // PLAY scene has no manifest while it sits on its title screen. Offering the
    // paid "map controls with AI" run here — as the panel used to — sells a fix
    // for a game that is already mappable, and the panel overlays the game so the
    // player can't even start it to find that out.
    expect(controlsPanelState(false, false)).toBe('waiting-for-start');
  });

  it('offers the AI mapping only once the game is running and still declares nothing', () => {
    expect(controlsPanelState(false, true)).toBe('unmappable');
  });
});
