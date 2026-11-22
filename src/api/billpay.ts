/**
 * Belize Bank bill payments.
 *
 * For the business (signed in):
 *   GET  /v1/bill-payments           set up or not, the addresses to give the bank, recent events
 *   POST /v1/bill-payments           turn on, or issue a new token { referenceField } → the token, shown once
 *   PUT  /v1/bill-payments           { referenceField, enabled }
 *
 * For the bank (bearer token), per business:
 *   POST /v1/billpay/:slug/validate  is this invoice number right, and how much is owed?
 *   POST /v1/billpay/:slug/post      a payment was taken
 *   POST /v1/billpay/:slug/reconcile the day's payments
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { authenticateBillPay, billPayAccount, issueBillPayToken, postBillPayment, reconcileBillPayments, validateBillPayment } from '../receivables/billpay.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';

const fieldSchema = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' } as const;

export function registerBillPaySettingsRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const describe = async (tenantId: string) => {
    const account = await billPayAccount(db, tenantId);
    const slug = (await db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
    const base = ctx.publicUrl ? `${ctx.publicUrl.replace(/\/$/, '')}/v1/billpay/${slug}` : null;
    const events = (await db.query<{ id: string; kind: string; bank_reference: string | null; reference: string | null; amount_cents: unknown; outcome: string; created_at: Date | string }>(
      `select id, kind, bank_reference, reference, amount_cents, outcome, created_at from bill_payment_events
       where tenant_id = $1 and outcome in ('unmatched', 'ambiguous', 'invalid') order by created_at desc limit 20`, [tenantId],
    )).rows;
    const recent = (await db.query<{ n: number; cents: unknown }>(
      "select count(*)::int as n, coalesce(sum(amount_cents), 0) as cents from invoice_payments where tenant_id = $1 and external_id like 'bbl:%' and voided_at is null and created_at > now() - interval '30 days'", [tenantId],
    )).rows[0]!;
    return {
      enabled: Boolean(account?.enabled),
      configured: Boolean(account),
      referenceField: account?.referenceField ?? 'referenceNumber',
      lastSeenAt: account?.lastSeenAt ?? null,
      urls: base ? { validate: `${base}/validate`, post: `${base}/post`, reconcile: `${base}/reconcile` } : null,
      last30Days: { payments: recent.n, amount: formatCents(toBigInt(recent.cents)) },
      problems: events.map((e) => ({
        id: e.id, kind: e.kind, bankReference: e.bank_reference, reference: e.reference,
        amount: e.amount_cents === null ? null : formatCents(toBigInt(e.amount_cents)), outcome: e.outcome, createdAt: new Date(e.created_at).toISOString(),
      })),
    };
  };

  app.get('/bill-payments', async (request) => {
    requirePermission(request, 'business.manage');
    return describe(request.tenantId);
  });

  app.post<{ Body: { referenceField?: string } | undefined }>(
    '/bill-payments',
    { schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: { referenceField: fieldSchema } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const current = await billPayAccount(db, request.tenantId);
      const token = await issueBillPayToken(db, request.tenantId, request.body?.referenceField ?? current?.referenceField ?? 'referenceNumber');
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: current ? 'billpay.token_rotated' : 'billpay.enabled', ip: request.ip });
      return { ...(await describe(request.tenantId)), token };
    },
  );

  app.put<{ Body: { referenceField: string; enabled: boolean } }>(
    '/bill-payments',
    { schema: { body: { type: 'object', required: ['referenceField', 'enabled'], additionalProperties: false, properties: { referenceField: fieldSchema, enabled: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const r = await db.query('update bill_payment_accounts set reference_field = $2, enabled = $3, updated_at = now() where tenant_id = $1 returning tenant_id', [request.tenantId, request.body.referenceField, request.body.enabled]);
      if (!r.rows.length) throw new ApiError(409, 'not_set_up', 'Turn bill payments on first');
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: request.body.enabled ? 'billpay.settings_changed' : 'billpay.disabled', ip: request.ip });
      return describe(request.tenantId);
    },
  );
}

export function registerBillPayBankRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const params = { type: 'object', required: ['slug'], properties: { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' } } } as const;
  const bearer = (request: FastifyRequest) => {
    const h = request.headers.authorization;
    return typeof h === 'string' && /^Bearer\s+\S+$/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
  };
  const route = (path: string, handle: (tenantId: string, body: Record<string, unknown>, field: string) => Promise<Record<string, unknown>>) => {
    app.post<{ Params: { slug: string }; Body: unknown }>(`/:slug/${path}`, { schema: { params }, bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
      const who = await authenticateBillPay(db, request.params.slug, bearer(request));
      if (!who) return reply.code(401).send({ status: 1, displayInfo: 'Not authorized' });
      const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
      return reply.header('Cache-Control', 'no-store').send(await handle(who.tenantId, body, who.referenceField));
    });
  };
  route('validate', (tenantId, body, field) => validateBillPayment(db, tenantId, body, field));
  route('post', (tenantId, body, field) => postBillPayment(db, tenantId, body, field));
  route('reconcile', async (tenantId, body, field) => ({ status: (await reconcileBillPayments(db, tenantId, body, field)).status }));
}
