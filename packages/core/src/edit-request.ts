/**
 * What KIND of thing did the user ask for on an iteration turn?
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * `declare_edit_intent` made an iteration prove it did what was asked, and that
 * fixed the "make the jump lower" → "still too high" → `passed` loop. But it
 * assumes the request names a value: the agent restates it, picks a snapshot
 * field, and asserts a number moved.
 *
 * A bug report names nothing. Production project 687f2ddb shipped a game whose
 * HUD scrolled off-camera; the user's entire next message was:
 *
 *     "Game  does not run"
 *
 * The agent took that through the tweak path. It declared an edit intent whose
 * observable was that `blueZones` would change, edited a zone-capture rule,
 * measured `blueZones` changing, and shipped `floor_verified` with playbook 0/0.
 * Every gate agreed. The complaint was never investigated, because nothing in
 * the loop distinguished "change this specific thing" from "this is broken,
 * find out why".
 *
 * Those need different first moves. A change starts by editing. A breakage
 * report starts by REPRODUCING — and the reproduction has to look for the class
 * of defect that survives every automated gate, because a game the gates already
 * passed is exactly what the user is complaining about.
 *
 * Pure, dependency-free, and deliberately conservative: it errs toward `change`,
 * since the cost of misreading a real tweak as a bug report is a wasted
 * diagnostic pass, and the cost of the reverse is the run above.
 */

export type EditRequestKind = 'breakage' | 'change';

export interface EditRequestClassification {
  kind: EditRequestKind;
  /** The phrase that decided it, for logging and telemetry. Absent for `change`. */
  matched?: string;
}

/**
 * Phrases that report the game not working, rather than asking for a change.
 *
 * Drawn from what users actually type. Kept narrow on purpose — "the jump does
 * not work now" is a breakage report AND names a subject, and that is fine: the
 * diagnostic pass still starts by reproducing, then fixes the named thing.
 *
 * Deliberately NOT included: "too fast", "too hard", "I don't like", "make it",
 * "add", "change", "remove" — those are changes, however unhappily phrased.
 */
const BREAKAGE_PATTERNS: ReadonlyArray<RegExp> = [
  // "doesn't run" / "does not work" / "won't start" / "can't play"
  /\b(?:does|doesn|do|don|did|didn|would|wouldn|will|won|can|cann?|could|couldn)(?:'?t| not)?\s+(?:even\s+)?(?:seem to\s+)?(?:run|start|load|work|play|open|launch|boot|respond|render)\b/i,
  /\b(?:not|no longer|never)\s+(?:running|starting|loading|working|playing|opening|launching|booting|responding|rendering)\b/i,
  // "it's broken" / "totally broken" / "game is broken"
  /\bbroken\b/i,
  /\bbugged\b/i,
  // "nothing happens" / "nothing shows" / "nothing loads"
  /\bnothing\s+(?:happens|shows|loads|renders|appears|works|is happening)\b/i,
  // "blank screen" / "black screen" / "white screen" / "empty screen"
  /\b(?:blank|black|white|empty|grey|gray)\s+(?:screen|page|canvas)\b/i,
  // "just a black screen", "stuck on the loading screen"
  /\bstuck\s+(?:on|at|in)\b/i,
  // "it crashes" / "keeps crashing" / "it freezes"
  /\b(?:crash(?:es|ed|ing)?|freez(?:es|ed|ing)|hangs?)\b/i,
  // "I can't see anything" / "can't see the game"
  /\bcan(?:'?t| ?not)\s+see\b/i,
  // "unplayable"
  /\bunplayable\b/i,
  // "there is no game" / "there's no hud"
  /\bthere(?:'?s| is| are)\s+no\b/i,
];

/**
 * Classify one iteration request. Total and side-effect free.
 *
 * Only the user's own words are examined; an empty or whitespace-only prompt is
 * a `change` (there is nothing to read).
 */
export function classifyEditRequest(prompt: string): EditRequestClassification {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text.length === 0) return { kind: 'change' };
  // Only the user's ACTUAL request matters. Continuation prompts carry a
  // "Decided with the player:" recap of the original brief, and a brief may well
  // contain the word "crash" as a game mechanic; cut at that boundary.
  const request = text.split(/\n\s*Decided with the player:/i)[0] ?? text;
  for (const re of BREAKAGE_PATTERNS) {
    const m = re.exec(request);
    if (m !== null) return { kind: 'breakage', matched: m[0].trim() };
  }
  return { kind: 'change' };
}

/**
 * The round-0 prompt for an iteration that reports the game is broken.
 *
 * Two jobs. First, stop the tweak reflex: the request names no value, so there
 * is no number to declare an intent about, and inventing one produces the
 * `blueZones` outcome above. Second, aim the reproduction at the defects that
 * survive an automated pass — because the run being complained about already
 * booted, already rendered, already responded to input, and already scored its
 * predicates. Whatever is wrong is something no existing gate can see, so the
 * checklist is the list of those.
 *
 * The user's own words are quoted verbatim rather than summarised; "Game does
 * not run" is four words and every one of them is evidence.
 */
export function buildBreakageDiagnosisPrompt(userRequest: string): string {
  return [
    'The user is reporting that the game is BROKEN. Their message, in full:',
    '',
    `    ${userRequest.trim()}`,
    '',
    'This is not a tweak. Do not open by editing a value, and do not declare an',
    'edit intent that asserts some number changed — the request names no number,',
    'and a passing assertion about an unrelated field is how a broken game ships',
    'twice.',
    '',
    'Reproduce first.',
    '',
    '1. `playtest_game` the CURRENT build before changing anything. Drive it like a',
    '   player: get past the title screen, pick whatever the game asks you to pick,',
    '   then move a long way from the spawn point and keep playing. Read every',
    '   snapshot in the trace.',
    '',
    '2. The game you are looking at already passed every automated gate on the run',
    '   the user is complaining about: it booted, it rendered, it responded to input,',
    '   it scored its predicates. So the defect is one of the ones those gates cannot',
    '   see. Check each of these explicitly:',
    '',
    '   - **The HUD is gone after the camera moves.** Screen-space UI must be pinned,',
    '     and in Phaser `Container.setScrollFactor(0)` does NOT pin the container’s',
    '     children — it takes a third argument, `setScrollFactor(0, 0, true)`, and',
    '     without it every child scrolls away with the world. Camera zoom scales',
    '     pinned UI too, about the camera centre, which pushes edge-anchored HUD off',
    '     the viewport; UI belongs on its own unzoomed camera.',
    '   - **The player cannot be identified.** If the player looks like the NPCs',
    '     around it, there is no game to play. Outline it, mark it, colour it apart.',
    '   - **A screen the player cannot get past.** A modal, a role picker, a prompt',
    '     waiting on a key nothing tells the player about.',
    '   - **Controls that never reach the scene.** Bound to the wrong target, bound',
    '     before the scene exists, or swallowed by an overlay.',
    '   - **Nothing to do.** The world is empty, the objectives never appear, the',
    '     enemies never spawn, the loop never starts.',
    '',
    '3. Say what you found, in one sentence, before you fix it. If you genuinely',
    '   cannot reproduce a failure, say that instead of inventing a fix — and then',
    '   fix the most likely cause from the list above, because the user is looking',
    '   at something you are not.',
    '',
    '4. Then fix it, and re-`playtest_game` the same way you reproduced it. The',
    '   evidence that it is fixed is the trace, not the diff.',
  ].join('\n');
}
