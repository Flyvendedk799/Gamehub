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
  // Only when nothing at all can be seen. "i cant see what im doing" is a readability complaint
  // about a game that runs, so it is a change request, not a breakage report.
  /\bcan(?:'?t| ?not)\s+see\s+(?:anything|a thing|nothing|the (?:game|screen|hud|page|canvas|world))\b/i,
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

/**
 * Open-ended quality requests: "polish the game", "make it better", "improve it".
 *
 * They name no value and no behaviour, so the literal edit prompt ("do exactly what was asked and
 * nothing else") had nothing to do, and run af88707f spent 15 minutes on invisible hit-detection
 * tweaks while the user, who wanted to SEE a better game, felt it "did not do much". The gate was
 * worse: with nothing to assert, the agent asserted that a `round` field it had just invented was
 * greater than zero.
 */
const POLISH_PATTERNS: ReadonlyArray<RegExp> = [
  /\bpolish(?:ed|ing)?\b/i,
  /\bmake (?:it|the game|this)(?: a lot| much| way)? (?:better|nicer|prettier|cooler|more polished|more fun|feel better|look better)\b/i,
  /\b(?:improve|enhance|upgrade|juice(?: up)?|spruce up)\s+(?:it|the game|this|everything|the (?:graphics|visuals|feel))\b/i,
  /^\s*(?:improve|make it better|more polish|better)\s*[.!]?\s*$/i,
  // Quality complaints that name no change: "needs improvement", "hard to see what I'm doing",
  // "feels clunky". The user's own words go into the brief, so the upgrades aim at the complaint.
  /\bneeds?\s+(?:some\s+)?(?:improv\w*|work|polish\w*)\b/i,
  /\b(?:hard|difficult)\s+to\s+(?:\w+\s+){0,4}(?:see|read|tell|follow|understand|control)\b/i,
  /\bcan(?:'?t|not)\s+see\s+what\b/i,
  /\b(?:clunky|janky|unclear|confusing|unreadable|stiff|floaty|boring|ugly)\b/i,
  /\bfeels?\s+(?:bad|off|wrong|clunky|floaty|stiff|unresponsive|flat)\b/i,
];

/** True for a request that asks for general quality rather than one named change. */
export function isOpenEndedPolishRequest(prompt: string): boolean {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text.length === 0 || text.length > 240) return false;
  // A named change ("add a double jump", "make the platforms longer") is a change, whatever else
  // the sentence says about polish.
  if (
    /\b(?:add|remove|delete|change|fix|longer|shorter|bigger|smaller|faster|slower|higher|lower)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return POLISH_PATTERNS.some((re) => re.test(text));
}

/**
 * Turn a vague quality request into a concrete brief for the edit step: pick a few upgrades a
 * player will SEE and FEEL, leave mechanics alone. Concrete beats "do exactly what was asked".
 */
export function buildPolishRequest(userRequest: string, seen?: string | null): string {
  return [
    `The user asked, in general terms: "${userRequest.trim()}"`,
    '',
    ...(seen !== undefined && seen !== null && seen.trim().length > 0
      ? [
          'WHAT THE RUNNING GAME LOOKS LIKE RIGHT NOW (from a screenshot of it being played):',
          seen.trim(),
          '',
          'Build on what is really there: fix the weak points above first.',
          '',
        ]
      : []),
    'That names no single change, so choose 3 to 5 upgrades a player will clearly SEE and FEEL in the first ten seconds of play, and make them. Pick the ones this game is missing, from:',
    '- Impact feedback: hit flash or squash on the victim, impact sparks or particles, short screen shake and a brief hit-stop on a clean hit, a distinct effect on block / parry / miss.',
    '- Motion: anticipation and follow-through on attacks, smooth easing instead of snapping, a readable idle and movement animation.',
    '- Readability: HUD that shows health / stamina / state clearly, floating damage or combo numbers, a clear win / lose / restart screen.',
    '- Atmosphere: lighting, fog or background depth, colour grading, a camera that follows the action.',
    '- Audio: a short sound for each of attack, hit, block, win, lose.',
    '',
    'Make it count:',
    '- At least THREE of your changes must be NEW things a player can see on screen (a new effect, animation, telegraph, HUD element, lighting or camera behaviour). Retuning an existing sound or number does not count towards those three.',
    '- Read the code first and do not re-add anything that already exists. If a hit already spawns sparks and floating numbers, add something it does NOT have yet.',
    "- If the user's words point at an area (combat, movement, the HUD, the camera), put most of the effort there.",
    '',
    'Do NOT change rules, controls, balance numbers or the genre, and do not rewrite working systems. Additive, visible changes only, in the files that already own that behaviour.',
  ].join('\n');
}

/**
 * A request about how the game PLAYS, not how it looks: "more skill based", "the AI is too
 * predictable", "it needs more depth".
 *
 * Run e229481c: "Take this to the next level. Make it better and more skill based." matched the
 * polish patterns ("make it better"), so it got the polish brief, whose last line says "Do NOT
 * change rules, controls, balance numbers". The edit obediently changed the camera, added sound
 * effects and a spacing push, and left combat.js and ai.js untouched: the one thing asked for.
 * Deliberately narrow: "make it harder" or "make it faster" are tuning requests, not this.
 */
const GAMEPLAY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bskill(?:s|ed|ful)?(?:[- ]based)?\b/i,
  /\bmechanics?\b/i,
  /\bgame ?play\b/i,
  /\bdepth\b|\bshallow\b/i,
  /\bstrateg(?:y|ic)\b|\btactic(?:s|al)?\b/i,
  /\b(?:smarter|predictable|dumb)\b/i,
  /\b(?:enemy|opponent|npc|bot)s?\s+(?:ai|behaviou?r|logic)\b|\bthe ai\b/i,
  /\b(?:repetitive|button[- ]?mash\w*|counter-?play)\b|\bmash(?:ing)? (?:the )?buttons?\b/i,
  /\brisk (?:and|\/|&) reward\b/i,
];

export function isGameplayDepthRequest(prompt: string): boolean {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text.length === 0 || text.length > 400) return false;
  return GAMEPLAY_PATTERNS.some((re) => re.test(text));
}

