/**
 * First-draft writer for a project that is still the unmodified starter.
 *
 * Why this exists: with Gemini (Antigravity) the open-ended editing loop never converged. Live
 * runs read the seeded starter for ~200 tool calls, then wrote only some modules, left the rest as
 * the placeholder, and ended "paused" so the user had to keep pressing continue. The same model,
 * asked to write the whole game as ONE plain completion with the runtime contract in front of it,
 * produces coherent, consistent modules in under a minute. So the host does the first draft and
 * hands the agent a project that already loads, for the verify / playtest / polish work the loop
 * is good at.
 *
 * Everything model-facing is injected so this is unit-testable without a network.
 */
import { parseFileBlocks } from './import-repair.js';
import { PREMIUM_STARTER_FILES, type StarterEngine } from './premium-starters.js';

/** A module the draft may NOT replace — the engine the starter already runs on. */
const FROZEN_PATHS = new Set(['src/engine/core.js']);

/** Only `src/**.js` modules, never the engine, never a path that climbs out of the project. */
export function isWritableDraftPath(path: string): boolean {
  return (
    /^src\/[A-Za-z0-9_./-]+\.js$/.test(path) &&
    !path.includes('..') &&
    !path.includes('//') &&
    !FROZEN_PATHS.has(path)
  );
}

export function buildDraftSystemPrompt(): string {
  return [
    'You are a senior web-game developer. You are given a small, working STARTER project (a placeholder game) and a BRIEF for the game the user actually wants.',
    'Rewrite the starter modules so the project IS the game in the brief: its player, its opponents, its controls, its rules, its win and lose conditions, its look and its sounds. The placeholder subject (falling objects, a craft, rocks) must be gone.',
    '',
    'THE PAGE PROVIDES (do not reimplement, do not invent other members):',
    '- window.__game.controls has ONLY: define({ actions: [{ id, label, keys: [KeyboardEvent.code or "Mouse0"/"Mouse2"] }] }) called once at startup; isDown(actionId) -> true while held; on(actionId, fn) -> fn() on press; rebind(). There is NO controls.active/get/pressed.',
    '- window.__game.debug.track({ ... }) takes getters the automatic playtest reads. ALWAYS expose: score: () => number, playerPos: () => ({ x, y, z }) (a plain object of the fighter\'s world position), and every live number the rules use, e.g. playerHp, opponentHp, state ("title" | "play" | "over").',
    '- The canvas is <canvas id="game"> and already exists; src/engine/core.js (READ-ONLY, shown below) provides createStage, runLoop, sfx and the exports the starter imports. Import only what it really exports.',
    '',
    'Hard rules:',
    '- The starter STAGE is a placeholder, not a look to keep: createStage() returns { renderer, scene, camera, canvas, hemi, sun, ground } - a dark-blue void, a flat grey ground plane, one hemisphere + sun rig, fog and a camera at (0, 7, 12). Recolour, move or remove those (scene.remove(stage.ground)), set scene.background / scene.fog, and drive stage.camera yourself every frame to match the DESIGN DIRECTION below. A game whose arena, camera and lighting still look like the starter has FAILED.',
    '- Keep the module structure: src/main.js stays a thin bootstrap that wires the others and owns the Title -> Play -> Over screen flow; gameplay lives in the other modules.',
    '- Every import must resolve: each name imported by one file must be exported by the file it imports from. Keep file names; you may add new src/*.js modules.',
    '- Do NOT rewrite src/engine/core.js and do not output index.html.',
    '- You MUST output EVERY module that the game needs, INCLUDING src/main.js (the starter main.js wires the placeholder and cannot be kept) - a reply without src/main.js is rejected. Gameplay modules should be substantial (hundreds of lines), not sketches.',
    '- Make it a REAL game: the opponent must act and fight back with readable telegraphs; combat must have weight (hit-stop or shake, sparks, sound); health/state HUD always visible; a clear win and a clear lose; restart without reloading.',
    '- Call sfx(freq, dur, type) on every meaningful event (swing, hit, block, parry, hurt, win, lose) and kick the camera shake on impacts. The game must NOT be silent.',
    '- Draw named things as themselves (composed shapes), not a tinted default primitive.',
    '- COMPLETE and PLAYABLE as written. No TODOs, no placeholders, no stubs.',
    '',
    'Output format — nothing else, no commentary:',
    '=== FILE: src/main.js ===',
    '<complete file contents>',
    '=== END FILE ===',
    '(repeat for every file you write; write ALL modules that must change, each COMPLETE)',
  ].join('\n');
}

