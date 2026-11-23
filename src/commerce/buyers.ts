/**
 * Buyer accounts for the online store. A buyer signs in with a six-digit code
 * sent to their email: no password to keep or forget, and the first sign-in
 * makes the account. An account belongs to one store.
 *
 * Signed in, a buyer sees every order they placed at the store with that
 * email (as a guest too: the code proves the address is theirs), keeps
 * delivery addresses and their business's TIN for tax invoices, and checks
 * out with those filled in. Checking out as a guest stays possible.
 *
 * The code is tied to the browser that asked for it by a challenge only that
 * browser holds (the code's hash is keyed by it, so a database copy alone
 * cannot be used to find codes). It lasts ten minutes and allows five tries.
 * Wrong codes also count per email: after ten in a day no more codes go to
 * that address until the next day, so guessing stays hopeless.
 * Sessions last 90 days; only hashes of their tokens are stored.
 */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { countHit } from '../db/ratelimit.ts';
import type { DistrictCode } from '../engine/ubl.ts';
import { formatCents } from '../engine/decimal.ts';
import { toBigInt } from '../db/database.ts';

export const CODE_MINUTES = 10;
export const CODE_TRIES = 5;
export const BUYER_SESSION_DAYS = 90;
export const MAX_ADDRESSES = 10;
export const WRONG_CODES_PER_DAY = 10;
/** The rate-limit key counting wrong codes for an email at a store. */
export const wrongCodeKey = (tenantId: string, email: string) => `buyer-wrong|${tenantId}|${normalEmail(email)}`;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const codeHash = (challenge: string, code: string) => sha(`${challenge}:${code}`);

