/**
 * gameplan §7.1 — Game engine adapter registry.
 *
 * Each engine implements `GameEngineAdapter`. The registry is exported as a
 * frozen Map so callers (the `validate_game_scene` tool, the New-design
 * dialog, the game-html exporter) dispatch on `engine` without per-engine
 * if-trees scattered through the agent layer.
 *
 * The only supported engines are the two web engines, `three` and `phaser`.
 * Both run instantly in a sandboxed iframe with CDN-pinned bootstraps and a
 * `window.__game` postMessage bridge.
 */

import { phaserAdapter } from './phaser';
import { threeAdapter } from './three';
import type { GameEngineAdapter, GameEngineId } from './types';

export type { GameEngineAdapter, GameEngineId, ValidationIssue, ValidationResult } from './types';

/** Adapters registered for the current ship. The `Record` key type is
 *  exhaustive over `GameEngineId`, so the registry must cover every engine
 *  in the union (three + phaser) — adding/removing an engine surfaces here
 *  as a type error if the map drifts out of sync. */
const ADAPTERS: Record<GameEngineId, GameEngineAdapter> = {
  three: threeAdapter,
  phaser: phaserAdapter,
};

export const GAME_ENGINE_ADAPTERS: ReadonlyMap<GameEngineId, GameEngineAdapter> = new Map(
  Object.entries(ADAPTERS) as Array<[GameEngineId, GameEngineAdapter]>,
);

/** Look up the adapter for an engine id. Always non-null today since every
 *  member of the `GameEngineId` union is registered; the nullable return is
 *  kept so callers stay defensive against future narrowing. */
export function getEngineAdapter(id: GameEngineId): GameEngineAdapter | null {
  return GAME_ENGINE_ADAPTERS.get(id) ?? null;
}

/** Convenience for the New-design dialog and prompts: list engines that can
 *  preview live in the iframe today → ['three', 'phaser']. */
export function listLivePreviewEngines(): readonly GameEngineId[] {
  const out: GameEngineId[] = [];
  for (const [id, adapter] of GAME_ENGINE_ADAPTERS) {
    if (adapter.supportsLivePreview()) out.push(id);
  }
  return out;
}
