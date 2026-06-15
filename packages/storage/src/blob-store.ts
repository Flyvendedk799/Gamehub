/**
 * Content-addressed blob store. A blob's key is the SHA-256 of its bytes, so
 * identical content is stored once and naturally deduped across snapshots and
 * remixes. Two interchangeable implementations:
 *   - InMemoryBlobStore  — tests / ephemeral.
 *   - LocalFsBlobStore   — local dev (writes under a root dir).
 * Production will add an S3/R2 impl behind the same `BlobStore` interface.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

export class InMemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    const key = blobKey(sha256(bytes));
    if (!this.map.has(key)) this.map.set(key, bytes);
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    const v = this.map.get(key);
    if (!v) throw new Error(`blob not found: ${key}`);
    return v;
  }

  async has(key: string): Promise<boolean> {
    return this.map.has(key);
  }
}

export class LocalFsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, key);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const key = blobKey(sha256(bytes));
    const p = this.path(key);
    if (!(await this.has(key))) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    }
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}
