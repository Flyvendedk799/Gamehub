/**
 * The vendored `editor-core.mjs` bundle and its hand-written types.
 *
 * The bundle is generated in another repository and committed here, and its
 * `.d.mts` is written by hand — two ways for this to rot silently. So both are
 * checked mechanically:
 *
 *  1. every symbol the bundle exports is declared, and every symbol declared is
 *     actually exported, and
 *  2. the guarantees that matter when the caller is a model still hold after
 *     concatenation.
 *
 * Refresh with `node scripts/sync-engine-skill.mjs`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as editor from './editor-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(HERE, 'editor-core.mjs');
const TYPES_PATH = resolve(HERE, 'editor-core.d.mts');
const bundleSource = readFileSync(BUNDLE_PATH, 'utf8');
const typesSource = readFileSync(TYPES_PATH, 'utf8');

/** Value exports the `.d.mts` declares — functions and consts, not types. */
function declaredValues(): string[] {
  const names = new Set<string>();
  for (const match of typesSource.matchAll(
    /^export (?:declare )?(?:function|const) ([A-Za-z_][\w]*)/gm,
  )) {
    names.add(match[1] as string);
  }
  return [...names].sort();
}

describe('vendored editor-core.mjs', () => {
  it('says where it came from', () => {
    expect(bundleSource).toContain('GENERATED from engine3d');
  });

  it('imports nothing', () => {
    const imports = [...bundleSource.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map(
      (match) => match[1],
    );
    // This is what lets the same authoring model run on the server driving an
    // agent and in the browser driving the editor, with no build step.
    expect(imports).toEqual([]);
  });

  it('contains no eval', () => {
    expect(bundleSource).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
  });

  it('declares exactly what it exports', () => {
    const exported = Object.keys(editor)
      .filter((name) => typeof (editor as Record<string, unknown>)[name] !== 'undefined')
      .sort();
    const declared = declaredValues();

    const undeclared = exported.filter((name) => !declared.includes(name));
    const phantom = declared.filter((name) => !exported.includes(name));

    // Drift shows up here rather than as `undefined is not a function` in a
    // route somewhere.
    expect(undeclared).toEqual([]);
    expect(phantom).toEqual([]);
  });
});

describe('guarantees that survived concatenation', () => {
  it('rejects a path that escapes the project', () => {
    // The rule that matters most when the commands come from a model.
    expect(editor.isSafeProjectPath('textures/wall.png')).toBe(true);
    expect(editor.isSafeProjectPath('../../etc/passwd')).toBe(false);
    expect(editor.isSafeProjectPath('/etc/passwd')).toBe(false);
    expect(editor.isSafeProjectPath('C:\\Windows')).toBe(false);
  });

  it('refuses to delete an asset something still references', () => {
    const database = editor.createAssetDatabase({ idPrefix: 'a' });
    const texture = database.import({ path: 't.png', type: 'texture', content: 't' });
    database.import({
      path: 'm.mat',
      type: 'material',
      content: 'm',
      dependencies: [texture.id],
    });

    const refused = database.remove(texture.id);
    expect(refused.removed).toBe(false);
    expect(refused.dangling).toHaveLength(1);
  });

  it('keeps asset references intact across a move', () => {
    const database = editor.createAssetDatabase({ idPrefix: 'a' });
    const texture = database.import({ path: 'a/t.png', type: 'texture', content: 't' });
    const material = database.import({
      path: 'm.mat',
      type: 'material',
      content: 'm',
      dependencies: [texture.id],
    });

    expect(database.move(texture.id, 'b/t.png')).toBe(true);
    expect(database.get(material.id)?.dependencies).toEqual([texture.id]);
  });

  it('rolls a failed batch back completely', () => {
    const session = editor.createAgentSession({
      database: editor.createAssetDatabase({}),
      scene: editor.emptyScene('Level'),
    });
    session.execute({ op: 'scene.addNode', id: 'keep' });

    const result = session.batch([
      { op: 'scene.addNode', id: 'fresh' },
      { op: 'scene.addNode', id: 'keep' },
    ]);
    expect(result.ok).toBe(false);
    expect(session.scene().order).toEqual(['keep']);
  });

  it('reports an unknown operation rather than ignoring it', () => {
    const session = editor.createAgentSession({
      database: editor.createAssetDatabase({}),
    });
    const result = session.execute({ op: 'scene.explode' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_operation');
  });
});
