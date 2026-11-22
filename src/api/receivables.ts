/**
 * Getting paid: payments against invoices, what customers owe, statements,
 * reminders, and paying an invoice online from its link.
 *
 *   GET  /v1/documents/:id/payments          the invoice's balance and its payments
 *   POST /v1/documents/:id/payments          record money received { amount, method, reference?, paidOn?, note? }
 *   POST /v1/payments/:id/void               void a payment recorded by mistake { reason }
 *   POST /v1/documents/:id/remind            email the customer a payment reminder now
 *   GET  /v1/receivables                     totals and the ageing by customer
 *   GET  /v1/receivables/ageing.csv
 *   GET  /v1/receivables/statement?customer=          a customer's statement
 *   GET  /v1/receivables/statement.pdf?customer=
 *   POST /v1/receivables/statement/send      email it { customer, to? }
 *   GET|PUT /v1/receivable-settings          reminders, paying online, how to pay
 *
 * Public, the share link's token being the permission:
 *
 *   GET  /v1/pay/:token                      the invoice, what is left to pay, how
 *   POST /v1/pay/:token/start                start paying online → where to send the customer
 *   POST /v1/pay/:token/payments/:id/confirm back from the provider: was it paid?
 *   GET|POST /v1/pay/:token/test/:id         the pretend card page of the test gateway
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { overLimit } from '../db/ratelimit.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import { BELIZE_DISTRICTS } from '../engine/ubl.ts';
import { simpleHtml } from '../mail/mailer.ts';
import { confirmPayment, type GatewayOptions, gatewayFor, getPaymentAccount, PaymentError, type Provider, startPayment } from '../commerce/payments.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import {
  AGE_BUCKETS, ageing, openReceivables, PAYMENT_METHODS, type PaymentMethod, paymentJson, paymentsFor, type Receivable, receivable,
  ReceivableError, receivablesSummary, recordPayment, statement, voidPayment,
} from '../receivables/receivables.ts';
import { renderStatement } from '../render/statement.ts';
import { requireMail, type ServerContext } from './context.ts';
import { createShareLink, sendDocumentEmail, shareLinkFor } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { settlePayment } from './payments.ts';
import { can, requirePermission } from './permissions.ts';
import { csvCell } from './reports.ts';
import { date as dateSchema, money, uuid } from './schemas.ts';

// ---------- settings ----------

export interface ReceivableSettings {
  reminders: { enabled: boolean; offsets: number[] };
  /** Customers can pay invoices online from the link in their email (PayPal, or test payments in the BTS test environment). */
  payOnline: boolean;
  /** How to pay otherwise (bank details, where to bring a cheque): on statements and reminders. */
  instructions: string;
}

export const DEFAULT_OFFSETS = [-3, 3, 14, 30];

export async function receivableSettings(db: Queryable, tenantId: string): Promise<ReceivableSettings> {
  const raw = (await db.query<{ receivable_settings: Partial<ReceivableSettings> | null }>('select receivable_settings from tenants where id = $1', [tenantId])).rows[0]?.receivable_settings ?? {};
  return {
    reminders: { enabled: Boolean(raw.reminders?.enabled), offsets: raw.reminders?.offsets?.length ? [...raw.reminders.offsets].sort((a, b) => a - b) : DEFAULT_OFFSETS },
    payOnline: raw.payOnline ?? true,
    instructions: raw.instructions ?? '',
  };
}

/** Which provider takes invoice payments for this business, if any: PayPal when connected, test payments in the BTS test environment. */
export async function invoiceProvider(db: Queryable, tenantId: string, settings?: ReceivableSettings): Promise<Provider | null> {
  const s = settings ?? (await receivableSettings(db, tenantId));
  if (!s.payOnline) return null;
  const paypal = await getPaymentAccount(db, tenantId, 'paypal');
  if (paypal?.configured) return 'paypal';
  const env = (await db.query<{ environment: string }>('select environment from tenants where id = $1', [tenantId])).rows[0]?.environment;
  return env === 'test' ? 'test' : null;
}

