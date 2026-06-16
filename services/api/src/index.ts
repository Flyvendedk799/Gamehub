/** @playforge/api — control-plane API.
 *
 * Phase 0: health + authenticated projects CRUD (buildServer). Next: generation
 * enqueue (BullMQ) + SSE relay over Redis pub/sub, and a Drizzle-backed repo. */
export { buildServer, type ServerDeps } from './server';
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
