/**
 * Billable work, for businesses that sell services: time or jobs done for a
 * customer, logged as it happens and invoiced together later (a consultant's
 * hours, a repair job, a month of bookkeeping).
 *
 *   GET    /v1/work?customerId&status=unbilled|billed|all&from&to   entries (newest first) and what is still to invoice, by customer
 *   POST   /v1/work                 { customerId, date, description, quantity, unitCode?, itemId?, unitPrice?, gstCategory?, exemptionReasonCode? }
 *   PUT    /v1/work/:id             the same body; only while not invoiced
 *   DELETE /v1/work/:id             only while not invoiced
 *   POST   /v1/work/invoice         { customerId, entryIds?, dueDays?, note?, email? }: one tax invoice for them
 *
 * A service from the catalog fills in the price (before GST), unit and GST
 * category; the entry can set any of them itself. Invoicing issues one tax
 * invoice with a dated line per entry and marks them with it; if BTS rejects
 * the invoice they stay to be invoiced. While an invoice is being issued its
 * entries are claimed, so two people cannot bill the same work twice.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { type IssueBody, issueFromBody } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { emailInvoice } from './receivables.ts';
import { date as dateSchema, uuid } from './schemas.ts';

/** Documents that stand (or will, once BTS answers): their work is invoiced. */
const STANDING = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];
/** A claim older than this is a crashed attempt: the work can be invoiced again. */
const CLAIM_MS = 5 * 60_000;