// ---------- shared ----------

const receivableJson = (r: Receivable) => {
  const { balanceCents: _cents, ...rest } = r;
  return rest;
};

const TYPE_NAME: Record<string, string> = { '01': 'Invoice', '03': 'Debit note' };
const docLabel = (r: Receivable) => `${TYPE_NAME[r.type] ?? 'Invoice'} ${r.number}`;
const money2 = (s: string) => `BZ$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const daysPastDue = (dueDate: string) => Math.round((Date.parse(belizeToday()) - Date.parse(dueDate)) / 86_400_000);

async function business(db: Queryable, tenantId: string) {
  const b = (await db.query<{ name: string; legal_name: string; tin: string; street: string; additional_street: string | null; city: string; district_code: string; telephone: string; email: string }>(
    'select coalesce(trade_name, legal_name) as name, legal_name, tin, street, additional_street, city, district_code, telephone, email from tenants where id = $1', [tenantId],
  )).rows[0]!;
  const district = (BELIZE_DISTRICTS as Record<string, string>)[b.district_code] ?? '';
  return { name: b.name, tin: b.tin, address: [b.street, b.additional_street, b.city, district].filter(Boolean).join(', '), telephone: b.telephone, email: b.email };
}

/** The wording of a reminder, from how far past (or before) the due date it is. */
export function reminderWording(r: Receivable, businessName: string, days: number): { subject: string; intro: string[] } {
  const what = docLabel(r).toLowerCase();
  const amount = money2(r.balance);
  if (days < 0) {
    const n = -days;
    return {
      subject: `Reminder: ${what} from ${businessName} is due ${n === 1 ? 'tomorrow' : `in ${n} days`}`,
      intro: [`A friendly reminder that ${what} for ${money2(r.total)} is due on ${longDate(r.dueDate)}.`, `Amount due: ${amount}.`],
    };
  }
  if (days === 0) {
    return { subject: `Reminder: ${what} from ${businessName} is due today`, intro: [`A friendly reminder that ${what} is due today.`, `Amount due: ${amount}.`] };
  }
  return {
    subject: `Overdue: ${what} from ${businessName}`,
    intro: [
      `Our records show that ${what} was due on ${longDate(r.dueDate)} and ${amount} is still unpaid (${days} day${days === 1 ? '' : 's'} overdue).`,
      'If you have already paid, thank you, and please ignore this message.',
    ],
  };
}

/** Email one payment reminder for an invoice. Returns the message id. */
async function sendReminder(deps: PipelineDeps, ctx: ServerContext, tenantId: string, r: Receivable, to: string, userId: string | null, settings: ReceivableSettings): Promise<string> {
  const biz = await business(deps.db, tenantId);
  const { subject, intro } = reminderWording(r, biz.name, daysPastDue(r.dueDate));
  const provider = ctx.publicUrl ? await invoiceProvider(deps.db, tenantId, settings) : null;
  const payUrl = provider ? (await createShareLink(deps.db, ctx, tenantId, r.documentId, userId)).payUrl : undefined;
  return sendDocumentEmail(deps, ctx, tenantId, r.documentId, {
    to, userId, subject, intro, ...(settings.instructions.trim() && { message: settings.instructions.trim() }), ...(payUrl && { payUrl }),
  });
}

// ---------- reminders (housekeeping) ----------

/**
 * Automatic reminders: for each open invoice with a customer email, the
 * latest reminder step it has reached (days from the due date; negative is
 * before) is sent once. Turning reminders on late sends one reminder per
 * invoice, not every step it missed. A step that falls on or before the day
 * the invoice was issued is skipped (no "due in 3 days" right after issuing it).
 */
export async function runReminders(deps: PipelineDeps, ctx: ServerContext, options: { perBusiness?: number } = {}): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  if (!ctx.mailConfigured) return result;
  const tenants = (await deps.db.query<{ id: string }>("select id from tenants where receivable_settings #>> '{reminders,enabled}' = 'true'")).rows;
  for (const t of tenants) {
    const settings = await receivableSettings(deps.db, t.id);
    let budget = options.perBusiness ?? 50;
    for (const r of await openReceivables(deps.db, t.id)) {
      if (budget <= 0) break;
      if (r.balanceCents <= 0n || !r.customer.email) continue;
      const step = reminderStep(settings.reminders.offsets, r.issueDate, r.dueDate, belizeToday());
      if (step === null) continue;
      const key = `reminder:${r.documentId}:${step}`;
      const claimed = await deps.db.query('insert into notifications_sent (key, tenant_id) values ($1, $2) on conflict do nothing returning key', [key, t.id]);
      if (!claimed.rows.length) continue;
      budget--;
      try {
        await sendReminder(deps, ctx, t.id, r, r.customer.email, null, settings);
        result.sent++;
      } catch {
        // Try again next run.
        await deps.db.query('delete from notifications_sent where key = $1', [key]);
        result.failed++;
      }
    }
  }
  return result;
}

/** The latest reminder step an invoice has reached today (days from its due date), or null. Steps on or before the issue day never count. */
export function reminderStep(offsets: number[], issueDate: string, dueDate: string, today: string): number | null {
  const days = Math.round((Date.parse(today) - Date.parse(dueDate)) / 86_400_000);
  const reached = offsets.filter((o) => days >= o && addDays(dueDate, o) > issueDate);
  return reached.length ? Math.max(...reached) : null;
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------- statements ----------

async function statementPdf(db: Queryable, tenantId: string, s: Awaited<ReturnType<typeof statement>>, settings: ReceivableSettings): Promise<Buffer> {
  return renderStatement({
    business: await business(db, tenantId),
    customer: { name: s.customer.name, tin: s.customer.tin },
    asOf: s.asOf,
    open: s.open.map((r) => ({ type: r.type, number: r.number, issueDate: r.issueDate, dueDate: r.dueDate, daysOverdue: r.daysOverdue, total: r.total, paid: r.paid, credited: r.credited, balance: r.balance })),
    payments: s.payments.map((p) => ({ number: p.number, paidOn: p.paidOn, method: p.method, reference: p.reference, amount: p.amount })),
    totalDue: s.totalDue,
    overdue: s.overdue,
    note: settings.instructions.trim() || null,
  });
}

const customerKey = { type: 'string', minLength: 3, maxLength: 310, pattern: '^(c:[0-9a-fA-F-]{36}|t:\\d{6}|n:.+|walk-in)$' } as const;
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'customer';

// ---------- routes ----------

export function registerReceivableRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'payments.record')) requirePermission(request, 'reports.view');
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReceivableError) throw new ApiError(422, 'invalid_payment', e.message);
      throw e;
    }
  };

  app.get<{ Params: { id: string } }>('/documents/:id/payments', { schema: { params: idParams } }, async (request) => {
    canRead(request);
    const doc = (await db.query('select id from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!doc) throw notFound('Document');
    const r = await receivable(db, request.tenantId, request.params.id);
    return { invoice: r ? receivableJson(r) : null, payments: (await paymentsFor(db, request.tenantId, request.params.id)).map(paymentJson) };
  });

  app.post<{ Params: { id: string }; Body: { amount: string; method: PaymentMethod; reference?: string; paidOn?: string; note?: string } }>(
    '/documents/:id/payments',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['amount', 'method'],
          additionalProperties: false,
          properties: {
            amount: money,
            method: { type: 'string', enum: [...PAYMENT_METHODS] },
            reference: { type: 'string', maxLength: 100 },
            paidOn: dateSchema,
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'payments.record');
      const b = request.body;
      const doc = (await db.query('select id from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
      if (!doc) throw notFound('Document');
      const { payment, receivable: after } = await wrap(() => recordPayment(db, request.tenantId, request.params.id, {
        amountCents: parseCents(b.amount), method: b.method,
        ...(b.reference !== undefined && { reference: b.reference }), ...(b.paidOn && { paidOn: b.paidOn }), ...(b.note !== undefined && { note: b.note }),
      }, request.userId || null));
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'payment.recorded', target: after.number, details: { amount: paymentJson(payment).amount, method: b.method }, ip: request.ip });
      return reply.code(201).send({ payment: paymentJson(payment), invoice: receivableJson(after) });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/payments/:id/void',
    { schema: { params: idParams, body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 300 } } } } },
    async (request) => {
      requirePermission(request, 'payments.record');
      const p = await wrap(() => voidPayment(db, request.tenantId, request.params.id, request.body.reason, request.userId || null));
      const r = await receivable(db, request.tenantId, p.document_id);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'payment.voided', target: r?.number ?? p.document_id, details: { amount: paymentJson(p).amount, reason: request.body.reason }, ip: request.ip });
      return { payment: paymentJson(p), invoice: r ? receivableJson(r) : null };
    },
  );

  app.post<{ Params: { id: string }; Body: { to?: string } }>(
    '/documents/:id/remind',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { to: { type: 'string', format: 'email', maxLength: 254 } } } } },
    async (request) => {
      if (!can(request.principal, 'payments.record')) requirePermission(request, 'documents.send');
      requireMail(ctx);
      const r = await receivable(db, request.tenantId, request.params.id);
      if (!r) throw new ApiError(409, 'not_receivable', 'Only an authorized tax invoice or debit note can be reminded');
      if (r.balanceCents <= 0n) throw new ApiError(409, 'already_paid', 'This invoice is already paid');
      const to = request.body?.to ?? r.customer.email;
      if (!to) throw new ApiError(422, 'no_email', 'This customer has no email address; enter one');
      if (await overLimit(db, `remind|${request.params.id}`, 10, 24 * 3600_000)) throw new ApiError(429, 'too_many_reminders', 'Enough reminders for this invoice today');
      await sendReminder(deps, ctx, request.tenantId, r, to, request.userId || null, await receivableSettings(db, request.tenantId));
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'invoice.reminded', target: r.number, details: { to }, ip: request.ip });
      return { sent: true, to };
    },
  );

  app.get('/receivables', async (request) => {
    canRead(request);
    const settings = await receivableSettings(db, request.tenantId);
    return {
      summary: await receivablesSummary(db, request.tenantId),
      ageing: await ageing(db, request.tenantId),
      buckets: AGE_BUCKETS,
      reminders: settings.reminders,
      onlinePayments: Boolean(await invoiceProvider(db, request.tenantId, settings)),
    };
  });

  app.get<{ Querystring: { status?: 'open' | 'overdue' | 'all'; customer?: string } }>(
    '/receivables/invoices',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'overdue', 'all'] }, customer: customerKey } } } },
    async (request) => {
      canRead(request);
      const status = request.query.status ?? 'open';
      const rows = await openReceivables(db, request.tenantId, { ...(request.query.customer && { customerKey: request.query.customer }), includePaid: status === 'all' });
      const filtered = status === 'overdue' ? rows.filter((r) => r.balanceCents > 0n && r.daysOverdue > 0) : status === 'open' ? rows.filter((r) => r.balanceCents > 0n) : rows;
      return { data: filtered.slice(0, 500).map(receivableJson) };
    },
  );

  app.get('/receivables/ageing.csv', async (request, reply) => {
    canRead(request);
    const a = await ageing(db, request.tenantId);
    const header = ['Customer', 'TIN', 'Email', 'Invoices', 'Oldest due', 'Current', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days', 'Total'];
    const lines = [header.map((h) => csvCell(h)).join(',')];
    for (const c of a.customers) {
      lines.push([csvCell(c.name), csvCell(c.tin ?? ''), csvCell(c.email ?? ''), csvCell(c.invoices, false), csvCell(c.oldestDue), ...AGE_BUCKETS.map((b) => csvCell(c.buckets[b], false)), csvCell(c.total, false)].join(','));
    }
    lines.push([csvCell('Total'), '', '', '', '', ...AGE_BUCKETS.map((b) => csvCell(a.totals[b], false)), csvCell(a.totals.total, false)].join(','));
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="ageing-${belizeToday()}.csv"`).send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  const statementQuery = { type: 'object', required: ['customer'], additionalProperties: false, properties: { customer: customerKey } } as const;

  app.get<{ Querystring: { customer: string } }>('/receivables/statement', { schema: { querystring: statementQuery } }, async (request) => {
    canRead(request);
    const s = await wrap(() => statement(db, request.tenantId, request.query.customer));
    return { ...s, open: s.open.map(receivableJson) };
  });

  app.get<{ Querystring: { customer: string } }>('/receivables/statement.pdf', { schema: { querystring: statementQuery } }, async (request, reply) => {
    canRead(request);
    const s = await wrap(() => statement(db, request.tenantId, request.query.customer));
    const pdf = await statementPdf(db, request.tenantId, s, await receivableSettings(db, request.tenantId));
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="statement-${fileSafe(s.customer.name)}-${s.asOf}.pdf"`).send(pdf);
  });

  app.post<{ Body: { customer: string; to?: string } }>(
    '/receivables/statement/send',
    { schema: { body: { type: 'object', required: ['customer'], additionalProperties: false, properties: { customer: customerKey, to: { type: 'string', format: 'email', maxLength: 254 } } } } },
    async (request) => {
      requirePermission(request, 'payments.record');
      requireMail(ctx);
      const s = await wrap(() => statement(db, request.tenantId, request.body.customer));
      const to = request.body.to ?? s.customer.email;
      if (!to) throw new ApiError(422, 'no_email', 'This customer has no email address; enter one');
      if (await overLimit(db, `statement|${request.tenantId}|${request.body.customer}`, 10, 24 * 3600_000)) throw new ApiError(429, 'too_many_statements', 'Enough statements for this customer today');
      const settings = await receivableSettings(db, request.tenantId);
      const biz = await business(db, request.tenantId);
      const provider = ctx.publicUrl ? await invoiceProvider(db, request.tenantId, settings) : null;
      const owed = s.open.filter((r) => r.balanceCents > 0n);
      const invoiceLines: string[] = [];
      for (const r of owed.slice(0, 30)) {
        const link = provider ? (await createShareLink(db, ctx, request.tenantId, r.documentId, request.userId || null)).payUrl : null;
        invoiceLines.push(`${docLabel(r)}: ${money2(r.balance)}, due ${longDate(r.dueDate)}${r.daysOverdue > 0 ? ` (${r.daysOverdue} days overdue)` : ''}${link ? `. Pay online: ${link}` : ''}`);
      }
      const paragraphs = [
        `Please find attached your statement of account from ${biz.name} as of ${longDate(s.asOf)}.`,
        owed.length ? `Total due: ${money2(s.totalDue)}${s.overdue !== '0.00' ? `, of which ${money2(s.overdue)} is overdue` : ''}.` : 'You have nothing to pay. Thank you.',
        ...invoiceLines,
        ...(settings.instructions.trim() ? [settings.instructions.trim()] : []),
      ];
      const pdf = await statementPdf(db, request.tenantId, s, settings);
      await ctx.mailer.send({
        to, replyTo: biz.email, subject: `Statement of account from ${biz.name}`,
        text: paragraphs.join('\n\n'), html: simpleHtml({ heading: 'Statement of account', paragraphs }),
        attachments: [{ filename: `statement-${s.asOf}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'statement.sent', target: s.customer.name, details: { to }, ip: request.ip });
      return { sent: true, to };
    },
  );

  app.get('/receivable-settings', async (request) => {
    canRead(request);
    const settings = await receivableSettings(db, request.tenantId);
    return { ...settings, onlineProvider: await invoiceProvider(db, request.tenantId, { ...settings, payOnline: true }) };
  });

  app.put<{ Body: ReceivableSettings }>(
    '/receivable-settings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reminders', 'payOnline', 'instructions'],
          additionalProperties: false,
          properties: {
            reminders: {
              type: 'object', required: ['enabled', 'offsets'], additionalProperties: false,
              properties: { enabled: { type: 'boolean' }, offsets: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'integer', minimum: -30, maximum: 365 } } },
            },
            payOnline: { type: 'boolean' },
            instructions: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      const value: ReceivableSettings = { reminders: { enabled: b.reminders.enabled, offsets: [...b.reminders.offsets].sort((x, y) => x - y) }, payOnline: b.payOnline, instructions: b.instructions.trim() };
      await db.query('update tenants set receivable_settings = $2 where id = $1', [request.tenantId, JSON.stringify(value)]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'receivables.settings_changed', details: { reminders: value.reminders.enabled, offsets: value.reminders.offsets, payOnline: value.payOnline }, ip: request.ip });
      return { ...value, onlineProvider: await invoiceProvider(db, request.tenantId, { ...value, payOnline: true }) };
    },
  );
}

