/**
 * A customer's account page: one private link (valid a year) where a saved customer sees what they
 * owe, pays it online, and downloads their invoices and their statement. No sign-in; the token is
 * the permission (stored hashed, revocable).
 *
 * The business (owners, admins, managers, cashiers, accountants):
 *   POST   /v1/customers/:id/account-link        a new link { url, expiresAt }
 *   POST   /v1/customers/:id/account-link/send   { to? } emails a new link to the customer
 *   DELETE /v1/customers/:id/account-links       every link stops working
 *
 * The customer:
 *   GET  /v1/account/:token                       business, customer, what is owed, open invoices, recent documents
 *   POST /v1/account/:token/documents/:id/link    { url, payUrl } for one of their documents
 *   GET  /v1/account/:token/statement.pdf
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { overLimit } from '../db/ratelimit.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { openReceivables, ReceivableError, statement } from '../receivables/receivables.ts';
import { businessContext, renderEmail } from '../templates/render.ts';
import { accountTokenHash as hash, createAccountLink } from './account-links.ts';
import { requireMail, type ServerContext } from './context.ts';
import { createShareLink } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { businessContact, invoiceProvider, receivableSettings, statementPdfFor } from './receivables.ts';
import { uuid } from './schemas.ts';

const VALID = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];
const TYPE_NAMES: Record<string, string> = { '01': 'Tax invoice', '02': 'Tax receipt', '03': 'Debit note', '04': 'Credit note' };

export function registerAccountLinkRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const allowed = (request: FastifyRequest) => {
    if (!can(request.principal, 'payments.record')) requirePermission(request, 'catalog.manage');
  };

  app.post<{ Params: { id: string } }>('/customers/:id/account-link', { schema: { params: idParams } }, async (request) => {
    allowed(request);
    const link = await createAccountLink(db, ctx, request.tenantId, request.params.id, request.userId || null);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'customer.account_link', target: link.customer.name, ip: request.ip });
    return { url: link.url, expiresAt: link.expiresAt };
  });

  app.post<{ Params: { id: string }; Body: { to?: string } | null }>(
    '/customers/:id/account-link/send',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { to: { type: 'string', format: 'email', maxLength: 254 } } } } },
    async (request) => {
      allowed(request);
      requireMail(ctx);
      if (await overLimit(db, `account-link|${request.params.id}`, 5, 24 * 3600_000)) throw new ApiError(429, 'too_many_emails', 'Enough account links for this customer today');
      const link = await createAccountLink(db, ctx, request.tenantId, request.params.id, request.userId || null);
      const to = request.body?.to ?? link.customer.email;
      if (!to) throw new ApiError(422, 'no_email', 'This customer has no email address; enter one');
      // The business's own wording (Templates → Customer account link), in the language its customers are written to.
      const biz = await businessContext(db, request.tenantId);
      const mail = await renderEmail(db, request.tenantId, 'email.account-link', {
        business: biz, customer: { name: link.customer.name, email: to }, account_url: link.url,
      }, { publicUrl: ctx.publicUrl });
      await ctx.mailer.send({ type: 'account-link', tenantId: request.tenantId, userId: request.userId || null, to, replyTo: biz.email, subject: mail.subject, text: mail.text, html: mail.html });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'customer.account_link_sent', target: link.customer.name, details: { to }, ip: request.ip });
      return { sent: true, to, expiresAt: link.expiresAt };
    },
  );

  app.delete<{ Params: { id: string } }>('/customers/:id/account-links', { schema: { params: idParams } }, async (request) => {
    allowed(request);
    const r = await db.query('update customer_links set revoked_at = now() where customer_id = $1 and tenant_id = $2 and revoked_at is null returning id', [request.params.id, request.tenantId]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'customer.account_links_revoked', target: request.params.id, details: { links: r.rows.length }, ip: request.ip });
    return { revoked: r.rows.length };
  });
}

/** The customer behind an account token, while the link is good. */
async function linkFor(db: Queryable, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const l = (await db.query<{ id: string; tenant_id: string; customer_id: string; expires_at: Date | string; revoked_at: Date | null }>(
    'select id, tenant_id, customer_id, expires_at, revoked_at from customer_links where token_hash = $1', [hash(token)],
  )).rows[0];
  if (!l || l.revoked_at || new Date(l.expires_at).getTime() <= Date.now()) return null;
  return { linkId: l.id, tenantId: l.tenant_id, customerId: l.customer_id };
}

