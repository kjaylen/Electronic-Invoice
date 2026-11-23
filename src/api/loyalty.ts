/**
 * Loyalty points. Saved customers earn points on receipts and invoices (so many per BZ$1 paid) and
 * use them at the counter as a reward: a discount spread over the sale's lines so the customer
 * pays exactly the reward's value less (GST is then charged on what they actually pay, like any
 * discount). Credit notes take points back; a rejected or cancelled document gives back what it
 * used and takes back what it earned.
 *
 *   GET  /v1/loyalty-settings                 { enabled, earnRate, pointValue, minRedeem }
 *   PUT  /v1/loyalty-settings                 (owners and admins)
 *   GET  /v1/customers/:id/loyalty            balance, its value, recent entries
 *   POST /v1/customers/:id/loyalty/adjust     { points, note }: points given or taken by hand (managers and up)
 *
 * Issuing takes { redeemPoints } with a customerId (POST /v1/documents and its preview).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { calculateDocument, type LineInput } from '../engine/calc.ts';
import { formatCents, mul, parseDecimal, roundToCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

/** The reason on the discount lines a reward makes (also how they are told apart from other discounts). */
export const REWARD_REASON = 'Loyalty reward';

export interface LoyaltySettings {
  enabled: boolean;
  /** Points earned per BZ$1 paid (GST included). */
  earnRate: string;
  /** What one point is worth when used, in BZ$. */
  pointValue: string;
  /** The fewest points used at once. */
  minRedeem: number;
}
const DEFAULTS: LoyaltySettings = { enabled: false, earnRate: '1', pointValue: '0.05', minRedeem: 0 };
const COUNTED = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];

export async function loyaltySettings(db: Queryable, tenantId: string): Promise<LoyaltySettings> {
  const row = (await db.query<{ loyalty: Partial<LoyaltySettings> | null }>('select loyalty from tenants where id = $1', [tenantId])).rows[0];
  return { ...DEFAULTS, ...(row?.loyalty ?? {}) };
}

export async function loyaltyBalance(db: Queryable, tenantId: string, customerId: string): Promise<number> {
  return (await db.query<{ n: number }>('select coalesce(sum(points), 0)::int as n from loyalty_entries where tenant_id = $1 and customer_id = $2', [tenantId, customerId])).rows[0]!.n;
}

/** What so many points are worth, in cents. */
export const rewardCents = (points: number, s: LoyaltySettings) => roundToCents(mul(parseDecimal(String(points)), parseDecimal(s.pointValue)));

/**
 * Spread a reward over the lines as discounts: each line's share is the reward × its amount
 * before GST ÷ the sale's total with GST, so the total falls by the reward (to the cent).
 */
export function applyReward(lines: LineInput[], valueCents: bigint, tax: PipelineDeps['tax']): LineInput[] {
  const t = calculateDocument({ lines }, tax);
  const total = t.taxInclusiveAmount;
  if (valueCents > total) throw new ApiError(422, 'reward_too_large', `The reward (BZ$${formatCents(valueCents)}) is more than the sale (BZ$${formatCents(total)})`);
  let left = valueCents;
  const shares = t.lines.map((l) => (total > 0n ? (valueCents * l.netAmount * 2n + total) / (2n * total) : 0n));
  return lines.map((line, i) => {
    let share = shares[i]!;
    // Never more than the line itself, nor than what is left of the reward.
    share = share > t.lines[i]!.netAmount ? t.lines[i]!.netAmount : share;
    share = share > left ? left : share;
    left -= share;
    if (share <= 0n) return line;
    return { ...line, allowanceCharges: [...(line.allowanceCharges ?? []), { isCharge: false, reason: REWARD_REASON, amount: formatCents(share) }] };
  });
}

/** Points used on a sale: checked against the settings and the customer's balance. */
export async function checkRedeem(db: Queryable, tenantId: string, customerId: string | undefined, points: number, type: string) {
  const s = await loyaltySettings(db, tenantId);
  if (!s.enabled) throw new ApiError(422, 'loyalty_off', 'Loyalty points are turned off for this business');
  if (!customerId) throw new ApiError(422, 'invalid_document', 'Points are used by a saved customer: give customerId');
  if (type !== '01' && type !== '02') throw new ApiError(422, 'invalid_document', 'Points are used on receipts and invoices');
  if (points < s.minRedeem) throw new ApiError(422, 'not_enough_points', `Use at least ${s.minRedeem} points at a time`);
  return s;
}

/** After a document is issued (with legal value or on its way): points used, earned, or taken back by a credit note. */
export async function recordLoyalty(db: Queryable, tenantId: string, documentId: string, req: { etdType: string; customerId?: string; lines: LineInput[] }, redeemPoints: number | undefined, userId: string | null, tax: PipelineDeps['tax']) {
  const s = await loyaltySettings(db, tenantId);
  if (!s.enabled) return;
  const add = (customerId: string, points: number, reason: 'earned' | 'redeemed') => db.query(
    'insert into loyalty_entries (id, tenant_id, customer_id, points, reason, document_id, created_by) values ($1, $2, $3, $4, $5, $6, $7)',
    [randomUUID(), tenantId, customerId, points, reason, documentId, userId],
  );
  const total = calculateDocument({ lines: req.lines }, tax).taxInclusiveAmount;
  const earned = (cents: bigint) => Math.floor((Number(cents) / 100) * Number(s.earnRate));
  if ((req.etdType === '01' || req.etdType === '02') && req.customerId) {
    if (redeemPoints) await add(req.customerId, -redeemPoints, 'redeemed');
    const pts = earned(total);
    if (pts > 0) await add(req.customerId, pts, 'earned');
  } else if (req.etdType === '04') {
    // A credit note takes back the points its amount earned, from the customer of the document it credits.
    const original = (await db.query<{ customer_id: string | null }>(
      `select o.customer_id from documents c join documents o on o.tenant_id = c.tenant_id and o.etdui = c.referenced_etdui where c.id = $1`, [documentId],
    )).rows[0];
    const pts = earned(total);
    if (original?.customer_id && pts > 0) await add(original.customer_id, -pts, 'earned');
  }
}