export function buildDraftUserPrompt(opts: {
  brief: string;
  spec: unknown;
  engine: StarterEngine;
  /** Binding art / camera / setting direction (see variation.ts). */
  direction?: string | undefined;
  read: (path: string) => string | null;
}): string {
  const parts: string[] = [];
  parts.push(`ENGINE: ${opts.engine}`);
  parts.push(`BRIEF (what the user asked for):\n${opts.brief.trim()}`);
  if (opts.spec !== undefined && opts.spec !== null) {
    parts.push(
      `DECLARED GAME SPEC (the design already agreed):\n${JSON.stringify(opts.spec, null, 2)}`,
    );
  }
  if (opts.direction) parts.push(opts.direction);
  parts.push('STARTER FILES (current contents):');
  for (const path of Object.keys(PREMIUM_STARTER_FILES[opts.engine])) {
    if (!path.startsWith('src/')) continue;
    const body = opts.read(path);
    if (body === null) continue;
    const note = FROZEN_PATHS.has(path) ? ' (READ-ONLY reference — do not output this file)' : '';
    parts.push(`--- ${path}${note}\n${body}`);
  }
  parts.push('Now output the rewritten game files in the required format.');
  return parts.join('\n\n');
}

export interface DraftOptions {
  engine: StarterEngine;
  brief: string;
  spec?: unknown;
  /** Binding design direction, rolled per project. */
  direction?: string;
  read: (path: string) => string | null;
  write: (path: string, content: string) => Promise<void> | void;
  /** One plain completion: (system, user) -> the model's reply text. */
  generate: (system: string, user: string) => Promise<string>;
}

export interface DraftResult {
  written: string[];
  skipped: string[];
}

/**
 * Generate and write the first draft. Throws when the reply holds no usable entry module, so the
 * caller leaves the project as it was instead of reporting a draft that never happened. Nothing
 * is written unless the entry module is among the usable files (no half-converted project).
 */
export async function draftGameFromStarter(opts: DraftOptions): Promise<DraftResult> {
  const system = buildDraftSystemPrompt();
  const user = buildDraftUserPrompt({
    brief: opts.brief,
    spec: opts.spec,
    engine: opts.engine,
    direction: opts.direction,
    read: opts.read,
  });
  let lastNote = '';
  // One retry: the usual failure is a reply that rewrites some modules but forgets src/main.js.
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}

Your previous reply was rejected: ${lastNote} Output ALL modules again, each COMPLETE, and make sure src/main.js is included.`;
    const reply = await opts.generate(system, prompt);
    const all = parseFileBlocks(reply);
    const usable = all.filter((f) => isWritableDraftPath(f.path) && f.content.trim().length >= 80);
    const skipped = all.map((f) => f.path).filter((p) => !usable.some((f) => f.path === p));
    if (!usable.some((f) => f.path === 'src/main.js')) {
      lastNote = `it had no usable src/main.js (it contained ${usable.map((f) => f.path).join(', ') || 'no usable files'}).`;
      continue;
    }
    const written: string[] = [];
    for (const file of usable) {
      await opts.write(file.path, file.content);
      written.push(file.path);
    }
    return { written, skipped };
  }
  throw new Error(`draft did not include a usable src/main.js (${lastNote})`);
}
