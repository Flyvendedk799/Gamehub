/**
 * Exporter entry point — Playforge cloud scope: **web games only**.
 *
 * The publish pipeline turns an immutable snapshot's multi-file bundle into a
 * shareable artifact:
 *   - `game-html`  → single offline HTML, engine + assets inlined (itch.io-safe,
 *                    the primary published-game bundle).
 *   - `game-zip`   → directory archive (import-map + asset folders) for self-hosting.
 *   - `markdown`   → README of the game's controls + mechanics.
 *
 * Heavy/legacy formats from the desktop base (pdf, pptx, design html, and the
 * pygame/godot/unity game exporters) were intentionally removed — this product
 * only ships Three.js + Phaser web games.
 */

import { PlayforgeError, ERROR_CODES } from '@playforge/shared';

export const GAME_EXPORTER_FORMATS = ['game-html', 'game-zip', 'markdown'] as const;
export type GameExporterFormat = (typeof GAME_EXPORTER_FORMATS)[number];

export interface ExportResult {
  bytes: number;
  path: string;
}

export type { ExportZipOptions, ZipAsset } from './zip';
export type { ExportMarkdownOptions, MarkdownMeta } from './markdown';
export type { ExportGameZipOptions } from './game-zip';
export type { ExportGameHtmlOptions } from './game-html';
export { buildGameHtml } from './game-html';
export { htmlToMarkdown } from './markdown';

/**
 * Game-mode export entry point. Takes the snapshot's full multi-file bundle
 * (read from object storage by the publish worker) and dispatches to
 * `game-html` (single offline file), `game-zip` (directory archive), or
 * `markdown` (controls/mechanics README). Engine must be `three` or `phaser`.
 */
export async function exportGameArtifact(
  format: GameExporterFormat,
  destinationPath: string,
  opts: {
    files: import('./zip').ZipAsset[];
    designName?: string;
    engine?: 'three' | 'phaser';
    engineVersion?: string;
    /** Optional explicit HTML source for the markdown README. */
    htmlForMarkdown?: string;
  },
): Promise<ExportResult> {
  if (format === 'game-zip') {
    const mod = await import('./game-zip');
    const zipOpts: import('./game-zip').ExportGameZipOptions = { files: opts.files };
    if (opts.designName !== undefined) zipOpts.designName = opts.designName;
    if (opts.engine !== undefined) zipOpts.engine = opts.engine;
    if (opts.engineVersion !== undefined) zipOpts.engineVersion = opts.engineVersion;
    return mod.exportGameZip(destinationPath, zipOpts);
  }
  if (format === 'game-html') {
    if (opts.engine !== 'three' && opts.engine !== 'phaser') {
      throw new PlayforgeError(
        `game-html is browser-engine-only (Three.js / Phaser). Got "${opts.engine ?? 'undefined'}".`,
        ERROR_CODES.EXPORTER_FORMAT_REJECTED,
      );
    }
    const mod = await import('./game-html');
    return mod.exportGameHtml(destinationPath, {
      files: opts.files,
      engine: opts.engine,
      ...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
    });
  }
  if (format === 'markdown') {
    const mod = await import('./markdown');
    const indexEntry = opts.files.find((f) => f.path === 'index.html');
    const html =
      opts.htmlForMarkdown ??
      (indexEntry !== undefined
        ? typeof indexEntry.content === 'string'
          ? indexEntry.content
          : indexEntry.content.toString('utf8')
        : `<html><body><h1>${opts.designName ?? 'Game'}</h1></body></html>`);
    return mod.exportMarkdown(html, destinationPath);
  }
  throw new PlayforgeError(
    `Unknown game exporter format: ${format as string}`,
    ERROR_CODES.EXPORTER_UNKNOWN,
  );
}
