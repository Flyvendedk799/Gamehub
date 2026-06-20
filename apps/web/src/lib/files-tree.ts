/**
 * Pure helpers for the Files tab: turning the API's flat file list into a nested
 * tree, formatting byte sizes, and classifying a file by extension/content-type
 * so the UI can pick an icon glyph. No React, no I/O — unit-testable in isolation.
 */

import type { ProjectFileEntry } from './api';

export interface FileNode {
  name: string;
  /** Full path from the project root (e.g. "assets/img/p.png"). For a dir this
   *  is the directory prefix (e.g. "assets" / "assets/img"). */
  path: string;
  type: 'file' | 'dir';
  size?: number;
  contentType?: string;
  isText?: boolean;
  children?: FileNode[];
}

/**
 * Build a nested tree from the flat path list. Directories are inferred from the
 * "/" segments of each file path. Within every level, directories sort before
 * files and each group is alphabetical (case-insensitive).
 */
export function buildFileTree(files: ProjectFileEntry[]): FileNode[] {
  const root: FileNode = { name: '', path: '', type: 'dir', children: [] };

  for (const file of files) {
    const segments = file.path.split('/').filter((s) => s.length > 0);
    let cursor = root;
    let prefix = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === undefined) continue;
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = i === segments.length - 1;

      if (isLeaf) {
        cursor.children = cursor.children ?? [];
        cursor.children.push({
          name: segment,
          path: file.path,
          type: 'file',
          size: file.size,
          contentType: file.contentType,
          isText: file.isText,
        });
      } else {
        cursor.children = cursor.children ?? [];
        let dir = cursor.children.find((c) => c.type === 'dir' && c.name === segment);
        if (!dir) {
          dir = { name: segment, path: prefix, type: 'dir', children: [] };
          cursor.children.push(dir);
        }
        cursor = dir;
      }
    }
  }

  sortNodes(root);
  return root.children ?? [];
}

function sortNodes(node: FileNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const child of node.children) sortNodes(child);
}

/** Human-readable byte size: "0 B", "1.2 KB", "3.4 MB" (1024-based, 1 decimal
 *  for KB and up, whole numbers for bytes). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export type FileKind = 'html' | 'js' | 'css' | 'json' | 'image' | 'audio' | 'model' | 'other';

/** Classify a file by extension (preferred) then content-type, used to pick an
 *  icon glyph and decide how to preview it. */
export function fileKind(path: string, contentType?: string): FileKind {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';

  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
    case 'jsx':
      return 'js';
    case 'css':
      return 'css';
    case 'json':
      return 'json';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'bmp':
    case 'ico':
    case 'avif':
      return 'image';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'm4a':
    case 'aac':
    case 'flac':
      return 'audio';
    case 'glb':
    case 'gltf':
    case 'obj':
    case 'fbx':
    case 'stl':
      return 'model';
  }

  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('audio/')) return 'audio';
    if (ct.startsWith('model/')) return 'model';
    if (ct.includes('html')) return 'html';
    if (ct.includes('json')) return 'json';
    if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
    if (ct.includes('css')) return 'css';
  }

  return 'other';
}
