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

const DEBUG_WIRING_PATTERNS: readonly RegExp[] = [
  /\bdebug\s*\.\s*track\s*\(/,
  /\bdebug\s*\.\s*snapshot\s*=[^=]/,
  /__game\s*\.\s*state\s*=[^=]/,
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
  let total = 0;
  for (const re of DEBUG_WIRING_PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    total += (allContent.match(global) ?? []).length;
  }
  return total;
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

    // Provably-unreferenced (bulletproof gate for safe deletion): NOT imported,
    // AND the bare base name appears nowhere else (covers computed/dynamic refs
    // like `import('./engine/'+name)`), AND no export identifier appears elsewhere.
    if (!imported && !others.includes(base) && !exports.some((n) => others.includes(n))) {
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
