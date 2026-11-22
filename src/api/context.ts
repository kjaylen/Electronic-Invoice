/** Server-wide settings the routes need beyond the pipeline: email, public links, cookies. */

import type { Mailer } from '../mail/mailer.ts';
import type { ObjectStore } from '../storage/objects.ts';
import { ApiError } from './errors.ts';

export interface ServerContext {
  mailer: Mailer;
  /** Whether a real mailer (SMTP or outbox) is configured. */
  mailConfigured: boolean;
  /** Public base URL of the web app, e.g. https://app.example.bz. Links in emails are built from it, never from the Host header. */
  publicUrl?: string;
  cookieSecure: boolean;
  allowSignup: boolean;
  /** Product photos go here when set; otherwise they stay in the database. */
  objects?: ObjectStore;
  /** The platform's own billing: the business that issues its invoices (slug), and how subscribers pay. */
  billing?: { tenantSlug?: string; paymentInstructions?: string };
  /** Where businesses point their store domains (CNAME), e.g. stores.example.bz. */
  storeDomainTarget?: string;
  /** DNS TXT lookup (replaceable in tests). */
  resolveTxt?: (name: string) => Promise<string[][]>;
}

/** An absolute link into the web app. */
export function publicLink(ctx: ServerContext, path: string): string {
  if (!ctx.publicUrl) throw new ApiError(503, 'not_configured', 'PUBLIC_URL is not set on this server');
  return new URL(path.replace(/^\//, ''), ctx.publicUrl.endsWith('/') ? ctx.publicUrl : `${ctx.publicUrl}/`).toString();
}

export function requireMail(ctx: ServerContext) {
  if (!ctx.mailConfigured) throw new ApiError(503, 'email_unavailable', 'Email is not set up on this server');
}
