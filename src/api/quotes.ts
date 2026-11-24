/**
 * Quotes (estimates): an offer to a customer before anything is owed. Not a
 * tax document; when accepted it becomes a tax invoice (or receipt) through
 * the normal issuing pipeline.
 *
 *   GET  /v1/quotes                  list (status, search)
 *   POST /v1/quotes                  { document, validUntil?, dueDays? } → a draft
 *   GET  /v1/quotes/:id              with its lines and totals
 *   PUT  /v1/quotes/:id              change a draft or sent quote
 *   GET  /v1/quotes/:id/pdf
 *   POST /v1/quotes/:id/send         email it with the PDF and a link to accept { to?, message? }
 *   POST /v1/quotes/:id/link         a link to share another way (WhatsApp)
 *   POST /v1/quotes/:id/status       { status: accepted | declined | cancelled, reason? } (told by phone, say)
 *   POST /v1/quotes/:id/invoice      issue the tax invoice from it
 *
 * Public, the link's token being the permission:
 *   GET  /v1/quote/:token            the quote
 *   GET  /v1/quote/:token/pdf
 *   POST /v1/quote/:token/accept     { name }
 *   POST /v1/quote/:token/decline    { reason? }
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { overLimit } from '../db/ratelimit.ts';
import { calculateDocument } from '../engine/calc.ts';
import { formatCents } from '../engine/decimal.ts';
import { simpleHtml } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderQuote, type QuoteInput } from '../render/quote.ts';
import { quotePdf as templateQuotePdf } from '../templates/pdf.ts';
import { businessContext, renderEmail } from '../templates/render.ts';
import { logoForPdf } from '../templates/assets.ts';
import { customerFromRow, loadCustomer } from './catalog.ts';
import { publicLink, requireMail, type ServerContext } from './context.ts';
import { type IssueBody, issueFromBody, resolveBody, toIssueRequest } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { businessContact, emailInvoice } from './receivables.ts';
import { date as dateSchema, issueSchema, uuid } from './schemas.ts';

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'invoiced' | 'cancelled';
const LINK_TTL_MS = 120 * 86_400_000;
const VALID_DOCUMENT = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];
export const UNIT_NAMES: Record<string, string> = {
  H87: 'piece', EA: 'each', BX: 'box', PK: 'pack', KGM: 'kg', LBR: 'lb', LTR: 'litre', GLL: 'US gal', GLI: 'imp. gal', MTR: 'metre', FOT: 'foot', HUR: 'hour', DAY: 'day', MON: 'month',
};

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
export const addDays = (isoDate: string, days: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const quoteNumber = (n: number) => `Q-${n}`;

/** The document part of a quote or recurring invoice: an issue body without references, prepaid amounts or a payment record. */
export const templateDocumentSchema = (() => {
  const { reference: _r, paid: _p, prepaidAmount: _pa, payableRoundingAmount: _pr, series: _s, ...properties } = issueSchema.properties;
  return { ...issueSchema, properties };
})();