// ---------- paying an invoice from its link (public) ----------

export function registerPayRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, options: { gatewayOptions: (tenantId: string) => Promise<GatewayOptions> }) {
  const { db } = deps;
  const tokenParams = { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } as const;
  const paymentParams = { type: 'object', required: ['token', 'id'], properties: { token: tokenParams.properties.token, id: uuid } } as const;

  const linked = async (token: string) => {
    const link = await shareLinkFor(db, token);
    if (!link) throw new ApiError(404, 'not_found', 'This link is not available. It may have expired; ask the business to send it again.');
    return link;
  };
  const gatewayFor_ = async (tenantId: string, provider: Provider, token: string) => {
    const base = await options.gatewayOptions(tenantId);
    return gatewayFor(db, tenantId, provider, { ...base, testPage: (paymentId) => `/pay/${token}?test=${paymentId}` });
  };

  app.get<{ Params: { token: string } }>('/:token', { schema: { params: tokenParams } }, async (request, reply) => {
    const link = await linked(request.params.token);
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
    const biz = await business(db, link.tenantId);
    const r = await receivable(db, link.tenantId, link.documentId);
    const doc = (await db.query<{ etd_type: string; series_number: number; serial: string; issue_date: string; status: string; payable_cents: unknown }>(
      'select etd_type, series_number, serial::text as serial, issue_date::text as issue_date, status, payable_cents from documents where id = $1', [link.documentId],
    )).rows[0]!;
    const settings = await receivableSettings(db, link.tenantId);
    const provider = r && r.balanceCents > 0n ? await invoiceProvider(db, link.tenantId, settings) : null;
    return {
      business: { name: biz.name, email: biz.email, telephone: biz.telephone },
      document: {
        type: doc.etd_type,
        number: `${String(doc.series_number).padStart(3, '0')}-${doc.serial.padStart(9, '0')}`,
        issueDate: doc.issue_date,
        valid: ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(doc.status),
      },
      invoice: r ? { customer: r.customer.name, dueDate: r.dueDate, total: r.total, paid: r.paid, credited: r.credited, balance: r.balance, status: r.status, daysOverdue: r.daysOverdue } : null,
      pdfUrl: `/d/${request.params.token}`,
      online: provider ? { provider } : null,
      instructions: settings.instructions || null,
    };
  });

  app.post<{ Params: { token: string } }>('/:token/start', { schema: { params: tokenParams } }, async (request) => {
    const link = await linked(request.params.token);
    const r = await receivable(db, link.tenantId, link.documentId);
    if (!r || r.balanceCents <= 0n) throw new ApiError(409, 'nothing_to_pay', 'There is nothing left to pay on this invoice');
    const provider = await invoiceProvider(db, link.tenantId);
    if (!provider) throw new ApiError(409, 'not_available', 'This business does not take online payments; see how to pay on the invoice');
    if (await overLimit(db, `invoice-pay|${link.documentId}`, 20, 3600_000)) throw new ApiError(429, 'too_many_attempts', 'Too many payment attempts for this invoice; try again later or contact the business');
    const base = ctx.publicUrl?.replace(/\/$/, '') ?? '';
    if (provider !== 'test' && !base) throw new ApiError(503, 'not_configured', 'Online payments are not available right now');
    const biz = await business(db, link.tenantId);
    const page = `${base}/pay/${request.params.token}`;
    try {
      const gateway = await gatewayFor_(link.tenantId, provider, request.params.token);
      const started = await startPayment(db, gateway, {
        tenantId: link.tenantId, documentId: link.documentId, amountCents: r.balanceCents,
        description: `${biz.name} ${docLabel(r).toLowerCase()}`, invoiceRef: `${link.tenantId.slice(0, 8)}-${r.number}`,
      }, { returnUrl: (paymentId) => `${page}?payment=${paymentId}`, cancelUrl: `${page}?cancelled=1` });
      return started;
    } catch (e) {
      if (e instanceof PaymentError) throw new ApiError(409, 'payment_unavailable', e.message);
      throw e;
    }
  });

  app.post<{ Params: { token: string; id: string } }>('/:token/payments/:id/confirm', { schema: { params: paymentParams } }, async (request) => {
    const link = await linked(request.params.token);
    const p = (await db.query<{ id: string; provider: Provider }>('select id, provider from order_payments where id = $1 and document_id = $2', [request.params.id, link.documentId])).rows[0];
    if (!p) throw notFound('Payment');
    const gateway = await gatewayFor_(link.tenantId, p.provider, request.params.token);
    const now = await confirmPayment(db, gateway, p.id);
    if (now.status === 'paid') await settlePayment(deps, ctx, now);
    const r = await receivable(db, link.tenantId, link.documentId);
    return { status: now.status, problem: (now.detail as { reason?: string } | null)?.reason ?? null, balance: r?.balance ?? null };
  });

  // The test gateway's pretend card page (BTS test environment only).
  const testPayment = async (token: string, id: string) => {
    const link = await linked(token);
    const p = (await db.query<{ id: string; status: string; amount_cents: unknown; detail: Record<string, unknown> | null }>(
      "select id, status, amount_cents, detail from order_payments where id = $1 and document_id = $2 and provider = 'test'", [id, link.documentId],
    )).rows[0];
    if (!p) throw notFound('Payment');
    return p;
  };
  app.get<{ Params: { token: string; id: string } }>('/:token/test/:id', { schema: { params: paymentParams } }, async (request) => {
    const p = await testPayment(request.params.token, request.params.id);
    return { amount: formatCents(toBigInt(p.amount_cents)), status: p.status, decided: Boolean(p.detail?.testDecision) };
  });
  app.post<{ Params: { token: string; id: string }; Body: { decision: 'approved' | 'declined' } }>(
    '/:token/test/:id',
    { schema: { params: paymentParams, body: { type: 'object', required: ['decision'], additionalProperties: false, properties: { decision: { type: 'string', enum: ['approved', 'declined'] } } } } },
    async (request) => {
      const p = await testPayment(request.params.token, request.params.id);
      if (p.status !== 'pending' || p.detail?.testDecision) throw new ApiError(409, 'conflict', 'This test payment was already decided');
      await db.query("update order_payments set detail = coalesce(detail, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1", [p.id, JSON.stringify({ testDecision: request.body.decision })]);
      return { ok: true };
    },
  );
}
