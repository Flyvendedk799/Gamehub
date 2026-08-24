/**
 * Visual critique — feed ONE frame back into the loop (BUILD_SPEED §3).
 *
 * The agent cannot see what it built. `playtest_game` returns numbers — positions,
 * HP, error counts — and the agent reasons entirely from them. Run 3's `juice_score`
 * fell 96 → 91 while the game got twice as large, and nothing in the loop noticed,
 * because nothing in the loop looks at a frame.
 *
 * Flat lighting, untextured primitives, unreadable silhouettes, HUD elements
 * colliding, z-fighting: every one is obvious in a screenshot and invisible in a
 * state snapshot. The browser-worker already screenshots (the thumbnail job) and the
 * platform credential is a vision model, so the frame costs nothing new to obtain.
 *
 * BOUNDED, NOT A LOOP. Two vision calls per run, no more: one at the first passing
 * playtest (its findings drive at most one repair round) and one after the last
 * repair (recorded, never acted on). `MAX_VISUAL_CRITIQUES` is the contract.
 *
 * Pure + dependency-free: the prompt, the parser, and the repair instruction. The
 * model call and the screenshot both live in the worker.
 */

/** Hard cap on vision calls per run. One at first pass, one after the last repair. */
export const MAX_VISUAL_CRITIQUES = 2;

/** A finding is only worth a repair round if it is about what the frame SHOWS. */
export interface VisualCritique {
  /** What reads as unfinished, most severe first. Empty when the frame looks shipped. */
  findings: string[];
  /** True when the model returned the explicit ship verdict and no findings. */
  readsFinished: boolean;
  /** The raw model text, kept for telemetry so a bad critique is diagnosable. */
  raw: string;
}

/**
 * The question asked of the frame.
 *
 * Deliberately narrow: "what reads as unfinished", not "how would you improve this".
 * An open-ended critique produces taste notes the agent cannot act on and a repair
 * round spent re-skinning something that was fine. The named failure modes are the
 * ones a frame reveals and a state snapshot cannot.
 *
 * The output contract is strict because the parser is strict — a critique we cannot
 * parse must read as "no findings" and ship, never as a phantom repair.
 */
export function buildVisualCritiquePrompt(brief: string): string {
  return [
    'This is one frame from a web game that was just built to this brief:',
    '',
    brief.trim().slice(0, 600),
    '',
    'You are the first pair of eyes on it. Judge ONLY what this frame shows.',
    '',
    'Report what reads as UNFINISHED — the things a player would notice in a',
    'screenshot and call unpolished:',
    '  - flat or absent lighting; everything one shade',
    '  - untextured default primitives standing in for a named thing',
    '  - a subject whose silhouette is unreadable against the background',
    '  - HUD or text colliding with itself, with the play area, or clipped off-screen',
    '  - z-fighting, seams, or geometry visibly intersecting wrongly',
    '  - an empty or near-empty frame where the game should be',
    '',
    'Do NOT comment on: game design, difficulty, whether the idea is good, art',
    'style preference, or anything you cannot see in this single frame. If the',
    'frame looks like a finished game, say so — a wrong finding costs a whole',
    'repair round.',
    '',
    'Answer in EXACTLY this format and nothing else:',
    '',
    'FINDING: <one specific, visible problem and where in the frame it is>',
    'FINDING: <the next one>',
    '(at most 4, most severe first — omit the lines entirely if there are none)',
    'VERDICT: FIX   (if you listed any findings)',
    'VERDICT: SHIP  (if the frame reads as a finished game)',
  ].join('\n');
}

const FINDING_LINE = /^\s*(?:[-*]\s*)?FINDING\s*:\s*(.+)$/i;
const VERDICT_LINE = /^\s*(?:[-*]\s*)?VERDICT\s*:\s*(SHIP|FIX)\b/i;
const MAX_FINDINGS = 4;

/**
 * Parse a critique into findings.
 *
 * Fails SAFE in both directions:
 *  - unparseable text → no findings, `readsFinished` false. We do not spend a
 *    repair round on something we could not read, and we do not claim the frame
 *    was blessed either.
 *  - `VERDICT: SHIP` alongside findings → the findings win. A model that lists
 *    problems and then says ship has contradicted itself; the concrete half is
 *    the trustworthy half.
 */
export function parseVisualCritique(raw: string): VisualCritique {
  const findings: string[] = [];
  let sawShip = false;
  for (const line of raw.split('\n')) {
    const finding = FINDING_LINE.exec(line);
    if (finding !== null) {
      const text = (finding[1] ?? '').trim();
      // A placeholder echoed back from the format block is not a finding.
      if (text.length > 0 && !text.startsWith('<') && findings.length < MAX_FINDINGS) {
        findings.push(text);
      }
      continue;
    }
    const verdict = VERDICT_LINE.exec(line);
    if (verdict !== null && (verdict[1] ?? '').toUpperCase() === 'SHIP') sawShip = true;
  }
  return { findings, readsFinished: sawShip && findings.length === 0, raw };
}

/**
 * Turn findings into ONE repair instruction.
 *
 * Framed as "you have now seen a frame of your own game" on purpose: the agent has
 * spent the whole run reasoning from a state snapshot, and the instruction has to
 * be explicit that this is new information, not a restatement of the playtest.
 */
export function buildVisualRepairInstruction(findings: readonly string[]): string {
  const list = findings.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return [
    'A screenshot was taken of your game running, and reviewed. This is the first',
    'time anything in this run has LOOKED at the game — every check before now read',
    'state values, which cannot see any of the following:',
    '',
    list,
    '',
    'Fix these, in order, and only these. They are about how the game LOOKS, so the',
    'fixes are in your draw/render code, your materials and lighting, your palette,',
    'and your HUD layout — not in the gameplay logic, which is already verified.',
    '',
    'Change nothing unrelated. Then re-run validate_game_scene + playtest_game and',
    'call done.',
  ].join('\n');
}
