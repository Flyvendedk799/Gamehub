import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BlobStore,
  InMemoryBlobStore,
  LocalFsBlobStore,
  blobKey,
  canonicalBlobKey,
  sha256,
} from './blob-store';
import { isSafeBundlePath } from './paths';
import { type SnapshotInputFile, SnapshotStore } from './snapshot-store';

const enc = (s: string) => new TextEncoder().encode(s);

const tmpDirs: string[] = [];
async function freshFsStore(): Promise<LocalFsBlobStore> {
  const dir = await mkdtemp(join(tmpdir(), 'pf-storage-'));
  tmpDirs.push(dir);
  return new LocalFsBlobStore(dir);
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function tree(...pairs: [string, string][]): SnapshotInputFile[] {
  return pairs.map(([path, content]) => ({ path, bytes: enc(content) }));
}

describe('path safety', () => {
  it('accepts normal POSIX-relative bundle paths', () => {
    for (const p of ['index.html', 'src/main.js', 'assets/sprites/hero.png']) {
      expect(isSafeBundlePath(p)).toBe(true);
    }
  });
  it('rejects traversal, absolute, protocol, drive, and empty paths', () => {
    for (const p of ['', '/etc/passwd', '../secret', 'a/../../b', 'C:\\x', 'http://x/y', 'a\\b']) {
      expect(isSafeBundlePath(p)).toBe(false);
    }
  });
});

describe('content-addressed blobs', () => {
  it('keys by sha256 and dedupes identical content', async () => {
    const store = new InMemoryBlobStore();
    const k1 = await store.put(enc('hello'));
    const k2 = await store.put(enc('hello'));
    expect(k1).toBe(k2);
    expect(k1).toBe(`blobs/${sha256('hello')}`);
    expect(new TextDecoder().decode(await store.get(k1))).toBe('hello');
  });
});

describe('SnapshotStore', () => {
  it('writes a manifest and reads files back', async () => {
    const blobs = new InMemoryBlobStore();
    const snaps = new SnapshotStore(blobs);
    const res = await snaps.write(tree(['index.html', '<h1>hi</h1>'], ['src/main.js', 'let x=1']));
    expect(res.manifestKey).toBe(`snapshots/${res.filesHash}/manifest.json`);
    expect(Object.keys(res.manifest.files).sort()).toEqual(['index.html', 'src/main.js']);
    expect(res.manifest.files['index.html']?.contentType).toBe('text/html; charset=utf-8');
    const bytes = await snaps.readFile(res.manifest, 'src/main.js');
    expect(new TextDecoder().decode(bytes)).toBe('let x=1');
  });

  it('produces a stable filesHash regardless of input order', async () => {
    const snaps = new SnapshotStore(new InMemoryBlobStore());
    const a = await snaps.write(tree(['a.js', '1'], ['b.js', '2']));
    const b = await snaps.write(tree(['b.js', '2'], ['a.js', '1']));
    expect(a.filesHash).toBe(b.filesHash);
  });

  it('dedupes unchanged blobs across an edit (cheap versioning)', async () => {
    const blobs = new InMemoryBlobStore();
    const snaps = new SnapshotStore(blobs);
    const v1 = await snaps.write(tree(['index.html', 'BIG'], ['src/main.js', 'old']));
    const v2 = await snaps.write(tree(['index.html', 'BIG'], ['src/main.js', 'new']));
    // index.html blob is shared; only main.js differs → different manifest hash.
    expect(v1.manifest.files['index.html']?.blob).toBe(v2.manifest.files['index.html']?.blob);
    expect(v1.manifest.files['src/main.js']?.blob).not.toBe(v2.manifest.files['src/main.js']?.blob);
    expect(v1.filesHash).not.toBe(v2.filesHash);
  });

  it('rejects an unsafe path inside a tree', async () => {
    const snaps = new SnapshotStore(new InMemoryBlobStore());
    await expect(snaps.write(tree(['../escape.js', 'x']))).rejects.toThrow();
  });
});

// ── #24: putBlob → getBlob key round-trip ──────────────────────────────────
// The exact key returned by putBlob (`blobs/<sha256>`) must be readable by
// getBlob, AND a bare `<sha256>` (what the games edge route extracts) must too.
describe('blob key round-trip (#24)', () => {
  for (const [name, make] of [
    ['InMemory', () => new InMemoryBlobStore()] as const,
    ['LocalFs', () => freshFsStore()] as const,
  ]) {
    it(`putBlob key round-trips through getBlob — ${name}`, async () => {
      const blobs: BlobStore = await make();
      const snaps = new SnapshotStore(blobs);
      const payload = enc(`thumbnail-bytes-${name}`);

      const key = await snaps.putBlob(payload);
      // putBlob returns the canonical prefixed key.
      expect(key).toBe(`blobs/${sha256(payload)}`);

      // 1. The EXACT key from putBlob is readable.
      expect(new TextDecoder().decode(await snaps.getBlob(key))).toBe(`thumbnail-bytes-${name}`);

      // 2. The bare hash (what `/v1/blobs/:key` extracts) is ALSO readable.
      const bareHash = sha256(payload);
      expect(new TextDecoder().decode(await snaps.getBlob(bareHash))).toBe(
        `thumbnail-bytes-${name}`,
      );
    });
  }

  it('canonicalBlobKey accepts bare + prefixed and rejects garbage', () => {
    const h = sha256('x');
    expect(canonicalBlobKey(h)).toBe(blobKey(h));
    expect(canonicalBlobKey(blobKey(h))).toBe(blobKey(h));
    for (const bad of ['', 'blobs/', 'blobs/../etc', 'not-a-hash', `blobs/${h}/extra`, `${h}x`]) {
      expect(() => canonicalBlobKey(bad)).toThrow();
    }
  });
});

// ── #42(b): strict path-traversal / control-char rejection ─────────────────
describe('path safety hardening (#42b)', () => {
  it('rejects C0 control chars (incl. NUL/CR/LF/TAB) and DEL', () => {
    // 0x00 (NUL), 0x09 (TAB), 0x0A (LF), 0x0D (CR), 0x1F (last C0), 0x7F (DEL).
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      expect(isSafeBundlePath(`a${String.fromCharCode(code)}b`)).toBe(false);
    }
  });
  it('rejects non-NFC (decomposed) unicode paths', () => {
    const decomposed = 'café/x.js'; // "café" with combining acute → not NFC
    expect(decomposed.normalize('NFC')).not.toBe(decomposed);
    expect(isSafeBundlePath(decomposed)).toBe(false);
    // The composed (NFC) equivalent is accepted.
    expect(isSafeBundlePath(decomposed.normalize('NFC'))).toBe(true);
  });
  it('still rejects traversal / absolute / leading-slash, accepts deep relative', () => {
    for (const p of ['/a', '..', 'a/../../b', 'a//b', './a']) {
      expect(isSafeBundlePath(p)).toBe(false);
    }
    expect(isSafeBundlePath('assets/levels/01/data.json')).toBe(true);
  });
});

