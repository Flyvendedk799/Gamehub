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
import type { EventBus } from '@playforge/bus';
import { runChannel } from '@playforge/bus';
import { buildGameHtml, type ExportGameHtmlOptions } from '@playforge/exporters';
import { type SnapshotStore, contentTypeFor } from '@playforge/storage';
import type { Authenticator, AuthedUser } from './auth';
import type { ChatRepo } from './chat-repo';
import type { PublishRepo } from './publish-repo';
import type { Engine, ProjectRepo, Visibility } from './repo';
import type { Run, RunRepo } from './run-repo';

/** Minimal payload the API passes to the generation queue. */
export type EnqueueFn = (input: {
  runId: string;
  projectId: string;
  userId: string;
  prompt: string;
  /** Manifest key of the project's current snapshot — seeds the new generation with existing files. */
  parentManifestKey?: string;
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
}

const ENGINES: Engine[] = ['three', 'phaser'];
const VISIBILITIES: Visibility[] = ['private', 'unlisted', 'public'];

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
    // EventSource cannot set custom headers; fall back to ?userId= query param.
    const qUserId = (req.query as Record<string, string | undefined>)['userId'];
    const headers = qUserId
      ? { ...req.headers, 'x-user-id': qUserId }
      : req.headers;
    const user = await deps.auth.authenticate(headers);
    if (!user) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    return user;
  }

  // ── health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({ ok: true, service: 'playforge-api' }));

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
    const run = await deps.runRepo.create({ projectId: project.id, userId: user.userId });

    // Persist the user's prompt to chat history so it survives page reloads.
    if (deps.chatRepo) {
      void deps.chatRepo.add(project.id, 'user', { text: body.prompt.trim(), runId: run.id });
    }

    // Fire-and-forget — the worker publishes events; the browser streams via SSE.
    // Pass the project's current manifest key so the agent can build on previous files.
    void deps.enqueue({
      runId: run.id,
      projectId: project.id,
      userId: user.userId,
      prompt: body.prompt.trim(),
      ...(project.currentManifestKey !== null
        ? { parentManifestKey: project.currentManifestKey }
        : {}),
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
        // Attach the preview URL to run_complete so the browser knows where to load the game.
        const payload =
          m.type === 'run_complete'
            ? { ...m, previewUrl: `/v1/runs/${id}/preview/` }
            : message;
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (m.type === 'run_complete' || m.type === 'run_error') {
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
      return reply
        .header('Content-Type', contentTypeFor(filePath))
        .header('Cache-Control', 'no-cache')
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

    return reply.code(200).send({
      slug: publishedGame.publishSlug,
      publishUrl: `/v1/play/${publishedGame.publishSlug}`,
    });
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

    let html: string;
    try {
      const bytes = await deps.store.getBlob(published.bundleKey);
      html = Buffer.from(bytes).toString('utf8');
    } catch {
      return reply.code(404).send({ error: 'bundle_not_found' });
    }

    // CSP for self-contained game bundles (engine + assets inlined as data URLs):
    // • script-src data: blob:   — module scripts with src="data:..." need data: allowance
    // • connect-src 'none'       — block all network (no exfil from generated code)
    // • frame-ancestors *        — relaxed for Phase 2; tighten to app origins in Phase 3
    const csp = [
      "default-src 'none'",
      "script-src 'unsafe-inline' data: blob:",
      "style-src 'unsafe-inline'",
      "img-src * data: blob:",
      "media-src * data: blob:",
      "connect-src 'none'",
      "frame-ancestors *",
    ].join('; ');

    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', csp)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(html);
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

  return app;
}
