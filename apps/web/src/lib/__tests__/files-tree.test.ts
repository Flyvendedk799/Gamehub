import { describe, expect, it } from 'vitest';
import type { ProjectFileEntry } from '../api';
import { buildFileTree, fileKind, formatBytes } from '../files-tree';

function entry(path: string, isText = true): ProjectFileEntry {
  return { path, size: 100, contentType: isText ? 'text/plain' : 'image/png', isText };
}

describe('buildFileTree', () => {
  it('nests directories from "/" segments and orders dirs before files', () => {
    const tree = buildFileTree([
      entry('main.js'),
      entry('index.html'),
      entry('assets/img/p.png', false),
    ]);

    // Top level: dir "assets" first, then files alphabetical.
    expect(tree.map((n) => `${n.type}:${n.name}`)).toEqual([
      'dir:assets',
      'file:index.html',
      'file:main.js',
    ]);

    const assets = tree[0];
    expect(assets?.path).toBe('assets');
    const img = assets?.children?.[0];
    expect(img).toMatchObject({ type: 'dir', name: 'img', path: 'assets/img' });
    expect(img?.children?.[0]).toMatchObject({
      type: 'file',
      name: 'p.png',
      path: 'assets/img/p.png',
    });
  });

  it('sorts case-insensitively within a group', () => {
    const tree = buildFileTree([entry('Zebra.js'), entry('apple.js'), entry('Banana.js')]);
    expect(tree.map((n) => n.name)).toEqual(['apple.js', 'Banana.js', 'Zebra.js']);
  });

  it('returns an empty array for no files', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('handles bytes, boundaries, and larger units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });
});

describe('fileKind', () => {
  it('maps by extension', () => {
    expect(fileKind('index.html')).toBe('html');
    expect(fileKind('main.js')).toBe('js');
    expect(fileKind('mod.mjs')).toBe('js');
    expect(fileKind('game.ts')).toBe('js');
    expect(fileKind('style.css')).toBe('css');
    expect(fileKind('data.json')).toBe('json');
    expect(fileKind('p.png')).toBe('image');
    expect(fileKind('logo.svg')).toBe('image');
    expect(fileKind('sfx.mp3')).toBe('audio');
    expect(fileKind('hero.glb')).toBe('model');
    expect(fileKind('LICENSE')).toBe('other');
  });

  it('falls back to content-type when the extension is unknown', () => {
    expect(fileKind('blob', 'image/webp')).toBe('image');
    expect(fileKind('blob', 'audio/ogg')).toBe('audio');
    expect(fileKind('blob', 'application/json')).toBe('json');
    expect(fileKind('blob', 'text/css')).toBe('css');
  });
});
