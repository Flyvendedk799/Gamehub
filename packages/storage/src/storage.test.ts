import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore, sha256 } from './blob-store';
import { isSafeBundlePath } from './paths';
import { SnapshotStore, type SnapshotInputFile } from './snapshot-store';

const enc = (s: string) => new TextEncoder().encode(s);

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
