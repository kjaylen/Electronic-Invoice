/**
 * Layaway: goods put aside for a customer who pays over time.
 *
 * A layaway is a tax invoice on a saved customer's account whose goods stay
 * in the shop until it is paid. It is started at the counter (a sale "on
 * account" with `layaway` on POST /v1/documents: until when the goods are
 * kept, and the deposit paid now). After that:
 *
 *   GET  /v1/layaways?status=open|collected|cancelled|all   the list: what is owed, until when, what is in it
 *   POST /v1/layaways/:id/collect   the customer takes the goods (only when nothing is owed)
 *   POST /v1/layaways/:id/cancel    { refundMethod }  a credit note for the whole invoice, the goods back on the
 *                                   shelf, and what was paid given back
 *
 * Payments in between are ordinary invoice payments (POST /v1/documents/:id/payments),
 * so they are in Getting paid, on statements and in the shift's takings like any other.
 *
 * The invoice carries the GST from the day it is issued. Whether BTS expects
 * it then or when the goods are handed over is for the business's accountant;
 * issuing the invoice first is the careful reading (see DECISIONS.md).
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import { moveStock } from '../inventory/stock.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { type PaymentMethod, receivable, recordPayment } from '../receivables/receivables.ts';
import { type IssueBody, issueFromBody, resolveBody } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

export interface LayawayInput {
  /** The goods are kept until this day (YYYY-MM-DD). */
  holdUntil: string;
  /** Paid now. */
  deposit?: { amount: string; method: PaymentMethod; reference?: string };
  note?: string;
}

/** The longest a layaway may run. */
export const MAX_HOLD_DAYS = 366;
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

/** Check what a layaway needs before anything is issued. */
export function checkLayaway(body: IssueBody, input: LayawayInput): void {
  if (body.type !== '01') throw new ApiError(422, 'invalid_layaway', 'A layaway is a sale on account: a tax invoice');
  if (!body.customerId) throw new ApiError(422, 'invalid_layaway', 'A layaway needs a saved customer, so the shop knows whose goods they are');
  const now = today();
  if (input.holdUntil <= now) throw new ApiError(422, 'invalid_layaway', 'Keep the goods until a day after today');
  if ((Date.parse(input.holdUntil) - Date.parse(now)) / 86_400_000 > MAX_HOLD_DAYS) throw new ApiError(422, 'invalid_layaway', 'A layaway runs a year at most');
}

/** After its invoice is issued: remember it is a layaway, and record the deposit. */
export async function startLayaway(deps: PipelineDeps, tenantId: string, documentId: string, body: IssueBody, input: LayawayInput, userId: string | null, deviceId: string | null): Promise<void> {
  const { db } = deps;
  // The lines as sold, each written out, so a cancellation credits exactly what was sold.
  const resolved = await resolveBody(deps, tenantId, { ...body, layaway: undefined } as IssueBody);
  await db.query(
    `insert into layaways (document_id, tenant_id, customer_id, hold_until, lines, note, created_by) values ($1, $2, $3, $4, $5, $6, $7) on conflict (document_id) do nothing`,
    [documentId, tenantId, body.customerId ?? null, input.holdUntil, JSON.stringify(resolved.body.lines), input.note?.trim() || null, userId],
  );
  const deposit = input.deposit;
  if (deposit) {
    const open = await receivable(db, tenantId, documentId);
    const cents = toCents(deposit.amount);
    if (open && cents > 0n) {
      await recordPayment(db, tenantId, documentId, { amountCents: cents > open.balanceCents ? open.balanceCents : cents, method: deposit.method, reference: deposit.reference ?? null, paidOn: open.issueDate, note: 'Layaway deposit' }, userId, { deviceId });
    }
  }
}

const toCents = (amount: string): bigint => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};