/**
 * The brief for a request about gameplay depth. Unlike the polish brief it is allowed, and
 * required, to change rules and AI: the point is how the game plays, not how it looks.
 */
export function buildGameplayRequest(userRequest: string, seen?: string | null): string {
  return [
    `The user asked: "${userRequest.trim()}"`,
    '',
    ...(seen !== undefined && seen !== null && seen.trim().length > 0
      ? [
          'WHAT THE RUNNING GAME LOOKS LIKE RIGHT NOW (from a screenshot of it being played):',
          seen.trim(),
          '',
        ]
      : []),
    'They want the game to PLAY deeper, not just look better. Choose 3 to 5 changes to how it plays and make them in the code that owns the rules and the opponent, not only in the visuals. Skill means reading, timing and positioning beat button-mashing. Good changes, adapted to this game and genre:',
    '- Telegraphs and counterplay: every enemy action has a readable lead-in and a right answer (block, parry, dodge, or punish its recovery). Vary the actions (quick, slow and heavy, feints, delayed) so one answer is not always correct.',
    '- Risk and reward: strong moves leave you open; a well-timed parry or dodge opens a counter window; mashing drains stamina and gets punished.',
    '- A smarter opponent: it mixes up timing, feints, backs off to recover, punishes your recovery and adjusts to repeated patterns, but stays fair (it never reads inputs and never has unblockable moves).',
    '- Positioning: range, spacing and pushback matter; stepping out of reach is a real choice.',
    '- Clear outcomes: a clean hit, block, parry, dodge, whiff and punish each look and sound different.',
    '',
    'Rules for this change:',
    '- Change mechanics and AI where needed. At least one change must be to the OPPONENT behaviour and at least one to the PLAYER options. Retuning an existing number or sound does not count.',
    '- Read the code first. Do not re-add what exists, and do not rewrite systems that already work.',
    '- Keep the controls, keep the game completable, and keep every field exposed through window.__game.debug.track (the automatic playtest reads them). If you change the camera, change how input becomes movement with it: right must still move the player right on screen.',
    '- A player who walks up and strikes repeatedly must still be able to land hits: difficulty comes from timing and reading, never from an opponent that cannot be hit.',
    '- Add the matching feedback (animation, effect, sound or HUD) so each new mechanic is visible, but the mechanics come first.',
  ].join('\n');
}
