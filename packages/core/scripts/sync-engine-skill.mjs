#!/usr/bin/env node
/**
 * Refresh the vendored `three/engine-core.jsx` from the engine3d repo.
 *
 * The engine lives in its own repository — it is not PlayerZero-specific and has
 * no dependency on anything here. What PlayerZero needs is the *emitted* skill:
 * one self-contained ES module whose only import is `three`, because a generated
 * game runs in a sandboxed iframe and cannot import a package at all.
 *
 * That artifact is committed here rather than fetched at build time, and that is
 * deliberate. This repo must build without the engine checkout present, on CI and
 * on a laptop that has never cloned it, and a generated game must be reproducible
 * from this repo alone. The cost is that the copy can go stale, so
 * `engine-core.test.ts` pins what the artifact must contain and this script is
 * how you refresh it.
 *
 *   node scripts/sync-engine-skill.mjs                 # ../../../engine3d
 *   node scripts/sync-engine-skill.mjs --engine=<path>
 *   ENGINE3D_REPO=<path> node scripts/sync-engine-skill.mjs
 *
 * It runs the engine's own emitter rather than copying its checked-in artifact,
 * so a stale artifact in the engine repo cannot quietly become a stale artifact
 * here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const SKILL_PATH = join(PACKAGE_ROOT, 'src', 'game-skills', 'three', 'engine-core.jsx');

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

  const before = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, 'utf8') : null;

  // Emit straight into this repo. The engine's emitter is the single source of
  // truth for how the artifact is built; nothing here reimplements it.
  execFileSync(process.execPath, [emitter, `--out=${SKILL_PATH}`], { stdio: 'inherit' });

  const after = readFileSync(SKILL_PATH, 'utf8');
  if (before === after) {
    console.log('sync-engine-skill: already up to date');
    return;
  }

  // Rewrite is a no-op unless the emitter changed line endings; keeping the file
  // byte-stable avoids a diff that is nothing but CRLF churn.
  writeFileSync(SKILL_PATH, after);
  const delta = before === null ? 'created' : `updated (${before.length} -> ${after.length} bytes)`;
  console.log(`sync-engine-skill: ${delta}`);
}

main();
