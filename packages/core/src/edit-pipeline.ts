/**
 * Loop-free application of a user's change request.
 *
 * Why this exists: with Gemini (Antigravity) the open editing loop is where precision is lost. In a
 * live follow-up ("the striking effect points the wrong way; it should follow the mouse") the model
 * made 115 editor calls: 12 edits failed (it quoted code it had invented, e.g. a probe comment that
 * is not in the file) and the ONE that landed changed the page shell, not the game. The run still
 * finished "successfully", so the user got a game that ignored the request.
 *
 * The same model does well with the whole file in front of it. So the change is made in two plain
 * completions - (1) pick the file(s) the request is about, (2) rewrite exactly those files - and
 * accepted only if the project still loads (no new broken imports / runtime-API misuse) and the
 * rewrite did not gut the file. The agent loop then verifies; it no longer has to locate and patch.
 *
 * Everything model- and filesystem-facing is injected so this is unit-testable.
 */
import { applyHunks, parseEditBlocks, parseSummary } from './edit-blocks.js';
import { isRepairablePath, parseFileBlocks } from './import-repair.js';
import { projectProblems } from './tools/project-checks.js';
import type { ProjectFile } from './tools/unresolved-imports.js';

/** A rewrite shorter than this share of the original is treated as destructive and refused. */
const MIN_KEEP_RATIO = 0.55;
const MAX_FILES = 3;
const MAX_PROMPT_CHARS = 200_000;

/** Declarations + first comment lines: enough to choose a file without reading all of them. */
export function outlineOf(file: ProjectFile): string {
  const lines = file.content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < 60; i++) {
    const line = lines[i] ?? '';
    if (
      /^\s*(export\s+)?(async\s+)?(function\*?|class)\s+\w+/.test(line) ||
      /^\s*export\s+(const|let|var)\s+\w+/.test(line) ||
      /^\s{2}(async\s+)?[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/.test(line)
    ) {
      out.push(`  L${i + 1}: ${line.trim().slice(0, 110)}`);
    }
  }
  const head = lines
    .slice(0, 3)
    .filter((l) => l.trim().startsWith('//'))
    .join(' ')
    .slice(0, 160);
  return `${file.path} (${lines.length} lines)${head ? ` ${head}` : ''}\n${out.join('\n')}`;
}

export function buildLocateSystemPrompt(): string {
  return [
    'You route a change request for a small web game to the source files that must change.',
    'You get the request and an outline of every source file (declarations with line numbers).',
    `Pick the ${MAX_FILES} or fewer files whose code must be edited to satisfy the request - the ones that CONTAIN the behaviour the user is talking about, not files that merely call it.`,
    'Reply with ONLY a JSON object: {"files": ["src/a.js"], "why": "one sentence"}',
  ].join('\n');
}

export function buildLocateUserPrompt(request: string, files: ProjectFile[]): string {
  return [
    `CHANGE REQUEST:\n${request.trim()}`,
    `SOURCE FILES:\n${files.map(outlineOf).join('\n\n')}`,
    'Which files must change? JSON only.',
  ].join('\n\n');
}

