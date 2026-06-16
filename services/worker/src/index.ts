/** @playforge/worker — the generation worker.
 *
 * Phase 0 scope: the WorkingTree fs adapter (agent ↔ content-addressed storage).
 * Next: the BullMQ consumer that runs `generateViaAgent` with cloud deps
 * injected (fs → WorkingTree, onEvent → Redis pub/sub, gameMode → engine/spec,
 * runtimeVerify/playtester → browser-worker pool) and persists snapshots + runs.
 */
export { WorkingTree, type EditResult } from './working-tree';
export {
  runGeneration,
  type GenerationRequest,
  type GenerationPorts,
  type GenerationResult,
  type GenerateFn,
  type SceneValidator,
  type WebEngine,
} from './run-generation';
