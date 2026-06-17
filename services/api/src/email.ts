/**
 * Email port + transports (Phase 6.2).
 *
 * `EmailPort` is the seam the API sends transactional mail through — today only
 * the password-reset link. The dev default is `ConsoleEmailTransport`, which
 * logs the message instead of dispatching it (no SMTP/provider creds needed to
 * run locally or in tests). A real provider transport (SES/Resend/Postmark) is
 * a later swap behind the same interface; nothing in the routes changes.
 *
 * Why a port (not a direct console.log in the route): the reset route must stay
 * provider-agnostic and testable. Tests inject a capturing transport and assert
 * what would have been sent without touching the network.
 */

/** A single outbound email. Plain-text body is required; HTML is optional. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** The send seam. Implementations dispatch (or log) one message. */
export interface EmailPort {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Dev/default transport: logs the email to the console instead of sending it.
 * The reset link is visible in the API logs so a developer can complete the
 * flow locally without a mail provider. NEVER use in production — a real
 * transport must be wired before reset emails carry live tokens to real users.
 */
export class ConsoleEmailTransport implements EmailPort {
  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(message: EmailMessage): Promise<void> {
    this.log(
      `[email:console] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
  }
}

/**
 * Test/inspection transport: records every message in-memory instead of
 * dispatching it. Lets inject() tests assert the reset email was "sent" and read
 * the token out of the captured body.
 */
export class CapturingEmailTransport implements EmailPort {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Compose the password-reset email. The raw token goes in the body; the link is
 * built from `appBaseUrl` when configured (so the user clicks straight through),
 * otherwise the bare token is shown for manual entry. Pure builder — kept out of
 * the route so the wording/link shape is unit-testable.
 */
export function buildPasswordResetEmail(opts: {
  to: string;
  token: string;
  appBaseUrl?: string | undefined;
  ttlMinutes: number;
}): EmailMessage {
  const link = opts.appBaseUrl
    ? `${opts.appBaseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(opts.token)}`
    : null;
  const action = link
    ? `Reset your password:\n${link}`
    : `Your password reset token (valid ${opts.ttlMinutes} minutes):\n${opts.token}`;
  return {
    to: opts.to,
    subject: 'Reset your Playforge password',
    text:
      `We received a request to reset your Playforge password.\n\n` +
      `${action}\n\n` +
      `This link expires in ${opts.ttlMinutes} minutes and can be used once. ` +
      `If you didn't request this, you can safely ignore this email.`,
  };
}
