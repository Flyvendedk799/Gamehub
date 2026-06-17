/**
 * may9 Phase 14 — eval framework public surface.
 *
 * The framework is split into:
 *   - fixture.ts   — Zod schema + types
 *   - runner.ts    — pure assertion compute
 *   - report.ts    — markdown serializer
 *   - source-sqlite.ts — designs.db -> RunObservation (lazy-imported by
 *     the CLI to keep this barrel free of better-sqlite3)
 */
export {
  EVAL_FIXTURE_SCHEMA_VERSION,
  EvalAssertion,
  EvalEngine,
  EvalFixture,
} from './fixture.js';
export type { EvalReport, EvalResult } from './fixture.js';
export { evaluateFixture } from './runner.js';
export type { RunObservation, RuntimeVerifyObservation } from './runner.js';
export { renderEvalReport } from './report.js';
export { RECORDING_SCHEMA_VERSION, emptyRecording, parseEvalRecording } from './recording.js';
export type { EvalRecording } from './recording.js';
export {
  PLAYTEST_PREDICATE_OPS,
  evaluatePredicate,
  parsePlaytestPredicate,
  resolvePath,
  scorePlaytest,
} from './playtest-score.js';
export type {
  FrameRef,
  PlaytestFrame,
  PlaytestPredicate,
  PlaytestPredicateOp,
  PlaytestScore,
  PlaytestTrace,
  PredicateResult,
} from './playtest-score.js';
export { PostgresEvalSource, aggregateGenreQuality } from './source-postgres.js';
export type {
  EvalSource,
  GenreQualityAggregate,
  QualityRowSource,
  QualityWindow,
  RunQualityRow,
} from './source-postgres.js';
