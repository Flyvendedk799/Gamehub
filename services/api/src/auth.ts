/**
 * Auth abstraction + native session-based authenticator.
 *
 * Production uses SessionAuthenticator: reads `Authorization: Bearer <token>`
 * and validates it against the `sessions` table in Postgres. Password hashing
 * uses Node's built-in `crypto.scrypt` (memory-hard, NIST-approved).
 *
 * Dev/test uses HeaderAuthenticator (no DB, trusts x-user-id header) so
 * tests run without Postgres.
 */
import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Db } from '@playforge/db';
import { schema } from '@playforge/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, buf) => (err ? reject(err) : resolve(buf))),
  );
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthedUser {
  userId: string;
  handle: string;
}

export interface Authenticator {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthedUser | null>;
}

/** Dev/test authenticator: trusts `x-user-id` (+ optional `x-user-handle`). */
export class HeaderAuthenticator implements Authenticator {
  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthedUser | null> {
    const raw = headers['x-user-id'];
    const userId = Array.isArray(raw) ? raw[0] : raw;
    if (!userId) return null;
    const handleRaw = headers['x-user-handle'];
    const handle = (Array.isArray(handleRaw) ? handleRaw[0] : handleRaw) ?? userId;
    return { userId, handle };
  }
}

/** Production authenticator: validates Bearer tokens against the sessions table. */
export class SessionAuthenticator implements Authenticator {
  constructor(private readonly db: Db) {}

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthedUser | null> {
    const authHeader = headers['authorization'];
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!raw?.startsWith('Bearer ')) return null;
    const token = raw.slice(7).trim();
    if (!token) return null;

    const [row] = await this.db
      .select({
        userId: schema.sessions.userId,
        handle: schema.users.handle,
        expiresAt: schema.sessions.expiresAt,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(
        and(
          eq(schema.sessions.token, token),
          gt(schema.sessions.expiresAt, new Date()),
          isNull(schema.users.deletedAt),
        ),
      );

    if (!row) return null;
    return { userId: row.userId, handle: row.handle };
  }
}

// ── Password helpers ──────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  try {
    const hash = (await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS)) as Buffer;
    const storedBuf = Buffer.from(hashHex, 'hex');
    return hash.length === storedBuf.length && timingSafeEqual(hash, storedBuf);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionExpiresAt(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}
