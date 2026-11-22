/**
 * Bill payments through Belize Bank's online and mobile banking.
 *
 * The business is set up as a payee with the bank. A customer paying a bill
 * types the invoice number; the bank asks us whether it is right (and how
 * much is owed) before taking the payment, tells us when it was paid, and
 * sends a summary of the day's payments for reconciliation. Every payment is
 * recorded on its invoice once, by the bank's own reference.
 *
 * The bank authenticates with a bearer token we generate for the business;
 * only its hash is kept.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { parseCents } from '../engine/decimal.ts';
import { type Receivable, receivable, ReceivableError, recordPayment } from './receivables.ts';

const OPEN = "('authorized', 'authorized_with_alert', 'contingency_pending')";
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
/** Field names banks commonly use for the bill's reference, tried after the agreed one. */
const FALLBACK_FIELDS = ['referenceNumber', 'invoiceNumber', 'accountNumber', 'reference', 'billNumber'];

export interface BillPayAccount {
  referenceField: string;
  enabled: boolean;
  lastSeenAt: string | null;
}

export async function billPayAccount(db: Queryable, tenantId: string): Promise<BillPayAccount | null> {
  const r = (await db.query<{ reference_field: string; enabled: boolean; last_seen_at: Date | string | null }>(
    'select reference_field, enabled, last_seen_at from bill_payment_accounts where tenant_id = $1', [tenantId],
  )).rows[0];
  return r ? { referenceField: r.reference_field, enabled: r.enabled, lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null } : null;
}