/** Undo the points of documents that turned out rejected or cancelled (once each). */
export async function reverseVoidedLoyalty(db: Queryable, options: { documentId?: string; limit?: number } = {}): Promise<number> {
  const rows = (await db.query<{ id: string; tenant_id: string; customer_id: string; points: number; document_id: string }>(
    `select e.id, e.tenant_id, e.customer_id, e.points, e.document_id from loyalty_entries e join documents d on d.id = e.document_id
     where d.status in ('rejected', 'cancelled') and e.reason in ('earned', 'redeemed') and ($1::uuid is null or e.document_id = $1)
       and not exists (select 1 from loyalty_entries r where r.reverses_id = e.id)
     order by e.created_at limit $2`,
    [options.documentId ?? null, options.limit ?? 500],
  )).rows;
  let n = 0;
  for (const r of rows) {
    const done = await db.query(
      `insert into loyalty_entries (id, tenant_id, customer_id, points, reason, document_id, reverses_id, note)
       values ($1, $2, $3, $4, 'reversed', $5, $6, 'Document rejected or cancelled') on conflict (reverses_id) do nothing returning id`,
      [randomUUID(), r.tenant_id, r.customer_id, -r.points, r.document_id, r.id],
    );
    n += done.rows.length;
  }
  return n;
}

export function registerLoyaltyRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const canSee = (request: FastifyRequest) => {
    if (!can(request.principal, 'documents.issue') && !can(request.principal, 'catalog.manage')) requirePermission(request, 'reports.view');
  };

  app.get('/loyalty-settings', async (request) => {
    canSee(request);
    return loyaltySettings(db, request.tenantId);
  });

  app.put<{ Body: LoyaltySettings }>(
    '/loyalty-settings',
    {
      schema: {
        body: {
          type: 'object', required: ['enabled', 'earnRate', 'pointValue', 'minRedeem'], additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            earnRate: { type: 'string', pattern: '^\\d{1,4}(\\.\\d{1,2})?$' },
            pointValue: { type: 'string', pattern: '^\\d{1,4}(\\.\\d{1,4})?$' },
            minRedeem: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      if (b.enabled && (Number(b.earnRate) <= 0 || Number(b.pointValue) <= 0)) throw new ApiError(422, 'invalid_settings', 'Points earned and their value must be more than zero');
      await db.query('update tenants set loyalty = $2 where id = $1', [request.tenantId, JSON.stringify(b)]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'loyalty.settings', details: { ...b }, ip: request.ip });
      return loyaltySettings(db, request.tenantId);
    },
  );

  app.get<{ Params: { id: string } }>('/customers/:id/loyalty', { schema: { params: idParams } }, async (request) => {
    canSee(request);
    const s = await loyaltySettings(db, request.tenantId);
    const balance = await loyaltyBalance(db, request.tenantId, request.params.id);
    const entries = (await db.query<{ id: string; points: number; reason: string; note: string | null; created_at: Date; number: string | null; document_id: string | null }>(
      `select e.id, e.points, e.reason, e.note, e.created_at, e.document_id,
         case when d.id is null then null else lpad(d.series_number::text, 3, '0') || '-' || lpad(d.serial::text, 9, '0') end as number
       from loyalty_entries e left join documents d on d.id = e.document_id
       where e.tenant_id = $1 and e.customer_id = $2 order by e.created_at desc limit 50`, [request.tenantId, request.params.id],
    )).rows;
    return {
      enabled: s.enabled, balance, value: formatCents(rewardCents(Math.max(0, balance), s)), pointValue: s.pointValue, minRedeem: s.minRedeem,
      entries: entries.map((e) => ({ id: e.id, points: e.points, reason: e.reason, note: e.note, at: new Date(e.created_at).toISOString(), documentId: e.document_id, number: e.number })),
    };
  });

  app.post<{ Params: { id: string }; Body: { points: number; note: string } }>(
    '/customers/:id/loyalty/adjust',
    { schema: { params: idParams, body: { type: 'object', required: ['points', 'note'], additionalProperties: false, properties: { points: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 }, note: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      if (request.body.points === 0) throw new ApiError(422, 'invalid_points', 'Give or take at least one point');
      const c = (await db.query<{ name: string }>('select name from customers where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
      if (!c) throw new ApiError(404, 'not_found', 'Customer not found');
      const balance = await loyaltyBalance(db, request.tenantId, request.params.id);
      if (balance + request.body.points < 0) throw new ApiError(422, 'not_enough_points', `They have ${balance} points`);
      await db.query('insert into loyalty_entries (id, tenant_id, customer_id, points, reason, note, created_by) values ($1, $2, $3, $4, \'adjusted\', $5, $6)',
        [randomUUID(), request.tenantId, request.params.id, request.body.points, request.body.note.trim(), request.userId || null]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'loyalty.adjusted', target: c.name, details: { points: request.body.points, note: request.body.note.trim() }, ip: request.ip });
      return { balance: balance + request.body.points };
    },
  );
}