interface QuoteRow {
  id: string;
  tenant_id: string;
  number: number;
  status: QuoteStatus;
  body: IssueBody;
  customer_id: string | null;
  customer_snapshot: { name: string | null; tin: string | null; email: string | null } | null;
  subtotal_cents: unknown;
  gst_cents: unknown;
  total_cents: unknown;
  valid_until: string;
  due_days: number;
  sent_at: Date | string | null;
  accepted_at: Date | string | null;
  accepted_by: string | null;
  declined_at: Date | string | null;
  decline_reason: string | null;
  document_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const expired = (q: QuoteRow) => (q.status === 'draft' || q.status === 'sent') && q.valid_until < belizeToday();

export function quoteJson(q: QuoteRow) {
  return {
    id: q.id,
    number: quoteNumber(q.number),
    status: q.status,
    expired: expired(q),
    customer: { id: q.customer_id, name: q.customer_snapshot?.name ?? null, tin: q.customer_snapshot?.tin ?? null, email: q.customer_snapshot?.email ?? null },
    totals: { subtotal: formatCents(toBigInt(q.subtotal_cents)), gst: formatCents(toBigInt(q.gst_cents)), total: formatCents(toBigInt(q.total_cents)) },
    validUntil: String(q.valid_until).slice(0, 10),
    dueDays: q.due_days,
    documentType: q.body.type,
    sentAt: iso(q.sent_at),
    acceptedAt: iso(q.accepted_at),
    acceptedBy: q.accepted_by,
    declinedAt: iso(q.declined_at),
    declineReason: q.decline_reason,
    documentId: q.document_id,
    createdAt: iso(q.created_at)!,
    updatedAt: iso(q.updated_at)!,
  };
}

const COLUMNS = 'q.*, q.valid_until::text as valid_until';

async function loadQuote(db: Queryable, tenantId: string, id: string): Promise<QuoteRow> {
  const q = (await db.query<QuoteRow>(`select ${COLUMNS} from quotes q where q.id = $1 and q.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!q) throw notFound('Quote');
  return q;
}

/** Who the quote is for, as it stands now (for lists and emails). */
export async function customerSnapshot(deps: PipelineDeps, tenantId: string, body: IssueBody): Promise<{ name: string | null; tin: string | null; email: string | null }> {
  if (body.customerId) {
    const c = customerFromRow(await loadCustomer(deps, tenantId, body.customerId));
    return { name: c.name ?? null, tin: c.tin ?? null, email: c.contact?.email ?? null };
  }
  const c = body.customer;
  return { name: c?.name ?? null, tin: c?.tin ?? null, email: c?.contact?.email ?? null };
}

/** Checks what a quote or recurring invoice will issue, and writes every price out. */
export async function prepareTemplate(deps: PipelineDeps, tenantId: string, doc: IssueBody, allowed: readonly string[]) {
  if (!allowed.includes(doc.type)) throw new ApiError(422, 'invalid_document', `Only ${allowed.map((t) => (t === '01' ? 'tax invoices' : 'tax receipts')).join(' or ')} can be prepared ahead`);
  if (doc.type === '01' && !doc.customerId && !doc.customer?.name?.trim()) throw new ApiError(422, 'invalid_document', 'A tax invoice needs a customer with a name');
  const { payment, ...rest } = doc;
  // The due date is set when the invoice is issued, from the number of days given.
  const cleaned: IssueBody = { ...rest, ...(payment && { payment: { ...(payment.meansCode && { meansCode: payment.meansCode }), ...(payment.terms && { terms: payment.terms }) } }) };
  const { body, totals } = await resolveBody(deps, tenantId, cleaned);
  return { body, totals, customer: await customerSnapshot(deps, tenantId, body) };
}

/** Each line with its GST and total, for screens and the PDF. */
async function linesOf(deps: PipelineDeps, tenantId: string, body: IssueBody) {
  const req = await toIssueRequest(deps, tenantId, body);
  const t = calculateDocument({ lines: req.lines }, deps.tax);
  return req.lines.map((l, i) => ({
    description: l.description, quantity: l.quantity, unitCode: l.unitCode, unitPrice: l.unitPrice, gstCategory: l.gstCategory,
    net: formatCents(t.lines[i]!.netAmount), gst: formatCents(t.lines[i]!.gstAmount), total: formatCents(t.lines[i]!.lineTotal),
  }));
}

async function quotePdf(deps: PipelineDeps, tenantId: string, q: QuoteRow): Promise<Buffer> {
  const req = await toIssueRequest(deps, tenantId, q.body);
  const c = req.customer;
  const lines = await linesOf(deps, tenantId, q.body);
  const input: QuoteInput = {
    business: await businessContact(deps.db, tenantId),
    customer: {
      name: c?.name ?? 'Customer', tin: c?.tin ?? null, email: c?.contact?.email ?? null,
      addressLines: c?.address ? [c.address.street, [c.address.city, c.address.districtName].filter(Boolean).join(', ')] : [],
    },
    number: quoteNumber(q.number),
    date: new Date(new Date(q.created_at).getTime() - 6 * 3600_000).toISOString().slice(0, 10),
    validUntil: q.valid_until,
    status: q.status,
    expired: expired(q),
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: UNIT_NAMES[l.unitCode] ?? l.unitCode, unitPrice: l.unitPrice, gst: l.gst, total: l.total })),
    totals: { subtotal: formatCents(toBigInt(q.subtotal_cents)), gst: formatCents(toBigInt(q.gst_cents)), total: formatCents(toBigInt(q.total_cents)) },
    terms: q.body.payment?.terms ?? (q.body.type === '01' ? `Payment due ${q.due_days} days after the invoice` : null),
    note: q.body.note ?? null,
    acceptedBy: q.accepted_by,
  };
  const logo = await logoForPdf(deps.db, tenantId);
  return (await templateQuotePdf(deps.db, tenantId, input)) ?? renderQuote({ ...input, ...(logo && { logo }) });
}

async function createLink(db: Queryable, ctx: ServerContext, q: QuoteRow): Promise<string> {
  publicLink(ctx, '/');
  const token = randomBytes(32).toString('base64url');
  await db.query('insert into quote_links (token_hash, tenant_id, quote_id, expires_at) values ($1, $2, $3, $4)', [hashToken(token), q.tenant_id, q.id, new Date(Date.now() + LINK_TTL_MS).toISOString()]);
  return publicLink(ctx, `/q/${token}`);
}

/** Issue the tax invoice (or receipt) a quote describes. */
export async function invoiceQuote(deps: PipelineDeps, ctx: ServerContext, tenantId: string, quoteId: string, userId: string | null, options: { email?: boolean; ekyash?: { sandboxUrl?: string; liveUrl?: string } } = {}) {
  const q = await loadQuote(deps.db, tenantId, quoteId);
  if (q.status === 'invoiced') throw new ApiError(409, 'already_invoiced', 'This quote was already invoiced');
  if (q.status === 'declined' || q.status === 'cancelled') throw new ApiError(409, 'not_open', `A ${q.status} quote cannot be invoiced`);
  const today = belizeToday();
  const body: IssueBody = {
    ...q.body,
    ...(q.body.type === '01'
      ? { payment: { meansCode: '30', ...q.body.payment, dueDate: addDays(today, q.due_days), terms: q.body.payment?.terms ?? (q.due_days ? `Net ${q.due_days}` : 'Due on receipt') } }
      : {}),
    note: [q.body.note, `Quote ${quoteNumber(q.number)}`].filter(Boolean).join(' · '),
  };
  const result = await issueFromBody(deps, tenantId, body, userId);
  if (VALID_DOCUMENT.includes(result.status)) {
    await deps.db.query("update quotes set status = 'invoiced', document_id = $3, updated_at = now() where id = $1 and tenant_id = $2", [q.id, tenantId, result.documentId]);
    const email = q.customer_snapshot?.email;
    if (options.email && email && ctx.mailConfigured && result.status !== 'pending') {
      await emailInvoice(deps, ctx, tenantId, result.documentId, email, { userId, ...(options.ekyash && { ekyash: options.ekyash }) }).catch(() => {});
    }
  }
  return result;
}

export function registerQuoteRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, extras: { ekyash?: { sandboxUrl?: string; liveUrl?: string } } = {}) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const quoteBody = {
    type: 'object',
    required: ['document'],
    additionalProperties: false,
    properties: {
      document: templateDocumentSchema,
      validUntil: dateSchema,
      dueDays: { type: 'integer', minimum: 0, maximum: 365 },
    },
  } as const;
  type QuoteBody = { document: IssueBody; validUntil?: string; dueDays?: number };

  app.get<{ Querystring: { status?: string; q?: string } }>(
    '/quotes',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'draft', 'sent', 'accepted', 'declined', 'invoiced', 'cancelled', 'all'] }, q: { type: 'string', maxLength: 100 } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const status = request.query.status ?? 'all';
      const params: unknown[] = [request.tenantId];
      let where = 'q.tenant_id = $1';
      if (status === 'open') where += " and q.status in ('draft', 'sent', 'accepted')";
      else if (status !== 'all') {
        params.push(status);
        where += ` and q.status = $${params.length}`;
      }
      const text = request.query.q?.trim();
      if (text) {
        params.push(`%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, text.replace(/^q-?/i, ''));
        where += ` and (q.customer_snapshot->>'name' ilike $${params.length - 1} or q.number::text = $${params.length})`;
      }
      const rows = (await db.query<QuoteRow>(`select ${COLUMNS} from quotes q where ${where} order by q.created_at desc limit 200`, params)).rows;
      return { data: rows.map(quoteJson) };
    },
  );

  app.post<{ Body: QuoteBody }>('/quotes', { schema: { body: quoteBody } }, async (request, reply) => {
    requirePermission(request, 'documents.issue');
    const b = request.body;
    const { body, totals, customer } = await prepareTemplate(deps, request.tenantId, b.document, ['01', '02']);
    const validUntil = b.validUntil ?? addDays(belizeToday(), 30);
    if (validUntil < belizeToday()) throw new ApiError(422, 'invalid_quote', 'The quote must be valid until today or later');
    const id = randomUUID();
    await db.transaction(async (tx) => {
      const n = (await tx.query<{ number: number }>('update tenants set next_quote_number = next_quote_number + 1 where id = $1 returning next_quote_number - 1 as number', [request.tenantId])).rows[0]!.number;
      await tx.query(
        `insert into quotes (id, tenant_id, number, body, customer_id, customer_snapshot, subtotal_cents, gst_cents, total_cents, valid_until, due_days, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, request.tenantId, n, JSON.stringify(body), body.customerId ?? null, JSON.stringify(customer), String(totals.subtotal), String(totals.gst), String(totals.total), validUntil, b.dueDays ?? 30, request.userId || null],
      );
    });
    const q = await loadQuote(db, request.tenantId, id);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'quote.created', target: quoteNumber(q.number), ip: request.ip });
    return reply.code(201).send({ ...quoteJson(q), document: q.body, lines: await linesOf(deps, request.tenantId, q.body) });
  });

  app.get<{ Params: { id: string } }>('/quotes/:id', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const q = await loadQuote(db, request.tenantId, request.params.id);
    return { ...quoteJson(q), document: q.body, lines: await linesOf(deps, request.tenantId, q.body) };
  });

  app.put<{ Params: { id: string }; Body: QuoteBody }>('/quotes/:id', { schema: { params: idParams, body: quoteBody } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const before = await loadQuote(db, request.tenantId, request.params.id);
    if (before.status !== 'draft' && before.status !== 'sent') throw new ApiError(409, 'not_editable', `A ${before.status} quote cannot be changed`);
    const b = request.body;
    const { body, totals, customer } = await prepareTemplate(deps, request.tenantId, b.document, ['01', '02']);
    await db.query(
      `update quotes set body = $3, customer_id = $4, customer_snapshot = $5, subtotal_cents = $6, gst_cents = $7, total_cents = $8, valid_until = $9, due_days = $10, updated_at = now()
       where id = $1 and tenant_id = $2`,
      [before.id, request.tenantId, JSON.stringify(body), body.customerId ?? null, JSON.stringify(customer), String(totals.subtotal), String(totals.gst), String(totals.total), b.validUntil ?? before.valid_until, b.dueDays ?? before.due_days],
    );
    const q = await loadQuote(db, request.tenantId, before.id);
    return { ...quoteJson(q), document: q.body, lines: await linesOf(deps, request.tenantId, q.body) };
  });

  app.get<{ Params: { id: string } }>('/quotes/:id/pdf', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'documents.issue');
    const q = await loadQuote(db, request.tenantId, request.params.id);
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="quote-${q.number}.pdf"`).send(await quotePdf(deps, request.tenantId, q));
  });

  app.post<{ Params: { id: string }; Body: { to?: string; message?: string } | undefined }>(
    '/quotes/:id/send',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { to: { type: 'string', format: 'email', maxLength: 254 }, message: { type: 'string', maxLength: 2000 } } } } },
    async (request) => {
      requirePermission(request, 'documents.send');
      requireMail(ctx);
      const q = await loadQuote(db, request.tenantId, request.params.id);
      if (q.status !== 'draft' && q.status !== 'sent') throw new ApiError(409, 'not_open', `A ${q.status} quote is not sent again`);
      const to = request.body?.to ?? q.customer_snapshot?.email;
      if (!to) throw new ApiError(422, 'no_email', 'This customer has no email address; enter one');
      if (await overLimit(db, `quote-send|${q.id}`, 10, 24 * 3600_000)) throw new ApiError(429, 'too_many_emails', 'Enough emails for this quote today');
      const biz = await businessContext(db, request.tenantId);
      const url = await createLink(db, ctx, q);
      const mail = await renderEmail(db, request.tenantId, 'email.quote', {
        business: biz,
        customer: { name: q.customer_snapshot?.name ?? null, email: to },
        quote: { number: quoteNumber(q.number), total: formatCents(toBigInt(q.total_cents)), valid_until: String(q.valid_until).slice(0, 10) },
        view_url: url,
        message: request.body?.message?.trim() || null,
      }, { publicUrl: ctx.publicUrl });
      await ctx.mailer.send({ type: 'quote', tenantId: request.tenantId, userId: request.userId || null,
        to, replyTo: biz.email, subject: mail.subject, text: mail.text, html: mail.html,
        attachments: [{ filename: `quote-${q.number}.pdf`, content: await quotePdf(deps, request.tenantId, q), contentType: 'application/pdf' }],
      });
      await db.query("update quotes set status = 'sent', sent_at = now(), updated_at = now() where id = $1", [q.id]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'quote.sent', target: quoteNumber(q.number), details: { to }, ip: request.ip });
      return { ...quoteJson(await loadQuote(db, request.tenantId, q.id)), to };
    },
  );

  app.post<{ Params: { id: string } }>('/quotes/:id/link', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'documents.send');
    const q = await loadQuote(db, request.tenantId, request.params.id);
    if (q.status === 'cancelled') throw new ApiError(409, 'not_open', 'A cancelled quote cannot be shared');
    const url = await createLink(db, ctx, q);
    if (q.status === 'draft') await db.query("update quotes set status = 'sent', sent_at = now(), updated_at = now() where id = $1", [q.id]);
    return reply.code(201).send({ url });
  });

  app.post<{ Params: { id: string }; Body: { status: 'accepted' | 'declined' | 'cancelled'; reason?: string; name?: string } }>(
    '/quotes/:id/status',
    { schema: { params: idParams, body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['accepted', 'declined', 'cancelled'] }, reason: { type: 'string', maxLength: 500 }, name: { type: 'string', maxLength: 120 } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const q = await loadQuote(db, request.tenantId, request.params.id);
      const s = request.body.status;
      const allowed: Record<typeof s, QuoteStatus[]> = { accepted: ['draft', 'sent', 'declined'], declined: ['draft', 'sent', 'accepted'], cancelled: ['draft', 'sent', 'accepted', 'declined'] };
      if (!allowed[s].includes(q.status)) throw new ApiError(409, 'invalid_status', `A ${q.status} quote cannot be marked ${s}`);
      if (s === 'accepted') await db.query("update quotes set status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now() where id = $1", [q.id, request.body.name?.trim() || q.customer_snapshot?.name || null]);
      if (s === 'declined') await db.query("update quotes set status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() where id = $1", [q.id, request.body.reason?.trim() || null]);
      if (s === 'cancelled') await db.query("update quotes set status = 'cancelled', updated_at = now() where id = $1", [q.id]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `quote.${s}`, target: quoteNumber(q.number), ip: request.ip });
      return quoteJson(await loadQuote(db, request.tenantId, q.id));
    },
  );

  app.post<{ Params: { id: string }; Body: { email?: boolean } | undefined }>(
    '/quotes/:id/invoice',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { email: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const result = await invoiceQuote(deps, ctx, request.tenantId, request.params.id, request.userId || null, { email: request.body?.email ?? false, ...extras });
      const q = await loadQuote(db, request.tenantId, request.params.id);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'quote.invoiced', target: quoteNumber(q.number), ip: request.ip });
      return { quote: quoteJson(q), document: { id: result.documentId, status: result.status } };
    },
  );
}