export function parseLocateReply(reply: string, known: Set<string>): string[] {
  const m = /\{[\s\S]*\}/.exec(reply);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return [];
    return parsed.files
      .filter((f): f is string => typeof f === 'string' && known.has(f))
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

/** "combat.js", "combat.js and duelist.js", "combat.js, duelist.js and hud.js". */
export function fileNames(paths: readonly string[]): string {
  const names = paths.map((p) => p.split('/').pop() ?? p);
  if (names.length <= 1) return names[0] ?? 'the game';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type EditMode = 'diff' | 'full';

export function buildEditSystemPrompt(mode: EditMode = 'full'): string {
  return [
    "You make ONE change to a working web game, exactly as the user describes it. You are given the user's request and the COMPLETE current contents of the file(s) to change.",
    '',
    'Rules:',
    '- Do EXACTLY what was asked - the behaviour, the direction, the value, the look the user named - and nothing else. Do not refactor, rename, restyle or "improve" anything the user did not mention.',
    '- First reason about where in the code the behaviour lives and what is actually wrong or missing (quote the relevant lines to yourself), then change it. If the request names a direction, key, mouse behaviour, number or colour, the result must demonstrably follow it.',
    mode === 'diff'
      ? '- Change only what is needed, using SEARCH/REPLACE hunks (format below). Copy each SEARCH EXACTLY from the file shown above, with enough surrounding lines that it matches once, and keep every hunk small. Use a FILE block with the complete contents only for a brand-new file, or when most of an existing file changes.'
      : '- Return each changed file COMPLETE and otherwise byte-for-byte identical - never abbreviate with "...", never drop code you did not mean to change.',
    '- Keep every existing export and import working; do not rename exports other files use.',
    "- A complaint about which way something FACES, aims or points is about what happens every frame, not at spawn. Find the per-frame code that sets rotation / facing / flip / aim and make THAT follow the target or the movement; changing only an initial value is not a fix when the update loop never maintains it (the first live attempt set the spawn yaw and left the loop alone, so the character still turned the wrong way as soon as play started). In Three.js a mesh's front is its local +Z axis, so `rotation.y = Math.atan2(dx, dz)` turns it toward the vector (dx, dz); Phaser uses `flipX` / `setRotation` the same way. Check the model's own front against the camera before deciding which sign is right.",
    '- The page provides ONE input API: window.__game.controls has ONLY define({ actions }), isDown(actionId), on(actionId, fn), rebind(). There is NO controls.active/get/pressed.',
    '- Mouse position is available through your own mousemove listener; convert it to world space with the camera when the request is about aiming.',
    '- Write the SUMMARY for the PLAYER: 2 to 4 short bullets in plain language about what they will notice when they play. No file names, no function names, no code terms.',
    '',
    'Output format - after your reasoning, ONLY these blocks:',
    '=== SUMMARY ===',
    '- <what the player will notice>',
    '=== END SUMMARY ===',
    ...(mode === 'diff'
      ? [
          '=== EDIT: src/player.js ===',
          '<<<<<<< SEARCH',
          '<exact existing lines>',
          '=======',
          '<replacement lines>',
          '>>>>>>> REPLACE',
          '(more hunks for the same file may follow; each is applied in order)',
          '=== END EDIT ===',
          '(and, only for a new file or a near-total rewrite:)',
        ]
      : []),
    '=== FILE: src/player.js ===',
    '<complete file contents>',
    '=== END FILE ===',
  ].join('\n');
}

export function buildEditUserPrompt(opts: {
  request: string;
  brief?: string;
  targets: ProjectFile[];
  others: ProjectFile[];
  problems?: string[];
}): string | null {
  const parts: string[] = [`USER REQUEST (do exactly this):\n${opts.request.trim()}`];
  if (opts.brief) parts.push(`THE GAME (for context only):\n${opts.brief.trim().slice(0, 1500)}`);
  parts.push(
    `OTHER SOURCE FILES (outlines, so imports stay correct - do not output these):\n${opts.others
      .map(outlineOf)
      .join('\n\n')}`,
  );
  parts.push('FILES TO CHANGE (complete current contents):');
  for (const f of opts.targets) parts.push(`--- ${f.path}\n${f.content}`);
  if (opts.problems && opts.problems.length > 0) {
    parts.push(
      `YOUR PREVIOUS ATTEMPT BROKE THE PROJECT - fix these while still doing what was asked:\n${opts.problems
        .map((p) => `- ${p}`)
        .join('\n')}`,
    );
  }
  parts.push('Now give your reasoning, then the changed files in the required format.');
  const prompt = parts.join('\n\n');
  return prompt.length > MAX_PROMPT_CHARS ? null : prompt;
}

export interface EditOptions {
  request: string;
  brief?: string;
  /** Every text file in the project right now. */
  listFiles: () => ProjectFile[];
  write: (path: string, content: string) => Promise<void> | void;
  /** One plain completion: (system, user, reasoning) -> the model's reply text. */
  generate: (system: string, user: string, reasoning: string) => Promise<string>;
  /** Plain-language progress for the chat, so the minutes this takes are not silent. */
  progress?: (message: string) => void;
  /** Technical detail for the server log: why an attempt was thrown away. */
  debug?: (message: string) => void;
}

export interface EditResult {
  files: string[];
  why: string;
  /** Plain-language summary of what the player will notice, when the model wrote one. */
  summary?: string;
}

/**
 * Apply `request`. Throws when no acceptable change could be made, so the caller leaves the
 * project untouched and falls back to the agent loop. Never writes a change that makes the
 * project's static problems worse or that guts a file.
 */
export async function applyEditRequest(opts: EditOptions): Promise<EditResult> {
  const all = opts.listFiles();
  const sources = all.filter((f) => isRepairablePath(f.path));
  if (sources.length === 0) throw new Error('no source files to edit');
  const known = new Set(sources.map((f) => f.path));

  // 1) which file(s)?
  const locateReply = await opts.generate(
    buildLocateSystemPrompt(),
    buildLocateUserPrompt(opts.request, sources),
    'low',
  );
  const located = parseLocateReply(locateReply, known);
  const why = /"why"\s*:\s*"([^"]*)"/.exec(locateReply)?.[1] ?? '';
  if (located.length === 0) throw new Error('could not tell which file the request is about');
  opts.progress?.(`Editing ${fileNames(located)}`);

  const baseline = projectProblems(all).length;
  let problems: string[] | undefined;
  // 2) rewrite them; one retry that shows the model exactly what its attempt broke.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      opts.debug?.(`attempt ${attempt} discarded: ${(problems ?? []).join(' | ').slice(0, 500)}`);
      opts.progress?.('Redoing the edit more carefully');
    }
    const targets = located
      .map((p) => sources.find((f) => f.path === p))
      .filter(Boolean) as ProjectFile[];
    const others = sources.filter((f) => !located.includes(f.path));
    const user = buildEditUserPrompt({
      request: opts.request,
      ...(opts.brief !== undefined ? { brief: opts.brief } : {}),
      targets,
      others,
      ...(problems !== undefined ? { problems } : {}),
    });
    if (user === null) throw new Error('project too large to edit in one step');
    // First try the cheap form (hunks: only the changed lines are written). If it does not
    // apply, fall back to whole files, which cost more but cannot fail to match.
    const mode: EditMode = attempt === 0 ? 'diff' : 'full';
    const reply = await opts.generate(buildEditSystemPrompt(mode), user, 'medium');
    const changes = parseFileBlocks(reply).filter(
      (f) => isRepairablePath(f.path) && known.has(f.path),
    );
    const hunkProblems: string[] = [];
    for (const block of parseEditBlocks(reply)) {
      if (!isRepairablePath(block.path) || !known.has(block.path)) continue;
      const base =
        changes.find((c) => c.path === block.path)?.content ??
        sources.find((f) => f.path === block.path)?.content ??
        '';
      const applied = applyHunks(base, block.hunks);
      if (applied.errors.length > 0) {
        hunkProblems.push(...applied.errors.map((e) => `${block.path}: ${e}`));
        continue;
      }
      const existing = changes.findIndex((c) => c.path === block.path);
      if (existing >= 0) changes[existing] = { path: block.path, content: applied.content };
      else changes.push({ path: block.path, content: applied.content });
    }
    if (hunkProblems.length > 0) {
      problems = [
        ...hunkProblems,
        'Some SEARCH text did not match the file. Return the changed files COMPLETE this time.',
      ];
      continue;
    }
    if (changes.length === 0) {
      problems = ['your reply contained no EDIT or FILE block in the required format'];
      continue;
    }
    // Refuse a rewrite that gutted a file (truncated / abbreviated output).
    const gutted = changes.find((c) => {
      const before = sources.find((s) => s.path === c.path)?.content ?? '';
      return before.length > 400 && c.content.length < before.length * MIN_KEEP_RATIO;
    });
    if (gutted) {
      problems = [
        `${gutted.path} came back much shorter than the original - return the WHOLE file`,
      ];
      continue;
    }
    const merged = new Map(all.map((f) => [f.path, f.content]));
    for (const c of changes) merged.set(c.path, c.content);
    const after = projectProblems([...merged].map(([path, content]) => ({ path, content })));
    if (after.length > baseline) {
      problems = after.map((p) => p.message);
      continue;
    }
    const changed = changes.filter(
      (c) => c.content !== sources.find((s) => s.path === c.path)?.content,
    );
    if (changed.length === 0) {
      problems = ['the files came back unchanged - actually make the requested change'];
      continue;
    }
    for (const c of changed) await opts.write(c.path, c.content);
    const summary = parseSummary(reply);
    return { files: changed.map((c) => c.path), why, ...(summary !== null ? { summary } : {}) };
  }
  throw new Error(`no acceptable edit after retry: ${(problems ?? []).join('; ').slice(0, 200)}`);
}