/** Turn bill payments on (or issue a new token): returns the token, shown once. */
export async function issueBillPayToken(db: Queryable, tenantId: string, referenceField: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into bill_payment_accounts (tenant_id, token_hash, reference_field) values ($1, $2, $3)
     on conflict (tenant_id) do update set token_hash = excluded.token_hash, reference_field = excluded.reference_field, enabled = true, updated_at = now()`,
    [tenantId, hashToken(token), referenceField],
  );
  return token;
}

/** The business a bank request is for, if its token is right and bill payments are on. */
export async function authenticateBillPay(db: Queryable, slug: string, bearer: string | null): Promise<{ tenantId: string; referenceField: string } | null> {
  if (!bearer) return null;
  const r = (await db.query<{ tenant_id: string; token_hash: string; reference_field: string }>(
    'select a.tenant_id, a.token_hash, a.reference_field from bill_payment_accounts a join tenants t on t.id = a.tenant_id where t.slug = $1 and a.enabled', [slug],
  )).rows[0];
  if (!r) return null;
  const given = Buffer.from(hashToken(bearer), 'hex');
  const stored = Buffer.from(r.token_hash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
  await db.query('update bill_payment_accounts set last_seen_at = now() where tenant_id = $1', [r.tenant_id]);
  return { tenantId: r.tenant_id, referenceField: r.reference_field };
}

/** "001-000000012", "1-12", "INV 12", "000000012", "12" → series (if given) and number. */
export function parseInvoiceNumber(raw: string): { series: number | null; serial: number } | null {
  const s = raw.trim().replace(/^[A-Za-z#.\s]+/, '');
  const m = /^(?:(\d{1,3})\s*[-/\s]\s*)?0*(\d{1,9})$/.exec(s);
  if (!m || Number(m[2]) === 0) return null;
  return { series: m[1] ? Number(m[1]) : null, serial: Number(m[2]) };
}

type Found = { kind: 'owed' | 'paid'; invoice: Receivable } | { kind: 'not_found' } | { kind: 'ambiguous' };

/** The invoice (or debit note) a customer means by the number they typed. */
export async function findInvoice(db: Queryable, tenantId: string, raw: string): Promise<Found> {
  const n = parseInvoiceNumber(raw);
  if (!n) return { kind: 'not_found' };
  const ids = (await db.query<{ id: string }>(
    `select d.id from documents d where d.tenant_id = $1 and d.etd_type in ('01', '03') and d.serial = $2 and ($3::int is null or d.series_number = $3)
       and d.status in ${OPEN} and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)
     order by d.issue_date desc limit 10`,
    [tenantId, n.serial, n.series],
  )).rows;
  const found = (await Promise.all(ids.map((r) => receivable(db, tenantId, r.id)))).filter((r): r is Receivable => r !== null);
  const owed = found.filter((r) => r.balanceCents > 0n);
  if (owed.length > 1) return { kind: 'ambiguous' };
  if (owed.length === 1) return { kind: 'owed', invoice: owed[0]! };
  return found.length ? { kind: 'paid', invoice: found[0]! } : { kind: 'not_found' };
}

function referenceOf(body: Record<string, unknown>, field: string): string {
  for (const f of [field, ...FALLBACK_FIELDS]) {
    const v = body[f];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim().slice(0, 64);
  }
  return '';
}

async function logEvent(db: Queryable, tenantId: string, e: { kind: 'validate' | 'post' | 'reconcile'; bankReference?: string | null; reference?: string | null; amountCents?: bigint | null; outcome: string; detail?: unknown }) {
  await db.query(
    'insert into bill_payment_events (id, tenant_id, kind, bank_reference, reference, amount_cents, outcome, detail) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [randomUUID(), tenantId, e.kind, e.bankReference ?? null, e.reference ?? null, e.amountCents === null || e.amountCents === undefined ? null : String(e.amountCents), e.outcome, e.detail === undefined ? null : JSON.stringify(e.detail)],
  );
}

const cut = (s: string) => (s.length > 50 ? `${s.slice(0, 49)}…` : s);
const toNumber = (cents: bigint) => Number(cents) / 100;

/** The bank asks before taking a payment: is this invoice number right, and how much is owed? */
export async function validateBillPayment(db: Queryable, tenantId: string, body: Record<string, unknown>, field: string) {
  const ref = referenceOf(body, field);
  if (!ref) return { status: 1, displayInfo: 'Enter the invoice number' };
  const f = await findInvoice(db, tenantId, ref);
  if (f.kind === 'not_found') return { status: 1, displayInfo: cut(`No invoice ${ref}. Check the number`) };
  if (f.kind === 'ambiguous') return { status: 1, displayInfo: 'Enter the full number, e.g. 001-000000012' };
  if (f.kind === 'paid') return { status: 1, displayInfo: cut(`Invoice ${f.invoice.number} is already paid`) };
  const inv = f.invoice;
  return {
    status: 0,
    displayInfo: cut(`Due ${inv.dueDate}. Balance BZ$${inv.balance}`),
    amountMin: 0.01,
    amountMax: toNumber(inv.balanceCents),
    customerName: inv.customer.name.slice(0, 100),
  };
}

interface Applied {
  outcome: 'recorded' | 'already_recorded' | 'unmatched' | 'invalid';
  receiptNumber?: string;
  message?: string;
}

/** Record one payment the bank took (idempotent on the bank's reference). */
async function apply(db: Queryable, tenantId: string, body: Record<string, unknown>, field: string, kind: 'post' | 'reconcile'): Promise<Applied> {
  const bankRef = String(body.bblReferenceNumber ?? '').trim();
  const ref = referenceOf(body, field);
  let amountCents: bigint;
  try {
    amountCents = parseCents(String(body.amount ?? '').trim());
  } catch {
    amountCents = 0n;
  }
  if (!/^[A-Za-z0-9-]{1,40}$/.test(bankRef) || amountCents <= 0n) {
    await logEvent(db, tenantId, { kind, bankReference: bankRef || null, reference: ref || null, outcome: 'invalid', detail: { body } });
    return { outcome: 'invalid', message: 'bblReferenceNumber and a positive amount are required' };
  }
  const externalId = `bbl:${bankRef}`;
  const existing = (await db.query<{ id: string }>('select id from invoice_payments where tenant_id = $1 and external_id = $2', [tenantId, externalId])).rows[0];
  if (existing) return { outcome: 'already_recorded', receiptNumber: receipt(existing.id) };
  const f = ref ? await findInvoice(db, tenantId, ref) : { kind: 'not_found' as const };
  if (f.kind !== 'owed' && f.kind !== 'paid') {
    await logEvent(db, tenantId, { kind, bankReference: bankRef, reference: ref || null, amountCents, outcome: f.kind === 'ambiguous' ? 'ambiguous' : 'unmatched' });
    return { outcome: 'unmatched', message: 'No single invoice matches this reference' };
  }
  const inv = f.invoice;
  const today = belizeToday();
  const posted = typeof body.postingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.postingDate) ? body.postingDate : today;
  const paidOn = posted > today ? today : posted < inv.issueDate ? inv.issueDate : posted;
  try {
    // The bank already took the money: recorded even if it is more than the balance (a credit to return).
    const { payment } = await recordPayment(db, tenantId, inv.documentId, {
      amountCents, method: 'bank_transfer', reference: `Belize Bank bill payment ${bankRef}`, paidOn, externalId,
    }, null, { allowOverpay: true });
    return { outcome: 'recorded', receiptNumber: receipt(payment.id) };
  } catch (e) {
    if (e instanceof ReceivableError && /already recorded/.test(e.message)) {
      const again = (await db.query<{ id: string }>('select id from invoice_payments where tenant_id = $1 and external_id = $2', [tenantId, externalId])).rows[0];
      return { outcome: 'already_recorded', ...(again && { receiptNumber: receipt(again.id) }) };
    }
    throw e;
  }
}

const receipt = (paymentId: string) => `PAY-${paymentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

/** The bank tells us a payment was taken. */
export async function postBillPayment(db: Queryable, tenantId: string, body: Record<string, unknown>, field: string) {
  const a = await apply(db, tenantId, body, field, 'post');
  return a.outcome === 'recorded' || a.outcome === 'already_recorded' ? { status: 0, receiptNumber: a.receiptNumber } : { status: 1 };
}

/** The day's summary: record anything the real-time messages missed. */
export async function reconcileBillPayments(db: Queryable, tenantId: string, body: Record<string, unknown>, field: string) {
  const txs = Array.isArray(body.transactions) ? (body.transactions as Array<Record<string, unknown>>).slice(0, 5000) : [];
  const counts = { recorded: 0, already_recorded: 0, unmatched: 0, invalid: 0 };
  for (const tx of txs) {
    if (tx && typeof tx === 'object') counts[(await apply(db, tenantId, tx, field, 'reconcile')).outcome]++;
  }
  await logEvent(db, tenantId, { kind: 'reconcile', outcome: 'summary', detail: { businessDate: body.businessDate ?? null, totalCount: body.totalCount ?? null, totalAmount: body.totalAmount ?? null, ...counts } });
  return { status: 0 as const, counts };
}