// ---------- the customer's side ----------

export function registerPublicQuoteRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const tokenParams = { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } as const;
  const linked = async (token: string) => {
    const l = (await db.query<{ tenant_id: string; quote_id: string; expires_at: Date | string }>('select tenant_id, quote_id, expires_at from quote_links where token_hash = $1', [hashToken(token)])).rows[0];
    if (!l || new Date(l.expires_at).getTime() <= Date.now()) throw new ApiError(404, 'not_found', 'This link is not available. It may have expired; ask the business to send it again.');
    return loadQuote(db, l.tenant_id, l.quote_id);
  };
  const canRespond = (q: QuoteRow) => (q.status === 'sent' || q.status === 'draft') && !expired(q);

  app.get<{ Params: { token: string } }>('/:token', { schema: { params: tokenParams } }, async (request, reply) => {
    const q = await linked(request.params.token);
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
    const biz = await businessContact(db, q.tenant_id);
    const j = quoteJson(q);
    return {
      business: { name: biz.name, email: biz.email, telephone: biz.telephone },
      quote: { number: j.number, status: j.status, expired: j.expired, validUntil: j.validUntil, customer: j.customer.name, totals: j.totals, documentType: j.documentType, acceptedBy: j.acceptedBy, terms: q.body.payment?.terms ?? null, note: q.body.note ?? null },
      lines: (await linesOf(deps, q.tenant_id, q.body)).map((l) => ({ description: l.description, quantity: l.quantity, unitCode: l.unitCode, unitPrice: l.unitPrice, total: l.total })),
      canRespond: canRespond(q),
      pdfUrl: `/v1/quote/${request.params.token}/pdf`,
    };
  });

  app.get<{ Params: { token: string } }>('/:token/pdf', { schema: { params: tokenParams } }, async (request, reply) => {
    const q = await linked(request.params.token);
    return reply.type('application/pdf').header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex')
      .header('Content-Disposition', `inline; filename="quote-${q.number}.pdf"`).send(await quotePdf(deps, q.tenant_id, q));
  });

  const notify = async (q: QuoteRow, line: string) => {
    if (!ctx.mailConfigured) return;
    const biz = await businessContact(db, q.tenant_id);
    await ctx.mailer.send({ type: 'quote-answer', tenantId: q.tenant_id, to: biz.email, subject: `Quote ${quoteNumber(q.number)}: ${line}`, text: line, html: simpleHtml({ heading: `Quote ${quoteNumber(q.number)}`, paragraphs: [line] }) }).catch(() => {});
  };

  app.post<{ Params: { token: string }; Body: { name: string } }>(
    '/:token/accept',
    { schema: { params: tokenParams, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 120 } } } } },
    async (request) => {
      const q = await linked(request.params.token);
      if (!canRespond(q)) throw new ApiError(409, 'not_open', q.status === 'accepted' || q.status === 'invoiced' ? 'This quote was already accepted' : 'This quote can no longer be accepted; contact the business');
      const name = request.body.name.trim();
      await db.query("update quotes set status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now() where id = $1 and status in ('draft', 'sent')", [q.id, name]);
      await audit(db, { tenantId: q.tenant_id, action: 'quote.accepted_online', target: quoteNumber(q.number), details: { name }, ip: request.ip });
      await notify(q, `accepted by ${name} (BZ$${formatCents(toBigInt(q.total_cents))}). Open it to issue the invoice.`);
      return { status: 'accepted' };
    },
  );

  app.post<{ Params: { token: string }; Body: { reason?: string } | undefined }>(
    '/:token/decline',
    { schema: { params: tokenParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } } } },
    async (request) => {
      const q = await linked(request.params.token);
      if (!canRespond(q)) throw new ApiError(409, 'not_open', 'This quote can no longer be declined');
      const reason = request.body?.reason?.trim() || null;
      await db.query("update quotes set status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() where id = $1 and status in ('draft', 'sent')", [q.id, reason]);
      await audit(db, { tenantId: q.tenant_id, action: 'quote.declined_online', target: quoteNumber(q.number), details: { reason }, ip: request.ip });
      await notify(q, `declined${reason ? `: ${reason}` : ''}.`);
      return { status: 'declined' };
    },
  );
}
