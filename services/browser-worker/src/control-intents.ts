/**
 * Resolve a playtest step's intent ("walk toward the opponent", "attack") to the key the game
 * actually binds, using the controls manifest the game declared.
 *
 * A canned playbook has to name a key, and any key it names is a guess: W is forward in one duel
 * and a dodge in another, and a game that binds attack to U gets no strike at all. The game has
 * already said what its keys are. `window.__game.controls.define({ actions })` publishes a
 * manifest (the same one that fills the Controls tab), so a step can carry an `action` hint and
 * the browser worker swaps in the bound key. The step's own `code` stays as the fallback for a
 * game that declares no controls or has no matching action, so nothing that worked is lost.
 */

export type ControlIntent = 'forward' | 'attack' | 'heavy';

export interface ControlManifestAction {
  id?: unknown;
  label?: unknown;
  keys?: unknown;
}

export interface ControlManifest {
  actions?: unknown;
}

interface IntentRule {
  match: RegExp;
  /** An action whose name also matches this is a different action (e.g. "back", "block"). */
  exclude?: RegExp;
}

/** Matched against the action's id and label only: descriptions say things like "block an attack". */
const RULES: Record<ControlIntent, IntentRule> = {
  forward: {
    match: /forward|advance|approach|step.?in|walk.?in|move.?up|toward/i,
    exclude: /back|retreat|away|jump|dodge|roll|lateral|strafe/i,
  },
  attack: {
    match: /attack|strike|slash|swing|stab|thrust|punch|hit\b|light/i,
    exclude: /heavy|strong|power|charge|special|ranged|parry|block|guard|dodge/i,
  },
  heavy: {
    match: /heavy|strong|power|charge/i,
    exclude: /parry|block|guard|dodge/i,
  },
};

/** A key code the playtest can hold down. Mouse and gamepad bindings are not key steps. */
const KEYBOARD_CODE =
  /^(Key[A-Z]|Digit\d|Arrow(Up|Down|Left|Right)|Space|Enter|Shift(Left|Right)|Control(Left|Right)|Numpad\w+)$/;

function isIntent(value: string): value is ControlIntent {
  return value in RULES;
}

/**
 * The keyboard code bound to `intent`, or null when the manifest is absent, has no matching
 * action, or the matching action has no keyboard binding. Pure and total: it never throws on a
 * malformed manifest, because the manifest comes from untrusted game code.
 */
export function resolveControlKey(manifest: unknown, intent: string): string | null {
  if (!isIntent(intent)) return null;
  const actions = (manifest as ControlManifest | null | undefined)?.actions;
  if (!Array.isArray(actions)) return null;
  const rule = RULES[intent];
  for (const raw of actions) {
    if (raw === null || typeof raw !== 'object') continue;
    const action = raw as ControlManifestAction;
    const name = `${typeof action.id === 'string' ? action.id : ''} ${
      typeof action.label === 'string' ? action.label : ''
    }`;
    if (!rule.match.test(name)) continue;
    if (rule.exclude?.test(name) === true) continue;
    if (!Array.isArray(action.keys)) continue;
    const code = action.keys.find(
      (k): k is string => typeof k === 'string' && KEYBOARD_CODE.test(k),
    );
    if (code !== undefined) return code;
  }
  return null;
}
