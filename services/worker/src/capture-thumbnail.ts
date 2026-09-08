/**
 * captureProjectThumbnail — the ONE canonical gameplay-thumbnail capture path.
 *
 * A project's `thumbnail_url` is what the dashboard's project cards, the Hub
 * cards, and the Share ("social outro") card all render. Without it every one of
 * those falls through to the hatched "GAMEPLAY FRAME" placeholder.
 *
 * This exists for the same reason `finalizeRun` does: the two generation
 * entrypoints had DRIFTED. Capture was implemented only in the API's in-process
 * fallback (`services/api/src/main.ts`), which runs when no REDIS_URL is
 * configured. Every deployment that DOES have Redis — i.e. the real one — runs
 * generation in the BullMQ worker, which never captured anything. The result was
 * a table of projects with `thumbnail_url` NULL across the board and a Share
 * dialog that could never show the game, no matter how many times the underlying
 * rendering bugs were fixed.
 *
 * Both entrypoints now call this. It is deliberately parameterised over a
 * `screenshot` function rather than a browser client, because the two paths reach
 * Chromium differently (the API uses its in-process pool; the worker enqueues a
 * `thumbnail` job onto the browser-worker queue) while everything around it —
 * reading the snapshot, building a single-file HTML bundle, storing the PNG,
 * stamping the project row — is identical.
 *
 * Best-effort by contract: it resolves `false` instead of throwing on a capture
 * that produced no frame, and callers invoke it without awaiting. A thumbnail is
 * never worth failing a run over.
 */
import { type ExportGameHtmlOptions, buildGameHtml } from '@playforge/exporters';
import type { SnapshotStore } from '@playforge/storage';

/** A captured frame. Mirrors the browser worker's `ThumbnailResult`. */
export interface CapturedFrame {
  pngBase64: string;
}

export interface CaptureThumbnailArgs {
  manifestKey: string;
  engine: 'phaser' | 'three' | 'canvas2d';
  projectId: string;
}

export interface CaptureThumbnailPorts {
  store: SnapshotStore;
  /** Boot the game HTML in a browser and return one non-blank frame of play. */
  screenshot: (htmlContent: string) => Promise<CapturedFrame | null>;
  /** Persist the project's thumbnail URL (`/v1/blobs/<key>`). */
  setThumbnail: (projectId: string, thumbnailUrl: string) => Promise<void>;
}

const TEXT_PREFIXES = ['text/', 'application/json'];

/**
 * Capture a gameplay thumbnail for a just-built project and record it.
 * Resolves `true` when a thumbnail was stored, `false` when the capture produced
 * no frame. Throws only on an unexpected storage/DB failure — callers treat that
 * as best-effort too.
 */
export async function captureProjectThumbnail(
  ports: CaptureThumbnailPorts,
  args: CaptureThumbnailArgs,
): Promise<boolean> {
  const { store, screenshot, setThumbnail } = ports;
  const manifest = await store.readManifest(args.manifestKey);
  const files: ExportGameHtmlOptions['files'] = await Promise.all(
    Object.entries(manifest.files).map(async ([path, entry]) => {
      const bytes = await store.readFile(manifest, path);
      const isText = TEXT_PREFIXES.some((p) => entry.contentType.startsWith(p));
      return {
        path,
        content: isText ? Buffer.from(bytes).toString('utf8') : Buffer.from(bytes),
      };
    }),
  );
  const html = await buildGameHtml({ files, engine: args.engine });
  const result = await screenshot(html);
  if (!result?.pngBase64) return false;
  const key = await store.putBlob(Buffer.from(result.pngBase64, 'base64'));
  await setThumbnail(args.projectId, `/v1/blobs/${key.replace(/^blobs\//, '')}`);
  return true;
}
