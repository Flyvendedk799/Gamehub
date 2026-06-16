/**
 * Control-plane API (Fastify). Phase 0 scope: health + authenticated projects
 * CRUD + generation enqueue + SSE event relay.
 *
 * buildServer() takes all dependencies so the entire surface is testable via
 * fastify.inject() without Postgres, Clerk, Redis, or a real worker.
 *
 * SSE relay (GET /v1/runs/:id/stream):
 *   The handler subscribes to `run:{id}` on the bus. InMemoryEventBus replays
 *   history synchronously before going live, which means inject() tests work
 *   without timing gymnastics — pre-publish events (including the terminal
 *   `run_complete`) to the bus, then inject the SSE route; replay fires
 *   synchronously, the handler ends the response, inject() returns the full body.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { EventBus } from '@playforge/bus';
import { runChannel } from '@playforge/bus';
import { buildGameHtml, type ExportGameHtmlOptions } from '@playforge/exporters';
import { exportGameZip } from '@playforge/exporters/game-zip';
import { type SnapshotStore, contentTypeFor } from '@playforge/storage';
import type { Authenticator, AuthedUser } from './auth';
import { generateSessionToken, hashPassword, sessionExpiresAt, verifyPassword } from './auth';
import { eq as drizzleEq, or as drizzleOr, sql as drizzleSql } from 'drizzle-orm';
import type { BrowserJobQueue, RuntimeVerifyResult, ThumbnailResult } from './browser-queue';
import type { ChatRepo } from './chat-repo';
import type { HubRepo } from './hub-repo';
import type { PublishRepo } from './publish-repo';
import type { Engine, ProjectRepo, Visibility } from './repo';
import type { Run, RunRepo } from './run-repo';
import type { SnapshotRepo } from './snapshot-repo';

/**
 * autoMod — lightweight keyword/pattern classifier for published game content.
 * Returns a list of flag labels when the content matches; empty array means clean.
 * Matched content is logged and recorded as a moderation report, but stays 'live'
 * by default. Escalate to 'pending_review' setStatus when abuse rates warrant a gate.
 */
