/**
 * Gift cards: money a customer paid in advance (or the business gave), used
 * to pay at the counter, on a till or in the online store, in part or in full.
 *
 * GST is charged when a card is used, not when it is sold: selling one is
 * not a taxed sale (no BTS document), and the receipt of the sale it pays
 * for carries the full GST, with the card as how (part of) it was paid
 * (payment means code 1, "instrument not defined", and the terms say "gift card").
 *
 * The code is 16 characters from an alphabet without look-alikes (80 bits,
 * shown as XXXX-XXXX-XXXX-XXXX). It is a bearer secret: only its hash finds a
 * card; the code itself is kept encrypted, to email it again. Every change to
 * a balance is written to the card's activity, and a use is all or nothing
 * (the balance can never go below zero, even with two sales at once).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { openShiftSql } from '../db/shifts.ts';
import { formatCents } from '../engine/decimal.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The payment means code a gift card pays with on a BTS document. */
export const GIFT_CARD_MEANS = '1';
export const MAX_CARD_CENTS = 1_000_000n; // BZ$10,000

export class GiftCardError extends Error {
  override name = 'GiftCardError';
  readonly code: 'not_found' | 'disabled' | 'expired' | 'empty' | 'not_enough' | 'invalid';
  constructor(code: GiftCardError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function newCode(): string {
  return [...randomBytes(16)].map((b) => ALPHABET[b & 31]).join('');
}
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (code: string) => normalizeCode(code).match(/.{1,4}/g)?.join('-') ?? '';
const codeHash = (code: string) => createHash('sha256').update(`gift-card:${normalizeCode(code)}`, 'utf8').digest('hex');
const secretContext = (tenantId: string, id: string) => `gift-card:${tenantId}:${id}`;
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

export interface GiftCardRow {
  id: string;
  tenant_id: string;
  code_encrypted: string;
  last4: string;
  initial_cents: unknown;
  balance_cents: unknown;
  status: 'active' | 'disabled';
  expires_on: string | null;
  source: 'sold' | 'given';
  paid_by: 'cash' | 'card' | 'bank_transfer' | null;
  recipient_name: string | null;
  recipient_email: string | null;
  message: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date | string;
  last_used_at: Date | string | null;
}
const COLUMNS = `id, tenant_id, code_encrypted, last4, initial_cents, balance_cents, status, to_char(expires_on, 'YYYY-MM-DD') as expires_on, source, paid_by,
  recipient_name, recipient_email, message, note, created_by, created_at, last_used_at`;

export function cardJson(r: GiftCardRow) {
  const expired = r.expires_on !== null && r.expires_on < belizeToday();
  return {
    id: r.id,
    last4: r.last4,
    initial: formatCents(toBigInt(r.initial_cents)),
    balance: formatCents(toBigInt(r.balance_cents)),
    status: r.status === 'disabled' ? 'disabled' as const : expired ? 'expired' as const : toBigInt(r.balance_cents) === 0n ? 'used_up' as const : 'active' as const,
    expiresOn: r.expires_on,
    source: r.source,
    paidBy: r.paid_by,
    recipient: { name: r.recipient_name, email: r.recipient_email },
    message: r.message,
    note: r.note,
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  };
}

/** Why a card cannot pay, or null when it can. */
export function cannotPay(r: GiftCardRow): GiftCardError | null {
  if (r.status === 'disabled') return new GiftCardError('disabled', 'This gift card has been turned off. Ask the store about it.');
  if (r.expires_on !== null && r.expires_on < belizeToday()) return new GiftCardError('expired', `This gift card expired on ${r.expires_on}`);
  if (toBigInt(r.balance_cents) <= 0n) return new GiftCardError('empty', 'This gift card has been used up');
  return null;
}

export interface NewCard {
  amountCents: bigint;
  source: 'sold' | 'given';
  paidBy?: 'cash' | 'card' | 'bank_transfer';
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
  note?: string;
  expiresOn?: string;
  userId: string | null;
  deviceId?: string | null;
}

/** A new card. Sold ones are recorded in the seller's open shift (their drawer). The code is returned once, here. */
export async function issueGiftCard(db: Queryable, keys: KeyProtector, tenantId: string, input: NewCard): Promise<{ card: GiftCardRow; code: string }> {
  if (input.amountCents <= 0n || input.amountCents > MAX_CARD_CENTS) throw new GiftCardError('invalid', `A gift card is for BZ$0.01 to BZ$${formatCents(MAX_CARD_CENTS)}`);
  if (input.source === 'sold' && !input.paidBy) throw new GiftCardError('invalid', 'Say how the card was paid for');
  if (input.expiresOn && input.expiresOn <= belizeToday()) throw new GiftCardError('invalid', 'The expiry date must be after today');
  const id = randomUUID();
  const code = newCode();
  const encrypted = await keys.encrypt(Buffer.from(code, 'utf8'), secretContext(tenantId, id));
  const card = (await db.query<GiftCardRow>(
    `insert into gift_cards (id, tenant_id, code_hash, code_encrypted, last4, initial_cents, balance_cents, source, paid_by, recipient_name, recipient_email, message, note, expires_on,
       created_by, device_id, shift_id)
     values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       case when $7 = 'sold' and $14::uuid is not null then ${openShiftSql('$2', '$14', '$15')} end)
     returning ${COLUMNS}`,
    [id, tenantId, codeHash(code), encrypted, code.slice(-4), String(input.amountCents), input.source, input.source === 'sold' ? input.paidBy : null,
      input.recipientName?.trim() || null, input.recipientEmail?.trim().toLowerCase() || null, input.message?.trim() || null, input.note?.trim() || null, input.expiresOn ?? null,
      input.userId, input.deviceId ?? null],
  )).rows[0]!;
  await activity(db, tenantId, id, 'issued', input.amountCents, input.amountCents, { userId: input.userId, note: input.source === 'given' ? 'Given by the business' : `Sold, paid by ${input.paidBy === 'bank_transfer' ? 'bank transfer' : input.paidBy}` });
  return { card, code };
}

async function activity(db: Queryable, tenantId: string, cardId: string, kind: string, amount: bigint, balanceAfter: bigint, ref: { documentId?: string | null; orderId?: string | null; userId?: string | null; note?: string | null; reversesId?: string | null }): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `insert into gift_card_activity (id, tenant_id, gift_card_id, kind, amount_cents, balance_after, document_id, order_id, user_id, note, reverses_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (reverses_id) do nothing returning id`,
    [randomUUID(), tenantId, cardId, kind, String(amount), String(balanceAfter), ref.documentId ?? null, ref.orderId ?? null, ref.userId ?? null, ref.note ?? null, ref.reversesId ?? null],
  );
  return r.rows[0]?.id ?? null;
}

