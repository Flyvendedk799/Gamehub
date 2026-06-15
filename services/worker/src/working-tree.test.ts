import type { TextEditorFsCallbacks } from '@playforge/agent-core';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import { WorkingTree } from './working-tree';

describe('WorkingTree satisfies the agent fs contract', () => {
  it('is assignable to TextEditorFsCallbacks', () => {
    // Compile-time proof the adapter matches what generateViaAgent's
    // text_editor tool expects. Runtime assertion keeps the test non-empty.
    const fs: TextEditorFsCallbacks = new WorkingTree();
    expect(typeof fs.create).toBe('function');
    expect(typeof fs.view).toBe('function');
    expect(typeof fs.strReplace).toBe('function');
    expect(typeof fs.listDir).toBe('function');
  });
});

describe('WorkingTree edits', () => {
  it('create + view round-trips with line counts', () => {
    const t = new WorkingTree();
    t.create('index.html', '<h1>hi</h1>\n<p>x</p>');
    expect(t.view('index.html')).toEqual({ content: '<h1>hi</h1>\n<p>x</p>', numLines: 2 });
    expect(t.view('missing.js')).toBeNull();
  });

  it('strReplace replaces a unique match and reports lines', () => {
    const t = new WorkingTree([['src/main.js', 'const speed = 1;\nupdate();']]);
    const r = t.strReplace('src/main.js', 'const speed = 1;', 'const speed = 5;');
    expect(t.view('src/main.js')?.content).toBe('const speed = 5;\nupdate();');
    expect(r.startLine).toBe(1);
    expect(r.totalLines).toBe(2);
  });

  it('strReplace throws on no match and on non-unique match', () => {
    const t = new WorkingTree([['a.js', 'x\nx']]);
    expect(() => t.strReplace('a.js', 'nope', 'y')).toThrow();
    expect(() => t.strReplace('a.js', 'x', 'y')).toThrow(/not unique/);
  });

  it('insert places text after a 1-indexed line', () => {
    const t = new WorkingTree([['a.js', 'line1\nline3']]);
    t.insert('a.js', 1, 'line2');
    expect(t.view('a.js')?.content).toBe('line1\nline2\nline3');
  });

  it('patch applies line-bounded hunks descending', () => {
    const t = new WorkingTree([['a.js', 'one\ntwo\nthree\nfour']]);
    t.patch('a.js', [
      { startLine: 1, endLine: 1, replacement: 'ONE' },
      { startLine: 3, endLine: 4, replacement: 'THREE+FOUR' },
    ]);
    expect(t.view('a.js')?.content).toBe('ONE\ntwo\nTHREE+FOUR');
  });

  it('patch rejects overlapping hunks', () => {
    const t = new WorkingTree([['a.js', 'a\nb\nc']]);
    expect(() =>
      t.patch('a.js', [
        { startLine: 1, endLine: 2, replacement: 'x' },
        { startLine: 2, endLine: 3, replacement: 'y' },
      ]),
    ).toThrow(/overlapping/);
  });

  it('listDir returns sorted paths under a prefix', () => {
    const t = new WorkingTree([
      ['index.html', ''],
      ['src/a.js', ''],
      ['src/sub/b.js', ''],
    ]);
    expect(t.listDir('src')).toEqual(['src/a.js', 'src/sub/b.js']);
    expect(t.listDir('')).toEqual(['index.html', 'src/a.js', 'src/sub/b.js']);
  });

  it('rejects unsafe paths on create', () => {
    const t = new WorkingTree();
    expect(() => t.create('../escape.js', 'x')).toThrow();
  });
});

describe('WorkingTree persistence to content-addressed storage', () => {
  it('persists the tree and reads files back through the manifest', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const t = new WorkingTree();
    t.create('index.html', '<canvas id="game"></canvas>');
    t.create('src/main.js', 'new Phaser.Game();');

    const res = await t.persist(store);
    expect(res.manifestKey).toBe(`snapshots/${res.filesHash}/manifest.json`);
    expect(Object.keys(res.manifest.files).sort()).toEqual(['index.html', 'src/main.js']);

    const bytes = await store.readFile(res.manifest, 'src/main.js');
    expect(new TextDecoder().decode(bytes)).toBe('new Phaser.Game();');
  });

  it('an edit re-uses the unchanged file blob (cheap versioning)', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const t = new WorkingTree();
    t.create('index.html', 'BIG_UNCHANGED');
    t.create('src/main.js', 'v1');
    const v1 = await t.persist(store);
    t.strReplace('src/main.js', 'v1', 'v2');
    const v2 = await t.persist(store);
    expect(v1.manifest.files['index.html']?.blob).toBe(v2.manifest.files['index.html']?.blob);
    expect(v1.filesHash).not.toBe(v2.filesHash);
  });
});
