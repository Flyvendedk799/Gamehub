import { GAME_QUALITY_BRIEF } from './game-quality.js';
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
import { sourceFixableProblems } from './tools/project-checks.js';

/** A module the draft may NOT replace — the engine the starter already runs on. */
const FROZEN_PATHS = new Set(['src/engine/core.js', 'src/runtime/session.js']);

/** Only `src/**.js` modules, never the engine, never a path that climbs out of the project. */
export function isWritableDraftPath(path: string): boolean {
  return (
    /^src\/[A-Za-z0-9_./-]+\.js$/.test(path) &&
    !path.includes('..') &&
    !path.includes('//') &&
    !FROZEN_PATHS.has(path)
  );
}

export function buildDraftSystemPrompt(engine: StarterEngine = 'three'): string {
  return [
    'You are a senior web-game developer. You are given a small, working STARTER project (a placeholder game) and a BRIEF for the game the user actually wants.',
    'Rewrite the starter modules so the project IS the game in the brief: its interactions, rules, progression or creative possibilities, look and sounds. The placeholder mechanics and subject must be gone unless the user requested them.',
    GAME_QUALITY_BRIEF,
    '',
    'THE PAGE PROVIDES (do not reimplement, do not invent other members):',
    '- window.__game.controls has ONLY: define({ actions: [{ id, label, keys: [KeyboardEvent.code or "Mouse0"/"Mouse2"] }] }) called once at startup; isDown(actionId) -> true while held; on(actionId, fn) -> fn() on press; rebind(). There is NO controls.active/get/pressed.',
    '- window.__game.debug.track({ ... }) takes getters the automatic playtest reads. Expose the actual state your rules use: for example board cells and moves for puzzles, resources and buildings for simulations, choices and current node for narrative games; score and playerPos only when relevant. All getters must read real gameplay state.',
    '- All engines export createGameSession(initialRulesState, { seed, version, historyLimit, validate }). It provides immutable state; defineAction(name, (draft,payload,{random})=>...) and dispatch(name,payload) for atomic rule changes; undo/redo/reset; pause/resume; after(seconds,callback) and advance(dtSeconds); snapshot/restore/dispose. Use it for serializable rules, resources, puzzle boards, story choices or turn state. Keep sprites/meshes outside the session. Feed advance from the existing engine update; never create a second loop. Recovery cancels managed timers. Expose debug getters into session.state. Rejected actions return false without consuming randomness. High-frequency physics remains in the engine.',
    '- src/engine/core.js is READ-ONLY and shown below. Import only what it really exports; follow the selected engine contract below.',
    '',
    'Hard rules:',
    ...(engine === 'three'
      ? [
          '- THREE CONTRACT: <canvas id="game"> already exists. createStage() returns { renderer, scene, camera, canvas, hemi, sun, ground, dispose }. The STAGE is a placeholder: adapt or remove the ground, lights, background and fog to match the brief and DESIGN DIRECTION. Use runLoop(step) for per-frame work; it returns pause/resume/dispose. For physics you may pass { fixedUpdate, fixedStep, maxSubSteps } as the second argument; fixedUpdate receives seconds before each render callback.',
          '- Controls follow the SCREEN when movement is part of the game. For ground-plane movement derive forward/right from the camera; never hard-code world axes when the view changes. For side-on or top-down views project onto the actual movement plane; handle a camera pointing straight down without a zero direction vector. Preserve intentional world-relative controls when the brief requires them.',
        ]
      : engine === 'phaser'
        ? [
            '- PHASER CONTRACT: use Phaser.Game and scenes extending SceneBase. The engine provides SceneBase, sfx, gradientBg, artTexture and impact; it does NOT provide createStage or runLoop. Phaser owns the update/physics loop. Use its scale manager for responsive layout and scene shutdown for cleanup. Preserve the seeded mounting configuration.',
          ]
        : [
            '- CANVAS2D CONTRACT: <canvas id="game"> already exists. createStage() returns { canvas, ctx, width, height, dispose }; coordinates are CSS pixels. Use runLoop(step), sfx and clamp. There is no THREE scene, camera, renderer or Phaser scene.',
          ]),
    '- Keep src/main.js a thin bootstrap. Organize modules around the actual game systems; keep or replace starter modules as needed. Choose screen flow appropriate to the game, not necessarily Title -> Play -> Over.',
    '- Every import must resolve: each name imported by one file must be exported by the file it imports from. Keep file names; you may add new src/*.js modules.',
    '- Do NOT rewrite src/engine/core.js or src/runtime/session.js and do not output index.html.',
    '- You MUST output EVERY module that must change, INCLUDING src/main.js (the starter main.js wires the placeholder and cannot be kept). Complete behavior matters, not line count. Small complete modules are valid.',
    '- Use sfx(freq, dur, type) for appropriate meaningful events with a mute control. Prefer subtle confirmation for calm games and stronger feedback for action; do not add combat effects to unrelated interactions.',
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
  const system = buildDraftSystemPrompt(opts.engine);
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
    const usable = all.filter((f) => isWritableDraftPath(f.path) && f.content.trim().length > 0);
    const skipped = all.map((f) => f.path).filter((p) => !usable.some((f) => f.path === p));
    if (!usable.some((f) => f.path === 'src/main.js')) {
      lastNote = `it had no usable src/main.js (it contained ${usable.map((f) => f.path).join(', ') || 'no usable files'}).`;
      continue;
    }
    if (new Set(usable.map((f) => f.path)).size !== usable.length) {
      lastNote = 'it contained duplicate file paths; output each module exactly once.';
      continue;
    }
    // Validate the proposed tree before the first write. A short glue module is
    // legitimate; a long module importing a nonexistent export is not.
    const proposed = new Map<string, string>();
    for (const path of Object.keys(PREMIUM_STARTER_FILES[opts.engine])) {
      const content = opts.read(path);
      if (content !== null) proposed.set(path, content);
    }
    for (const file of usable) proposed.set(file.path, file.content);
    const problems = sourceFixableProblems(
      [...proposed].map(([path, content]) => ({ path, content })),
    );
    if (problems.length > 0) {
      lastNote = problems
        .slice(0, 12)
        .map((p) => p.message)
        .join('\n');
      continue;
    }
    const written: string[] = [];
    for (const file of usable) {
      await opts.write(file.path, file.content);
      written.push(file.path);
    }
    return { written, skipped };
  }
  throw new Error(`draft rejected before writing: ${lastNote}`);
}
