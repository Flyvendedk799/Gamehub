import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PartySessionClaims, PlayerRole } from '@playforge/shared';

// Stable per-process fallback secret if PARTY_SESSION_SECRET is not configured in env
const DEFAULT_SECRET = process.env['PARTY_SESSION_SECRET'] || randomBytes(32).toString('hex');

/**
 * Returns the effective secret for signing and verifying party session tokens.
 */
export function getPartySessionSecret(explicitSecret?: string): string {
  return explicitSecret || process.env['PARTY_SESSION_SECRET'] || DEFAULT_SECRET;
}

/**
 * Encodes an object to a URL-safe Base64 string.
 */
function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decodes a URL-safe Base64 string back to a utf8 string.
 */
function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Computes an HMAC-SHA256 signature for data with a secret.
 */
function computeHmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Cryptographically signs party session claims using HMAC-SHA256.
 * Format: `<base64url(claims)>.<hex(hmac)>`
 */
export function signSessionToken(claims: PartySessionClaims, secret?: string): string {
  const activeSecret = getPartySessionSecret(secret);
  const payload = JSON.stringify(claims);
  const encodedPayload = base64UrlEncode(payload);
  const signature = computeHmac(encodedPayload, activeSecret);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies and parses an HMAC-SHA256 signed party session token.
 * Returns the validated claims, or null if invalid or tampered with.
 */
export function verifySessionToken(token: string, secret?: string): PartySessionClaims | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, providedSignature] = parts;
  if (!encodedPayload || !providedSignature) return null;

  const activeSecret = getPartySessionSecret(secret);
  const expectedSignature = computeHmac(encodedPayload, activeSecret);

  const providedBuf = Buffer.from(providedSignature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');

  if (providedBuf.length !== expectedBuf.length) {
    return null;
  }

  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const rawPayload = base64UrlDecode(encodedPayload);
    const parsed = JSON.parse(rawPayload) as PartySessionClaims;

    if (
      !parsed.roomId ||
      !parsed.roomCode ||
      !parsed.memberId ||
      !parsed.role ||
      typeof parsed.issuedAt !== 'number' ||
      !parsed.nonce
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Creates and signs a new party session token.
 */
export function createSessionToken(
  roomId: string,
  roomCode: string,
  memberId: string,
  role: PlayerRole,
  secret?: string,
): string {
  const claims: PartySessionClaims = {
    roomId,
    roomCode,
    memberId,
    role,
    issuedAt: Date.now(),
    nonce: randomBytes(16).toString('hex'),
  };
  return signSessionToken(claims, secret);
}