export async function findCard(db: Queryable, tenantId: string, code: string): Promise<GiftCardRow | null> {
  const normal = normalizeCode(code);
  if (normal.length !== 16) return null;
  return (await db.query<GiftCardRow>(`select ${COLUMNS} from gift_cards where tenant_id = $1 and code_hash = $2`, [tenantId, codeHash(normal)])).rows[0] ?? null;
}

export async function cardById(db: Queryable, tenantId: string, id: string): Promise<GiftCardRow | null> {
  return (await db.query<GiftCardRow>(`select ${COLUMNS} from gift_cards where tenant_id = $1 and id = $2`, [tenantId, id])).rows[0] ?? null;
}

/** A card that can pay, found by its code (or why not). */
export async function payingCard(db: Queryable, tenantId: string, code: string): Promise<GiftCardRow> {
  const card = await findCard(db, tenantId, code);
  if (!card) throw new GiftCardError('not_found', 'There is no gift card with this code. Check it and try again.');
  const problem = cannotPay(card);
  if (problem) throw problem;
  return card;
}

/**
 * Take `cents` off a card: all of it or nothing (another sale using the card
 * at the same moment can never take it below zero).
 */
export async function useGiftCard(db: Queryable, tenantId: string, cardId: string, cents: bigint, ref: { documentId?: string | null; orderId?: string | null; userId?: string | null; note?: string }): Promise<{ card: GiftCardRow; activityId: string }> {
  if (cents <= 0n) throw new GiftCardError('invalid', 'The amount from the gift card must be more than zero');
  const card = (await db.query<GiftCardRow>(
    `update gift_cards set balance_cents = balance_cents - $3, last_used_at = now()
     where tenant_id = $1 and id = $2 and status = 'active' and (expires_on is null or expires_on >= $4::date) and balance_cents >= $3
     returning ${COLUMNS}`,
    [tenantId, cardId, String(cents), belizeToday()],
  )).rows[0];
  if (!card) {
    const now = await cardById(db, tenantId, cardId);
    if (!now) throw new GiftCardError('not_found', 'Gift card not found');
    throw cannotPay(now) ?? new GiftCardError('not_enough', `The gift card has BZ$${formatCents(toBigInt(now.balance_cents))} left`);
  }
  const activityId = (await activity(db, tenantId, cardId, 'used', -cents, toBigInt(card.balance_cents), ref))!;
  return { card, activityId };
}

