#!/usr/bin/env node
/**
 * Refresh the vendored engine3d artifacts.
 *
 * The engine lives in its own repository — it is not PlayerZero-specific and has
 * no dependency on anything here. What PlayerZero needs are its two *emitted*
 * bundles:
 *
 *  - `three/engine-core.jsx` — the runtime a generated game boots. One
 *    self-contained ES module whose only import is `three`, because a generated
 *    game runs in a sandboxed iframe and cannot import a package at all.
 *  - `editor/editor-core.mjs` — the authoring model: assets, scene documents,
 *    prefabs, and the agent command surface. Imports nothing. Both the agent
 *    tools and the manual editor drive it, so a prompt and a drag land in the
 *    same document and mean the same thing to undo.
 *
 * The artifacts are committed here rather than fetched at build time, and that
 * is deliberate. This repo must build without the engine checkout present, on CI
 * and on a laptop that has never cloned it, and a generated game must be
 * reproducible from this repo alone. The cost is that the copies can go stale,
 * so the tests beside each artifact pin what it must contain, and this script is
 * how you refresh them.
 *
 *   node scripts/sync-engine-skill.mjs                 # ../../../engine3d
 *   node scripts/sync-engine-skill.mjs --engine=<path>
 *   ENGINE3D_REPO=<path> node scripts/sync-engine-skill.mjs
 *
 * It runs the engine's own emitter rather than copying its checked-in artifacts,
 * so a stale artifact in the engine repo cannot quietly become a stale artifact
 * here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

/** The artifacts this repo vendors, and where each one lands. */
const VENDORED = [
  {
    target: 'playerzero',
    path: join(PACKAGE_ROOT, 'src', 'game-skills', 'three', 'engine-core.jsx'),
  },
  {
    target: 'editor',
    path: join(PACKAGE_ROOT, 'src', 'editor', 'editor-core.mjs'),
  },
];

function resolveEnginePath(argv = process.argv.slice(2)) {
  const flag = argv.find((arg) => arg.startsWith('--engine='));
  if (flag) return resolve(flag.slice('--engine='.length));
  if (process.env.ENGINE3D_REPO) return resolve(process.env.ENGINE3D_REPO);
  // Sibling of this repo is the common layout and costs nothing to guess.
  return resolve(REPO_ROOT, '..', 'engine3d');
}

function main() {
  const enginePath = resolveEnginePath();
  const emitter = join(enginePath, 'scripts', 'emit-skill.mjs');

  if (!existsSync(emitter)) {
    console.error(`sync-engine-skill: no engine3d checkout at ${enginePath}`);
    console.error('Pass --engine=<path> or set ENGINE3D_REPO.');
    process.exit(1);
  }

  let changed = 0;
  for (const { target, path: destination } of VENDORED) {
    const before = existsSync(destination) ? readFileSync(destination, 'utf8') : null;

    mkdirSync(dirname(destination), { recursive: true });
    execFileSync(process.execPath, [emitter, `--target=${target}`, `--out=${destination}`], {
      stdio: 'inherit',
    });

    const after = readFileSync(destination, 'utf8');
    if (before === after) {
      console.log(`sync-engine-skill[${target}]: already up to date`);
      continue;
    }
    changed++;
    const delta =
      before === null ? 'created' : `updated (${before.length} -> ${after.length} bytes)`;
    console.log(`sync-engine-skill[${target}]: ${delta}`);
  }

  if (changed === 0) console.log('sync-engine-skill: nothing changed');
}

main();
