/**
 * Content-addressed blob store. A blob's key is the SHA-256 of its bytes, so
 * identical content is stored once and naturally deduped across snapshots and
 * remixes. Two interchangeable implementations:
 *   - InMemoryBlobStore  — tests / ephemeral.
 *   - LocalFsBlobStore   — local dev (writes under a root dir).
 * Production will add an S3/R2 impl behind the same `BlobStore` interface.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

export interface BlobStore {
  /** Store bytes; returns the content-addressed key (`blobs/<sha256>`). Idempotent. */
  put(bytes: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  has(key: string): Promise<boolean>;
}

export function blobKey(hash: string): string {
  return `blobs/${hash}`;
}

const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Normalize a blob key to its canonical `blobs/<sha256>` form. Accepts BOTH a
 * bare `<sha256>` hash AND a `blobs/<sha256>` key, so the exact key returned by
 * `put` round-trips through `get` — and so callers that only kept the bare hash
 * (e.g. the games edge route that strips the prefix) still resolve. Throws on
 * anything that is not a well-formed content-addressed key.
 */
export function canonicalBlobKey(key: string): string {
  if (typeof key !== 'string') throw new Error('invalid blob key');
  const hash = key.startsWith('blobs/') ? key.slice('blobs/'.length) : key;
  if (!HASH_RE.test(hash)) throw new Error(`invalid blob key: ${JSON.stringify(key)}`);
  return blobKey(hash);
}

export class InMemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    const key = blobKey(sha256(bytes));
    if (!this.map.has(key)) this.map.set(key, bytes);
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    const canonical = canonicalBlobKey(key);
    const v = this.map.get(canonical);
    if (!v) throw new Error(`blob not found: ${key}`);
    return v;
  }

  async has(key: string): Promise<boolean> {
    let canonical: string;
    try {
      canonical = canonicalBlobKey(key);
    } catch {
      return false;
    }
    return this.map.has(canonical);
  }
}

export class LocalFsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  /** Resolve a (bare or `blobs/`-prefixed) key to its on-disk canonical path. */
  private path(key: string): string {
    return join(this.root, canonicalBlobKey(key));
  }

  async put(bytes: Uint8Array): Promise<string> {
    const key = blobKey(sha256(bytes));
    const p = this.path(key);
    if (!(await this.has(key))) {
      const dir = dirname(p);
      await mkdir(dir, { recursive: true });
      // Atomic write: stream into a unique temp file in the SAME directory (so the
      // final `rename` stays on one filesystem and is atomic), then rename into
      // place. Readers therefore never observe a partially written blob, and a
      // crash mid-write leaves only an orphan temp file, never a torn blob.
      const tmp = join(dir, `.tmp-${sha256(key)}-${randomBytes(8).toString('hex')}`);
      try {
        await writeFile(tmp, bytes, { flag: 'wx' });
        await rename(tmp, p);
      } catch (err) {
        // Best-effort cleanup of the temp file; ignore if it never existed or the
        // rename already consumed it.
        await unlink(tmp).catch(() => {});
        // If another concurrent writer won the race and the blob now exists, the
        // content is identical (content-addressed), so treat that as success.
        if (await this.has(key)) return key;
        throw err;
      }
    }
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async has(key: string): Promise<boolean> {
    let p: string;
    try {
      p = this.path(key);
    } catch {
      return false;
    }
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }
}
