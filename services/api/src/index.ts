/** @playforge/api — control-plane API.
 *
 * Phase 0: health + projects CRUD + generation enqueue + SSE relay.
 * In-process generation + InMemoryEventBus for the live red-square E2E;
 * BullMQ + RedisEventBus swap in at Phase 1. */
export { buildServer, type ServerDeps, type EnqueueFn } from './server';
export {
  type Authenticator,
  type AuthedUser,
  HeaderAuthenticator,
} from './auth';
export {
  type Project,
  type ProjectRepo,
  type CreateProjectInput,
  type Engine,
  type Visibility,
  InMemoryProjectRepo,
} from './repo';
export { type Run, type RunRepo, InMemoryRunRepo } from './run-repo';
export { DrizzleProjectRepo, DrizzleRunRepo } from './drizzle-repos';
