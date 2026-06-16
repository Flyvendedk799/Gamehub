/**
 * Snapshot file-tree persistence on top of a content-addressed BlobStore.
 *
 * A snapshot's file tree is written as: every file's bytes → a blob (deduped),
 * plus a canonical `manifest.json` mapping each safe bundle path to its blob
 * key + size + content-type. The manifest itself is content-addressed, so:
 *   - `filesHash` is a stable cache key (publish smoke-tests, CDN immutability),
 *   - an edit that touches one file re-uses every other blob (cheap versioning),
 *   - **remix copies the manifest pointer only** — no bytes move.
 *
 * This is the cloud replacement for the desktop `design_files` rows + the
 * `game-files://` protocol: paths are validated (no traversal), and the games
 * edge server serves blobs back out by manifest lookup.
 */
import { type BlobStore, blobKey, sha256 } from './blob-store';
import { assertSafeBundlePath } from './paths';

export interface ManifestEntry {
  blob: string;
  size: number;
  contentType: string;
}

export interface SnapshotManifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

export interface WriteResult {
  /** Object-storage key of the stored manifest (`snapshots/<filesHash>/manifest.json`). */
  manifestKey: string;
  /** SHA-256 of the canonical manifest JSON. */
  filesHash: string;
  manifest: SnapshotManifest;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

export function contentTypeFor(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Canonical JSON: object keys sorted, so identical trees hash identically. */
function canonicalManifestJson(manifest: SnapshotManifest): string {
  const sortedFiles: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(manifest.files).sort()) {
    // biome-ignore lint/style/noNonNullAssertion: keys come from Object.keys
    sortedFiles[key] = manifest.files[key]!;
  }
  return JSON.stringify({ version: manifest.version, files: sortedFiles });
}

export function manifestKeyFor(filesHash: string): string {
  return `snapshots/${filesHash}/manifest.json`;
}

export interface SnapshotInputFile {
  path: string;
  bytes: Uint8Array;
}

export class SnapshotStore {
  constructor(private readonly blobs: BlobStore) {}

  /** Write a full file tree; returns the manifest pointer + content hash. */
  async write(files: SnapshotInputFile[]): Promise<WriteResult> {
    const entries: Record<string, ManifestEntry> = {};
    for (const file of files) {
      assertSafeBundlePath(file.path);
      const blob = await this.blobs.put(file.bytes);
      entries[file.path] = {
        blob,
        size: file.bytes.byteLength,
        contentType: contentTypeFor(file.path),
      };
    }
    const manifest: SnapshotManifest = { version: 1, files: entries };
    const json = canonicalManifestJson(manifest);
    const filesHash = sha256(json);
    const manifestKey = manifestKeyFor(filesHash);
    await this.blobs.put(Buffer.from(json, 'utf8'));
    return { manifestKey, filesHash, manifest };
  }

  /** Load a manifest from storage given its key (snapshots/{filesHash}/manifest.json). */
  async readManifest(manifestKey: string): Promise<SnapshotManifest> {
    // manifestKey = "snapshots/{filesHash}/manifest.json"
    // The manifest JSON is itself a content-addressed blob stored as "blobs/{filesHash}"
    const parts = manifestKey.split('/');
    const filesHash = parts[1];
    if (!filesHash) throw new Error(`invalid manifestKey: ${manifestKey}`);
    const bytes = await this.blobs.get(blobKey(filesHash));
    return JSON.parse(Buffer.from(bytes).toString()) as SnapshotManifest;
  }

  /** Read a single file's bytes from a manifest (used by the games edge server). */
  async readFile(manifest: SnapshotManifest, path: string): Promise<Uint8Array> {
    const entry = manifest.files[path];
    if (!entry) throw new Error(`file not in manifest: ${path}`);
    return this.blobs.get(entry.blob);
  }
}
