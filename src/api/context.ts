/** Server-wide settings the routes need beyond the pipeline: email, public links, cookies. */

import type { Mailer } from '../mail/mailer.ts';
import { ApiError } from './errors.ts';

export interface ServerContext {
  mailer: Mailer;
  /** Whether a real mailer (SMTP or outbox) is configured. */
  mailConfigured: boolean;
  /** Public base URL of the web app, e.g. https://app.example.bz. Links in emails are built from it, never from the Host header. */
  publicUrl?: string;
  cookieSecure: boolean;
  allowSignup: boolean;
}

/** An absolute link into the web app. */
export function publicLink(ctx: ServerContext, path: string): string {
  if (!ctx.publicUrl) throw new ApiError(503, 'not_configured', 'PUBLIC_URL is not set on this server');
  return new URL(path.replace(/^\//, ''), ctx.publicUrl.endsWith('/') ? ctx.publicUrl : `${ctx.publicUrl}/`).toString();
}

export function requireMail(ctx: ServerContext) {
  if (!ctx.mailConfigured) throw new ApiError(503, 'email_unavailable', 'Email is not set up on this server');
}
