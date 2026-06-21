export interface SkillUsageSignals {
  engineFilesWritten: number;
  engineImports: number;
  usesSkillFns: number;
  debugWired: number;
  skillImportedNotCalled: string[];
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

function isImportedInOutside(outside: string, base: string): boolean {
  const re = new RegExp(`from\\s+['"]\\.\\.?/(?:.*/)?engine/${base}(?:\\.\\w+)?['"]`);
  return re.test(outside);
}

function countCallsInOutside(outside: string, name: string): number {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  return (outside.match(re) ?? []).length;
}

function countDebugWirings(allContent: string): number {
  let total = 0;
  for (const re of DEBUG_WIRING_PATTERNS) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
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

  const engineMeta = engineFiles.map((f) => ({
    base: getBaseName(f.path),
    exports: parseExportNames(f.content),
  }));

  const outsideParts: string[] = [];
  const allParts: string[] = [];

  for (const f of files) {
    const lower = f.path.toLowerCase();
    const isSource = SOURCE_EXTS.some((ext) => lower.endsWith(ext));
    if (!isSource) continue;
    if (f.content.startsWith('data:')) continue;
    allParts.push(f.content);
    if (!ENGINE_PATH_RE.test(f.path)) {
      outsideParts.push(f.content);
    }
  }

  for (const f of engineFiles) {
    allParts.push(f.content);
  }

  const outside = outsideParts.join('\n\n');
  const allContent = allParts.join('\n\n');

  let engineImports = 0;
  let usesSkillFns = 0;
  const skillImportedNotCalled: string[] = [];

  for (const meta of engineMeta) {
    const imported = isImportedInOutside(outside, meta.base);
    if (imported) engineImports += 1;

    let callCount = 0;
    if (imported) {
      for (const name of meta.exports) {
        callCount += countCallsInOutside(outside, name);
      }
    }
    usesSkillFns += callCount;

    if (!imported || callCount === 0) {
      skillImportedNotCalled.push(meta.base);
    }
  }

  const debugWired = countDebugWirings(allContent);

  return {
    engineFilesWritten,
    engineImports,
    usesSkillFns,
    debugWired,
    skillImportedNotCalled,
  };
}
