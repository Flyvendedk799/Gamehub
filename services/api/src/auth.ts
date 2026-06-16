/**
 * Auth abstraction. Production resolves the caller from a Clerk session and
 * maps it to a `users` row; tests/dev use a trivial header-based resolver so
 * routes are exercisable without standing up Clerk.
 */
export interface AuthedUser {
  userId: string;
  handle: string;
}

export interface Authenticator {
  /** Resolve the user from request headers, or null if unauthenticated. */
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
