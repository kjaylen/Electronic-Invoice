/**
 * Locations: a business with more than one shop keeps stock at each.
 *
 * items.stock_quantity is the total the business owns. location_stock holds
 * what is at every location but the main one; the main location has what is
 * left (the total, less the others, less what is on the way). A business
 * that never adds a location has no rows here and nothing changes for it.
 *
 * A transfer takes stock off one location when sent and puts it on the other
 * when received; in between it is "on the way" and belongs to neither.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { StockError, stockQuantity } from './stock.ts';

export interface Location { id: string; name: string; main: boolean }

/** What is at one location, for `items i`: $loc is a parameter holding a location id that is not the main one, or null for the main one. */
export const levelSql = (loc: string) => `case when ${loc}::uuid is null
  then coalesce(i.stock_quantity, 0)
    - coalesce((select sum(ls.quantity) from location_stock ls where ls.item_id = i.id), 0)
    - coalesce((select sum(tl.quantity) from stock_transfer_lines tl join stock_transfers st on st.id = tl.transfer_id where tl.item_id = i.id and st.status = 'sent'), 0)
  else coalesce((select ls.quantity from location_stock ls where ls.item_id = i.id and ls.location_id = ${loc}::uuid), 0) end`;

export async function listLocations(db: Queryable, tenantId: string): Promise<Location[]> {
  return (await db.query<{ id: string; name: string; is_main: boolean }>(
    'select id, name, is_main from locations where tenant_id = $1 and archived_at is null order by is_main desc, lower(name)', [tenantId],
  )).rows.map((r) => ({ id: r.id, name: r.name, main: r.is_main }));
}

/**
 * The location to keep stock under: null for the main one (or none given),
 * its id for any other. Throws when it is not one of the business's.
 */
export async function stockLocation(db: Queryable, tenantId: string, locationId: string | null | undefined): Promise<string | null> {
  if (!locationId) return null;
  const l = (await db.query<{ is_main: boolean }>('select is_main from locations where id = $1 and tenant_id = $2 and archived_at is null', [locationId, tenantId])).rows[0];
  if (!l) throw new StockError('That location is not one of yours');
  return l.is_main ? null : locationId;
}

/** Where a document was sold: the location of the drawer whose shift it went into (null: the main one). */
export async function documentLocation(db: Queryable, documentId: string): Promise<string | null> {
  const r = (await db.query<{ id: string | null }>(
    `select l.id from documents d join register_shifts s on s.id = d.shift_id join registers r on r.id = s.register_id
     join locations l on l.id = r.location_id and not l.is_main and l.archived_at is null where d.id = $1`, [documentId],
  )).rows[0];
  return r?.id ?? null;
}

/** For a list of items: what is at each location and on the way. Empty when the business has one shop. */
export async function levelsByLocation(db: Queryable, tenantId: string, items: Array<{ id: string; stock: number | null }>): Promise<{ locations: Location[]; levels: Map<string, { at: Record<string, number>; onTheWay: number }> }> {
  const locations = await listLocations(db, tenantId);
  const levels = new Map<string, { at: Record<string, number>; onTheWay: number }>();
  const main = locations.find((l) => l.main);
  if (!main || locations.length < 2 || !items.length) return { locations: locations.length > 1 ? locations : [], levels };
  const ids = items.map((i) => i.id);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  for (const i of items) if (i.stock !== null) levels.set(i.id, { at: { [main.id]: i.stock }, onTheWay: 0 });
  for (const r of (await db.query<{ item_id: string; location_id: string; quantity: string }>(
    'select item_id, location_id, quantity::text as quantity from location_stock where tenant_id = $1 and item_id = any($2::uuid[])', [tenantId, ids],
  )).rows) {
    const l = levels.get(r.item_id);
    if (!l) continue;
    l.at[r.location_id] = Number(r.quantity);
    l.at[main.id] = round(l.at[main.id]! - Number(r.quantity));
  }
  for (const r of (await db.query<{ item_id: string; quantity: string }>(
    `select tl.item_id, sum(tl.quantity)::text as quantity from stock_transfer_lines tl join stock_transfers st on st.id = tl.transfer_id
     where st.tenant_id = $1 and st.status = 'sent' and tl.item_id = any($2::uuid[]) group by tl.item_id`, [tenantId, ids],
  )).rows) {
    const l = levels.get(r.item_id);
    if (!l) continue;
    l.onTheWay = Number(r.quantity);
    l.at[main.id] = round(l.at[main.id]! - Number(r.quantity));
  }
  return { locations, levels };
}

/** One row of history for a transfer: the total does not change, only where it is. */
async function transferMovement(db: Queryable, tenantId: string, itemId: string, change: string, reason: 'transfer_out' | 'transfer_in', locationId: string | null, note: string, userId: string | null) {
  await db.query(
    `insert into stock_movements (id, tenant_id, item_id, change, balance_after, reason, note, created_by, location_id)
     select $1, $2, i.id, $4::numeric, coalesce(i.stock_quantity, 0), $5, $6, $7, $8 from items i where i.id = $3 and i.tenant_id = $2`,
    [randomUUID(), tenantId, itemId, change, reason, note, userId, locationId],
  );
}

