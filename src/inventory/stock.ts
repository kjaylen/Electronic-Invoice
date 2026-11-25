/**
 * Stock: every change to an item's level is a movement, written together with
 * the new level (in the same statement order, inside the caller's
 * transaction when there is one). Items whose stock is not tracked (null
 * level) have no movements, except the one that starts tracking.
 *
 * Sales on tax documents take stock off when issued; a sale whose document
 * is later rejected or cancelled is put back once (reverseVoidedSales).
 * Online orders reserve stock when placed and never take more than there is.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { emitEvent } from '../webhooks/emit.ts';
import { documentLocation, levelSql } from './locations.ts';

export type MovementReason = 'initial' | 'sale' | 'sale_reversed' | 'order' | 'order_cancelled' | 'refund' | 'receive' | 'count' | 'damaged' | 'lost' | 'returned' | 'other' | 'transfer_out' | 'transfer_in' | 'waste' | 'spillage';
export const ADJUST_REASONS = ['count', 'damaged', 'lost', 'returned', 'other'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export class StockError extends Error {
  override name = 'StockError';
}

/** A quantity for stock: up to 3 decimals. */
export function stockQuantity(v: string | number): string {
  let s = typeof v === 'number' ? String(v) : v.trim();
  // "1.000000" (a numeric column) is 1: trailing zeros do not count as decimals.
  if (/^-?\d+\.\d+$/.test(s)) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (!/^-?\d{1,12}(\.\d{1,3})?$/.test(s)) throw new StockError('Quantities have up to 3 decimals');
  return s;
}

export interface Movement {
  tenantId: string;
  itemId: string;
  /** How much to add (negative takes off), or the level to set ("set"). */
  quantity: string;
  mode?: 'change' | 'set';
  reason: MovementReason;
  documentId?: string | null;
  orderId?: string | null;
  receiptId?: string | null;
  reversesId?: string | null;
  /** For stock received: the cost of one unit before GST (updates the average cost). */
  unitCost?: string | null;
  note?: string | null;
  userId?: string | null;
  /** Start tracking an item that is not tracked yet (receiving, an opening count). */
  startTracking?: boolean;
  /** Where it happens, for a business with more than one shop. None, or the main location: the main one. With "set", the level set is this location's. */
  locationId?: string | null;
}

/**
 * Apply one movement, in one statement (the level, the average cost and the
 * movement row change together or not at all). Returns the new level, or
 * null when the item's stock is not tracked (nothing recorded) or, with
 * `atLeast`, when there is not enough.
 */
export async function moveStock(db: Queryable, m: Movement & { atLeast?: number }): Promise<{ id: string; balance: string; change: string } | null> {
  const q = stockQuantity(m.quantity);
  const id = randomUUID();
  const r = (await db.query<{ balance: string; change: string }>(
    // The item's level is the total the business owns. "loc" is the location this happens at when it is not
    // the main one; a count ("set") sets what is at that location, and the total follows by the difference.
    `with loc as (
       select id from locations where id = $16::uuid and tenant_id = $2::uuid and not is_main
     ), old as (
       select i.stock_quantity as s, ${levelSql('(select id from loc)')} as here
       from items i
       where i.id = $1 and i.tenant_id = $2 and (i.stock_quantity is not null or $7::boolean) and ($6::numeric is null or i.stock_quantity >= $6::numeric)
       for update of i
     ), d as (
       select old.s, old.here, case when $3::text = 'set' then $4::numeric - old.here else $4::numeric end as delta from old
     ), upd as (
       update items i set
         stock_quantity = coalesce(i.stock_quantity, 0) + d.delta,
         average_cost = case
           when $5::numeric is null then i.average_cost
           when coalesce(i.stock_quantity, 0) > 0 and i.average_cost is not null and coalesce(i.stock_quantity, 0) + d.delta > 0
             then round((i.stock_quantity * i.average_cost + d.delta * $5::numeric) / (i.stock_quantity + d.delta), 6)
           else $5::numeric end
       from d where i.id = $1 and i.tenant_id = $2
       returning i.stock_quantity as balance, d.delta as change, d.s is null as started, d.here + d.delta as here
     ), put as (
       insert into location_stock (location_id, item_id, tenant_id, quantity)
       select (select id from loc), $1::uuid, $2::uuid, upd.here from upd where (select id from loc) is not null
       on conflict (location_id, item_id) do update set quantity = excluded.quantity
     ), ins as (
       insert into stock_movements (id, tenant_id, item_id, change, balance_after, reason, document_id, order_id, receipt_id, reverses_id, unit_cost, note, created_by, location_id)
       select $8::uuid, $2::uuid, $1::uuid, upd.change, upd.balance, case when upd.started then 'initial' else $9::text end, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $5::numeric, $14::text, $15::uuid, (select id from loc)
       from upd
       returning id
     )
     select upd.balance::text as balance, upd.change::text as change from upd`,
    [m.itemId, m.tenantId, m.mode ?? 'change', q, m.unitCost ?? null, m.atLeast ?? null, Boolean(m.startTracking), id, m.reason, m.documentId ?? null, m.orderId ?? null,
      m.receiptId ?? null, m.reversesId ?? null, m.note?.trim() || null, m.userId ?? null, m.locationId ?? null],
  )).rows[0];
  // Tell the business's other systems (a site showing what is in stock) that the level changed.
  if (r && Number(r.change) !== 0) await emitEvent(db, m.tenantId, 'stock.changed', m.itemId);
  return r ? { id, balance: r.balance, change: r.change } : null;
}

