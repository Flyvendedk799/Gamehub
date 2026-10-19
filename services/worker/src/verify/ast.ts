import { type ParserPlugin, parse } from '@babel/parser';

export interface AstVerificationError {
  message: string;
  line: number;
  column: number;
}

export interface AstVerificationResult {
  valid: boolean;
  errors: AstVerificationError[];
}

function getPluginsForFilename(filename: string): ParserPlugin[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tsx')) {
    return ['typescript', 'jsx'];
  }
  if (lower.endsWith('.ts')) {
    return ['typescript'];
  }
  if (lower.endsWith('.jsx')) {
    return ['jsx'];
  }
  // Standard plain JavaScript files for browser execution
  return [];
}

function getPluginsForScriptType(typeAttr: string | undefined): ParserPlugin[] {
  if (!typeAttr) return [];
  const lower = typeAttr.trim().toLowerCase();
  if (lower === 'text/typescript' || lower === 'application/typescript') {
    return ['typescript'];
  }
  if (lower === 'text/tsx') {
    return ['typescript', 'jsx'];
  }
  if (lower === 'text/jsx' || lower === 'text/babel') {
    return ['jsx'];
  }
  return [];
}

function parseCode(code: string, plugins: ParserPlugin[], lineOffset = 0): AstVerificationError[] {
  const errors: AstVerificationError[] = [];
  try {
    const ast = parse(code, {
      sourceType: 'module',
      plugins,
      errorRecovery: true,
    });

    if (ast.errors && ast.errors.length > 0) {
      for (const err of ast.errors) {
        errors.push({
          message: err.message ? err.message.replace(/\s*\(\d+:\d+\)$/, '') : 'Syntax error',
          line: (err.loc?.line ?? 1) + lineOffset,
          column: err.loc?.column ?? 0,
        });
      }
    }
  } catch (err: unknown) {
    const errorObj = err as { message?: string; loc?: { line?: number; column?: number } };
    errors.push({
      message: errorObj.message ? errorObj.message.replace(/\s*\(\d+:\d+\)$/, '') : String(err),
      line: (errorObj.loc?.line ?? 1) + lineOffset,
      column: errorObj.loc?.column ?? 0,
    });
  }
  return errors;
}

/**
 * Extracts inline script tag contents and their starting line numbers from HTML.
 */
function extractHtmlScripts(
  html: string,
): Array<{ code: string; lineOffset: number; plugins: ParserPlugin[] }> {
  const scripts: Array<{ code: string; lineOffset: number; plugins: ParserPlugin[] }> = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match = scriptRegex.exec(html);

  while (match !== null) {
    const attrs = match[1] ?? '';
    const scriptBody = match[2] ?? '';

    // Skip external script references
    if (/\bsrc\s*=/i.test(attrs)) {
      match = scriptRegex.exec(html);
      continue;
    }
    // Skip non-javascript scripts (e.g. application/json, text/html templates)
    const typeMatch = attrs.match(/\btype\s*=\s*['"]?([^'"]+)['"]?/i);
    const rawType = typeMatch ? typeMatch[1]?.trim() : undefined;
    const scriptType = rawType?.toLowerCase();
    if (scriptType) {
      if (
        scriptType !== 'module' &&
        scriptType !== 'text/javascript' &&
        scriptType !== 'application/javascript' &&
        scriptType !== 'text/typescript' &&
        scriptType !== 'application/typescript' &&
        scriptType !== 'text/tsx' &&
        scriptType !== 'text/jsx' &&
        scriptType !== 'text/babel'
      ) {
        match = scriptRegex.exec(html);
        continue;
      }
    }

    // Calculate line offset from the start of HTML to the script body
    const matchIndex = match.index;
    const tagOpenLength = match[0].indexOf(scriptBody);
    const scriptStartPos = matchIndex + (tagOpenLength >= 0 ? tagOpenLength : 0);
    const prefix = html.substring(0, scriptStartPos);
    const lineOffset = prefix.split('\n').length - 1;

    scripts.push({
      code: scriptBody,
      lineOffset,
      plugins: getPluginsForScriptType(scriptType),
    });
    match = scriptRegex.exec(html);
  }

  return scripts;
}

/**
 * Verifies generated code syntax using @babel/parser.
 * Supports TypeScript, JSX, modern JavaScript, and embedded scripts in HTML.
 */
export async function verifyGeneratedAst(
  filename: string,
  code: string,
): Promise<AstVerificationResult> {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const scripts = extractHtmlScripts(code);
    if (scripts.length === 0) {
      return { valid: true, errors: [] };
    }

    const allErrors: AstVerificationError[] = [];
    for (const script of scripts) {
      const scriptErrors = parseCode(script.code, script.plugins, script.lineOffset);
      allErrors.push(...scriptErrors);
    }

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
    };
  }

  const plugins = getPluginsForFilename(filename);
  const errors = parseCode(code, plugins);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Formats a structured diagnostic reflexion block containing file name,
 * code snippet around lines of failure, and clear error description for agent self-repair.
 */
export function formatReflexionPayload(
  filename: string,
  code: string,
  errors: Array<{ message: string; line: number; column: number }>,
): string {
  if (errors.length === 0) {
    return `AST verification passed for ${filename}. No syntax errors detected.`;
  }

  const lines = code.split(/\r?\n/);
  const sections: string[] = [];

  sections.push(`[SYNTAX_VERIFICATION_FAILURE] in file: ${filename}`);
  sections.push(`Encountered ${errors.length} syntax error(s) during AST parsing:`);

  errors.forEach((err, idx) => {
    sections.push(`\nError ${idx + 1}: ${err.message} (Line ${err.line}, Column ${err.column})`);

    const startLine = Math.max(1, err.line - 3);
    const endLine = Math.min(lines.length, err.line + 3);

    const snippetLines: string[] = [];
    for (let l = startLine; l <= endLine; l++) {
      const lineContent = lines[l - 1] ?? '';
      const isTarget = l === err.line;
      const prefix = isTarget ? `> ${String(l).padStart(4)} | ` : `  ${String(l).padStart(4)} | `;
      snippetLines.push(`${prefix}${lineContent}`);
      if (isTarget && err.column >= 0) {
        const indent = ' '.repeat(prefix.length + err.column);
        snippetLines.push(`${indent}^ ${err.message}`);
      }
    }

    sections.push(snippetLines.join('\n'));
  });

  sections.push(
    '\nAction Required: Modify the code to resolve the syntax error(s) identified above. Do not repeat the same invalid syntax.',
  );

  return sections.join('\n');
}
