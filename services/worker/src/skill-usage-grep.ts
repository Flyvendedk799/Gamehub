export interface SkillUsageSignals {
  engineFilesWritten: number;
  engineImports: number;
  usesSkillFns: number;
  debugWired: number;
  skillImportedNotCalled: string[];
  /** v3.1 — base names of src/engine modules that are PROVABLY unreferenced: the
   *  path `engine/<base>`, the base name, and every export identifier appear in NO
   *  other source file. Such a module can never be loaded (the game booted without
   *  it), so it is safe to delete deterministically as dead weight. A strict
   *  subset of skillImportedNotCalled (excludes imported-but-uncalled, whose import
   *  line still references the file). */
  unreferencedEngineFiles: string[];
}

const ENGINE_PATH_RE = /^src\/engine\/.+\.(js|jsx|mjs)$/;
const EXPORT_FN_RE = /export\s+function\s+([A-Za-z_$][\w$]*)/g;
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.mjs', '.html'];

// Kept in lockstep with SNAPSHOT_WIRING_PATTERNS in
// packages/core/src/tools/assert-game-invariants.ts — both decide "is the debug
// snapshot wired?" and must agree, else the build-report `debugWired` disagrees
// with the runtime verdict (run3 shipped debugWired=0 yet passed snapshot-reading
// predicates). (Plan step 1.)
const DEBUG_WIRING_PATTERNS: readonly RegExp[] = [
  /\bdebug\s*\.\s*track\s*\(/,
  /\bdebug\s*\.\s*snapshot\s*=[^=]/,
  /__game\s*\.\s*state\s*=[^=]/,
  /__game\s*\.\s*state\s*\.\s*\w+\s*=[^=]/,
  /__game\s*\.\s*state\s*\[[^\]]*\]\s*=[^=]/,
  /Object\.assign\s*\(\s*[^,)]*__game\s*\.\s*state\b/,
  /\b\w+\s*\.\s*track\s*\(\s*\{/,
];

function parseExportNames(content: string): string[] {
  const names: string[] = [];
  const re = new RegExp(EXPORT_FN_RE.source, 'g');
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    if (m[1] !== undefined) names.push(m[1]);
    m = re.exec(content);
  }
  return names;
}

function getBaseName(path: string): string {
  const file = path.split('/').pop() ?? path;
  const dotIdx = file.lastIndexOf('.');
  return dotIdx === -1 ? file : file.slice(0, dotIdx);
}

function isImported(haystack: string, base: string): boolean {
  // Static `from '…/engine/<base>'` OR dynamic `import('…/engine/<base>')`.
  const re = new RegExp(
    `(?:from|import\\s*\\()\\s*['"][./]*(?:.*/)?engine/${base}(?:\\.\\w+)?['"]`,
  );
  return re.test(haystack);
}

function countCalls(haystack: string, name: string): number {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  return (haystack.match(re) ?? []).length;
}

function countDebugWirings(allContent: string): number {
  // Count DISTINCT lines that match ANY wiring pattern. Summing per-pattern match
  // counts double-counts overlapping patterns (e.g. `debug.track(` also matches the
  // aliased `\w+.track({`), and would inflate every time a new form is added. Per
  // distinct line, adding a pattern only ever discovers NEW wiring sites. (Plan step 1.)
  let count = 0;
  for (const line of allContent.split('\n')) {
    if (DEBUG_WIRING_PATTERNS.some((re) => re.test(line))) count += 1;
  }
  return count;
}

export function analyzeSkillUsage(
  files: ReadonlyArray<{ path: string; content: string }>,
): SkillUsageSignals {
  const engineFiles = files.filter((f) => ENGINE_PATH_RE.test(f.path));
  const engineFilesWritten = engineFiles.length;

  // All source files (incl. engine modules — a skill may be wired engine→engine).
  const sourceFiles = files.filter((f) => {
    const lower = f.path.toLowerCase();
    return SOURCE_EXTS.some((ext) => lower.endsWith(ext)) && !f.content.startsWith('data:');
  });
  const allContent = sourceFiles.map((f) => f.content).join('\n\n');

  let engineImports = 0;
  let usesSkillFns = 0;
  const skillImportedNotCalled: string[] = [];
  const unreferencedEngineFiles: string[] = [];

  // A COMPUTED dynamic import — `import(expr)` whose argument is NOT a single
  // string literal (e.g. `import('./engine/' + name)` or `import(path)`) — could
  // resolve to any module at runtime, so if one exists ANYWHERE we cannot prove
  // any module is unreferenced. A clean LITERAL `import('./engine/x.js')` is
  // handled by isImported per-module and does NOT count as computed.
  const hasComputedDynamicImport = (allContent.match(/\bimport\s*\([^)]*\)/g) ?? []).some(
    (call) => !/^import\s*\(\s*['"][^'"]*['"]\s*\)$/.test(call),
  );

  for (const ef of engineFiles) {
    const base = getBaseName(ef.path);
    const exports = parseExportNames(ef.content);
    // Scan every OTHER source file (excludes the skill's own file so its own
    // definition can't count as usage) for an import edge + a call.
    const others = sourceFiles
      .filter((f) => f.path !== ef.path)
      .map((f) => f.content)
      .join('\n\n');
    const imported = isImported(others, base);
    if (imported) engineImports += 1;

    let callCount = 0;
    if (imported) {
      for (const name of exports) {
        callCount += countCalls(others, name);
      }
    }
    usesSkillFns += callCount;

    if (!imported || callCount === 0) {
      skillImportedNotCalled.push(base);
    }

    // Safe to delete iff there is NO ACTIVE import edge to it (a comment — e.g.
    // P3's commented import stub — or a string mentioning the name can't LOAD a
    // module; only an active import can). The earlier "name appears nowhere" gate
    // was defeated by P3's own `// import { ... } from './engine/<base>'` stub, so
    // genuinely-dead modules were never swept. Stay conservative only when a
    // COMPUTED dynamic import exists (it could resolve to this module at runtime).
    if (!imported && !hasComputedDynamicImport) {
      unreferencedEngineFiles.push(base);
    }
  }

  const debugWired = countDebugWirings(allContent);

  return {
    engineFilesWritten,
    engineImports,
    usesSkillFns,
    debugWired,
    skillImportedNotCalled,
    unreferencedEngineFiles,
  };
}