/**
 * Reserve stock for an online order: never more than there is. Returns false
 * when it sold out (nothing changes); untracked items always succeed.
 */
export async function takeForOrder(db: Queryable, tenantId: string, itemId: string, quantity: number, orderId: string): Promise<boolean> {
  const item = (await db.query<{ stock: string | null }>('select stock_quantity::text as stock from items where id = $1 and tenant_id = $2', [itemId, tenantId])).rows[0];
  if (!item) return false;
  if (item.stock === null) return true;
  return Boolean(await moveStock(db, { tenantId, itemId, quantity: String(-quantity), reason: 'order', orderId, atLeast: quantity }));
}

/** Take a document's sold items off the shelf (tracked items only). */
export async function recordSale(db: Queryable, tenantId: string, documentId: string, lines: Array<{ itemId?: string | null; quantity: string }>, userId: string | null): Promise<number> {
  let moved = 0;
  const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => Boolean(x)))];
  // Sold at a till of another shop: it comes off that shop's shelf.
  const locationId = ids.length ? await documentLocation(db, documentId) : null;
  // A bundle sells its components (each its quantity per bundle), not itself.
  const parts = new Map<string, Array<{ id: string; quantity: number }>>();
  if (ids.length) {
    for (const c of (await db.query<{ item_id: string; component_id: string; quantity: string }>(
      'select c.item_id, c.component_id, c.quantity::text as quantity from item_components c join items i on i.id = c.item_id where i.tenant_id = $1 and c.item_id = any($2::uuid[])', [tenantId, ids],
    )).rows) {
      const list = parts.get(c.item_id) ?? [];
      list.push({ id: c.component_id, quantity: Number(c.quantity) });
      parts.set(c.item_id, list);
    }
  }
  for (const l of lines) {
    if (!l.itemId || !/^\d{1,12}(\.\d{1,6})?$/.test(l.quantity)) continue;
    const take = parts.get(l.itemId)?.map((p) => ({ id: p.id, quantity: Number(l.quantity) * p.quantity })) ?? [{ id: l.itemId, quantity: Number(l.quantity) }];
    for (const t of take) {
      const qty = (Math.round(t.quantity * 1000) / 1000).toFixed(3);
      if (await moveStock(db, { tenantId, itemId: t.id, quantity: `-${qty}`, reason: 'sale', documentId, userId, locationId })) moved++;
    }
  }
  return moved;
}

/**
 * Put back what was sold on documents that turned out rejected or cancelled
 * (once each; the unique reversal link guarantees it across processes).
 * A document replaced by its contingency reissue keeps its sale: the reissue
 * is the same sale.
 */
export async function reverseVoidedSales(db: Queryable, options: { documentId?: string; limit?: number } = {}): Promise<number> {
  const rows = (await db.query<{ id: string; tenant_id: string; item_id: string; change: string; status: string; location_id: string | null }>(
    `select m.id, m.tenant_id, m.item_id, m.change::text as change, d.status, m.location_id from stock_movements m join documents d on d.id = m.document_id
     where m.reason = 'sale' and d.status in ('rejected', 'cancelled') and ($1::uuid is null or m.document_id = $1)
       and not exists (select 1 from stock_movements r where r.reverses_id = m.id)
     order by m.created_at limit $2`,
    [options.documentId ?? null, options.limit ?? 500],
  )).rows;
  let n = 0;
  for (const r of rows) {
    try {
      const back = r.change.startsWith('-') ? r.change.slice(1) : `-${r.change}`;
      const done = await moveStock(db, {
        tenantId: r.tenant_id, itemId: r.item_id, quantity: back, reason: 'sale_reversed', reversesId: r.id, locationId: r.location_id,
        note: r.status === 'cancelled' ? 'Document cancelled' : 'Document rejected by BTS',
      });
      if (done) n++;
    } catch (e) {
      // Another process reversed it first (the unique link), or the item stopped being tracked.
      if (!/duplicate|unique/i.test(String((e as Error).message))) throw e;
    }
  }
  return n;
}
