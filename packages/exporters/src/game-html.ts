/**
 * gameplan §A7 — `game-html` exporter.
 *
 * Produces a single offline-runnable HTML file that bundles:
 *   - the entry index.html
 *   - every `src/**` JS module inlined as data: URLs (rewriting the import
 *     map so bare specifiers + relative paths resolve to those data URLs)
 *   - the engine library (Three.js or Phaser) fetched once at export
 *     time from `cdn.jsdelivr.net` and inlined as a data: URL
 *   - every addon importmap entry (e.g. `three/addons/*`) — the specific
 *     addon modules the project imports are fetched + inlined and the
 *     prefix mapping is replaced with explicit per-module data: URLs
 *   - every referenced local asset (PNG / WAV / CSS / etc.) inlined as a
 *     data: URL. The asset filter is complement-correct: every non-engine
 *     file in the bundle that is *referenced* (src/href/url()/import) gets
 *     inlined, not a hardcoded subset of extensions.
 *
 * Result: opens in Chrome from `file://` with no network access. Suitable
 * for itch.io single-file uploads, email attachments, sharing offline.
 *
 * Limitations (Phase A scope):
 *   - JS / Three / Phaser only — the only engines this product ships.
 *   - Asset references are rewritten via path-string match (both quoted
 *     specifiers and `url(...)` in CSS). The agent's guide instructs it to
 *     use stable relative paths (`assets/foo.png`). Computed paths (string
 *     concat) won't be caught — fall back to game-zip when in doubt.
 *   - No headless boot-check ships here (this package has no browser dep);
 *     a Playwright boot smoke is tracked as a follow-up in the browser
 *     worker / e2e package.
 */

import { CodesignError, ERROR_CODES } from '@playforge/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGameHtmlOptions {
  files: ZipAsset[];
  /** Engine pinned for the project. Drives engine-library fetch. */
  engine: 'three' | 'phaser';
  /** Pinned engine version. Defaults: three@0.170.0, phaser@3.88.0. */
  engineVersion?: string;
}

const DEFAULT_VERSIONS = { three: '0.170.0', phaser: '3.88.0' } as const;

const ENGINE_CDN_URLS = {
  three: (v: string) => `https://cdn.jsdelivr.net/npm/three@${v}/build/three.module.js`,
  phaser: (v: string) => `https://cdn.jsdelivr.net/npm/phaser@${v}/dist/phaser.esm.js`,
} as const;

function bytesToBase64(bytes: Uint8Array | Buffer): string {
  return Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
}

function jsDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'json':
      return 'application/json';
    case 'css':
      return 'text/css';
    case 'txt':
      return 'text/plain';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'ttf':
      return 'font/ttf';
    case 'otf':
      return 'font/otf';
    case 'glb':
      return 'model/gltf-binary';
    case 'gltf':
      return 'model/gltf+json';
    default:
      return 'application/octet-stream';
  }
}

function extOf(path: string): string {
  return path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isJsPath(path: string): boolean {
  return /\.[jt]sx?$/.test(path);
}

function contentToString(content: Buffer | string): string {
  return typeof content === 'string' ? content : content.toString('utf8');
}

/**
 * Hardened CSP for the exported single-file game (#13). Mirrors the
 * anti-exfil boundary the served routes enforce so an offline export can
 * never become a softer attack surface than the hosted play URL.
 *
 * The engine library + every addon module are fetched at export time and
 * inlined as `data:` URLs — the export keeps NO live CDN reference — so
 * `script-src` deliberately omits any CDN host. Inline scripts plus
 * `data:`/`blob:` cover the inlined modules; everything else (network
 * egress in particular) is denied: `connect-src 'none'`.
 */
const EXPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data: blob:",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;

/**
 * Remove every author/generated CSP `<meta http-equiv>` (case-insensitive,
 * attribute order independent) so generated game code can't weaken the
 * policy, then inject our hardened tag at the very start of `<head>`. If no
 * `<head>` exists, fall back to inserting right after `<html ...>` (or at
 * the top of the document).
 */
function applyExportCsp(html: string): string {
  const cspMetaRegex =
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']\s*content-security-policy\s*["'][^>]*>\s*/gi;
  const out = html.replace(cspMetaRegex, '');

  const headOpen = /<head\b[^>]*>/i;
  if (headOpen.test(out)) {
    return out.replace(headOpen, (match) => `${match}\n${CSP_META_TAG}`);
  }
  const htmlOpen = /<html\b[^>]*>/i;
  if (htmlOpen.test(out)) {
    return out.replace(htmlOpen, (match) => `${match}\n${CSP_META_TAG}`);
  }
  return `${CSP_META_TAG}\n${out}`;
}

