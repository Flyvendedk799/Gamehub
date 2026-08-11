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

import nodemailer, { type Transporter } from 'nodemailer';

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
 * Production transport: sends over SMTP via nodemailer, using the credentials
 * injected by the host (ServerHoster -> Cloudflare Email:
 * smtp.mx.cloudflare.net:465, user "api_token"). Reads SMTP_* from the
 * environment and supplies the From identity nodemailer's EmailMessage lacks.
 * If SMTP is not fully configured it degrades to a no-op rather than throwing,
 * so a partial env can never turn the reset route into a 500.
 */
export class SmtpEmailTransport implements EmailPort {
  private transport: Transporter | null = null;

  private getTransport(): Transporter | null {
    if (this.transport) return this.transport;
    const host = process.env['SMTP_HOST'];
    const pass = process.env['SMTP_PASSWORD'];
    if (!host || !pass) return null;
    const port = Number(process.env['SMTP_PORT']) || 465;
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS (Cloudflare SMTP)
      auth: { user: process.env['SMTP_USER'] ?? 'api_token', pass },
    });
    return this.transport;
  }

  async send(message: EmailMessage): Promise<void> {
    const transport = this.getTransport();
    if (!transport) return;
    const from = process.env['SMTP_FROM'] ?? 'noreply@playerzero.online';
    const fromName = process.env['SMTP_FROM_NAME'] ?? 'PlayerZero';
    await transport.sendMail({
      from: `"${fromName}" <${from}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
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
    subject: 'Reset your PlayerZero password',
    text: `We received a request to reset your PlayerZero password.\n\n${action}\n\nThis link expires in ${opts.ttlMinutes} minutes and can be used once. If you didn't request this, you can safely ignore this email.`,
  };
}
