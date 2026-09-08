/**
 * Which state the Controls tab should render.
 *
 * Pulled out as a pure function because getting it wrong is expensive in a very
 * specific way. The panel used to have only two states — "here are your binds"
 * and "this game reads input directly, pay for an AI run to map it" — and it
 * showed the second one for ANY game it had no manifest for.
 *
 * That is wrong for the most common game there is. Generated games routinely
 * call `window.__game.controls.define(...)` inside their PLAY scene's `create()`,
 * which only runs after the player presses Start on a title screen. Open the
 * Controls tab on a game sitting at its title screen and there is genuinely no
 * manifest yet — and because the panel OVERLAYS the game, the player can't press
 * Start to produce one either. The panel then offered an AI run to "fix" a game
 * whose controls were already perfectly mappable.
 *
 * The runtime beacon gives us the missing signal: whether the game has rendered
 * a frame at all. Combined with the manifest, three honest states fall out.
 */
export type ControlsPanelState =
  /** A manifest arrived — show the bindable action list. */
  | 'ready'
  /** No manifest, and the game hasn't rendered yet: it is still loading or
   *  waiting on a title screen. Send the player to the game; the list fills in
   *  by itself once the game declares its controls. */
  | 'waiting-for-start'
  /** No manifest even though the game IS running — it really does read input
   *  directly. Only here is the one-off AI mapping the right offer. */
  | 'unmappable';

export function controlsPanelState(hasManifest: boolean, gameStarted: boolean): ControlsPanelState {
  if (hasManifest) return 'ready';
  return gameStarted ? 'unmappable' : 'waiting-for-start';
}