/**
 * Fetch a CDN URL at export time and return its text. Centralised so the
 * engine fetch + each addon fetch share the same error envelope (the
 * exporter needs network access to vendor everything it inlines).
 */
async function fetchText(url: string, engine: string): Promise<string> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    return await resp.text();
  } catch (err) {
    throw new CodesignError(
      `Failed to fetch the ${engine} library at export time. game-html needs network access to vendor the engine and its addons. Use game-zip for an export that keeps the CDN reference. (${err instanceof Error ? err.message : String(err)})`,
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
}

interface ImportMap {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}

/**
 * Collect every bare/addon specifier statically OR dynamically imported
 * across the inlined JS modules. Used to decide which prefix-mapped addon
 * modules (e.g. `three/addons/controls/OrbitControls.js`) we must fetch +
 * inline. Catches `import x from 'spec'`, `import 'spec'`, `export … from
 * 'spec'`, and `import('spec')` (dynamic).
 */
function collectSpecifiers(sources: string[]): Set<string> {
  const specifiers = new Set<string>();
  // Static: `from '...'`, side-effect `import '...'`, re-export `from '...'`.
  const staticRe = /(?:import|export)\b[^'"`;]*?from\s*(['"`])([^'"`]+)\1/g;
  const sideEffectRe = /import\s*(['"`])([^'"`]+)\1/g;
  // Dynamic: `import('...')` / `import("...")`.
  const dynamicRe = /import\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  for (const src of sources) {
    for (const re of [staticRe, sideEffectRe, dynamicRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null = re.exec(src);
      while (m !== null) {
        const spec = m[2];
        if (spec !== undefined) specifiers.add(spec);
        m = re.exec(src);
      }
    }
  }
  return specifiers;
}

/**
 * Rewrite the page's `<script type="importmap">` so EVERY entry resolves
 * to an inlined source — not just the bare engine specifier.
 *
 * - Bare exact entries (`"three": "<cdn>"`) whose URL equals the engine URL
 *   are swapped to the engine data: URL.
 * - Other exact entries are fetched + inlined.
 * - Prefix entries (`"three/addons/": "<cdn-dir>/"`) are expanded: every
 *   specifier the project actually imports under that prefix is fetched,
 *   inlined, and added as an explicit exact mapping. The prefix entry is
 *   dropped (its directory URL is a live CDN reference the CSP would block).
 */
async function inlineImportMap(
  html: string,
  engine: string,
  engineUrl: string,
  engineDataUrl: string,
  importedSpecifiers: Set<string>,
): Promise<string> {
  const importmapRe =
    /(<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/i;
  const match = html.match(importmapRe);
  if (match === null) return html;

  const openTag = match[1] ?? '';
  const body = match[2] ?? '';
  const closeTag = match[3] ?? '';

  let parsed: ImportMap;
  try {
    parsed = JSON.parse(body) as ImportMap;
  } catch {
    // Unparseable importmap — fall back to the targeted engine-URL swap so
    // we never crash the export on a malformed map.
    return html.replace(new RegExp(escapeRegExp(engineUrl), 'g'), engineDataUrl);
  }

  const fetchCache = new Map<string, string>();
  const fetchInlined = async (url: string): Promise<string> => {
    const cached = fetchCache.get(url);
    if (cached !== undefined) return cached;
    const source = await fetchText(url, engine);
    const dataUrl = jsDataUrl(source);
    fetchCache.set(url, dataUrl);
    return dataUrl;
  };

  const rewrittenImports: Record<string, string> = {};
  const oldImports = parsed.imports ?? {};
  for (const [specifier, url] of Object.entries(oldImports)) {
    if (specifier.endsWith('/')) {
      // Prefix mapping (e.g. `three/addons/`). Expand only the modules the
      // project imports under it; drop the bare prefix (a live CDN dir).
      for (const imported of importedSpecifiers) {
        if (!imported.startsWith(specifier)) continue;
        const rest = imported.slice(specifier.length);
        const moduleUrl = url + rest;
        rewrittenImports[imported] = await fetchInlined(moduleUrl);
      }
      continue;
    }
    if (url === engineUrl) {
      rewrittenImports[specifier] = engineDataUrl;
      continue;
    }
    if (/^https?:\/\//i.test(url)) {
      // Any other remote exact entry — vendor it too so nothing stays live.
      rewrittenImports[specifier] = await fetchInlined(url);
      continue;
    }
    // Local/relative or already-data: entry — leave as-is (local module
    // entries are handled by the JS-inlining pass below).
    rewrittenImports[specifier] = url;
  }

  const newMap: ImportMap = { imports: rewrittenImports };
  if (parsed.scopes !== undefined) newMap.scopes = parsed.scopes;
  const newBody = JSON.stringify(newMap, null, 2);
  return html.replace(importmapRe, `${openTag}${newBody}${closeTag}`);
}

/**
 * Inline every JS module in the bundle, recursively rewriting cross-module
 * references — static `import`/`export … from`, side-effect `import '…'`,
 * AND dynamic `import('…')` specifiers that name a local module — to the
 * inlined data: URLs.
 */
function buildJsDataUrls(jsFiles: ZipAsset[]): Map<string, string> {
  // Index by both the exact path and a leading-`./` form so relative
  // specifiers resolve regardless of the convention the model emitted.
  const byPath = new Map<string, string>();
  for (const f of jsFiles) {
    byPath.set(f.path, jsDataUrl(contentToString(f.content)));
  }

  // Recursively rewrite: replace any quoted local-module specifier with the
  // current data: URL for that module. Iterate to a fixed point so deep
  // import chains (a → b → c) fully inline.
  const sourceByPath = new Map<string, string>();
  for (const f of jsFiles) sourceByPath.set(f.path, contentToString(f.content));

  for (let pass = 0; pass < jsFiles.length + 1; pass++) {
    let changed = false;
    for (const f of jsFiles) {
      const current = sourceByPath.get(f.path) ?? '';
      let rewritten = current;
      for (const other of jsFiles) {
        if (other.path === f.path) continue;
        const otherDataUrl = byPath.get(other.path) ?? '';
        // Match the path with or without a leading `./` (both `'a/b.js'`
        // and `'./a/b.js'`), in any quote style. This also covers dynamic
        // `import('a/b.js')` because the quoted specifier is identical.
        const variants = referenceVariants(other.path);
        for (const variant of variants) {
          const re = new RegExp(`(['"\`])${escapeRegExp(variant)}\\1`, 'g');
          const next = rewritten.replace(re, `$1${otherDataUrl}$1`);
          if (next !== rewritten) {
            rewritten = next;
            changed = true;
          }
        }
      }
      if (rewritten !== current) {
        sourceByPath.set(f.path, rewritten);
        byPath.set(f.path, jsDataUrl(rewritten));
      }
    }
    if (!changed) break;
  }
  return byPath;
}

/**
 * Path variants a specifier might use to reference a bundle file: the
 * exact bundle path, and the same with a leading `./` (the relative form
 * the engine guides recommend). De-duplicated.
 */
function referenceVariants(path: string): string[] {
  const variants = new Set<string>([path]);
  variants.add(`./${path}`);
  return [...variants];
}

export async function buildGameHtml(opts: ExportGameHtmlOptions): Promise<string> {
  if (opts.engine !== 'three' && opts.engine !== 'phaser') {
    throw new CodesignError(
      `game-html exporter only supports browser engines (three / phaser). Got "${opts.engine}".`,
      ERROR_CODES.EXPORTER_FORMAT_REJECTED,
    );
  }
  const indexEntry = opts.files.find((f) => f.path === 'index.html');
  if (indexEntry === undefined) {
    throw new CodesignError(
      'game-html export requires an index.html entry point in the file bundle.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  let html = contentToString(indexEntry.content);

  const version = opts.engineVersion ?? DEFAULT_VERSIONS[opts.engine];
  const engineUrl = ENGINE_CDN_URLS[opts.engine](version);

  // 1. Fetch the engine library + inline as a data: URL.
  const engineSource = await fetchText(engineUrl, opts.engine);
  const engineDataUrl = jsDataUrl(engineSource);

  // 2. Inline every JS module (recursive static + dynamic import rewrite).
  const jsFiles = opts.files.filter((f) => isJsPath(f.path) && f.path !== 'index.html');
  const jsDataUrlByPath = buildJsDataUrls(jsFiles);

  // 3. Rewrite the importmap so EVERY entry (engine + addon prefixes + any
  //    other remote entry) resolves to an inlined source. Done before the
  //    bare-URL fallback so a structured rewrite always wins.
  const importedSpecifiers = collectSpecifiers(
    jsFiles.map((f) => contentToString(f.content)),
  );
  html = await inlineImportMap(
    html,
    opts.engine,
    engineUrl,
    engineDataUrl,
    importedSpecifiers,
  );

  // Belt-and-braces: if the engine URL still appears anywhere (e.g. a
  // hard-coded reference outside the importmap), swap it for the data URL.
  html = html.replace(new RegExp(escapeRegExp(engineUrl), 'g'), engineDataUrl);

  // 4. Rewrite the entry `<script type="module" src="…">` tags to the
  //    recursively-inlined data: URLs. Match any src whose value contains
  //    the module path so transitively-inlined values win.
  for (const [path, dataUrl] of jsDataUrlByPath) {
    for (const variant of referenceVariants(path)) {
      const tagRegex = new RegExp(
        `(<script\\b[^>]*\\bsrc\\s*=\\s*["'])${escapeRegExp(variant)}(["'])`,
        'g',
      );
      html = html.replace(tagRegex, `$1${dataUrl}$2`);
    }
  }

  // 5. Inline every referenced local asset — COMPLEMENT-correct: every file
  //    in the bundle that is NOT index.html and NOT a JS module already
  //    inlined above is an asset candidate. Inline whichever are referenced
  //    via src/href/url()/quoted-specifier in the HTML (and in CSS/JS once
  //    those are inlined into the HTML). We inline by data: URL regardless
  //    of extension (text or binary), driven by reference, not a hardcoded
  //    extension allowlist.
  const assetFiles = opts.files.filter(
    (f) => f.path !== 'index.html' && !isJsPath(f.path),
  );
  // Build data: URLs for every asset. CSS files are inlined too — but first
  // rewrite any `url(...)`/quoted references INSIDE them to the other
  // assets' data: URLs so a stylesheet's background images resolve offline.
  const assetDataUrlByPath = new Map<string, string>();
  for (const f of assetFiles) {
    const ext = extOf(f.path);
    if (ext.toLowerCase() === 'css') continue; // handled after binaries
    assetDataUrlByPath.set(
      f.path,
      `data:${mimeForExt(ext)};base64,${bytesToBase64(
        f.content instanceof Buffer ? f.content : Buffer.from(contentToString(f.content), 'utf8'),
      )}`,
    );
  }
  // CSS: rewrite inner references, THEN inline.
  for (const f of assetFiles) {
    if (extOf(f.path).toLowerCase() !== 'css') continue;
    let css = contentToString(f.content);
    css = rewriteLocalReferences(css, assetDataUrlByPath);
    assetDataUrlByPath.set(f.path, `data:text/css;base64,${Buffer.from(css, 'utf8').toString('base64')}`);
  }

  // Now rewrite every referenced asset path in the HTML to its data: URL.
  // Covers quoted attribute values (src=, href=) and `url(...)` in inline
  // styles. Reference-driven, so unreferenced assets simply don't bloat the
  // output and referenced ones never stay as un-inlined local paths.
  html = rewriteLocalReferences(html, assetDataUrlByPath);

  // The <base href="game-files://..."> line in the starter no longer
  // applies once everything is inlined — strip it so the file: URL
  // doesn't try to resolve relatives against the protocol.
  html = html.replace(/<base\s+href=["'][^"']*["']\s*\/?\s*>\s*/i, '');

  // 6. Enforce the anti-exfil CSP boundary (#13): strip any author/generated
  //    CSP meta so the game can't weaken the policy, then inject our locked
  //    one. Done last so it survives all prior rewrites.
  html = applyExportCsp(html);

  return html;
}

/**
 * Replace every reference to a local bundle path with its data: URL. Handles
 * both quoted specifiers (`"assets/x.png"`, `'./assets/x.png'`) and CSS
 * `url(assets/x.png)` (quoted or bare). Reference-driven: a path only gets
 * rewritten if it's actually present, so this is the complement of the old
 * extension allowlist — anything in `dataUrlByPath` that is referenced gets
 * inlined.
 */
function rewriteLocalReferences(input: string, dataUrlByPath: Map<string, string>): string {
  let out = input;
  for (const [path, dataUrl] of dataUrlByPath) {
    for (const variant of referenceVariants(path)) {
      const esc = escapeRegExp(variant);
      // Quoted specifier in any quote style: "x", 'x', `x`.
      out = out.replace(new RegExp(`(['"\`])${esc}\\1`, 'g'), `$1${dataUrl}$1`);
      // CSS url(...) — bare or quoted, allowing surrounding whitespace.
      out = out.replace(
        new RegExp(`url\\(\\s*(['"\`]?)${esc}\\1\\s*\\)`, 'g'),
        `url($1${dataUrl}$1)`,
      );
    }
  }
  return out;
}

export async function exportGameHtml(
  destinationPath: string,
  opts: ExportGameHtmlOptions,
): Promise<ExportResult> {
  const html = await buildGameHtml(opts);
  const { writeFile, stat } = await import('node:fs/promises');
  await writeFile(destinationPath, html, 'utf8');
  const s = await stat(destinationPath);
  return { bytes: s.size, path: destinationPath };
}