export class BuyerError extends Error {
  override name = 'BuyerError';
  readonly code: 'invalid_code' | 'code_expired' | 'not_found' | 'conflict';
  constructor(code: BuyerError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Buyer {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  phone: string | null;
  business: { tin: string; name: string } | null;
  createdAt: string;
}

export interface BuyerAddress {
  id: string;
  street: string;
  city: string;
  districtCode: DistrictCode;
  isDefault: boolean;
}

export interface AddressInput {
  street: string;
  city: string;
  districtCode: DistrictCode;
  isDefault?: boolean;
}

interface BuyerRow { id: string; tenant_id: string; email: string; name: string | null; phone: string | null; business_tin: string | null; business_name: string | null; created_at: Date | string }
const toBuyer = (r: BuyerRow): Buyer => ({
  id: r.id,
  tenantId: r.tenant_id,
  email: r.email,
  name: r.name,
  phone: r.phone,
  business: r.business_tin && r.business_name ? { tin: r.business_tin, name: r.business_name } : null,
  createdAt: new Date(r.created_at).toISOString(),
});

interface AddressRow { id: string; street: string; city: string; district_code: DistrictCode; is_default: boolean }
const toAddress = (r: AddressRow): BuyerAddress => ({ id: r.id, street: r.street, city: r.city, districtCode: r.district_code, isDefault: r.is_default });

export const normalEmail = (email: string) => email.trim().toLowerCase();

// ---------- signing in ----------

/** A new code for this email at this store: the challenge goes to the browser, the code into the email. */
export async function startSignIn(db: Queryable, tenantId: string, email: string): Promise<{ challenge: string; code: string }> {
  const challenge = randomBytes(24).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `insert into store_buyer_codes (challenge_hash, tenant_id, email, code_hash, expires_at)
     values ($1, $2, $3, $4, now() + $5::float8 * interval '1 minute')`,
    [sha(challenge), tenantId, normalEmail(email), codeHash(challenge, code), CODE_MINUTES],
  );
  return { challenge, code };
}

/** A code that was never sent (the email failed) is withdrawn. */
export async function withdrawCode(db: Queryable, challenge: string) {
  await db.query('delete from store_buyer_codes where challenge_hash = $1', [sha(challenge)]);
}

/**
 * The code from the email, from the browser that asked for it. Right: the
 * account (made now on the first sign-in) and a session token. Each wrong try
 * counts; after five the code stops working.
 */
export async function finishSignIn(db: Queryable, tenantId: string, challenge: string, code: string): Promise<{ buyer: Buyer; token: string; created: boolean }> {
  const tried = (await db.query<{ email: string; code_hash: string; attempts: number }>(
    `update store_buyer_codes set attempts = attempts + 1
     where challenge_hash = $1 and tenant_id = $2 and expires_at > now() and attempts < $3
     returning email, code_hash, attempts`,
    [sha(challenge), tenantId, CODE_TRIES],
  )).rows[0];
  if (!tried) throw new BuyerError('code_expired', 'This code has expired. Ask for a new one.');
  const given = Buffer.from(codeHash(challenge, code.replace(/\s/g, '')), 'hex');
  const expected = Buffer.from(tried.code_hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    if (await countHit(db, wrongCodeKey(tenantId, tried.email), 24 * 60 * 60 * 1000) >= WRONG_CODES_PER_DAY) {
      await db.query('delete from store_buyer_codes where tenant_id = $1 and email = $2', [tenantId, tried.email]);
      throw new BuyerError('code_expired', 'Too many wrong codes for this email today; try again tomorrow.');
    }
    if (tried.attempts >= CODE_TRIES) {
      await withdrawCode(db, challenge);
      throw new BuyerError('code_expired', 'Too many wrong tries. Ask for a new code.');
    }
    throw new BuyerError('invalid_code', 'That code is not right. Check the email and try again.');
  }
  // Used once: a second use (a double submit) finds nothing.
  if (!(await db.query('delete from store_buyer_codes where challenge_hash = $1 returning 1', [sha(challenge)])).rows.length) {
    throw new BuyerError('code_expired', 'This code has expired. Ask for a new one.');
  }
  const inserted = (await db.query<BuyerRow>(
    `insert into store_buyers (id, tenant_id, email) values ($1, $2, $3)
     on conflict (tenant_id, email) do nothing returning *`,
    [randomUUID(), tenantId, tried.email],
  )).rows[0];
  // A new account for someone who ordered here as a guest: their name and phone from the last order.
  const row = inserted
    ? (await db.query<BuyerRow>(
      `update store_buyers b set name = o.customer_name, phone = o.customer_phone
       from (select customer_name, customer_phone from orders where tenant_id = $2 and customer_email = $3 order by created_at desc limit 1) o
       where b.id = $1 returning b.*`,
      [inserted.id, tenantId, tried.email],
    )).rows[0] ?? inserted
    : (await db.query<BuyerRow>('select * from store_buyers where tenant_id = $1 and email = $2', [tenantId, tried.email])).rows[0]!;
  // Other codes for this address are done with.
  await db.query('delete from store_buyer_codes where tenant_id = $1 and email = $2', [tenantId, tried.email]);
  return { buyer: toBuyer(row), token: await createBuyerSession(db, tenantId, row.id), created: Boolean(inserted) };
}

export async function createBuyerSession(db: Queryable, tenantId: string, buyerId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into store_buyer_sessions (token_hash, tenant_id, buyer_id, expires_at) values ($1, $2, $3, now() + $4::float8 * interval '1 day')`,
    [sha(token), tenantId, buyerId, BUYER_SESSION_DAYS],
  );
  await db.query('update store_buyers set last_seen_at = now() where id = $1', [buyerId]);
  return token;
}

/** Who a session cookie belongs to at this store (null when it has ended or is another store's). */
export async function buyerFromToken(db: Queryable, tenantId: string, token: string): Promise<Buyer | null> {
  const r = (await db.query<BuyerRow & { session_seen: Date | string }>(
    `select b.*, s.last_seen_at as session_seen from store_buyer_sessions s join store_buyers b on b.id = s.buyer_id
     where s.token_hash = $1 and s.tenant_id = $2 and s.expires_at > now()`,
    [sha(token), tenantId],
  )).rows[0];
  if (!r) return null;
  // Seen: noted at most once an hour.
  if (Date.now() - new Date(r.session_seen).getTime() > 60 * 60 * 1000) {
    await db.query('update store_buyer_sessions set last_seen_at = now() where token_hash = $1', [sha(token)]);
    await db.query('update store_buyers set last_seen_at = now() where id = $1', [r.id]);
  }
  return toBuyer(r);
}

export async function endBuyerSession(db: Queryable, token: string) {
  await db.query('delete from store_buyer_sessions where token_hash = $1', [sha(token)]);
}

// ---------- the account ----------

export async function updateBuyer(db: Queryable, buyer: Buyer, input: { name: string; phone: string; business: { tin: string; name: string } | null }): Promise<Buyer> {
  const r = (await db.query<BuyerRow>(
    'update store_buyers set name = $2, phone = $3, business_tin = $4, business_name = $5 where id = $1 returning *',
    [buyer.id, input.name.trim() || null, input.phone.trim() || null, input.business?.tin ?? null, input.business?.name.trim() || null],
  )).rows[0]!;
  return toBuyer(r);
}

export async function listAddresses(db: Queryable, buyerId: string): Promise<BuyerAddress[]> {
  return (await db.query<AddressRow>(
    'select id, street, city, district_code, is_default from store_buyer_addresses where buyer_id = $1 order by is_default desc, created_at desc',
    [buyerId],
  )).rows.map(toAddress);
}

const sameAddress = (a: { street: string; city: string; districtCode: string }, b: { street: string; city: string; districtCode: string }) =>
  a.street.trim().toLowerCase() === b.street.trim().toLowerCase() && a.city.trim().toLowerCase() === b.city.trim().toLowerCase() && a.districtCode === b.districtCode;

/** Keep an address (the first one is the default). The same address again is the one already kept. */
export async function addAddress(db: Queryable, buyer: Buyer, input: AddressInput): Promise<BuyerAddress> {
  const existing = await listAddresses(db, buyer.id);
  const same = existing.find((a) => sameAddress(a, input));
  if (same) {
    if (input.isDefault && !same.isDefault) return setDefault(db, buyer, same.id);
    return same;
  }
  if (existing.length >= MAX_ADDRESSES) throw new BuyerError('conflict', `You can keep up to ${MAX_ADDRESSES} addresses; remove one first`);
  const isDefault = existing.length === 0 || Boolean(input.isDefault);
  if (isDefault) await db.query('update store_buyer_addresses set is_default = false where buyer_id = $1', [buyer.id]);
  const r = (await db.query<AddressRow>(
    `insert into store_buyer_addresses (id, tenant_id, buyer_id, street, city, district_code, is_default) values ($1, $2, $3, $4, $5, $6, $7)
     returning id, street, city, district_code, is_default`,
    [randomUUID(), buyer.tenantId, buyer.id, input.street.trim(), input.city.trim(), input.districtCode, isDefault],
  )).rows[0]!;
  return toAddress(r);
}

async function setDefault(db: Queryable, buyer: Buyer, id: string): Promise<BuyerAddress> {
  await db.query('update store_buyer_addresses set is_default = (id = $2) where buyer_id = $1', [buyer.id, id]);
  return (await listAddresses(db, buyer.id)).find((a) => a.id === id)!;
}

export async function updateAddress(db: Queryable, buyer: Buyer, id: string, input: AddressInput): Promise<BuyerAddress> {
  const r = (await db.query<AddressRow>(
    `update store_buyer_addresses set street = $3, city = $4, district_code = $5 where id = $1 and buyer_id = $2
     returning id, street, city, district_code, is_default`,
    [id, buyer.id, input.street.trim(), input.city.trim(), input.districtCode],
  )).rows[0];
  if (!r) throw new BuyerError('not_found', 'Address not found');
  return input.isDefault && !r.is_default ? setDefault(db, buyer, id) : toAddress(r);
}

/** Remove an address; when it was the default, the newest one left becomes the default. */
export async function removeAddress(db: Queryable, buyer: Buyer, id: string) {
  const r = (await db.query<{ is_default: boolean }>('delete from store_buyer_addresses where id = $1 and buyer_id = $2 returning is_default', [id, buyer.id])).rows[0];
  if (!r) throw new BuyerError('not_found', 'Address not found');
  if (r.is_default) {
    await db.query(
      `update store_buyer_addresses set is_default = true where id = (select id from store_buyer_addresses where buyer_id = $1 order by created_at desc limit 1)`,
      [buyer.id],
    );
  }
}

/** The account and its addresses go; the store keeps the orders (they are its sales records), without the link to the account. */
export async function deleteBuyer(db: Queryable, buyer: Buyer) {
  await db.query('update orders set buyer_id = null where buyer_id = $1', [buyer.id]);
  await db.query('delete from store_buyers where id = $1', [buyer.id]);
}

/** The buyer's orders at this store: placed signed in, or as a guest with the same email. */
export async function buyerOrders(db: Queryable, buyer: Buyer) {
  const rows = (await db.query<{ number: number; status: string; payment_status: string; fulfillment_status: string; fulfillment: string; total_cents: unknown; refunded_cents: unknown; items: number; ready_at: Date | null; created_at: Date | string }>(
    `select o.number, o.status, o.payment_status, o.fulfillment_status, o.fulfillment, o.total_cents, o.refunded_cents, o.ready_at, o.created_at,
       (select coalesce(round(sum(l.quantity)), 0) from order_lines l where l.order_id = o.id)::int as items
     from orders o where o.tenant_id = $1 and (o.buyer_id = $2 or o.customer_email = $3)
     order by o.created_at desc limit 200`,
    [buyer.tenantId, buyer.id, buyer.email],
  )).rows;
  return rows.map((r) => ({
    number: r.number,
    status: r.status,
    paymentStatus: r.payment_status,
    fulfillmentStatus: r.fulfillment_status,
    fulfillment: r.fulfillment,
    ready: Boolean(r.ready_at),
    items: r.items,
    total: formatCents(toBigInt(r.total_cents)),
    refunded: toBigInt(r.refunded_cents ?? 0) > 0n ? formatCents(toBigInt(r.refunded_cents)) : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * After an order placed signed in: the account remembers what was new in it,
 * so the next checkout is quicker. The name and phone fill in only when the
 * account has none; the business (for a tax invoice) is kept; the address is
 * kept when the buyer ticked "save".
 */
export async function rememberFromOrder(db: Queryable, buyer: Buyer, input: { customer: { name: string; phone: string }; address?: AddressInput; business?: { tin: string; name: string }; saveAddress?: boolean }) {
  await db.query(
    `update store_buyers set name = coalesce(name, $2), phone = coalesce(phone, $3),
       business_tin = coalesce($4, business_tin), business_name = coalesce($5, business_name) where id = $1`,
    [buyer.id, input.customer.name.trim() || null, input.customer.phone.trim() || null, input.business?.tin ?? null, input.business?.name.trim() || null],
  );
  if (input.saveAddress && input.address) {
    try {
      await addAddress(db, buyer, { ...input.address, isDefault: false });
    } catch (e) {
      // A full address book does not fail the order.
      if (!(e instanceof BuyerError)) throw e;
    }
  }
}

// ---------- for the store's owner ----------

export async function listBuyers(db: Queryable, tenantId: string, q?: string) {
  const params: unknown[] = [tenantId];
  let where = 'b.tenant_id = $1';
  if (q?.trim()) {
    params.push(`%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where += ` and (b.email ilike $2 or b.name ilike $2 or b.phone like $2)`;
  }
  const rows = (await db.query<{ id: string; email: string; name: string | null; phone: string | null; business_name: string | null; created_at: Date; last_seen_at: Date; orders: number; spent: string | null; last_order: Date | null; addresses: number }>(
    `select b.id, b.email, b.name, b.phone, b.business_name, b.created_at, b.last_seen_at,
       coalesce(o.orders, 0)::int as orders, o.spent::text as spent, o.last_order,
       (select count(*) from store_buyer_addresses a where a.buyer_id = b.id)::int as addresses
     from store_buyers b
     left join lateral (
       select count(*) filter (where status <> 'cancelled') as orders,
              sum(total_cents - coalesce(refunded_cents, 0)) filter (where payment_status = 'paid') as spent,
              max(created_at) as last_order
       from orders where tenant_id = b.tenant_id and (buyer_id = b.id or customer_email = b.email)
     ) o on true
     where ${where}
     order by coalesce(o.last_order, b.created_at) desc limit 500`,
    params,
  )).rows;
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    phone: r.phone,
    business: r.business_name,
    orders: r.orders,
    spent: formatCents(toBigInt(r.spent ?? 0)),
    lastOrderAt: r.last_order ? new Date(r.last_order).toISOString() : null,
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Codes and sessions past their time (housekeeping). */
export async function sweepBuyerSignIns(db: Queryable) {
  await db.query('delete from store_buyer_codes where expires_at < now()');
  await db.query('delete from store_buyer_sessions where expires_at < now()');
}
