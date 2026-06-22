import type { TextEditorFsCallbacks } from '@playforge/agent-core';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { describe, expect, it } from 'vitest';
import { WorkingTree, decodeMaybeDataUrl } from './working-tree';

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

  it('patch relocates a hunk when the line range is stale but expectedOriginal is unique', () => {
    // The file gained 2 lines at the top since the model last viewed it, so the
    // model's line numbers point one block too high. expectedOriginal is the
    // ground truth → relocate + apply rather than failing with a stale-line error.
    const t = new WorkingTree([['a.js', '// added\n// added2\nconst hp = 1;\nconst mp = 2;']]);
    t.patch('a.js', [
      {
        startLine: 1,
        endLine: 1,
        replacement: 'const hp = 99;',
        expectedOriginal: 'const hp = 1;',
      },
    ]);
    expect(t.view('a.js')?.content).toBe('// added\n// added2\nconst hp = 99;\nconst mp = 2;');
  });

  it('patch errors clearly when expectedOriginal is gone (0 matches) vs ambiguous (>1)', () => {
    const gone = new WorkingTree([['a.js', 'x\ny\nz']]);
    expect(() =>
      gone.patch('a.js', [
        { startLine: 1, endLine: 1, replacement: 'q', expectedOriginal: 'NOT THERE' },
      ]),
    ).toThrow(/not present anywhere/);
    const dupe = new WorkingTree([['a.js', 'dup\nmid\ndup']]);
    expect(() =>
      dupe.patch('a.js', [{ startLine: 2, endLine: 2, replacement: 'q', expectedOriginal: 'dup' }]),
    ).toThrow(/appears 2 times/);
  });

  it('strReplace does NOT auto-apply on whitespace drift (no silent indent corruption — errors instead)', () => {
    // Indentation-significant content (e.g. a GLSL shader string). The model's
    // old_str dropped the indent → exact match fails. We must NOT silently splice
    // the de-indented bytes in; a clean failure lets the model re-view + retry.
    const t = new WorkingTree([['a.js', 'const shader = `\n        void main() {\n        }\n`;']]);
    expect(() => t.strReplace('a.js', 'void main() {\n}', 'void main() { gl_x(); }')).toThrow(
      /no match/,
    );
    // File is untouched — no partial/corrupting write.
    expect(t.view('a.js')?.content).toBe('const shader = `\n        void main() {\n        }\n`;');
  });

  it('patch rejects non-integer line numbers rather than truncating (no slice/splice divergence)', () => {
    // Fast-path fractional: slice(1.7,3.2)→['two','three'] matches expectedOriginal,
    // but splice(1.7, 1.5) would delete only 1 line → orphan 'three'. Must reject.
    const t = new WorkingTree([['a.js', 'one\ntwo\nthree\nfour']]);
    expect(() =>
      t.patch('a.js', [
        { startLine: 2.7, endLine: 3.2, replacement: 'X', expectedOriginal: 'two\nthree' },
      ]),
    ).toThrow(/must be integers/);
  });

  it('patch does NOT relocate on a whitespace-only expectedOriginal (too weak an anchor)', () => {
    // A blank-line anchor carries no signal; relocation must not fire. With a stale
    // range it falls through to the range path → out-of-range error, never a guess.
    const t = new WorkingTree([['a.js', 'a\n\nb\n\nc']]);
    expect(() =>
      t.patch('a.js', [{ startLine: 50, endLine: 50, replacement: 'X', expectedOriginal: '   ' }]),
    ).toThrow(/out of range/);
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

describe('decodeMaybeDataUrl — binary asset sentinels become real bytes', () => {
  const wavBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]); // "RIFF.."

  it('decodes a MIME-typed base64 data URL (image tool form)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const out = decodeMaybeDataUrl(`data:image/png;base64,${png.toString('base64')}`);
    expect(Buffer.from(out)).toEqual(png);
  });

  it('decodes a MIME-less base64 data URL (legacy audio tool form)', () => {
    const out = decodeMaybeDataUrl(`data:base64,${wavBytes.toString('base64')}`);
    expect(Buffer.from(out)).toEqual(wavBytes);
  });

  it('UTF-8 encodes ordinary file content unchanged', () => {
    const html = '<!doctype html><body>data: not a url</body>';
    expect(Buffer.from(decodeMaybeDataUrl(html)).toString('utf8')).toBe(html);
  });

  it('toSnapshotInput decodes an audio sentinel to the real WAV bytes', async () => {
    const tree = new WorkingTree();
    tree.create('assets/audio/drift.wav', `data:audio/wav;base64,${wavBytes.toString('base64')}`);
    tree.create('index.html', '<!doctype html>');
    const snap = tree.toSnapshotInput();
    const audio = snap.find((f) => f.path === 'assets/audio/drift.wav');
    expect(Buffer.from(audio!.bytes)).toEqual(wavBytes); // real bytes, not the data-URL text
    const html = snap.find((f) => f.path === 'index.html');
    expect(Buffer.from(html!.bytes).toString('utf8')).toBe('<!doctype html>');
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