function autoMod(title: string, html: string): string[] {
  const flags: string[] = [];
  const combined = `${title} ${html}`.toLowerCase();

  // Phishing / social-engineering patterns
  if (/\b(enter your password|your account has been|verify your identity|click here to claim)\b/.test(combined)) {
    flags.push('phishing_language');
  }
  // Exfil attempt — tries to load external scripts or phone home despite CSP
  if (/\bfetch\s*\(\s*['"]https?:\/\/(?!cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.skypack\.dev)/.test(html)) {
    flags.push('external_fetch');
  }
  // Crypto miners
  if (/\b(coinhive|cryptonight|monero|xmrig|wasm.*miner)\b/.test(combined)) {
    flags.push('crypto_miner');
  }
  // Iframe injection of 3rd-party origins
  if (/<iframe[^>]+src\s*=\s*['"]https?:\/\/(?!localhost)/.test(html)) {
    flags.push('external_iframe');
  }

  return flags;
}

/** Minimal payload the API passes to the generation queue. */
export type EnqueueFn = (input: {
  runId: string;
  projectId: string;
  userId: string;
  prompt: string;
  /** Manifest key of the project's current snapshot — seeds the new generation with existing files. */
  parentManifestKey?: string;
  /** Hard token ceiling for this run — worker aborts if exceeded. */
  maxTokens?: number;
  /** Continuation state from a previously paused run. */
  continuation?: unknown;
  /**
   * When true, the working tree is seeded from a remixed project. The worker
   * will prepend an untrusted-content safety header to the effective prompt.
   */
  isRemix?: boolean;
}) => Promise<void>;

export interface ServerDeps {
  repo: ProjectRepo;
  auth: Authenticator;
  bus: EventBus;
  runRepo: RunRepo;
  enqueue: EnqueueFn;
  /** Optional: enables GET /v1/runs/:id/preview/* to serve generated game files. */
  store?: SnapshotStore;
  /** Optional: persists chat history (user prompts + artifact notifications). */
  chatRepo?: ChatRepo;
  /** Optional: enables publish + play routes. */
  publishRepo?: PublishRepo;
  /** Optional: enables community hub routes. */
  hubRepo?: HubRepo;
  /** Optional: max concurrent runs per user (default 1 free / 3 pro — enforced if set). */
  maxConcurrentRunsPerUser?: number;
  /** Optional: admin token for moderation endpoints. */
  adminToken?: string;
  /** Optional: async function to embed text for pgvector Hub search. */
  embedText?: (text: string) => Promise<number[]>;
  /** Optional: browser-worker queue for thumbnail capture + runtime verification. */
  browserQueue?: BrowserJobQueue;
  /**
   * Optional: space-separated list of origins allowed to embed published games in iframes.
   * Defaults to '*' when not set. Set to your app origin(s) in production.
   * Example: "https://playforge.app https://staging.playforge.app"
   */
  allowedFrameOrigins?: string;
  /** Optional: BullMQ Queue instance used to report queue depth for autoscaling. */
  generateQueue?: import('bullmq').Queue;
  /** Optional: max tokens per run — hard ceiling to prevent runaway generation costs. */
  maxRunTokens?: number;
  /** Optional: enables GET /v1/projects/:id/snapshots + revert endpoint. */
  snapshotRepo?: SnapshotRepo;
  /** Optional: enables /v1/auth/* routes (register, login, logout, me). */
  authDb?: import('@playforge/db').Db;
}

const ENGINES: Engine[] = ['three', 'phaser'];
const VISIBILITIES: Visibility[] = ['private', 'unlisted', 'public'];

/** Per-project WebSocket presence: projectId → Set of connected socket send functions. */
const presenceSockets = new Map<string, Set<(msg: string) => void>>();

/** Per-project CRDT collab rooms: projectId → Set of raw WebSocket objects for binary relay. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collabRooms = new Map<string, Set<any>>();

const FREE_TIER_CREDITS = 100;
const CREDITS_PER_RUN = 10;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(websocketPlugin);

  // ── Auth rate limiting (in-memory, per-server-instance) ──────────────────
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  const AUTH_WINDOW_MS = 15 * 60 * 1000;
  const AUTH_MAX_ATTEMPTS = 10;

  function checkAuthRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = authAttempts.get(key);
    if (!entry || entry.resetAt < now) {
      authAttempts.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
      return true;
    }
    if (entry.count >= AUTH_MAX_ATTEMPTS) return false;
    entry.count++;
    return true;
  }

  function clearAuthRateLimit(key: string): void {
    authAttempts.delete(key);
  }

  async function getUserBalance(userId: string): Promise<number> {
    if (!deps.authDb) return Infinity;
    const { schema: s } = await import('@playforge/db');
    const [row] = await deps.authDb
      .select({ bal: drizzleSql<number>`COALESCE(SUM(${s.creditLedger.delta}), 0)` })
      .from(s.creditLedger)
      .where(drizzleEq(s.creditLedger.userId, userId));
    return Number(row?.bal ?? 0);
  }

  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
    const q = req.query as Record<string, string | undefined>;
    const hdrs: Record<string, string | string[] | undefined> = { ...req.headers };
    // EventSource cannot set custom headers — support ?token= (Bearer) and ?userId= (dev HeaderAuth).
    const qToken = q['token'];
    if (qToken && !hdrs['authorization']) hdrs['authorization'] = `Bearer ${qToken}`;
    const qUserId = q['userId'];
    if (qUserId && !hdrs['x-user-id']) hdrs['x-user-id'] = qUserId;
    const user = await deps.auth.authenticate(hdrs);
    if (!user) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    return user;
  }

  // ── health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({ ok: true, service: 'playforge-api' }));

  // ── auth ──────────────────────────────────────────────────────────────────
  // POST /v1/auth/register  — create account, return session token
  // POST /v1/auth/login     — validate credentials, return session token
  // POST /v1/auth/logout    — delete current session
  // GET  /v1/auth/me        — return current user (requires auth)

  app.post('/v1/auth/register', async (req, reply) => {
    if (!deps.authDb) return reply.code(503).send({ error: 'auth_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; handle?: unknown; displayName?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === 'string' ? body.password : null;
    const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : null;
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : handle;

    if (!email || !email.includes('@')) return reply.code(400).send({ error: 'invalid_email' });
    if (!password || password.length < 8) return reply.code(400).send({ error: 'password_too_short', min: 8 });
    if (!handle || handle.length < 2) return reply.code(400).send({ error: 'invalid_handle' });

    // Rate-limit registrations per IP to prevent bulk account creation.
    if (!checkAuthRateLimit(`register:${req.ip ?? 'unknown'}`)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

    // Check uniqueness
    const existing = await deps.authDb.select({ id: s.users.id })
      .from(s.users)
      .where(drizzleOr(drizzleEq(s.users.email, email), drizzleEq(s.users.handle, handle)))
      .catch(() => []);
    if (existing.length > 0) return reply.code(409).send({ error: 'email_or_handle_taken' });

    const passwordHash = await hashPassword(password);
    const [user] = await deps.authDb.insert(s.users)
      .values({ email, passwordHash, handle, displayName: displayName ?? handle })
      .returning({ id: s.users.id, handle: s.users.handle, displayName: s.users.displayName });
    if (!user) return reply.code(500).send({ error: 'registration_failed' });

    const token = generateSessionToken();
    await deps.authDb.insert(s.sessions).values({ token, userId: user.id, expiresAt: sessionExpiresAt() });

    // Grant free tier credits — non-blocking, don't fail registration on credit error.
    void deps.authDb.insert(s.creditLedger)
      .values({ userId: user.id, delta: FREE_TIER_CREDITS, reason: 'welcome_grant' })
      .catch((err: unknown) => { console.error('[register] credit grant failed:', err); });

    return reply.code(201).send({ token, user: { id: user.id, handle: user.handle, displayName: user.displayName } });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    if (!deps.authDb) return reply.code(503).send({ error: 'auth_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === 'string' ? body.password : null;
    if (!email || !password) return reply.code(400).send({ error: 'email_and_password_required' });

    // Rate-limit login attempts per email to prevent brute-force.
    if (!checkAuthRateLimit(`login:${email}`)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

    const [user] = await deps.authDb.select({
      id: s.users.id, handle: s.users.handle, displayName: s.users.displayName, passwordHash: s.users.passwordHash,
    }).from(s.users).where(drizzleEq(s.users.email, email));

    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      if (!user) await hashPassword(password).catch(() => {});
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = generateSessionToken();
    await deps.authDb.insert(s.sessions).values({ token, userId: user.id, expiresAt: sessionExpiresAt() });

    clearAuthRateLimit(`login:${email}`);

    return reply.send({ token, user: { id: user.id, handle: user.handle, displayName: user.displayName } });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    if (!deps.authDb) return reply.code(503).send({ error: 'auth_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const authHeader = req.headers['authorization'];
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : null;
    if (token) {
      await deps.authDb.delete(s.sessions).where(drizzleEq(s.sessions.token, token)).catch(() => {});
    }
    return reply.send({ ok: true });
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const balance = await getUserBalance(user.userId);
    return reply.send({ userId: user.userId, handle: user.handle, ...(balance !== Infinity ? { balance } : {}) });
  });

  // ── projects CRUD ─────────────────────────────────────────────────────────

  app.post('/v1/projects', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as {
      name?: unknown;
      engine?: unknown;
      visibility?: unknown;
      remixOfProjectId?: unknown;
    };
    if (body.engine !== undefined && !ENGINES.includes(body.engine as Engine)) {
      return reply.code(400).send({ error: 'invalid_engine', allowed: ENGINES });
    }
    if (body.visibility !== undefined && !VISIBILITIES.includes(body.visibility as Visibility)) {
      return reply.code(400).send({ error: 'invalid_visibility', allowed: VISIBILITIES });
    }
    const project = await deps.repo.create({
      ownerId: user.userId,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(body.engine !== undefined ? { engine: body.engine as Engine } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility as Visibility } : {}),
      ...(typeof body.remixOfProjectId === 'string'
        ? { remixOfProjectId: body.remixOfProjectId }
        : {}),
    });
    return reply.code(201).send(project);
  });

  app.get('/v1/projects', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return reply.send({ projects: await deps.repo.listByOwner(user.userId) });
  });

  app.get('/v1/projects/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    if (project.ownerId !== user.userId && project.visibility === 'private') {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send(project);
  });

  app.patch('/v1/projects/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.code(400).send({ error: 'name_required' });
    }
    const updated = await deps.repo.rename(id, user.userId, body.name);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return reply.send(updated);
  });

  app.delete('/v1/projects/:id', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const ok = await deps.repo.softDelete(id, user.userId);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // ── generation enqueue ────────────────────────────────────────────────────

  app.post('/v1/projects/:id/generate', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const body = (req.body ?? {}) as { prompt?: unknown };
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      return reply.code(400).send({ error: 'prompt_required' });
    }
    // Concurrent run cap — reject if the user already has too many active runs.
    if (deps.maxConcurrentRunsPerUser !== undefined) {
      const active = await deps.runRepo.countActiveByUser(user.userId);
      if (active >= deps.maxConcurrentRunsPerUser) {
        return reply.code(429).send({ error: 'concurrent_run_limit', active, limit: deps.maxConcurrentRunsPerUser });
      }
    }

    // Credit pre-check — reject if balance is too low to cover one run.
    if (deps.authDb) {
      const balance = await getUserBalance(user.userId);
      if (balance < CREDITS_PER_RUN) {
        return reply.code(402).send({ error: 'insufficient_credits', balance, required: CREDITS_PER_RUN });
      }
    }

    const run = await deps.runRepo.create({ projectId: project.id, userId: user.userId });

    // Persist the user's prompt to chat history so it survives page reloads.
    if (deps.chatRepo) {
      void deps.chatRepo.add(project.id, 'user', { text: body.prompt.trim(), runId: run.id });
    }

    // Check for a paused continuation from a previous run on this project.
    const paused = await deps.runRepo.getPausedContinuation(project.id);

    // Fire-and-forget — the worker publishes events; the browser streams via SSE.
    void deps.enqueue({
      runId: run.id,
      projectId: project.id,
      userId: user.userId,
      prompt: body.prompt.trim(),
      ...(paused?.snapshotManifestKey !== null && paused?.snapshotManifestKey !== undefined
        ? { parentManifestKey: paused.snapshotManifestKey }
        : project.currentManifestKey !== null
          ? { parentManifestKey: project.currentManifestKey }
          : {}),
      ...(paused !== null ? { continuation: paused.continuation } : {}),
      ...(deps.maxRunTokens !== undefined ? { maxTokens: deps.maxRunTokens } : {}),
      // Prompt-injection guard: flag remix projects so the worker prepends the
      // untrusted-content safety header before passing the prompt to the agent.
      ...(project.remixOfProjectId !== null ? { isRemix: true } : {}),
    });
    return reply.code(202).send({ runId: run.id });
  });

  // ── SSE event relay ───────────────────────────────────────────────────────

  app.get('/v1/runs/:id/stream', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const run: Run | null = await deps.runRepo.get(id);
    if (!run || run.userId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Hand off to raw Node response; Fastify must not touch it after this.
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    let done = false;

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (done) return;
        done = true;
        reply.raw.end();
        resolve();
      };

      // `req.raw` is the underlying Node IncomingMessage.
      req.raw.on('close', finish);

      // Subscribe with replay: InMemoryEventBus calls the handler synchronously
      // for all history before resolving, so inject() tests complete without
      // needing to await a separate enqueue step.
      void deps.bus.subscribe(runChannel(id), (message) => {
        if (done) return;
        const m = message as { type?: string };
        const previewUrl = `/v1/runs/${id}/preview/`;
        // Attach the preview URL to run_complete so the browser knows where to load the game.
        const payload =
          m.type === 'run_complete'
            ? { ...m, previewUrl }
            : message;
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (m.type === 'run_complete') {
          // Push a preview_updated notification to all presence sockets for this project
          // so other collaborators' previews auto-reload without polling.
          void deps.runRepo.get(id).then((r) => {
            if (!r) return;
            const msg = JSON.stringify({ type: 'preview_updated', projectId: r.projectId, previewUrl });
            for (const fn of presenceSockets.get(r.projectId) ?? []) fn(msg);
          }).catch(() => {});
          finish();
        }
        if (m.type === 'run_error') {
          finish();
        }
      });
    });
  });

  // ── chat history ──────────────────────────────────────────────────────────

  app.get('/v1/projects/:id/chat', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || (project.ownerId !== user.userId && project.visibility === 'private')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const messages = deps.chatRepo ? await deps.chatRepo.list(id) : [];
    return reply.send({ messages });
  });

  // ── game preview file serving ─────────────────────────────────────────────
  // Serves files from a run's snapshot manifest so the iframe can load the game.
  // Route: GET /v1/runs/:id/preview/           → index.html
  //        GET /v1/runs/:id/preview/assets/...  → asset files
  // No auth required — the run ID acts as an unguessable capability token for
  // Phase 1. Origin isolation + CSP land in Phase 2.

  app.get('/v1/runs/:id/preview/*', async (req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: 'preview_unavailable' });

    const { id } = req.params as { id: string };
    const filePath = ((req.params as Record<string, string>)['*'] || '') || 'index.html';

    const run = await deps.runRepo.get(id);
    if (!run?.snapshotManifestKey) return reply.code(404).send({ error: 'not_found' });

    try {
      const manifest = await deps.store.readManifest(run.snapshotManifestKey);
      const bytes = await deps.store.readFile(manifest, filePath);
      const ct = contentTypeFor(filePath);
      const isHtml = ct.startsWith('text/html');
      return reply
        .header('Content-Type', ct)
        .header('Cache-Control', 'no-cache')
        // Apply game CSP to HTML preview files to match the published play route security model.
        .header('Content-Security-Policy', isHtml
          ? [
              "default-src 'none'",
              "script-src 'unsafe-inline' data: blob:",
              "style-src 'unsafe-inline'",
              "img-src * data: blob:",
              "media-src * data: blob:",
              "font-src data:",
              "worker-src blob:",
              "connect-src 'none'",
              "frame-ancestors *",
            ].join('; ')
          : "default-src 'none'")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .send(Buffer.from(bytes));
    } catch {
      return reply.code(404).send({ error: 'file_not_found', path: filePath });
    }
  });

  // ── publish pipeline ──────────────────────────────────────────────────────
  // POST /v1/projects/:id/publish  — builds a single-file HTML bundle from
  // the project's current snapshot and stores it as a published game.

  app.post('/v1/projects/:id/publish', async (req, reply) => {
    if (!deps.store || !deps.publishRepo) {
      return reply.code(503).send({ error: 'publish_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!project.currentManifestKey) {
      return reply.code(409).send({ error: 'no_snapshot', message: 'Generate a game first.' });
    }

    const engine = (project.engine ?? 'phaser') as 'phaser' | 'three';
    const manifest = await deps.store.readManifest(project.currentManifestKey);

    // Build ZipAsset[] from the manifest — text files as strings, binary as Buffers.
    const TEXT_PREFIXES = ['text/', 'application/json'];
    const files: ExportGameHtmlOptions['files'] = await Promise.all(
      Object.entries(manifest.files).map(async ([path, entry]) => {
        const bytes = await deps.store!.readFile(manifest, path);
        const isText = TEXT_PREFIXES.some((p) => entry.contentType.startsWith(p));
        return {
          path,
          content: isText ? Buffer.from(bytes).toString('utf8') : Buffer.from(bytes),
        };
      }),
    );

    const html = await buildGameHtml({ files, engine });
    const htmlBytes = Buffer.from(html, 'utf8');
    const bundleKey = await deps.store.putBlob(htmlBytes);

    const publishedGame = await deps.publishRepo.upsert({
      projectId: project.id,
      publishSlug: project.slug,
      title: project.name,
      bundleKey,
    });

    // Auto-moderation: scan title + bundle for flagged patterns.
    const autoModFlags = autoMod(project.name, html);
    if (autoModFlags.length > 0) {
      console.warn(`[publish:automod] game ${publishedGame.publishSlug} flagged: ${autoModFlags.join(', ')}`);
      void deps.hubRepo?.addReport({
        targetType: 'published_game',
        targetId: publishedGame.id,
        reason: `auto-mod: ${autoModFlags.join(', ')}`,
      }).catch(() => {});
    }

    // Smoke-test gate (blocking): verify the game boots in a headless browser
    // before marking it live. If the game fails to boot, mark it unpublished and
    // return a 422 so the user knows to fix the generation.
    if (deps.browserQueue) {
      try {
        const verifyJobId = await deps.browserQueue.enqueueRuntimeVerify(html);
        const verifyResult = await deps.browserQueue.waitForResult<RuntimeVerifyResult>(verifyJobId, 15_000);
        if (verifyResult && !verifyResult.hasGameContract) {
          await deps.publishRepo.setStatus(publishedGame.id, 'unpublished');
          return reply.code(422).send({
            error: 'smoke_test_failed',
            message: 'The game did not boot correctly in our verification environment.',
            fatalErrors: verifyResult.fatalErrors,
          });
        }
        if (verifyResult?.fatalErrors.length) {
          console.warn(`[publish:smoke] ${publishedGame.publishSlug} has fatal errors:`, verifyResult.fatalErrors);
        }
      } catch (err) {
        // Smoke-test infrastructure error — don't block publish, just log.
        console.warn(`[publish:smoke] verification skipped for ${publishedGame.publishSlug}:`, err);
      }
    }

    // Async: thumbnail capture via browser-worker (best-effort, non-blocking).
    if (deps.browserQueue) {
      void (async () => {
        try {
          const jobId = await deps.browserQueue!.enqueueThumbnail(html);
          const result = await deps.browserQueue!.waitForResult<ThumbnailResult>(jobId, 20_000);
          if (result?.pngBase64 && deps.store) {
            const pngBytes = Buffer.from(result.pngBase64, 'base64');
            const thumbKey = await deps.store.putBlob(pngBytes);
            await deps.publishRepo?.setThumbnailUrl(publishedGame.id, `/v1/blobs/${thumbKey}`);
            console.log(`[publish] thumbnail captured for ${publishedGame.publishSlug} → ${thumbKey}`);
          }
        } catch (err) {
          console.warn(`[publish] thumbnail failed for ${publishedGame.publishSlug}:`, err);
        }
      })();
    }

    // Async: index embedding for Hub semantic search (best-effort, non-blocking).
    if (deps.embedText && deps.hubRepo) {
      const textToEmbed = `${project.name}`;
      void deps.embedText(textToEmbed)
        .then((embedding) => deps.hubRepo!.setEmbedding(publishedGame.id, embedding))
        .catch(() => {});
    }

    return reply.code(200).send({
      slug: publishedGame.publishSlug,
      publishUrl: `/v1/play/${publishedGame.publishSlug}`,
    });
  });

  // GET /v1/projects/:id/export.zip — download project as a ZIP bundle.

  app.get('/v1/projects/:id/export.zip', async (req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: 'export_unavailable' });
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!project.currentManifestKey) {
      return reply.code(409).send({ error: 'no_snapshot', message: 'Generate a game first.' });
    }
    const manifest = await deps.store.readManifest(project.currentManifestKey);
    const TEXT_PREFIXES = ['text/', 'application/json'];
    const files = await Promise.all(
      Object.entries(manifest.files).map(async ([path, entry]) => {
        const bytes = await deps.store!.readFile(manifest, path);
        const isText = TEXT_PREFIXES.some((p) => entry.contentType.startsWith(p));
        return { path, content: isText ? Buffer.from(bytes).toString('utf8') : Buffer.from(bytes) };
      }),
    );
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readFile, rm } = await import('node:fs/promises');
    const dest = join(tmpdir(), `playforge-export-${id}-${Date.now()}.zip`);
    try {
      await exportGameZip(dest, {
        files,
        designName: project.name,
        engine: (project.engine as 'three' | 'phaser') ?? 'phaser',
      });
      const zipBytes = await readFile(dest);
      const safeName = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || 'game';
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${safeName}.zip"`)
        .header('Content-Length', String(zipBytes.length))
        .send(zipBytes);
    } finally {
      void rm(dest, { force: true }).catch(() => {});
    }
  });

  // GET /v1/projects/:id/publish-info — returns the current published state.

  app.get('/v1/projects/:id/publish-info', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const published = deps.publishRepo ? await deps.publishRepo.getByProject(id) : null;
    return reply.send({ published });
  });

  // ── public play endpoint ──────────────────────────────────────────────────
  // GET /v1/play/:slug  — serves the published single-file HTML bundle with
  // CSP headers that sandbox the game from the app origin.
  // No auth required — run ID is the capability token; slug is public.

  app.get('/v1/play/:slug', async (req, reply) => {
    if (!deps.store || !deps.publishRepo) {
      return reply.code(503).send({ error: 'play_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Fire-and-forget play count increment.
    void deps.hubRepo?.incrementPlayCount(published.id);

    let html: string;
    try {
      const bytes = await deps.store.getBlob(published.bundleKey);
      html = Buffer.from(bytes).toString('utf8');
    } catch {
      return reply.code(404).send({ error: 'bundle_not_found' });
    }

    // CSP for self-contained game bundles (engine + assets inlined as data URLs):
    // • script-src 'unsafe-inline' data: blob: — single-file bundles embed scripts inline
    //   and may use data:/blob: src; 'unsafe-eval' is intentionally absent
    // • connect-src 'none' — block all outbound network from game code (anti-exfil)
    // • frame-ancestors — restrict to configured app origins (default '*' for local dev)
    const frameAncestors = deps.allowedFrameOrigins ?? '*';
    const csp = [
      "default-src 'none'",
      "script-src 'unsafe-inline' data: blob:",
      "style-src 'unsafe-inline'",
      "img-src * data: blob:",
      "media-src * data: blob:",
      "font-src data:",
      "worker-src blob:",
      "connect-src 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; ');

    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', csp)
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', frameAncestors === '*' ? 'ALLOWALL' : 'SAMEORIGIN')
      .header('Referrer-Policy', 'no-referrer')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(html);
  });

  // ── blob serving ─────────────────────────────────────────────────────────
  // GET /v1/blobs/:key — serve a content-addressed blob (thumbnails, etc.)
  // The key is the SHA-256 hash of the blob bytes. No auth — keys are unguessable.

  app.get('/v1/blobs/:key', async (req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: 'store_unavailable' });
    const { key } = req.params as { key: string };
    // Reject keys that look path-traversal-y.
    if (!/^[a-f0-9]{16,}$/.test(key)) {
      return reply.code(400).send({ error: 'invalid_key' });
    }
    try {
      const bytes = await deps.store.getBlob(key);
      // Sniff PNG/JPEG/WebP/GIF magic bytes for content-type.
      const buf = Buffer.from(bytes);
      let ct = 'application/octet-stream';
      if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) ct = 'image/jpeg';
      else if (buf.slice(0, 4).toString() === 'RIFF') ct = 'image/webp';
      else if (buf.slice(0, 6).toString() === 'GIF87a' || buf.slice(0, 6).toString() === 'GIF89a') ct = 'image/gif';
      return reply
        .header('Content-Type', ct)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .send(buf);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // ── ZIP download ──────────────────────────────────────────────────────────
  // GET /v1/projects/:id/game.zip  — downloads the current snapshot as a ZIP.

  app.get('/v1/projects/:id/game.zip', async (req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: 'download_unavailable' });
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!project.currentManifestKey) {
      return reply.code(409).send({ error: 'no_snapshot', message: 'Generate a game first.' });
    }

    const manifest = await deps.store.readManifest(project.currentManifestKey);
    const files = await Promise.all(
      Object.entries(manifest.files).map(async ([path, entry]) => {
        const bytes = await deps.store!.readFile(manifest, path);
        const TEXT_PREFIXES = ['text/', 'application/json'];
        const isText = TEXT_PREFIXES.some((p) => entry.contentType.startsWith(p));
        return {
          path,
          content: isText ? Buffer.from(bytes).toString('utf8') : Buffer.from(bytes),
        };
      }),
    );

    const { exportGameArtifact } = await import('@playforge/exporters');
    const tmpPath = join(tmpdir(), `playforge-${randomUUID()}.zip`);
    try {
      await exportGameArtifact('game-zip', tmpPath, {
        files,
        designName: project.name,
        engine: (project.engine ?? 'phaser') as 'phaser' | 'three',
      });
      const { readFile } = await import('node:fs/promises');
      const zipBytes = await readFile(tmpPath);
      const safeName = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'game';
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${safeName}.zip"`)
        .send(zipBytes);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  });

  // ── version timeline ──────────────────────────────────────────────────────
  // GET  /v1/projects/:id/snapshots         — list all snapshots (auth)
  // POST /v1/projects/:id/snapshots/:sid/revert — revert HEAD to snapshot (auth)

  app.get('/v1/projects/:id/snapshots', async (req, reply) => {
    if (!deps.snapshotRepo) return reply.code(503).send({ error: 'snapshots_unavailable' });
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const snapshots = await deps.snapshotRepo.listByProject(id);
    return reply.send({ snapshots });
  });

  app.post('/v1/projects/:id/snapshots/:sid/revert', async (req, reply) => {
    if (!deps.snapshotRepo) return reply.code(503).send({ error: 'snapshots_unavailable' });
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id, sid } = req.params as { id: string; sid: string };
    const project = await deps.repo.get(id);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const snapshot = await deps.snapshotRepo.getById(sid);
    if (!snapshot || snapshot.projectId !== id) {
      return reply.code(404).send({ error: 'snapshot_not_found' });
    }
    await deps.repo.setCurrentSnapshot(id, snapshot.id, snapshot.filesManifestKey);
    return reply.send({ ok: true, manifestKey: snapshot.filesManifestKey, snapshotId: snapshot.id });
  });

  // ── community hub ─────────────────────────────────────────────────────────
  // GET /v1/hub                       — discovery feed (no auth)
  // GET /v1/hub/games/:slug           — game metadata (no auth)
  // POST /v1/hub/games/:slug/like     — toggle like (auth required)
  // POST /v1/hub/games/:slug/rate     — set rating (auth required)
  // GET /v1/hub/games/:slug/comments  — list comments (no auth)
  // POST /v1/hub/games/:slug/comments — add comment (auth required)
  // POST /v1/hub/games/:slug/remix    — fork into requester's project (auth required)
  // POST /v1/hub/games/:slug/report   — report (auth optional)

  // ── Creator profiles ─────────────────────────────────────────────────────

  app.get('/v1/users/:handle', async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const projects = await deps.repo.listByOwner(handle);
    const publicProjects = projects.filter((p) => p.visibility === 'public');
    return reply.send({
      handle,
      projectCount: publicProjects.length,
      projects: publicProjects.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        engine: p.engine,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
  });

  app.get('/v1/users/:handle/games', async (req, reply) => {
    if (!deps.publishRepo) return reply.code(503).send({ error: 'publish_unavailable' });
    const { handle } = req.params as { handle: string };
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q['limit'] ?? '20'), 50);
    const offset = Number(q['offset'] ?? '0');
    const games = await deps.publishRepo.listByOwner(handle, { limit, offset });
    return reply.send({ handle, games });
  });

  // ── Hub ───────────────────────────────────────────────────────────────────

  app.get('/v1/hub', async (req, reply) => {
    if (!deps.hubRepo) return reply.code(503).send({ error: 'hub_unavailable' });
    const q = req.query as Record<string, string | undefined>;
    const sort = q['sort'] === 'popular' ? 'popular' : 'recent';
    const limit = Math.min(Math.max(Number(q['limit'] ?? '20'), 1), 100);
    const offset = Math.max(Number(q['offset'] ?? '0'), 0);
    const games = await deps.hubRepo.feed({ limit, offset, sort });
    return reply.send({ games });
  });

  app.get('/v1/hub/games/:slug', async (req, reply) => {
    if (!deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send({ game: published });
  });

  app.post('/v1/hub/games/:slug/like', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const liked = await deps.hubRepo.toggleLike(user.userId, published.id);
    return reply.send({ liked });
  });

  app.post('/v1/hub/games/:slug/rate', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const body = (req.body ?? {}) as { stars?: unknown };
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return reply.code(400).send({ error: 'invalid_stars', message: 'stars must be an integer 1–5' });
    }
    const result = await deps.hubRepo.setRating(user.userId, published.id, stars);
    return reply.send(result);
  });

  app.get('/v1/hub/games/:slug/comments', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const comments = await deps.hubRepo.listComments(published.id);
    return reply.send({ comments });
  });

  app.post('/v1/hub/games/:slug/comments', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const body = (req.body ?? {}) as { body?: unknown; parentCommentId?: unknown };
    if (typeof body.body !== 'string' || body.body.trim() === '') {
      return reply.code(400).send({ error: 'body_required' });
    }
    const parentCommentId =
      typeof body.parentCommentId === 'string' ? body.parentCommentId : undefined;
    const comment = await deps.hubRepo.addComment(
      published.id,
      user.userId,
      body.body.trim(),
      parentCommentId,
    );
    return reply.code(201).send({ comment });
  });

  app.post('/v1/hub/games/:slug/remix', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const sourceProject = await deps.repo.get(published.projectId);
    if (!sourceProject) {
      return reply.code(404).send({ error: 'source_project_not_found' });
    }
    const newProject = await deps.repo.create({
      ownerId: user.userId,
      name: `Remix of ${published.title}`,
      ...(sourceProject.engine !== null ? { engine: sourceProject.engine } : {}),
      remixOfProjectId: published.projectId,
    });
    if (sourceProject.currentManifestKey !== null) {
      await deps.repo.setCurrentManifestKey(newProject.id, sourceProject.currentManifestKey);
    }
    return reply.code(201).send({ projectId: newProject.id });
  });

  app.post('/v1/hub/games/:slug/report', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Auth is optional for reports — try to get the user but don't block.
    const qUserId = (req.query as Record<string, string | undefined>)['userId'];
    const headers = qUserId
      ? { ...req.headers, 'x-user-id': qUserId }
      : req.headers;
    const user = await deps.auth.authenticate(headers);

    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    await deps.hubRepo.addReport({
      targetType: 'published_game',
      targetId: published.id,
      ...(user !== null ? { reporterId: user.userId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    return reply.code(202).send({ ok: true });
  });

  // ── Hub search ────────────────────────────────────────────────────────────

  app.get('/v1/hub/search', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { q, limit: limitStr } = req.query as Record<string, string | undefined>;
    if (!q || q.trim() === '') {
      return reply.code(400).send({ error: 'q_required' });
    }
    const limit = Math.min(Number(limitStr ?? '20'), 50);
    let embedding: number[] | undefined;
    if (deps.embedText) {
      try {
        embedding = await deps.embedText(q.trim());
      } catch {
        // Fall through to text search if embedding fails.
      }
    }
    const results = await deps.hubRepo.search({
      query: q.trim(),
      limit,
      ...(embedding !== undefined ? { embedding } : {}),
    });
    return reply.send({ results });
  });

  // ── WebSocket co-presence ─────────────────────────────────────────────────

  app.get('/v1/projects/:id/presence', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    let sockets = presenceSockets.get(id);
    if (!sockets) {
      sockets = new Set();
      presenceSockets.set(id, sockets);
    }

    const send = (msg: string) => {
      try { socket.send(msg); } catch { /* disconnected */ }
    };
    sockets.add(send);

    const broadcast = () => {
      const count = presenceSockets.get(id)?.size ?? 0;
      const msg = JSON.stringify({ type: 'presence', projectId: id, count });
      for (const fn of presenceSockets.get(id) ?? []) fn(msg);
    };

    broadcast();

    socket.on('close', () => {
      presenceSockets.get(id)?.delete(send);
      if (presenceSockets.get(id)?.size === 0) presenceSockets.delete(id);
      broadcast();
    });
  });

  // ── CRDT collab relay — GET /v1/projects/:id/collab (WebSocket) ───────────
  // Pure binary relay: every message from peer A is forwarded to all other peers
  // in the same project room. Clients run yjs + WebsocketProvider pointed here.
  // No server-side Y.Doc; late-joiners get state from existing peers via the
  // standard y-websocket sync step1/step2 protocol, which clients handle natively.
  app.get('/v1/projects/:id/collab', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };

    let room = collabRooms.get(id);
    if (!room) {
      room = new Set();
      collabRooms.set(id, room);
    }
    room.add(socket);

    socket.on('message', (data: Buffer | ArrayBuffer) => {
      const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      for (const peer of collabRooms.get(id) ?? []) {
        if (peer !== socket && (peer.readyState as number) === 1 /* OPEN */) {
          try { (peer as { send(d: Buffer): void }).send(buf); } catch { /* disconnected */ }
        }
      }
    });

    socket.on('close', () => {
      collabRooms.get(id)?.delete(socket);
      if (collabRooms.get(id)?.size === 0) collabRooms.delete(id);
    });
  });

  // ── admin metrics (autoscaling signal) ────────────────────────────────────

  app.get('/v1/admin/metrics', async (req, reply) => {
    if (deps.adminToken) {
      const provided = req.headers['x-admin-token'];
      const token = Array.isArray(provided) ? provided[0] : provided;
      if (token !== deps.adminToken) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    const presence: Record<string, number> = {};
    for (const [projectId, sockets] of presenceSockets) {
      presence[projectId] = sockets.size;
    }
    const [runStats, hubStats] = await Promise.all([
      deps.runRepo.getStats(),
      deps.hubRepo?.getStats?.() ?? Promise.resolve(null),
    ]);

    let queue: { waiting: number; active: number; delayed: number; failed: number } | null = null;
    if (deps.generateQueue) {
      const [waiting, active, delayed, failed] = await Promise.all([
        deps.generateQueue.getWaitingCount(),
        deps.generateQueue.getActiveCount(),
        deps.generateQueue.getDelayedCount(),
        deps.generateQueue.getFailedCount(),
      ]);
      queue = { waiting, active, delayed, failed };
    }

    return reply.send({
      runs: runStats,
      hub: hubStats,
      queue,
      presence,
      presenceProjects: presenceSockets.size,
      connectedSockets: [...presenceSockets.values()].reduce((n, s) => n + s.size, 0),
    });
  });

  // GET /v1/admin/queue-depth — lightweight autoscaling probe (no auth needed for HPA scrapers).
  // Returns the number of waiting + active jobs so KEDA or Fly.io autoscaling can read it.
  app.get('/v1/admin/queue-depth', async (_req, reply) => {
    if (!deps.generateQueue) {
      return reply.send({ waiting: 0, active: 0, depth: 0 });
    }
    const [waiting, active] = await Promise.all([
      deps.generateQueue.getWaitingCount(),
      deps.generateQueue.getActiveCount(),
    ]);
    return reply.send({ waiting, active, depth: waiting + active });
  });

  // ── moderation (admin) ────────────────────────────────────────────────────

  app.post('/v1/admin/games/:slug/moderate', async (req, reply) => {
    if (!deps.publishRepo) {
      return reply.code(503).send({ error: 'publish_unavailable' });
    }
    // Require admin token when configured.
    if (deps.adminToken) {
      const provided = req.headers['x-admin-token'];
      const token = Array.isArray(provided) ? provided[0] : provided;
      if (token !== deps.adminToken) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const VALID_STATUSES = ['live', 'unpublished', 'removed_by_mod'] as const;
    type Status = typeof VALID_STATUSES[number];
    const body = (req.body ?? {}) as { status?: unknown };
    if (!VALID_STATUSES.includes(body.status as Status)) {
      return reply.code(400).send({ error: 'invalid_status', valid: VALID_STATUSES });
    }
    await deps.publishRepo.setStatus(published.id, body.status as Status);
    return reply.code(200).send({ ok: true, slug, status: body.status });
  });

  return app;
}