/** Put money back on a card (a cancelled or refunded order, a sale that did not go through). Once per `reversesId`. */
export async function returnToCard(db: Queryable, tenantId: string, cardId: string, cents: bigint, ref: { documentId?: string | null; orderId?: string | null; userId?: string | null; note: string; reversesId?: string }): Promise<boolean> {
  if (cents <= 0n) return false;
  // Claim the reversal first, so a second run gives nothing back.
  const id = randomUUID();
  const claimed = await db.query(
    `insert into gift_card_activity (id, tenant_id, gift_card_id, kind, amount_cents, balance_after, document_id, order_id, user_id, note, reverses_id)
     values ($1, $2, $3, 'returned', $4, 0, $5, $6, $7, $8, $9) on conflict (reverses_id) do nothing returning id`,
    [id, tenantId, cardId, String(cents), ref.documentId ?? null, ref.orderId ?? null, ref.userId ?? null, ref.note, ref.reversesId ?? null],
  );
  if (!claimed.rows.length) return false;
  const r = (await db.query<{ balance_cents: unknown }>('update gift_cards set balance_cents = balance_cents + $3 where tenant_id = $1 and id = $2 returning balance_cents', [tenantId, cardId, String(cents)])).rows[0]!;
  await db.query('update gift_card_activity set balance_after = $2 where id = $1', [id, String(toBigInt(r.balance_cents))]);
  return true;
}

/** A correction by a manager: add to or take from the balance (never below zero). */
export async function adjustCard(db: Queryable, tenantId: string, cardId: string, deltaCents: bigint, userId: string | null, note: string): Promise<GiftCardRow> {
  if (deltaCents === 0n) throw new GiftCardError('invalid', 'Give an amount to add or take off');
  const card = (await db.query<GiftCardRow>(
    `update gift_cards set balance_cents = balance_cents + $3 where tenant_id = $1 and id = $2 and balance_cents + $3 >= 0 and balance_cents + $3 <= $4 returning ${COLUMNS}`,
    [tenantId, cardId, String(deltaCents), String(MAX_CARD_CENTS)],
  )).rows[0];
  if (!card) {
    const now = await cardById(db, tenantId, cardId);
    if (!now) throw new GiftCardError('not_found', 'Gift card not found');
    throw new GiftCardError('not_enough', deltaCents < 0n ? `The card has only BZ$${formatCents(toBigInt(now.balance_cents))}` : `A gift card holds up to BZ$${formatCents(MAX_CARD_CENTS)}`);
  }
  await activity(db, tenantId, cardId, 'adjusted', deltaCents, toBigInt(card.balance_cents), { userId, note });
  return card;
}

export async function setCardStatus(db: Queryable, tenantId: string, cardId: string, status: 'active' | 'disabled', userId: string | null, note?: string): Promise<GiftCardRow> {
  const card = (await db.query<GiftCardRow>(`update gift_cards set status = $3 where tenant_id = $1 and id = $2 returning ${COLUMNS}`, [tenantId, cardId, status])).rows[0];
  if (!card) throw new GiftCardError('not_found', 'Gift card not found');
  await activity(db, tenantId, cardId, status === 'disabled' ? 'disabled' : 'enabled', 0n, toBigInt(card.balance_cents), { userId, note: note ?? null });
  return card;
}

/** The card's code (to show or email it again). */
export async function cardCode(keys: KeyProtector, card: Pick<GiftCardRow, 'id' | 'tenant_id' | 'code_encrypted'>): Promise<string> {
  return formatCode((await keys.decrypt(card.code_encrypted, secretContext(card.tenant_id, card.id))).toString('utf8'));
}