interface Row {
  document_id: string; hold_until: string; status: 'open' | 'collected' | 'cancelled'; note: string | null; created_at: Date | string; collected_at: Date | string | null; cancelled_at: Date | string | null;
  refund_cents: unknown; lines: IssueBody['lines']; customer_id: string | null; customer_name: string | null; customer_phone: string | null;
  series_number: number; serial: string; payable_cents: unknown; doc_status: string; days_left: number; created_by_name: string | null;
}

async function load(db: Queryable, tenantId: string, where: string, params: unknown[]): Promise<Row[]> {
  return (await db.query<Row>(
    `select l.document_id, l.hold_until::text as hold_until, l.status, l.note, l.created_at, l.collected_at, l.cancelled_at, l.refund_cents, l.lines, l.customer_id,
       coalesce(c.name, d.customer_snapshot->>'name') as customer_name, c.telephone as customer_phone,
       d.series_number, d.serial::text as serial, d.payable_cents, d.status as doc_status, u.name as created_by_name,
       (l.hold_until - ((now() at time zone 'America/Belize')::date))::int as days_left
     from layaways l join documents d on d.id = l.document_id left join customers c on c.id = l.customer_id left join users u on u.id = l.created_by
     where l.tenant_id = $1 ${where}
     order by case l.status when 'open' then 0 else 1 end, l.hold_until, l.created_at desc limit 500`,
    [tenantId, ...params],
  )).rows;
}

async function json(db: Queryable, tenantId: string, r: Row) {
  const owed = await receivable(db, tenantId, r.document_id);
  const total = toBigInt(r.payable_cents);
  // A rejected or cancelled invoice is no longer a receivable: nothing is owed on it.
  const paid = owed ? owed.paid : '0.00';
  const balanceCents = owed ? owed.balanceCents : 0n;
  return {
    id: r.document_id,
    number: `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}`,
    status: r.status,
    customer: { id: r.customer_id, name: r.customer_name ?? 'Customer', phone: r.customer_phone },
    items: r.lines.map((l) => ({ description: l.description ?? '', quantity: l.quantity })),
    total: formatCents(total),
    paid,
    balance: formatCents(balanceCents > 0n ? balanceCents : 0n),
    /** Nothing is owed: the customer can take the goods. */
    ready: r.status === 'open' && balanceCents <= 0n && Boolean(owed),
    holdUntil: r.hold_until,
    daysLeft: r.days_left,
    note: r.note,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy: r.created_by_name,
    collectedAt: r.collected_at ? new Date(r.collected_at).toISOString() : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    refunded: r.refund_cents === null ? null : formatCents(toBigInt(r.refund_cents)),
  };
}