export function registerPublicAccountRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, extras: { ekyash?: { sandboxUrl?: string; liveUrl?: string } } = {}) {
  const { db } = deps;
  const gone = () => new ApiError(404, 'link_not_available', 'This link is not available: it may have expired or been replaced. Ask the business for a new one.');
  const tokenParams = { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 64 } } } as const;
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex');

  app.get<{ Params: { token: string } }>('/:token', { schema: { params: tokenParams } }, async (request, reply) => {
    const link = await linkFor(db, request.params.token);
    if (!link) throw gone();
    noStore(reply);
    await db.query('update customer_links set last_seen = now() where id = $1', [link.linkId]);
    const biz = await businessContact(db, link.tenantId);
    const customer = (await db.query<{ name: string; tin: string | null }>('select name, tin from customers where id = $1', [link.customerId])).rows[0]!;
    const open = (await openReceivables(db, link.tenantId, { customerKey: `c:${link.customerId}` })).filter((r) => r.balanceCents > 0n);
    const recent = (await db.query<{ id: string; etd_type: string; series_number: number; serial: string; issue_date: string; tax_inclusive_cents: unknown }>(
      `select id, etd_type, series_number, serial::text as serial, issue_date::text as issue_date, tax_inclusive_cents from documents
       where tenant_id = $1 and customer_id = $2 and status = any($3::text[]) and issue_date >= (now() - interval '400 days')::date
       order by issue_date desc, created_at desc limit 50`, [link.tenantId, link.customerId, VALID],
    )).rows;
    const settings = await receivableSettings(db, link.tenantId);
    const online = ctx.publicUrl ? await invoiceProvider(db, link.tenantId, settings, extras) : null;
    const number = (s: number, n: string) => `${String(s).padStart(3, '0')}-${n.padStart(9, '0')}`;
    return {
      business: { name: biz.name, email: biz.email, telephone: biz.telephone },
      customer: { name: customer.name, tin: customer.tin },
      owed: { total: formatCents(open.reduce((a, r) => a + r.balanceCents, 0n)), overdue: formatCents(open.filter((r) => r.daysOverdue > 0).reduce((a, r) => a + r.balanceCents, 0n)) },
      open: open.map((r) => ({ id: r.documentId, type: r.type, number: r.number, issueDate: r.issueDate, dueDate: r.dueDate, total: r.total, balance: r.balance, daysOverdue: r.daysOverdue })),
      recent: recent.map((d) => ({ id: d.id, type: d.etd_type, typeName: TYPE_NAMES[d.etd_type] ?? 'Document', number: number(d.series_number, d.serial), issueDate: d.issue_date, total: formatCents(toBigInt(d.tax_inclusive_cents)) })),
      payOnline: Boolean(online),
      instructions: settings.instructions.trim() || null,
    };
  });

  app.post<{ Params: { token: string; id: string } }>(
    '/:token/documents/:id/link',
    { schema: { params: { type: 'object', required: ['token', 'id'], properties: { token: { type: 'string', maxLength: 64 }, id: uuid } } } },
    async (request) => {
      const link = await linkFor(db, request.params.token);
      if (!link) throw gone();
      if (await overLimit(db, `account-doc|${link.linkId}`, 120, 3600_000)) throw new ApiError(429, 'too_many_requests', 'Too many requests; try again later');
      const doc = (await db.query<{ id: string }>('select id from documents where id = $1 and tenant_id = $2 and customer_id = $3 and status = any($4::text[])', [request.params.id, link.tenantId, link.customerId, VALID])).rows[0];
      if (!doc) throw notFound('Document');
      const share = await createShareLink(db, ctx, link.tenantId, doc.id, null);
      return { url: share.url, payUrl: share.payUrl };
    },
  );

  app.get<{ Params: { token: string } }>('/:token/statement.pdf', { schema: { params: tokenParams } }, async (request, reply) => {
    const link = await linkFor(db, request.params.token);
    if (!link) throw gone();
    let s;
    try {
      s = await statement(db, link.tenantId, `c:${link.customerId}`);
    } catch (e) {
      if (e instanceof ReceivableError) throw new ApiError(404, 'no_invoices', 'There is nothing on your account yet');
      throw e;
    }
    const pdf = await statementPdfFor(db, link.tenantId, s);
    return noStore(reply).type('application/pdf').header('Content-Disposition', `inline; filename="statement-${s.asOf}.pdf"`).send(pdf);
  });
}
