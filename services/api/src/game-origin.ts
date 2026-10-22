import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface PreviewTicket {
  projectId: string;
  manifestKey: string;
  engine: 'phaser' | 'three' | 'canvas2d';
  expiresAt: number;
}

/** A separate host per project, never an application/session origin. */
export function projectGameOrigin(base: string, projectId: string): string {
  const url = new URL(base);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && url.hostname.endsWith('.localhost'))
  ) {
    throw new Error('GAME_BASE_URL must use HTTPS (HTTP is allowed only on *.localhost)');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('GAME_BASE_URL must be an origin');
  }
  url.hostname = `p-${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}.${url.hostname}`;
  return url.origin;
}

export function signPreviewTicket(ticket: PreviewTicket, secret: string): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function readPreviewTicket(
  value: string,
  secret: string,
  now = Date.now(),
): PreviewTicket | null {
  if (value.length > 4096) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const t: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!t || typeof t !== 'object') return null;
    const v = t as Record<string, unknown>;
    if (
      typeof v['projectId'] !== 'string' ||
      typeof v['manifestKey'] !== 'string' ||
      typeof v['expiresAt'] !== 'number' ||
      v['expiresAt'] <= now ||
      !['phaser', 'three', 'canvas2d'].includes(String(v['engine']))
    )
      return null;
    return t as PreviewTicket;
  } catch {
    return null;
  }
}