export function registerLayawayRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const one = async (tenantId: string, id: string) => {
    const r = (await load(db, tenantId, 'and l.document_id = $2', [id]))[0];
    if (!r) throw notFound('Layaway');
    return r;
  };

  app.get<{ Querystring: { status?: 'open' | 'collected' | 'cancelled' | 'all' } }>(
    '/layaways',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'collected', 'cancelled', 'all'] } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const status = request.query.status ?? 'open';
      const rows = await load(db, request.tenantId, status === 'all' ? '' : 'and l.status = $2', status === 'all' ? [] : [status]);
      const data = [];
      for (const r of rows) data.push(await json(db, request.tenantId, r));
      const open = data.filter((x) => x.status === 'open');
      return {
        data,
        summary: {
          open: open.length,
          owed: formatCents(open.reduce((a, x) => a + toCents(x.balance), 0n)),
          ready: open.filter((x) => x.ready).length,
          expired: open.filter((x) => x.daysLeft < 0 && !x.ready).length,
        },
      };
    },
  );

  app.post<{ Params: { id: string } }>('/layaways/:id/collect', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const r = await one(request.tenantId, request.params.id);
    if (r.status !== 'open') throw new ApiError(409, 'not_open', r.status === 'collected' ? 'These goods were already collected' : 'This layaway was cancelled');
    const owed = await receivable(db, request.tenantId, r.document_id);
    if (!owed) throw new ApiError(409, 'not_open', 'Its invoice is not valid (BTS rejected it or it was cancelled). Start the layaway again.');
    if (owed.balanceCents > 0n) throw new ApiError(409, 'still_owed', `BZ$${owed.balance} is still owed. Take the payment first; the goods go when it is paid in full.`);
    await db.query(`update layaways set status = 'collected', collected_at = now(), collected_by = $3 where document_id = $1 and tenant_id = $2 and status = 'open'`, [r.document_id, request.tenantId, request.userId || null]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'layaway.collected', target: r.customer_name ?? r.document_id, details: { invoice: r.document_id }, ip: request.ip });
    return json(db, request.tenantId, await one(request.tenantId, request.params.id));
  });

  app.post<{ Params: { id: string }; Body: { refundMethod?: 'cash' | 'card' | 'bank_transfer' | 'online' | 'cheque' } | undefined }>(
    '/layaways/:id/cancel',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { refundMethod: { type: 'string', enum: ['cash', 'card', 'bank_transfer', 'online', 'cheque'] } } } } },
    async (request) => {
      // Giving money back and crediting an invoice: for those who may adjust documents.
      requirePermission(request, 'documents.adjust');
      const tenantId = request.tenantId;
      const userId = request.userId || null;
      const r = await one(tenantId, request.params.id);
      if (r.status !== 'open') throw new ApiError(409, 'not_open', r.status === 'collected' ? 'These goods were collected: take them back with a credit note from the invoice' : 'This layaway is already cancelled');
      // Claimed first, so two people cancelling at once make one credit note.
      const claimed = await db.query(`update layaways set status = 'cancelled', cancelled_at = now(), cancelled_by = $3 where document_id = $1 and tenant_id = $2 and status = 'open' returning document_id`, [r.document_id, tenantId, userId]);
      if (!claimed.rows.length) throw new ApiError(409, 'not_open', 'This layaway is already cancelled');
      const owed = await receivable(db, tenantId, r.document_id);
      let credit: string | null = null;
      let refund = 0n;
      try {
        if (owed) {
          const result = await issueFromBody(deps, tenantId, {
            type: '04', ...(r.customer_id && { customerId: r.customer_id }), lines: r.lines,
            reference: { documentId: r.document_id, reason: 'Layaway cancelled' },
            payment: { meansCode: '10', terms: 'Layaway cancelled; what was paid is given back' },
          }, userId, { deviceId: request.posDevice?.id ?? null, accountLimit: 'skip' });
          if (result.status === 'rejected') throw new ApiError(409, 'credit_rejected', 'BTS rejected the credit note, so the layaway stays open. Look at the credit note for why.');
          credit = result.documentId;
          // The goods go back on the shelf.
          for (const l of r.lines) {
            if (l.itemId) await moveStock(db, { tenantId, itemId: l.itemId, quantity: l.quantity, reason: 'returned', documentId: result.documentId, note: 'Layaway cancelled', userId });
          }
          // What was paid is given back: a payment the other way, so the customer's account and the drawer both show it.
          refund = toCents(owed.paid);
          if (refund > 0n) {
            await recordPayment(db, tenantId, r.document_id, { amountCents: -refund, method: request.body?.refundMethod ?? 'cash', paidOn: today(), note: 'Layaway cancelled: paid back' }, userId, { deviceId: request.posDevice?.id ?? null, refund: true });
          }
        }
      } catch (e) {
        if (!credit) await db.query(`update layaways set status = 'open', cancelled_at = null, cancelled_by = null where document_id = $1 and tenant_id = $2`, [r.document_id, tenantId]);
        throw e;
      }
      await db.query('update layaways set credit_document_id = $3, refund_cents = $4 where document_id = $1 and tenant_id = $2', [r.document_id, tenantId, credit, String(refund)]);
      await audit(db, { tenantId, userId, action: 'layaway.cancelled', target: r.customer_name ?? r.document_id, details: { invoice: r.document_id, creditNote: credit, refunded: formatCents(refund) }, ip: request.ip });
      return { ...(await json(db, tenantId, await one(tenantId, request.params.id))), creditNoteId: credit };
    },
  );
}