const addAt = (db: Queryable, tenantId: string, locationId: string, itemId: string, quantity: string) => db.query(
  `insert into location_stock (location_id, item_id, tenant_id, quantity) values ($1, $2, $3, $4::numeric)
   on conflict (location_id, item_id) do update set quantity = location_stock.quantity + excluded.quantity`,
  [locationId, itemId, tenantId, quantity],
);

export interface TransferInput {
  tenantId: string;
  fromLocationId: string;
  toLocationId: string;
  lines: Array<{ itemId: string; quantity: string }>;
  note?: string | null;
  userId?: string | null;
}

export const transferNumber = (n: number) => `TR-${String(n).padStart(4, '0')}`;

/** Send stock from one location to another (call inside a transaction). Never more than is there. */
export async function sendTransfer(tx: Queryable, t: TransferInput): Promise<{ id: string; number: number }> {
  if (t.fromLocationId === t.toLocationId) throw new StockError('Choose two different locations');
  if (new Set(t.lines.map((l) => l.itemId)).size !== t.lines.length) throw new StockError('Each item once per transfer');
  const all = await listLocations(tx, t.tenantId);
  const from = all.find((l) => l.id === t.fromLocationId);
  const to = all.find((l) => l.id === t.toLocationId);
  if (!from || !to) throw new StockError('That location is not one of yours');
  const fromKey = from.main ? null : from.id;
  for (const l of t.lines) {
    const q = stockQuantity(l.quantity);
    if (Number(q) <= 0) throw new StockError('Quantities must be more than zero');
    const item = (await tx.query<{ name: string; tracked: boolean; here: string }>(
      `select i.name, i.stock_quantity is not null as tracked, (${levelSql('$3')})::text as here from items i where i.id = $1 and i.tenant_id = $2 and i.archived_at is null for update of i`,
      [l.itemId, t.tenantId, fromKey],
    )).rows[0];
    if (!item) throw new StockError('An item is not in your catalog');
    if (!item.tracked) throw new StockError(`${item.name}: its stock is not tracked, so there is nothing to move`);
    if (Number(item.here) < Number(q)) throw new StockError(`${item.name}: only ${Number(item.here)} at ${from.name}`);
  }
  const number = (await tx.query<{ n: number }>('update tenants set next_transfer_number = next_transfer_number + 1 where id = $1 returning next_transfer_number - 1 as n', [t.tenantId])).rows[0]!.n;
  const id = randomUUID();
  await tx.query('insert into stock_transfers (id, tenant_id, number, from_location_id, to_location_id, note, sent_by) values ($1, $2, $3, $4, $5, $6, $7)',
    [id, t.tenantId, number, from.id, to.id, t.note?.trim() || null, t.userId ?? null]);
  for (const l of t.lines) {
    const q = stockQuantity(l.quantity);
    await tx.query('insert into stock_transfer_lines (transfer_id, item_id, quantity) values ($1, $2, $3::numeric)', [id, l.itemId, q]);
    // Off the shelf it leaves. (The main location's level is what is left, and "on the way" already takes it off.)
    if (fromKey) await addAt(tx, t.tenantId, fromKey, l.itemId, `-${q}`);
    await transferMovement(tx, t.tenantId, l.itemId, `-${q}`, 'transfer_out', fromKey, `${transferNumber(number)} to ${to.name}`, t.userId ?? null);
  }
  return { id, number };
}

/** Finish a transfer that is on the way: received at its destination, or cancelled and back where it came from. */
export async function closeTransfer(tx: Queryable, tenantId: string, transferId: string, how: 'received' | 'cancelled', userId: string | null): Promise<boolean> {
  const t = (await tx.query<{ number: number; from_location_id: string; to_location_id: string }>(
    `update stock_transfers set status = $3, ${how === 'received' ? 'received_by = $4, received_at = now()' : 'cancelled_by = $4, cancelled_at = now()'}
     where id = $1 and tenant_id = $2 and status = 'sent' returning number, from_location_id, to_location_id`,
    [transferId, tenantId, how, userId],
  )).rows[0];
  if (!t) return false;
  const lands = how === 'received' ? t.to_location_id : t.from_location_id;
  const place = (await tx.query<{ name: string; is_main: boolean }>('select name, is_main from locations where id = $1', [lands])).rows[0]!;
  const origin = (await tx.query<{ name: string }>('select name from locations where id = $1', [t.from_location_id])).rows[0]!;
  const key = place.is_main ? null : lands;
  const lines = (await tx.query<{ item_id: string; quantity: string }>('select item_id, quantity::text as quantity from stock_transfer_lines where transfer_id = $1', [transferId])).rows;
  for (const l of lines) {
    if (key) await addAt(tx, tenantId, key, l.item_id, l.quantity);
    await transferMovement(tx, tenantId, l.item_id, l.quantity, 'transfer_in', key, how === 'received' ? `${transferNumber(t.number)} from ${origin.name}` : `${transferNumber(t.number)} cancelled`, userId);
  }
  return true;
}
