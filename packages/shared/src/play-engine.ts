/**
 * S0 — resolve which engine HTML play/publish/export must boot.
 *
 * Prefer the agent-chosen engine persisted on the project after `choose_engine`.
 * Fall back to the snapshot's engine (immutable at ship time). Never invent
 * Phaser for a Three.js game: only default when BOTH are unset (legacy rows).
 */
import type { GameEngineId } from './game-spec.js';

export type PlayEngineId = GameEngineId;

export function resolvePlayEngine(
  projectEngine: PlayEngineId | null | undefined,
  snapshotEngine: PlayEngineId | null | undefined = null,
): PlayEngineId {
  if (projectEngine === 'three' || projectEngine === 'phaser' || projectEngine === 'canvas2d') {
    return projectEngine;
  }
  if (snapshotEngine === 'three' || snapshotEngine === 'phaser' || snapshotEngine === 'canvas2d') {
    return snapshotEngine;
  }
  return 'phaser';
}

/** True when a 3D-ish snapshot would be unplayable under a Phaser bootstrap. */
export function isEngineMismatch(
  declared: PlayEngineId | null | undefined,
  bootstrap: PlayEngineId,
): boolean {
  if (declared === null || declared === undefined) return false;
  return declared !== bootstrap;
}