export async function listCards(db: Queryable, tenantId: string, filter: { q?: string; status?: 'active' | 'used_up' | 'disabled' | 'all' } = {}) {
  const params: unknown[] = [tenantId];
  let where = 'tenant_id = $1';
  const q = filter.q?.trim();
  if (q) {
    // A whole code finds its card; otherwise the last four, or who it is for.
    if (normalizeCode(q).length === 16) {
      params.push(codeHash(q));
      where += ` and code_hash = $${params.length}`;
    } else {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, normalizeCode(q).slice(-4));
      where += ` and (recipient_name ilike $${params.length - 1} or recipient_email ilike $${params.length - 1} or note ilike $${params.length - 1} or last4 = $${params.length})`;
    }
  }
  if (filter.status === 'active') where += " and status = 'active' and balance_cents > 0";
  if (filter.status === 'used_up') where += " and status = 'active' and balance_cents = 0";
  if (filter.status === 'disabled') where += " and status = 'disabled'";
  const rows = (await db.query<GiftCardRow>(`select ${COLUMNS} from gift_cards where ${where} order by created_at desc limit 500`, params)).rows;
  const totals = (await db.query<{ n: number; outstanding: unknown }>(
    `select count(*)::int as n, coalesce(sum(balance_cents), 0) as outstanding from gift_cards where tenant_id = $1 and status = 'active'`, [tenantId],
  )).rows[0]!;
  return { data: rows.map(cardJson), summary: { active: totals.n, outstanding: formatCents(toBigInt(totals.outstanding)) } };
}

export async function cardActivity(db: Queryable, tenantId: string, cardId: string) {
  const rows = (await db.query<{ id: string; kind: string; amount_cents: unknown; balance_after: unknown; note: string | null; created_at: Date | string; user_name: string | null; order_id: string | null; order_number: number | null; document_id: string | null; doc_series: string | null; doc_serial: string | null; doc_type: string | null }>(
    `select a.id, a.kind, a.amount_cents, a.balance_after, a.note, a.created_at, u.name as user_name, a.order_id, o.number as order_number,
       a.document_id, d.series_number::text as doc_series, d.serial::text as doc_serial, d.etd_type as doc_type
     from gift_card_activity a left join users u on u.id = a.user_id left join orders o on o.id = a.order_id left join documents d on d.id = a.document_id
     where a.tenant_id = $1 and a.gift_card_id = $2 order by a.created_at, a.id`,
    [tenantId, cardId],
  )).rows;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: formatCents(toBigInt(r.amount_cents)),
    balanceAfter: formatCents(toBigInt(r.balance_after)),
    note: r.note,
    at: new Date(r.created_at).toISOString(),
    by: r.user_name,
    order: r.order_id ? { id: r.order_id, number: r.order_number } : null,
    document: r.document_id ? { id: r.document_id, type: r.doc_type, label: r.doc_series && r.doc_serial ? `${r.doc_series.padStart(3, '0')}-${r.doc_serial.padStart(9, '0')}` : null } : null,
  }));
}

/**
 * Uses for sales that did not stand (BTS rejected the receipt, or it was
 * cancelled) go back on the card, once each. Housekeeping runs it; a sale
 * rejected on the spot runs it for that document right away.
 */
export async function reverseVoidedGiftCards(db: Queryable, options: { documentId?: string; limit?: number } = {}): Promise<number> {
  const rows = (await db.query<{ id: string; tenant_id: string; gift_card_id: string; amount_cents: unknown; document_id: string }>(
    `select a.id, a.tenant_id, a.gift_card_id, a.amount_cents, a.document_id from gift_card_activity a join documents d on d.id = a.document_id
     where a.kind = 'used' and d.status in ('rejected', 'cancelled') and ($1::uuid is null or a.document_id = $1)
       and not exists (select 1 from gift_card_activity r where r.reverses_id = a.id)
     order by a.created_at limit $2`,
    [options.documentId ?? null, options.limit ?? 500],
  )).rows;
  let n = 0;
  for (const r of rows) {
    if (await returnToCard(db, r.tenant_id, r.gift_card_id, -toBigInt(r.amount_cents), { documentId: r.document_id, note: 'The sale was rejected or cancelled', reversesId: r.id })) n++;
  }
  return n;
}