const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const addDays = (isoDate: string, days: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface WorkRow {
  id: string;
  customer_id: string;
  customer_name: string;
  item_id: string | null;
  item_name: string | null;
  work_date: string;
  description: string;
  quantity: string;
  unit_code: string;
  unit_price: string;
  gst_category: 'S' | 'Z' | 'E';
  exemption_reason_code: string | null;
  amount: string;
  user_name: string | null;
  document_id: string | null;
  document_number: string | null;
  billed_at: string | Date | null;
}

const COLUMNS = `w.id, w.customer_id, c.name as customer_name, w.item_id, i.name as item_name, w.work_date::text as work_date, w.description,
  w.quantity::text as quantity, w.unit_code, w.unit_price::text as unit_price, w.gst_category, w.exemption_reason_code,
  round(w.quantity * w.unit_price, 2)::text as amount, u.name as user_name, w.document_id,
  (select lpad(d.series_number::text, 3, '0') || '-' || lpad(d.serial::text, 9, '0') from documents d where d.id = w.document_id) as document_number, w.billed_at`;
const FROM = `work_entries w join customers c on c.id = w.customer_id left join items i on i.id = w.item_id left join users u on u.id = w.user_id`;

/** "1.50" not "1.500000"; "40" not "40.000000". */
const trimNumber = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

const workJson = (r: WorkRow) => ({
  id: r.id,
  customer: { id: r.customer_id, name: r.customer_name },
  item: r.item_id ? { id: r.item_id, name: r.item_name } : null,
  date: r.work_date,
  description: r.description,
  quantity: trimNumber(r.quantity),
  unitCode: r.unit_code,
  unitPrice: trimNumber(r.unit_price),
  gstCategory: r.gst_category,
  exemptionReasonCode: r.exemption_reason_code,
  /** Before GST. */
  amount: r.amount,
  by: r.user_name,
  invoice: r.document_id ? { documentId: r.document_id, number: r.document_number, at: r.billed_at ? new Date(r.billed_at).toISOString() : null } : null,
});

type WorkBody = { customerId: string; date: string; description: string; quantity: string; unitCode?: string; itemId?: string | null; unitPrice?: string; gstCategory?: 'S' | 'Z' | 'E'; exemptionReasonCode?: string | null };

export function registerWorkRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, extras: { ekyash?: { sandboxUrl?: string; liveUrl?: string } } = {}) {
  const { db } = deps;
  const canSee = (request: FastifyRequest) => {
    if (!can(request.principal, 'documents.issue')) requirePermission(request, 'reports.view');
  };
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const workSchema = {
    type: 'object',
    required: ['customerId', 'date', 'description', 'quantity'],
    additionalProperties: false,
    properties: {
      customerId: uuid,
      date: dateSchema,
      description: { type: 'string', minLength: 1, maxLength: 300 },
      quantity: { type: 'string', pattern: '^\\d{1,8}(\\.\\d{1,2})?$' },
      unitCode: { type: 'string', pattern: '^[A-Z0-9]{1,3}$' },
      itemId: { anyOf: [uuid, { type: 'null' }] },
      unitPrice: { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,4})?$' },
      gstCategory: { type: 'string', enum: ['S', 'Z', 'E'] },
      exemptionReasonCode: { type: ['string', 'null'], maxLength: 10 },
    },
  } as const;

  const loadEntry = async (tenantId: string, id: string) => {
    const r = (await db.query<WorkRow>(`select ${COLUMNS} from ${FROM} where w.id = $1 and w.tenant_id = $2`, [id, tenantId])).rows[0];
    if (!r) throw notFound('Work entry');
    return r;
  };

  /** What an entry stores: the body, with the service's price, unit and GST where the body leaves them out. */
  const resolve = async (tenantId: string, b: WorkBody) => {
    if (Number(b.quantity) <= 0) throw new ApiError(422, 'invalid_quantity', 'Enter how much work: more than 0');
    const customer = (await db.query('select 1 from customers where id = $1 and tenant_id = $2', [b.customerId, tenantId])).rows[0];
    if (!customer) throw new ApiError(422, 'unknown_customer', 'Choose one of your customers');
    let item: { unit_price: string; unit_code: string; gst_category: 'S' | 'Z' | 'E'; exemption_reason_code: string | null } | undefined;
    if (b.itemId) {
      item = (await db.query<NonNullable<typeof item>>('select unit_price::text as unit_price, unit_code, gst_category, exemption_reason_code from items where id = $1 and tenant_id = $2 and archived_at is null', [b.itemId, tenantId])).rows[0];
      if (!item) throw new ApiError(422, 'unknown_item', 'Choose one of your services');
    }
    const unitPrice = b.unitPrice ?? item?.unit_price;
    if (unitPrice === undefined) throw new ApiError(422, 'price_required', 'Enter the rate, or choose a service from your catalog');
    const gstCategory = b.gstCategory ?? item?.gst_category ?? 'S';
    const exemption = gstCategory === 'E' ? (b.exemptionReasonCode ?? item?.exemption_reason_code ?? null) : null;
    if (gstCategory === 'E' && !exemption) throw new ApiError(422, 'exemption_reason_required', 'An exempt service needs its exemption reason');
    return { unitCode: b.unitCode ?? item?.unit_code ?? 'HUR', unitPrice, gstCategory, exemption };
  };

  app.get<{ Querystring: { customerId?: string; status?: 'unbilled' | 'billed' | 'all'; from?: string; to?: string } }>(
    '/work',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { customerId: uuid, status: { type: 'string', enum: ['unbilled', 'billed', 'all'] }, from: dateSchema, to: dateSchema } } } },
    async (request) => {
      canSee(request);
      const q = request.query;
      const params: unknown[] = [request.tenantId];
      let where = 'w.tenant_id = $1';
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where += ` and ${sql.replace('?', `$${params.length}`)}`;
      };
      if (q.customerId) add('w.customer_id = ?', q.customerId);
      if (q.from) add('w.work_date >= ?::date', q.from);
      if (q.to) add('w.work_date <= ?::date', q.to);
      const status = q.status ?? 'unbilled';
      if (status === 'unbilled') where += ' and w.document_id is null';
      if (status === 'billed') where += ' and w.document_id is not null';
      const rows = (await db.query<WorkRow>(`select ${COLUMNS} from ${FROM} where ${where} order by w.work_date desc, w.created_at desc limit 500`, params)).rows;
      // What is still to invoice, customer by customer (all of it, whatever the filter).
      const toInvoice = (await db.query<{ customer_id: string; name: string; email: string | null; entries: number; hours: string; amount: string; oldest: string }>(
        `select w.customer_id, c.name, c.email, count(*)::int as entries,
           coalesce(sum(w.quantity) filter (where w.unit_code = 'HUR'), 0)::text as hours,
           sum(round(w.quantity * w.unit_price, 2))::text as amount, min(w.work_date)::text as oldest
         from work_entries w join customers c on c.id = w.customer_id
         where w.tenant_id = $1 and w.document_id is null
         group by w.customer_id, c.name, c.email order by min(w.work_date)`,
        [request.tenantId],
      )).rows;
      return {
        data: rows.map(workJson),
        toInvoice: toInvoice.map((r) => ({ customer: { id: r.customer_id, name: r.name, email: r.email }, entries: r.entries, hours: trimNumber(r.hours), amount: r.amount, oldest: r.oldest })),
      };
    },
  );

  app.post<{ Body: WorkBody }>('/work', { schema: { body: workSchema } }, async (request, reply) => {
    requirePermission(request, 'documents.issue');
    const b = request.body;
    const r = await resolve(request.tenantId, b);
    const id = randomUUID();
    await db.query(
      `insert into work_entries (id, tenant_id, customer_id, user_id, item_id, work_date, description, quantity, unit_code, unit_price, gst_category, exemption_reason_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, request.tenantId, b.customerId, request.userId || null, b.itemId ?? null, b.date, b.description.trim(), b.quantity, r.unitCode, r.unitPrice, r.gstCategory, r.exemption],
    );
    return reply.code(201).send(workJson(await loadEntry(request.tenantId, id)));
  });

  app.put<{ Params: { id: string }; Body: WorkBody }>('/work/:id', { schema: { params: idParams, body: workSchema } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const b = request.body;
    const r = await resolve(request.tenantId, b);
    const updated = await db.query(
      `update work_entries set customer_id = $3, item_id = $4, work_date = $5, description = $6, quantity = $7, unit_code = $8, unit_price = $9, gst_category = $10, exemption_reason_code = $11
       where id = $1 and tenant_id = $2 and document_id is null and invoicing_at is null returning id`,
      [request.params.id, request.tenantId, b.customerId, b.itemId ?? null, b.date, b.description.trim(), b.quantity, r.unitCode, r.unitPrice, r.gstCategory, r.exemption],
    );
    if (!updated.rows.length) {
      await loadEntry(request.tenantId, request.params.id);
      throw new ApiError(409, 'already_invoiced', 'This work is already on an invoice');
    }
    return workJson(await loadEntry(request.tenantId, request.params.id));
  });

  app.delete<{ Params: { id: string } }>('/work/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'documents.issue');
    const deleted = await db.query('delete from work_entries where id = $1 and tenant_id = $2 and document_id is null and invoicing_at is null returning id', [request.params.id, request.tenantId]);
    if (!deleted.rows.length) {
      await loadEntry(request.tenantId, request.params.id);
      throw new ApiError(409, 'already_invoiced', 'This work is already on an invoice');
    }
    return reply.code(204).send();
  });

  app.post<{ Body: { customerId: string; entryIds?: string[]; dueDays?: number; note?: string; email?: boolean } }>(
    '/work/invoice',
    {
      schema: {
        body: {
          type: 'object', required: ['customerId'], additionalProperties: false,
          properties: {
            customerId: uuid,
            entryIds: { type: 'array', items: uuid, minItems: 1, maxItems: 200 },
            dueDays: { type: 'integer', minimum: 0, maximum: 365 },
            note: { type: 'string', maxLength: 500 },
            email: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const { tenantId } = request;
      const b = request.body;
      const customer = (await db.query<{ id: string; email: string | null; withholds_contract_tax: boolean }>('select id, email, withholds_contract_tax from customers where id = $1 and tenant_id = $2', [b.customerId, tenantId])).rows[0];
      if (!customer) throw notFound('Customer');
      // Claim the work first: nobody else can invoice it meanwhile.
      const params: unknown[] = [tenantId, b.customerId, new Date(Date.now() - CLAIM_MS).toISOString()];
      let only = '';
      if (b.entryIds) {
        params.push(b.entryIds);
        only = ` and id = any($${params.length}::uuid[])`;
      }
      const claimed = (await db.query<{ id: string }>(
        `update work_entries set invoicing_at = now()
         where tenant_id = $1 and customer_id = $2 and document_id is null and (invoicing_at is null or invoicing_at < $3)${only} returning id`,
        params,
      )).rows.map((r) => r.id);
      if (!claimed.length) throw new ApiError(409, 'nothing_to_invoice', 'There is no work left to invoice for this customer');
      if (b.entryIds && claimed.length !== b.entryIds.length) {
        await db.query('update work_entries set invoicing_at = null where id = any($1::uuid[]) and document_id is null', [claimed]);
        throw new ApiError(409, 'work_changed', 'Some of this work is already invoiced, or being invoiced; refresh and try again');
      }
      const release = () => db.query('update work_entries set invoicing_at = null where id = any($1::uuid[]) and document_id is null', [claimed]);
      try {
        const entries = (await db.query<WorkRow>(`select ${COLUMNS} from ${FROM} where w.id = any($1::uuid[]) order by w.work_date, w.created_at`, [claimed])).rows;
        const dueDays = b.dueDays ?? 30;
        const body: IssueBody = {
          type: '01',
          customerId: b.customerId,
          lines: entries.map((e) => ({
            description: `${e.work_date} · ${e.description}`,
            quantity: trimNumber(e.quantity),
            unitCode: e.unit_code,
            unitPrice: trimNumber(e.unit_price),
            gstCategory: e.gst_category,
            ...(e.exemption_reason_code && { exemptionReasonCode: e.exemption_reason_code }),
          })),
          payment: { meansCode: '30', dueDate: addDays(belizeToday(), dueDays), terms: dueDays ? `Net ${dueDays}` : 'Due on receipt' },
          ...(customer.withholds_contract_tax && { contractTax: true }),
          ...(b.note?.trim() && { note: b.note.trim() }),
        };
        const result = await issueFromBody(deps, tenantId, body, request.userId || null);
        if (!STANDING.includes(result.status)) {
          await release();
          return { ...result, invoiced: 0 };
        }
        await db.query('update work_entries set document_id = $2, billed_at = now(), invoicing_at = null where id = any($1::uuid[])', [claimed, result.documentId]);
        await audit(db, { tenantId, userId: request.userId || null, action: 'work.invoiced', details: { entries: claimed.length, documentId: result.documentId }, ip: request.ip });
        let emailed: string | null = null;
        if (b.email && customer.email && ctx.mailConfigured && result.status !== 'pending') {
          emailed = await emailInvoice(deps, ctx, tenantId, result.documentId, customer.email, { userId: request.userId || null, ...(extras.ekyash && { ekyash: extras.ekyash }) }).then(() => customer.email).catch(() => null);
        }
        return { ...result, invoiced: claimed.length, emailed };
      } catch (e) {
        await release();
        throw e;
      }
    },
  );
}
