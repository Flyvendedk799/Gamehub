/**
 * Bounded, loop-free repair of unresolved ES imports.
 *
 * Why: a Gemini (Antigravity) build rewrote the player / enemies / theme modules into the real
 * game but never touched main.js, hud.js, waves.js, fx.js — still the placeholder starter — which
 * import functions that no longer exist (`buildCraft`, `spawnRock`). Nothing could load. The
 * precise error message reached the model for ~100 turns and it still did not fix it: the open
 * editing loop is where this model class goes wrong. A single completion that sees every module
 * at once and returns corrected files is the task it is good at, so when a run ends with broken
 * imports the host makes that one call, checks the result, and (at most) once more.
 *
 * Everything model- and filesystem-facing is injected so this is unit-testable.
 */
import { sourceFixableProblems } from './tools/project-checks.js';
import type { ProjectFile } from './tools/unresolved-imports.js';

const FILE_RE = /^=== FILE: (\S+) ===\r?\n([\s\S]*?)\r?\n=== END FILE ===/gm;

/** Models sometimes wrap a file body in a markdown fence even when told not to. */
function stripFence(body: string): string {
  const m = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(body.trim());
  return m?.[1] ?? body;
}

export function parseFileBlocks(text: string): ProjectFile[] {
  const out: ProjectFile[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const path = m[1];
    const content = m[2];
    if (path === undefined || content === undefined) continue;
    out.push({ path, content: stripFence(content) });
  }
  return out;
}

/** Only `src/**.js` — never index.html, never a path that climbs out of the project. */
export function isRepairablePath(path: string): boolean {
  return /^src\/[A-Za-z0-9_./-]+\.js$/.test(path) && !path.includes('..') && !path.includes('//');
}

/** Cap on the prompt: the whole src/ tree is normally ~60KB; refuse to ship a monorepo. */
const MAX_PROMPT_CHARS = 220_000;

export function buildRepairSystemPrompt(): string {
  return [
    'You repair a broken multi-file web game written as ES modules.',
    'Some modules were rewritten to implement the real game described in the BRIEF. The others are leftovers from a placeholder starter (a dodge-the-falling-rocks toy with a craft and rocks) and still import functions the rewritten modules no longer export, so the game cannot load.',
    '',
    'Fix it so EVERY import resolves and the game runs as the brief describes:',
    '- Read the rewritten modules to learn their real exports (classes, functions, constants) and use exactly those.',
    '- Rewrite the leftover modules (typically src/main.js, src/hud.js, src/waves.js, src/fx.js) so they wire up and drive the REAL game: build the real player and the real opponents, handle the real controls, run the real win/lose flow. Delete every trace of the placeholder (craft, rocks, falling objects).',
    '- The page provides ONE input API: window.__game.controls has ONLY define({ actions: [{ id, label, keys }] }), isDown(actionId) (true while held), on(actionId, fn) (fires on press) and rebind(). There is NO controls.active / controls.get / controls.pressed - read held input with window.__game.controls.isDown(actionId).',
    '- Keep src/main.js a thin bootstrap that owns the Title -> Play -> Over flow; keep its window.__game.controls.define(...) and window.__game.debug.track({...}) calls (expose score, playerPos and the opponent health as plain numbers).',
    '- Do NOT shrink or simplify the rewritten gameplay modules; only change them if an export is genuinely missing.',
    '- If a module imports a name from a file that should provide it, add the export there OR change the import — whichever keeps the game complete.',
    '- The game must be COMPLETE and PLAYABLE: sound via sfx(), screen shake, a visible HUD, restart. No TODOs, no stubs.',
    '',
    'Output format — nothing else, no commentary. Output ONLY the files you change, each COMPLETE:',
    '=== FILE: src/main.js ===',
    '<complete file contents>',
    '=== END FILE ===',
  ].join('\n');
}

export function buildRepairUserPrompt(opts: {
  brief: string;
  spec?: unknown;
  problems: string[];
  files: ProjectFile[];
}): string | null {
  const parts: string[] = [];
  parts.push(`BRIEF (what the user asked for):\n${opts.brief.trim()}`);
  if (opts.spec !== undefined && opts.spec !== null) {
    parts.push(`DECLARED GAME SPEC:\n${JSON.stringify(opts.spec, null, 2)}`);
  }
  parts.push(
    `PROBLEMS TO FIX (${opts.problems.length}):\n${opts.problems.map((p) => `- ${p}`).join('\n')}`,
  );
  parts.push('CURRENT FILES:');
  for (const f of opts.files) parts.push(`--- ${f.path}\n${f.content}`);
  parts.push('Now output the corrected files in the required format.');
  const prompt = parts.join('\n\n');
  return prompt.length > MAX_PROMPT_CHARS ? null : prompt;
}

export interface RepairOptions {
  brief: string;
  spec?: unknown;
  /** Every text file in the project right now. */
  listFiles: () => ProjectFile[];
  write: (path: string, content: string) => Promise<void> | void;
  /** One plain completion: (system, user) -> the model's reply text. */
  generate: (system: string, user: string) => Promise<string>;
  /** Defaults to 2. */
  maxAttempts?: number;
}

export interface RepairResult {
  attempts: number;
  written: string[];
  remaining: string[];
}

function srcFiles(files: ProjectFile[]): ProjectFile[] {
  return files.filter((f) => isRepairablePath(f.path));
}

/**
 * Repair until every import resolves or the attempts run out. Never throws on a bad model reply:
 * a repair that could not be made is reported through `remaining`, and the project is left as it
 * was rather than half-written.
 */
export async function repairUnresolvedImports(opts: RepairOptions): Promise<RepairResult> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const written: string[] = [];
  let attempts = 0;
  const detect = (files: ProjectFile[]) => sourceFixableProblems(files).map((p) => p.message);
  let problems = detect(opts.listFiles());
  while (problems.length > 0 && attempts < maxAttempts) {
    attempts += 1;
    const files = srcFiles(opts.listFiles());
    const user = buildRepairUserPrompt({
      brief: opts.brief,
      spec: opts.spec,
      problems,
      files,
    });
    if (user === null) break;
    let reply: string;
    try {
      reply = await opts.generate(buildRepairSystemPrompt(), user);
    } catch {
      break;
    }
    const fixes = parseFileBlocks(reply).filter(
      (f) => isRepairablePath(f.path) && f.content.trim().length >= 40,
    );
    if (fixes.length === 0) continue;
    // Only accept a reply that leaves FEWER unresolved imports than before; a worse reply must
    // not replace a project that at least had the gameplay modules intact.
    const merged = new Map(files.map((f) => [f.path, f.content]));
    for (const f of fixes) merged.set(f.path, f.content);
    const after = detect([...merged].map(([path, content]) => ({ path, content })));
    if (after.length >= problems.length) continue;
    for (const f of fixes) {
      await opts.write(f.path, f.content);
      written.push(f.path);
    }
    problems = after;
  }
  return { attempts, written, remaining: problems };
}