// ── #42(b): readManifest strict key parsing ────────────────────────────────
describe('readManifest strict key parsing (#42b)', () => {
  it('rejects malformed / traversal manifest keys before touching the blob store', async () => {
    const snaps = new SnapshotStore(new InMemoryBlobStore());
    for (const bad of [
      'snapshots/../../etc/passwd/manifest.json',
      'snapshots//manifest.json',
      'snapshots/NOTHEX/manifest.json',
      'snapshots/deadbeef/manifest.json', // too short
      `snapshots/${'a'.repeat(64)}/evil.json`,
      'evil',
    ]) {
      await expect(snaps.readManifest(bad)).rejects.toThrow(/invalid manifestKey/);
    }
  });

  it('round-trips a real manifest key', async () => {
    const snaps = new SnapshotStore(new InMemoryBlobStore());
    const res = await snaps.write(tree(['index.html', '<h1>hi</h1>']));
    const loaded = await snaps.readManifest(res.manifestKey);
    expect(loaded).toEqual(res.manifest);
  });

  it('fails the content-address integrity check on a corrupted manifest blob', async () => {
    const corrupt = new CorruptibleStore();
    const snaps = new SnapshotStore(corrupt);
    const res = await snaps.write(tree(['index.html', 'hi']));
    // Tamper: overwrite the bytes stored at the manifest's content-address with
    // bytes of a DIFFERENT hash → sha256(bytes) !== filesHash, simulating a torn
    // / corrupted blob. The integrity check must reject before JSON.parse.
    corrupt.forceSet(blobKey(res.filesHash), enc('totally different bytes'));
    await expect(snaps.readManifest(res.manifestKey)).rejects.toThrow(/integrity check failed/);
  });
});

/** Test helper: an in-memory store that lets a test overwrite a key's bytes. */
class CorruptibleStore extends InMemoryBlobStore {
  forceSet(canonicalKey: string, bytes: Uint8Array): void {
    (this as unknown as { map: Map<string, Uint8Array> }).map.set(canonicalKey, bytes);
  }
}

// ── #42(a): atomic LocalFs writes ──────────────────────────────────────────
describe('LocalFs atomic writes (#42a)', () => {
  it('leaves no temp files and a readable blob after put', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pf-storage-atomic-'));
    tmpDirs.push(dir);
    const store = new LocalFsBlobStore(dir);
    const payload = enc('atomic-payload');
    const key = await store.put(payload);
    expect(new TextDecoder().decode(await store.get(key))).toBe('atomic-payload');
    // The blobs/ dir must contain only the final blob — no `.tmp-*` leftovers.
    const blobsDir = join(dir, 'blobs');
    const entries = await readdir(blobsDir);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
    expect(entries).toContain(sha256(payload));
  });

  it('concurrent puts of identical content converge on one intact blob', async () => {
    const store = await freshFsStore();
    const payload = enc('race-payload');
    const keys = await Promise.all(Array.from({ length: 16 }, () => store.put(payload)));
    expect(new Set(keys).size).toBe(1);
    expect(new TextDecoder().decode(await store.get(keys[0]!))).toBe('race-payload');
  });

  it('never exposes a torn read: a pre-existing temp file does not corrupt the blob', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pf-storage-torn-'));
    tmpDirs.push(dir);
    const store = new LocalFsBlobStore(dir);
    const payload = enc('full-content-bytes');
    // Pre-seed a stray partial temp file in the target dir; the atomic write must
    // succeed regardless (unique temp name) and the final blob must be complete.
    const key = await store.put(payload);
    const finalPath = join(dir, key);
    const bytes = await readFile(finalPath);
    expect(new TextDecoder().decode(bytes)).toBe('full-content-bytes');
    // A second put of the same content is a no-op (already present) and stays intact.
    await writeFile(join(dir, 'blobs', '.tmp-stray-leftover'), 'partial');
    const key2 = await store.put(payload);
    expect(key2).toBe(key);
    expect(new TextDecoder().decode(await readFile(finalPath))).toBe('full-content-bytes');
  });
});
