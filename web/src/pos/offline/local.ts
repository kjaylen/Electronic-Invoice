/**
 * The till's own API: the calls the till's screens make, answered on the
 * device. The screens (the counter, recent sales, the shift) are the web
 * app's own and call the API as always; this sits under them (api.ts asks it
 * first, see setTillTransport) and decides per call:
 *
 *   on the device, always   items, categories, customers, previews, Tax Receipts, the till's shift,
 *                           the printed copy of a receipt made here
 *   the server, else here   GET /v1/me, the sales list (the till's own receipts are added), held sales
 *   the server only         gift cards, points, sales on account, refunds, emailing a receipt, the time
 *                           clock: each needs the server's answer before it is done (a card's balance, a
 *                           customer's credit, BTS for a credit note), so offline it says so and why
 *
 * A Tax Receipt is made here even when the server can be reached: numbered in
 * the till's own series, printed, written to the device's disk with its event
 * for the server in one transaction, then sent (sync.ts). Losing or doubling a
 * sale is the worst thing a till can do; this order makes both impossible.
 */

import { calculateDocument, type DocumentTotals, type LineInput } from '../../../../src/engine/calc.ts';
import { formatCents } from '../../../../src/engine/decimal.ts';
import { buildEtdui, generateSecurityCode, type EtduiParts } from '../../../../src/engine/etdui.ts';
import { authorizationText, infoLines, regulatoryLines } from '../../../../src/engine/print-view.ts';
import { receiptPrintView } from '../../../../src/engine/receipt-view.ts';
import { toBelizeDateTime } from '../../../../src/engine/time.ts';
import type { Customer, DocumentInfo, DocumentLine, Item, Permission, Role } from '../../api';
import type { Shift, ShiftReport } from '../../pages/Shifts';
import type { OutboxKind, OutboxRow, TillDb } from './db';
import type { CashEvent, HeldSaleRecord, LocalSale, LocalShift, RemoteSale, SaleEvent, ShiftCloseEvent, ShiftOpenEvent, Snapshot, SyncEvent, Tender } from './types';

export interface SignedInPerson { id: string; name: string; role: Role; permissions: Permission[] }

export interface LocalContext {
  db: TillDb;
  snapshot(): Snapshot | null;
  /** Who is signed in on the till. */
  person(): SignedInPerson | null;
  /** A session the server knows (signed in online): calls that need the server can be made. */
  hasSession(): boolean;
  online(): boolean;
  /** A call to the server, as the signed-in person. Throws ApiError(0) when it cannot be reached. */
  net(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }): Promise<Response>;
  /** Something was written for the server: send it soon. */
  changed(): void;
  /** Send what is waiting now (before a call that needs the server to know the till's sales). */
  flush(): Promise<void>;
  /** The time, corrected by the server's clock. */
  now(): Date;
}

type Options = { method?: string; body?: unknown; headers?: Record<string, string> };

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const MEANS = ['cash', 'card', 'bank_transfer', 'wallet', 'cheque', 'other'] as const;
type Means = (typeof MEANS)[number];
const fromCode = (code: string | null | undefined): Means => (code === '10' ? 'cash' : code === '48' || code === '54' || code === '55' ? 'card' : code === '30' || code === '31' || code === '42' ? 'bank_transfer' : code === '68' ? 'wallet' : code === '20' ? 'cheque' : 'other');
const MEANS_NAMES: Record<string, string> = { '1': 'gift card', '10': 'cash', '20': 'cheque', '30': 'transfer', '31': 'transfer', '42': 'bank transfer', '48': 'card', '68': 'mobile wallet', '54': 'credit card', '55': 'debit card' };
const GIFT_CARD = '1';

const toCents = (amount: string): bigint => {
  const negative = amount.trim().startsWith('-');
  const [w = '0', f = ''] = amount.trim().replace('-', '').split('.');
  const v = BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return negative ? -v : v;
};
const money = (c: bigint | string) => formatCents(typeof c === 'string' ? BigInt(c) : c);
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/** Waits its turn: one sale is numbered at a time (and across windows, where the platform can say so). */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => (navigator.locks ? navigator.locks.request('floreo-till-sale', fn) : fn());
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

/** The sale as the counter sends it (POST /v1/documents). */
interface SaleBody {
  type: string;
  customerId?: string;
  customer?: { tin?: string; name?: string };
  lines: Array<{ itemId?: string; description?: string; quantity: string; unitCode?: string; unitPrice?: string; gstCategory?: 'S' | 'Z' | 'E'; exemptionReasonCode?: string; sellerItemCode?: string; allowanceCharges?: LineInput['allowanceCharges'] }>;
  payment?: { meansCode?: string; terms?: string; dueDate?: string };
  tenders?: Array<{ meansCode: string; amount: string }>;
  tip?: { amount: string; meansCode: string };
  giftCard?: unknown;
  redeemPoints?: number;
  note?: string;
}

/** The sale's contents, as a short hash: a retry sends the same, a new sale does not. */
async function fingerprint(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)) as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** An item's retail price at a quantity (its quantity prices). */
function priceForQuantity(item: Item, quantity: string): string {
  let best = item.unitPrice;
  for (const b of item.priceBreaks ?? []) if (Number(quantity) >= Number(b.minQuantity)) best = b.unitPrice;
  return best;
}

export class LocalApi {
  /** Receipts made here, unlocked once (the disk keeps them encrypted). */
  private sales = new Map<string, { row: { createdAt: string; shiftId: string | null }; sale: LocalSale }>();
  private loaded = false;

  constructor(private readonly ctx: LocalContext) {}

  /** Forget what is in memory (another person signed in, the snapshot changed). */
  reset() {
    this.sales.clear();
    this.loaded = false;
  }

  // ---------- the router ----------

  async handle(path: string, options: Options = {}): Promise<Response | null> {
    const url = new URL(path, 'http://till');
    const p = url.pathname;
    const method = (options.method ?? 'GET').toUpperCase();
    if (p.startsWith('/v1/pos/') || p.startsWith('/v1/assets/')) return null;
    const snap = this.ctx.snapshot();
    if (!snap) return null;
    const body = (options.body ?? {}) as Record<string, unknown>;
    try {
      // The catalog and customers: from the device.
      if (method === 'GET' && p === '/v1/items') return json(200, this.items(snap, url.searchParams));
      if (method === 'GET' && p === '/v1/items/categories') return json(200, this.categories(snap));
      let m = /^\/v1\/items\/([0-9a-f-]{36})$/.exec(p);
      if (method === 'GET' && m) {
        const item = snap.items.find((i) => i.id === m![1]);
        return item ? json(200, item) : problem(404, 'not_found', 'Item not found');
      }
      if (method === 'GET' && p === '/v1/customers') return json(200, this.customers(snap, url.searchParams));
      m = /^\/v1\/customers\/([0-9a-f-]{36})$/.exec(p);
      if (method === 'GET' && m) {
        const c = snap.customers.find((x) => x.id === m![1]);
        if (c) return json(200, c);
      }

      // Selling.
      if (method === 'POST' && p === '/v1/documents/preview') {
        if (body.redeemPoints) return this.needsServer(null, 'Points need a connection: the customer’s balance is on the server.');
        return json(200, this.preview(snap, body as unknown as SaleBody));
      }
      if (method === 'POST' && p === '/v1/documents') {
        const sale = body as unknown as SaleBody;
        if (sale.type === '02' && !sale.giftCard && !sale.redeemPoints) return await this.sell(snap, sale, options.headers?.['Idempotency-Key'] ?? null);
        const why = sale.giftCard ? 'Gift cards need a connection: the card’s balance is on the server.'
          : sale.redeemPoints ? 'Points need a connection: the customer’s balance is on the server.'
          : sale.type === '04' ? 'Refunds need a connection: a credit note is sent to BTS before the money goes back.'
          : sale.type === '01' ? 'Sales on account need a connection: the customer’s credit is checked on the server.'
          : 'This needs a connection.';
        return await this.throughServer(path, options, why, (doc) => this.recordRemote(sale, doc));
      }

      // Receipts.
      if (method === 'GET' && p === '/v1/documents') return await this.documents(url.searchParams, path);
      m = /^\/v1\/documents\/([0-9a-f-]{36})(\/view)?$/.exec(p);
      if (method === 'GET' && m) {
        const local = await this.sale(m[1]!);
        if (local) return json(200, m[2] ? this.printView(snap, local.sale) : { ...local.sale.doc, lines: local.sale.lines });
        return null;
      }
      m = /^\/v1\/documents\/([0-9a-f-]{36})\/(email|share|cancel|payments)$/.exec(p);
      if (m) {
        const what = m[2] === 'email' ? 'Emailing a receipt needs a connection.' : m[2] === 'cancel' ? 'Cancelling needs a connection: it is sent to BTS.' : 'This needs a connection.';
        return await this.throughServer(path, options, what);
      }

      // The till's shift.
      if (p === '/v1/shifts/current' && method === 'GET') return json(200, await this.currentShift());
      if (p === '/v1/shifts' && method === 'POST') return await this.openShift(snap, body);
      m = /^\/v1\/shifts\/([0-9a-f-]{36})\/(cash|close)$/.exec(p);
      if (m && method === 'POST') return m[2] === 'cash' ? await this.cash(m[1]!, body) : await this.closeShift(m[1]!, body);
      m = /^\/v1\/shifts\/([0-9a-f-]{36})$/.exec(p);
      if (m && method === 'GET') {
        const s = await this.shift(m[1]!);
        return s ? json(200, { shift: this.shiftJson(s), report: await this.report(s) }) : null;
      }
      if (p === '/v1/shifts' && method === 'GET') return await this.shifts(path);
      if (p === '/v1/registers' && method === 'GET' && !this.ctx.online()) {
        const current = await this.currentShift();
        return json(200, { data: [{ id: snap.device.register.id, name: snap.device.register.name, openBy: current.shift?.openedBy.name ?? null, openSince: current.shift?.openedAt ?? null }] });
      }

      // Held sales: on the server (shared by the business's tills); here while offline.
      if (p.startsWith('/v1/held-sales')) return await this.held(p, method, options);

      // The business, for the screens.
      if (method === 'GET' && p === '/v1/me') {
        if (this.ctx.online() && this.ctx.hasSession()) {
          try {
            const res = await this.ctx.net(path, { timeoutMs: 5000 });
            if (res.ok) return res;
          } catch {
            /* offline: the snapshot's */
          }
        }
        return json(200, snap.me);
      }

      // Only with the server.
      if (/^\/v1\/(customers\/[^/]+\/loyalty|gift-cards|timeclock|orders)/.test(p)) {
        const why = p.includes('loyalty') ? 'Points need a connection.' : p.startsWith('/v1/gift-cards') ? 'Gift cards need a connection: the card’s balance is on the server.' : p.startsWith('/v1/timeclock') ? 'The time clock needs a connection.' : 'This needs a connection.';
        if (!this.ctx.online() || !this.ctx.hasSession()) return this.needsServer(null, why);
        return null;
      }
      // Anything else needs a session the server knows.
      if (!this.ctx.hasSession()) return this.needsServer(null, 'This needs a connection.');
      return null;
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      if (err instanceof TillError) return problem(err.status, err.code, err.message);
      return problem(422, 'invalid_document', err.message || String(e));
    }
  }

  /** Refused while offline (or signed in without the server), with why. */
  private needsServer(_path: string | null, why: string): Response {
    if (this.ctx.online() && !this.ctx.hasSession()) return problem(503, 'sign_in_again', `${why} Lock the till and sign in again to use it now that the server can be reached.`);
    return problem(503, 'needs_connection', why);
  }

  /** A call that needs the server: what the till sold goes first, so the server knows it (a refund of a receipt made here). */
  private async throughServer(path: string, options: Options, why: string, after?: (doc: DocumentInfo) => Promise<void>): Promise<Response> {
    if (!this.ctx.online() || !this.ctx.hasSession()) return this.needsServer(null, why);
    await this.ctx.flush().catch(() => {});
    const res = await this.ctx.net(path, { method: options.method ?? 'GET', body: options.body, headers: options.headers ?? {}, timeoutMs: 60_000 });
    if (res.ok && after) await after(await res.clone().json() as DocumentInfo).catch(() => {});
    return res;
  }

  // ---------- catalog ----------

  private items(snap: Snapshot, q: URLSearchParams) {
    let list = snap.items.filter((i) => !i.archived);
    if (q.get('favorite') === 'true') list = list.filter((i) => i.favorite);
    if (q.has('category')) {
      const cat = q.get('category')!.toLowerCase();
      list = list.filter((i) => (cat === '' ? !i.category : (i.category ?? '').toLowerCase() === cat));
    }
    const code = q.get('code');
    if (code) list = list.filter((i) => i.barcode === code || (i.sellerCode ?? '').toLowerCase() === code.toLowerCase());
    const text = q.get('q')?.trim().toLowerCase();
    if (text) list = list.filter((i) => [i.name, i.description, i.sellerCode ?? ''].some((s) => s.toLowerCase().includes(text)) || (i.barcode ?? '').includes(text));
    const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
    return { data: list.slice(0, limit), nextCursor: null };
  }

  private categories(snap: Snapshot) {
    const by = new Map<string, { name: string; items: number }>();
    for (const i of snap.items) {
      if (i.archived || !i.category) continue;
      const k = i.category.toLowerCase();
      const c = by.get(k) ?? { name: i.category, items: 0 };
      c.items++;
      by.set(k, c);
    }
    return { data: [...by.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())) };
  }

  private customers(snap: Snapshot, q: URLSearchParams) {
    let list = snap.customers.filter((c) => !c.archived);
    const text = q.get('q')?.trim().toLowerCase();
    if (text) list = list.filter((c) => c.name.toLowerCase().includes(text) || (c.tin ?? '').includes(text) || (c.contact.email ?? '').toLowerCase().includes(text) || (c.contact.telephone ?? '').toLowerCase().includes(text));
    const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
    return { data: list.slice(0, limit), nextCursor: null };
  }

  // ---------- a sale ----------

  /** The lines as the server would resolve them (documents.ts, toIssueRequest), from the till's catalog. */
  private resolve(snap: Snapshot, body: SaleBody): { lines: LineInput[]; itemIds: Array<string | null>; customer?: SaleEvent['request']['customer']; customerId?: string } {
    if (!Array.isArray(body.lines) || body.lines.length === 0) throw new TillError(422, 'invalid_document', 'A sale needs at least one line');
    let customer: SaleEvent['request']['customer'] | undefined;
    let customerId: string | undefined;
    let wholesale = false;
    if (body.customerId) {
      const c: Customer | undefined = snap.customers.find((x) => x.id === body.customerId);
      if (!c) throw new TillError(422, 'invalid_document', 'That customer is not on this till yet; it is added when the till next reaches the server');
      customerId = c.id;
      wholesale = c.priceList === 'wholesale';
      customer = {
        name: c.name,
        ...(c.tin && { tin: c.tin }),
        ...(c.otherId && { otherId: c.otherId }),
        ...((c.contact.telephone || c.contact.email) && { contact: { ...(c.contact.telephone && { telephone: c.contact.telephone }), ...(c.contact.email && { email: c.contact.email }) } }),
      };
    } else if (body.customer?.tin?.trim()) {
      customer = { tin: body.customer.tin.trim() };
    }
    const items = new Map(snap.items.map((i) => [i.id, i]));
    const lines = body.lines.map((l, i): LineInput => {
      const item = l.itemId ? items.get(l.itemId) : undefined;
      const description = l.description ?? item?.description;
      const unitCode = l.unitCode ?? item?.unitCode;
      const unitPrice = l.unitPrice ?? (item ? (wholesale && item.wholesalePrice ? item.wholesalePrice : priceForQuantity(item, l.quantity)) : undefined);
      const gstCategory = l.gstCategory ?? item?.gstCategory;
      if (!description || !unitCode || !unitPrice || !gstCategory) throw new TillError(422, 'invalid_document', `Line ${i + 1}: the item is not on this till`);
      const exemptionReasonCode = l.exemptionReasonCode ?? item?.exemptionReasonCode ?? undefined;
      const itemName = item && item.name !== description ? item.name : undefined;
      const sellerItemCode = l.sellerItemCode ?? item?.sellerCode ?? undefined;
      return {
        description, quantity: l.quantity, unitCode, unitPrice, gstCategory,
        ...(itemName && { itemName }),
        ...(sellerItemCode && { sellerItemCode }),
        ...(exemptionReasonCode && { exemptionReasonCode }),
        ...(l.allowanceCharges && { allowanceCharges: l.allowanceCharges }),
      };
    });
    return { lines, itemIds: body.lines.map((l) => l.itemId ?? null), ...(customer && { customer }), ...(customerId && { customerId }) };
  }

  private preview(snap: Snapshot, body: SaleBody) {
    const { lines } = this.resolve(snap, body);
    const t = calculateDocument({ lines }, snap.tax ?? undefined);
    return {
      lines: t.lines.map((l) => ({ lineNumber: l.lineNumber, net: formatCents(l.netAmount), gst: formatCents(l.gstAmount), tax: formatCents(l.taxAmount), total: formatCents(l.lineTotal) })),
      totals: totalsJson(t),
    };
  }

  /** A cashier's discounts stay within the business's limit (documents.ts, checkDiscountLimit). */
  private checkDiscountLimit(snap: Snapshot, lines: LineInput[]) {
    const person = this.ctx.person();
    const limit = snap.me.counter?.cashierDiscountLimit;
    if (person?.role !== 'cashier' || limit === null || limit === undefined) return;
    const tax = snap.tax ?? undefined;
    const withDiscounts = calculateDocument({ lines }, tax);
    const fullPrice = calculateDocument({ lines: lines.map((l) => ({ ...l, allowanceCharges: (l.allowanceCharges ?? []).filter((a) => a.isCharge) })) }, tax);
    withDiscounts.lines.forEach((line, i) => {
      const base = fullPrice.lines[i]!.netAmount;
      if (base <= 0n) return;
      const off = base - line.netAmount;
      if (off > 0n && (off * 10000n - 50n * 100n) > BigInt(Math.round(Number(limit) * 100)) * base) {
        throw new TillError(403, 'discount_over_limit', `Cashiers can take up to ${Number(limit)}% off a line. Ask a manager to make this sale.`);
      }
    });
  }

  private async sell(snap: Snapshot, body: SaleBody, idem: string | null): Promise<Response> {
    const person = this.ctx.person();
    if (!person) return problem(401, 'unauthorized', 'Sign in on the till first');
    if (!person.permissions.includes('documents.issue')) return problem(403, 'forbidden', 'You cannot make sales on this till');
    if (!snap.me.certificate) return problem(409, 'no_certificate', 'The business has no BTS certificate yet; receipts cannot be signed');
    const { lines, itemIds, customer, customerId } = this.resolve(snap, body);
    this.checkDiscountLimit(snap, lines);
    const totals = calculateDocument({ lines }, snap.tax ?? undefined);

    // How it was paid: in parts (the largest names the document), or one way.
    let payment: { meansCode: string; terms: string };
    let tenders: Tender[];
    if (body.tenders?.length) {
      const parts = body.tenders.map((x) => ({ means: x.meansCode, cents: toCents(x.amount) }));
      if (parts.some((x) => x.cents <= 0n || !MONEY.test(money(x.cents)))) throw new TillError(422, 'invalid_tenders', 'Each part of the payment must be more than zero');
      if (parts.some((x) => x.means === GIFT_CARD)) throw new TillError(503, 'needs_connection', 'Gift cards need a connection');
      const sum = parts.reduce((a, x) => a + x.cents, 0n);
      if (sum !== totals.payableAmount) throw new TillError(422, 'invalid_tenders', `The parts add up to BZ$${money(sum)}, not the total BZ$${money(totals.payableAmount)}`);
      const largest = parts.reduce((a, x) => (x.cents > a.cents ? x : a));
      payment = { meansCode: largest.means, terms: `Paid ${parts.map((x) => `BZ$${money(x.cents)} ${MEANS_NAMES[x.means] ?? 'other'}`).join(', ')}` };
      tenders = parts.map((x) => ({ means: x.means, cents: x.cents.toString() }));
    } else {
      const meansCode = body.payment?.meansCode ?? '10';
      payment = { meansCode, terms: body.payment?.terms?.trim() || 'Paid' };
      tenders = [{ means: meansCode, cents: totals.payableAmount.toString() }];
    }
    const chargesOf = (l: (typeof totals.lines)[number], service = false) =>
      l.allowanceCharges.filter((a) => a.isCharge && (!service || a.reason.startsWith('Service charge'))).reduce((n, a) => n + a.amount, 0n);
    const discountCents = totals.lines.reduce((a, l) => {
      const full = BigInt(Math.round(Number(l.quantity) * Number(l.unitPrice) * 100)) + chargesOf(l);
      return a + (full > l.netAmount ? full - l.netAmount : 0n);
    }, 0n);
    const serviceCents = totals.lines.reduce((a, l) => a + chargesOf(l, true), 0n);
    const tipCents = body.tip && /^\d+(\.\d{1,2})?$/.test(body.tip.amount) ? toCents(body.tip.amount) : 0n;
    const tip: Tender | null = tipCents > 0n ? { means: body.tip!.meansCode, cents: tipCents.toString() } : null;
    const shiftId = (await this.ctx.db.meta<string | null>('currentShift')) ?? null;
    // The key and the contents together: the same sale sent again is found; a different sale under
    // an old key (a cart restored from long ago) is a new sale, not the old one.
    const idemKey = idem ? `${idem}:${await fingerprint(body)}` : null;

    return exclusive(async () => {
      const db = this.ctx.db;
      // Sent twice (a double tap, a retry after a lost answer): the first sale, once.
      if (idemKey) {
        const row = await db.saleByIdem(idemKey);
        if (row) return json(201, (await db.open<LocalSale>(row.payload)).doc);
      }
      const { series, receptionEnv, environment } = snap.offline;
      const serialKey = `nextSerial.${environment}.${series}`;
      // The next number in the till's series: never one used before (on this install, or known to the server).
      const serial = Math.max((await db.meta<number>(serialKey)) ?? 1, snap.offline.nextSerial);
      if (serial > 999_999_999) throw new TillError(409, 'series_full', 'This till’s series is full; connect it to get a new one');
      const now = this.ctx.now();
      const local = toBelizeDateTime(now);
      const securityCode = generateSecurityCode();
      const etdui = buildEtdui({
        etdType: '02', tin: snap.business.tin, serial, series, issueDate: local.date, issueTime: local.time,
        operMode: 3, receptionEnv: receptionEnv as EtduiParts['receptionEnv'], securityCode,
      } as EtduiParts);
      const id = crypto.randomUUID();
      const view = receiptPrintView({
        etdui, series, serial, issueDate: local.date, issueTime: local.time, operMode: 3, receptionEnv, issuer: snap.receipt.issuer,
        ...(customer && (customer.tin || customer.otherId) && { customer: { ...(customer.tin && { tin: customer.tin }), ...(customer.otherId && { otherId: customer.otherId }) } }),
        totals, payment: { terms: payment.terms },
        ...(body.note && { note: body.note }),
      });
      const doc: DocumentInfo = {
        id, etdui, type: '02', typeName: 'Tax Receipt', series: String(series).padStart(3, '0'), serial, number: String(serial).padStart(9, '0'),
        status: 'on_till', contingency: true, environment, protocolNumber: null, issueDate: local.date, issueTime: local.time,
        customerId: customerId ?? null, customer: customer ? { ...(customer.name && { name: customer.name }), ...(customer.tin && { tin: customer.tin }) } : null,
        referencedEtdui: null, totals: totalsJson(totals), conditions: [], supersedes: null, supersededBy: null, issuedBy: person.name, createdAt: now.toISOString(),
      };
      const docLines: DocumentLine[] = totals.lines.map((l) => ({
        lineNumber: l.lineNumber, description: l.description, quantity: l.quantity, unitCode: l.unitCode, unitPrice: l.unitPrice, gstCategory: l.gstCategory,
        net: formatCents(l.netAmount), gst: formatCents(l.gstAmount), tax: formatCents(l.taxAmount), total: formatCents(l.lineTotal),
      }));
      const event: SaleEvent = {
        id, kind: 'sale', at: now.toISOString(), userId: person.id, shiftId, environment, series, serial, issueDate: local.date, issueTime: local.time, securityCode, etdui,
        request: { lines, ...(customer && { customer }), ...(customerId && { customerId }), payment, ...(body.note && { note: body.note }), lineItemIds: itemIds },
        ...(tenders.length > 1 && { tenders }),
        ...(tip && { tip }),
      };
      const sale: LocalSale = { doc, lines: docLines, view, tenders, discountCents: discountCents.toString(), userId: person.id, ...(serviceCents > 0n && { serviceCents: serviceCents.toString() }), ...(tip && { tip }) };
      const [salePayload, eventPayload] = await Promise.all([db.seal(sale), db.seal(event)]);
      // The sale, its event for the server and the next number: all on the disk, or none of it.
      await db.write({
        meta: { [serialKey]: serial + 1 },
        sales: [{ id, createdAt: doc.createdAt, shiftId, idem: idemKey, payload: salePayload }],
        outbox: [outboxRow(event, `Receipt ${doc.series}-${doc.number} · BZ$${doc.totals.payable}`, eventPayload)],
      });
      this.sales.set(id, { row: { createdAt: doc.createdAt, shiftId }, sale });
      this.ctx.changed();
      return json(201, doc);
    });
  }

  /** A sale the server made (gift card, on account, refund) during the till's shift: in the shift's report. */
  private async recordRemote(body: SaleBody, doc: DocumentInfo) {
    const shift = await this.current();
    if (!shift || shift.closed) return;
    const payable = toCents(doc.totals.payable);
    const tenders: Tender[] = body.tenders?.length
      ? body.tenders.map((x) => ({ means: x.meansCode, cents: toCents(x.amount).toString() }))
      : [{ means: body.giftCard ? GIFT_CARD : body.payment?.meansCode ?? '10', cents: payable.toString() }];
    const remote: RemoteSale = { id: doc.id, type: doc.type, payableCents: payable.toString(), gstCents: toCents(doc.totals.gst).toString(), tenders, at: this.ctx.now().toISOString() };
    shift.remote = [...shift.remote.filter((r) => r.id !== doc.id), remote];
    await this.saveShift(shift);
  }

  // ---------- receipts ----------

  private async loadSales() {
    if (this.loaded) return;
    for (const row of await this.ctx.db.saleRows(500)) {
      if (this.sales.has(row.id)) continue;
      this.sales.set(row.id, { row, sale: await this.ctx.db.open<LocalSale>(row.payload) });
    }
    this.loaded = true;
  }

  async sale(id: string) {
    const cached = this.sales.get(id);
    if (cached) return cached;
    const row = await this.ctx.db.saleRow(id);
    if (!row) return null;
    const entry = { row, sale: await this.ctx.db.open<LocalSale>(row.payload) };
    this.sales.set(id, entry);
    return entry;
  }

  /** The server's answer for a receipt (sync.ts): its status from now on. */
  async saleSynced(id: string, status: string) {
    const entry = await this.sale(id);
    if (!entry || entry.sale.doc.status === status) return;
    entry.sale.doc = { ...entry.sale.doc, status: status as DocumentInfo['status'] };
    const row = await this.ctx.db.saleRow(id);
    if (row) await this.ctx.db.write({ sales: [{ ...row, payload: await this.ctx.db.seal(entry.sale) }] });
  }

  private printView(snap: Snapshot, sale: LocalSale) {
    const view = sale.view;
    return {
      view,
      status: sale.doc.status,
      protocolNumber: null,
      logo: snap.receipt.logo,
      qr: { url: `${snap.receipt.qrBase}${view.etdui}` },
      printed: { printable: true, authorization: authorizationText(view, { draft: true }), regulatory: regulatoryLines(view, {}), info: infoLines(view) },
    };
  }

  private async documents(q: URLSearchParams, path: string): Promise<Response> {
    await this.loadSales();
    const type = q.get('type');
    const text = q.get('q')?.trim().toLowerCase() ?? '';
    const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
    const mine = [...this.sales.values()]
      .map((e) => e.sale.doc)
      .filter((d) => (!type || type.split(',').includes(d.type)) && (!text || `${d.series}-${d.number} ${d.number} ${d.customer?.name ?? ''} ${d.customer?.tin ?? ''} ${d.totals.payable}`.toLowerCase().includes(text)));
    let fromServer: DocumentInfo[] = [];
    if (this.ctx.online() && this.ctx.hasSession() && !q.get('cursor')) {
      try {
        const res = await this.ctx.net(path, { timeoutMs: 6000 });
        if (res.ok) fromServer = ((await res.json()) as { data: DocumentInfo[] }).data;
      } catch {
        /* offline: the till's own */
      }
    }
    const seen = new Set(fromServer.map((d) => d.id));
    const all = [...fromServer, ...mine.filter((d) => !seen.has(d.id))].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return json(200, { data: all.slice(0, limit), nextCursor: null });
  }

  // ---------- the till's shift ----------

  private async shift(id: string): Promise<LocalShift | null> {
    const row = await this.ctx.db.shiftRow(id);
    return row ? this.ctx.db.open<LocalShift>(row.payload) : null;
  }

  private async current(): Promise<LocalShift | null> {
    const id = await this.ctx.db.meta<string | null>('currentShift');
    return id ? this.shift(id) : null;
  }

  private async saveShift(s: LocalShift, extra: { meta?: Record<string, unknown>; event?: SyncEvent; label?: string } = {}) {
    const [payload, eventPayload] = await Promise.all([this.ctx.db.seal(s), extra.event ? this.ctx.db.seal(extra.event) : Promise.resolve(null)]);
    await this.ctx.db.write({
      shifts: [{ id: s.id, createdAt: s.openedAt, payload }],
      ...(extra.meta && { meta: extra.meta }),
      ...(extra.event && eventPayload && { outbox: [outboxRow(extra.event, extra.label ?? extra.event.kind, eventPayload)] }),
    });
    if (extra.event) this.ctx.changed();
  }

  /** Take over the shift the server has open on this till's drawer (the till was updated mid-shift). */
  async adopt(snap: Snapshot) {
    if (await this.ctx.db.meta<string | null>('currentShift')) return;
    const open = snap.openShift;
    if (!open || open.shift.register.id !== snap.device.register.id) return;
    if (await this.ctx.db.shiftRow(open.shift.id)) return;
    const s: LocalShift = {
      id: open.shift.id, number: open.shift.number, registerId: open.shift.register.id, registerName: open.shift.register.name,
      openedBy: open.shift.openedBy, openedAt: open.shift.openedAt, floatCents: toCents(open.shift.openingFloat).toString(),
      movements: [], remote: [], closed: null, baseline: open.report,
    };
    await this.saveShift(s, { meta: { currentShift: s.id } });
  }

  /** The server gave the shift its number. */
  async shiftNumbered(id: string, number: number) {
    const s = await this.shift(id);
    if (s && s.number !== number) {
      s.number = number;
      await this.saveShift(s);
    }
  }

  private async currentShift(): Promise<{ shift: Shift | null; report: ShiftReport | null }> {
    const s = await this.current();
    if (!s || s.closed) return { shift: null, report: null };
    return { shift: this.shiftJson(s), report: await this.report(s) };
  }

  private async openShift(snap: Snapshot, body: Record<string, unknown>): Promise<Response> {
    const person = this.ctx.person();
    if (!person) return problem(401, 'unauthorized', 'Sign in on the till first');
    if (!person.permissions.includes('documents.issue')) return problem(403, 'forbidden', 'You cannot open a shift');
    const float = toCents(String(body.openingFloat ?? '0'));
    if (float < 0n || !MONEY.test(String(body.openingFloat ?? '0'))) return problem(422, 'invalid_shift', 'The float must be an amount');
    const open = await this.current();
    if (open && !open.closed) return problem(409, 'register_busy', 'This till’s shift is already open');
    const now = this.ctx.now().toISOString();
    const s: LocalShift = {
      id: crypto.randomUUID(), number: 0, registerId: snap.device.register.id, registerName: snap.device.register.name,
      openedBy: { id: person.id, name: person.name }, openedAt: now, floatCents: float.toString(), movements: [], remote: [], closed: null, baseline: null,
    };
    const event: ShiftOpenEvent = { id: crypto.randomUUID(), kind: 'shift_open', at: now, userId: person.id, shiftId: s.id, openingFloat: money(float) };
    await this.saveShift(s, { meta: { currentShift: s.id }, event, label: `Shift opened · float BZ$${money(float)}` });
    return json(201, { shift: this.shiftJson(s), report: await this.report(s) });
  }

  private async cash(id: string, body: Record<string, unknown>): Promise<Response> {
    const person = this.ctx.person();
    const s = await this.shift(id);
    if (!s) return problem(404, 'not_found', 'Shift not found');
    if (s.closed) return problem(409, 'shift_closed', 'This shift is already closed');
    const kind = body.kind === 'pay_in' ? 'pay_in' as const : body.kind === 'pay_out' ? 'pay_out' as const : null;
    const amount = String(body.amount ?? '');
    const reason = String(body.reason ?? '').trim();
    if (!kind || !MONEY.test(amount) || toCents(amount) <= 0n) return problem(422, 'invalid_amount', 'Give an amount more than zero');
    if (!reason) return problem(422, 'invalid_reason', 'Say why');
    const at = this.ctx.now().toISOString();
    const event: CashEvent = { id: crypto.randomUUID(), kind: 'cash', at, userId: person?.id ?? null, shiftId: s.id, type: kind, amount: money(toCents(amount)), reason };
    s.movements = [...s.movements, { id: event.id, kind, cents: toCents(amount).toString(), reason, at, by: person?.name ?? null }];
    await this.saveShift(s, { event, label: `${kind === 'pay_in' ? 'Paid in' : 'Paid out'} BZ$${event.amount}` });
    return json(201, { shift: this.shiftJson(s), report: await this.report(s) });
  }

  private async closeShift(id: string, body: Record<string, unknown>): Promise<Response> {
    const person = this.ctx.person();
    if (!person) return problem(401, 'unauthorized', 'Sign in on the till first');
    const s = await this.shift(id);
    if (!s) return problem(404, 'not_found', 'Shift not found');
    if (s.closed) return problem(409, 'shift_closed', 'This shift is already closed');
    const countedText = String(body.countedCash ?? '');
    if (!MONEY.test(countedText)) return problem(422, 'invalid_amount', 'The count must be an amount');
    const counted = toCents(countedText);
    const detail = (body.counted ?? null) as Record<string, number> | null;
    if (detail) {
      const sum = Object.entries(detail).reduce((a, [d, n]) => a + toCents(d) * BigInt(n), 0n);
      if (sum !== counted) return problem(422, 'invalid_count', `The notes and coins add up to BZ$${money(sum)}, not BZ$${money(counted)}`);
    }
    const report = await this.report(s);
    const expected = toCents(report.cash.expected);
    const at = this.ctx.now().toISOString();
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    s.closed = { by: person.name, at, countedCents: counted.toString(), expectedCents: expected.toString(), detail, note };
    const event: ShiftCloseEvent = { id: crypto.randomUUID(), kind: 'shift_close', at, userId: person.id, shiftId: s.id, countedCash: money(counted), counted: detail, note };
    await this.saveShift(s, { meta: { currentShift: null }, event, label: `Shift closed · counted BZ$${money(counted)}` });
    return json(200, { shift: this.shiftJson(s), report: await this.report(s) });
  }

  private async shifts(path: string): Promise<Response> {
    const mine = await Promise.all((await this.ctx.db.shiftRows()).slice(0, 50).map((r) => this.ctx.db.open<LocalShift>(r.payload)));
    let fromServer: Shift[] = [];
    if (this.ctx.online() && this.ctx.hasSession()) {
      try {
        const res = await this.ctx.net(path, { timeoutMs: 6000 });
        if (res.ok) fromServer = ((await res.json()) as { data: Shift[] }).data;
      } catch {
        /* offline */
      }
    }
    const local = new Map(mine.map((s) => [s.id, this.shiftJson(s)]));
    // The till's own copy of its shifts wins (it has what is not sent yet).
    const all = [...fromServer.map((s) => local.get(s.id) ?? s), ...[...local.values()].filter((s) => !fromServer.some((x) => x.id === s.id))]
      .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
    return json(200, { data: all });
  }

  private shiftJson(s: LocalShift): Shift {
    const expected = s.closed ? BigInt(s.closed.expectedCents) : null;
    const counted = s.closed ? BigInt(s.closed.countedCents) : null;
    return {
      id: s.id, number: s.number, register: { id: s.registerId, name: s.registerName }, openedBy: s.openedBy, openedAt: s.openedAt,
      openingFloat: money(s.floatCents), status: s.closed ? 'closed' : 'open', closedBy: s.closed?.by ?? null, closedAt: s.closed?.at ?? null,
      expectedCash: expected === null ? null : money(expected), countedCash: counted === null ? null : money(counted),
      difference: expected === null || counted === null ? null : money(counted - expected), note: s.closed?.note ?? null,
    };
  }

  /** The shift's report, as the server's (shifts.ts, shiftReport), from the till's own records. */
  async report(s: LocalShift): Promise<ShiftReport> {
    await this.loadSales();
    const receipts = [...this.sales.values()].filter((e) => e.row.shiftId === s.id).map((e) => e.sale);
    const zero = () => Object.fromEntries(MEANS.map((m) => [m, 0n])) as Record<Means, bigint>;
    const sales = zero();
    const refunded = zero();
    let giftUsed = 0n;
    const byType = new Map<string, { count: number; total: bigint; gst: bigint }>();
    const addDoc = (type: string, total: bigint, gst: bigint) => {
      const d = byType.get(type) ?? { count: 0, total: 0n, gst: 0n };
      d.count++;
      d.total += total;
      d.gst += gst;
      byType.set(type, d);
    };
    const takeParts = (parts: Tender[]) => {
      for (const part of parts) {
        if (part.means === GIFT_CARD) giftUsed += BigInt(part.cents);
        else sales[fromCode(part.means)] += BigInt(part.cents);
      }
    };
    for (const r of receipts) {
      addDoc('02', toCents(r.doc.totals.payable), toCents(r.doc.totals.gst));
      takeParts(r.tenders);
    }
    let refundCount = 0;
    for (const r of s.remote) {
      addDoc(r.type, BigInt(r.payableCents), BigInt(r.gstCents));
      if (r.type === '02') takeParts(r.tenders);
      if (r.type === '04') {
        refunded[fromCode(r.tenders[0]?.means)] += BigInt(r.payableCents);
        refundCount++;
      }
    }
    const discounted = receipts.filter((r) => BigInt(r.discountCents) > 0n);
    const served = receipts.filter((r) => BigInt(r.serviceCents ?? '0') > 0n);
    const tipped = receipts.filter((r) => r.tip);
    const payIn = s.movements.filter((m) => m.kind === 'pay_in').reduce((a, m) => a + BigInt(m.cents), 0n);
    const payOut = s.movements.filter((m) => m.kind === 'pay_out').reduce((a, m) => a + BigInt(m.cents), 0n);
    const takings = zero();
    for (const m of MEANS) takings[m] = sales[m] - refunded[m];

    // Carried on from the server: what it had then, plus what the till did since.
    const b = s.baseline;
    const plus = (m: Record<Means, bigint>, from?: Record<string, string>) => {
      const out = { ...m };
      for (const k of MEANS) out[k] += from ? toCents(from[k] ?? '0') : 0n;
      return out;
    };
    const salesAll = plus(sales, b?.sales);
    const refundsAll = plus(refunded, b?.refunds);
    const invoicePayments = plus(zero(), b?.invoicePayments);
    const takingsAll = plus(takings, b?.takings);
    const payInAll = payIn + (b ? toCents(b.cash.payIn) : 0n);
    const payOutAll = payOut + (b ? toCents(b.cash.payOut) : 0n);
    const float = BigInt(s.floatCents);
    const expected = float + takingsAll.cash + payInAll - payOutAll;
    const counted = s.closed ? BigInt(s.closed.countedCents) : null;
    for (const d of b?.documents ?? []) {
      const e = byType.get(d.type) ?? { count: 0, total: 0n, gst: 0n };
      byType.set(d.type, { count: e.count + d.count, total: e.total + toCents(d.total), gst: e.gst + toCents(d.gst) });
    }
    const typeName: Record<string, string> = { '01': 'Tax invoices', '02': 'Tax receipts', '03': 'Debit notes', '04': 'Credit notes' };
    const documents = [...byType.entries()].sort(([a], [b2]) => a.localeCompare(b2)).map(([type, d]) => ({ type, name: typeName[type] ?? type, count: d.count, total: money(d.total), gst: money(d.gst) }));
    const asMoney = (r: Record<Means, bigint>) => Object.fromEntries(MEANS.map((m) => [m, money(r[m])])) as Record<Means, string>;
    return {
      documents,
      gst: money([...byType.entries()].reduce((a, [type, d]) => a + (type === '04' ? -d.gst : d.gst), 0n)),
      sales: asMoney(salesAll),
      invoicePayments: asMoney(invoicePayments),
      refunds: asMoney(refundsAll),
      refundCount: refundCount + (b?.refundCount ?? 0),
      takings: asMoney(takingsAll),
      totalTakings: money(MEANS.reduce((a, m) => a + takingsAll[m], 0n)),
      voided: b?.voided ?? { count: 0, total: '0.00' },
      giftCards: { sold: b?.giftCards?.sold ?? { count: 0, total: '0.00' }, used: money(giftUsed + (b?.giftCards ? toCents(b.giftCards.used) : 0n)) },
      discounts: {
        count: discounted.length + (b?.discounts?.count ?? 0),
        total: money(discounted.reduce((a, r) => a + BigInt(r.discountCents), 0n) + (b?.discounts ? toCents(b.discounts.total) : 0n)),
      },
      serviceCharge: {
        count: served.length + (b?.serviceCharge?.count ?? 0),
        total: money(served.reduce((a, r) => a + BigInt(r.serviceCents ?? '0'), 0n) + (b?.serviceCharge ? toCents(b.serviceCharge.total) : 0n)),
      },
      tips: {
        count: tipped.length + (b?.tips?.count ?? 0),
        total: money(tipped.reduce((a, r) => a + BigInt(r.tip!.cents), 0n) + (b?.tips ? toCents(b.tips.total) : 0n)),
      },
      cash: {
        float: money(float), in: money(takingsAll.cash), payIn: money(payInAll), payOut: money(payOutAll), expected: money(expected),
        counted: counted === null ? null : money(counted), difference: counted === null ? null : money(counted - expected),
      },
      movements: [
        ...(b?.movements ?? []),
        ...s.movements.map((m) => ({ id: m.id, kind: m.kind, amount: money(m.cents), reason: m.reason, at: m.at, by: m.by })),
      ],
    };
  }

  // ---------- held sales ----------

  private async held(p: string, method: string, options: Options): Promise<Response> {
    const db = this.ctx.db;
    const online = this.ctx.online() && this.ctx.hasSession();
    const m = /^\/v1\/held-sales\/([0-9a-f-]{36})(\/recall)?$/.exec(p);
    if (m) {
      const row = await db.heldRow(m[1]!);
      if (row) {
        const h = await db.open<HeldSaleRecord>(row.payload);
        await db.write({ deleteHeld: [h.id] });
        return method === 'DELETE' ? json(204, null) : json(200, h);
      }
      return online ? (await this.ctx.net(p, { method, timeoutMs: 15_000 })) : this.needsServer(null, 'That held sale is on the server; it can be recalled once the till is online.');
    }
    if (p !== '/v1/held-sales') return online ? (await this.ctx.net(p, { method, body: options.body, timeoutMs: 15_000 })) : this.needsServer(null, 'This needs a connection.');
    if (method === 'POST') {
      if (online) {
        try {
          return await this.ctx.net(p, { method, body: options.body, timeoutMs: 8000 });
        } catch {
          /* the connection dropped: kept here */
        }
      }
      const b = options.body as { label?: string; total: string; count: number; sale: unknown };
      const h: HeldSaleRecord = { id: crypto.randomUUID(), at: this.ctx.now().toISOString(), label: b.label ?? '', total: b.total, count: b.count, sale: b.sale, heldBy: this.ctx.person()?.name ?? null };
      await db.write({ held: [{ id: h.id, createdAt: h.at, payload: await db.seal(h) }] });
      return json(201, h);
    }
    // The list: the server's, and those held here while offline (moved up as soon as it can be reached).
    const mine = await Promise.all((await db.heldRows()).map((r) => db.open<HeldSaleRecord>(r.payload)));
    let fromServer: HeldSaleRecord[] = [];
    if (online) {
      try {
        for (const h of [...mine].reverse()) {
          const res = await this.ctx.net('/v1/held-sales', { method: 'POST', body: { label: h.label, total: h.total, count: Math.max(1, h.count), sale: h.sale }, timeoutMs: 8000 });
          if (!res.ok) break;
          await db.write({ deleteHeld: [h.id] });
          mine.splice(mine.indexOf(h), 1);
        }
        const res = await this.ctx.net('/v1/held-sales', { timeoutMs: 6000 });
        if (res.ok) fromServer = ((await res.json()) as { data: HeldSaleRecord[] }).data;
      } catch {
        /* offline */
      }
    }
    return json(200, { data: [...mine, ...fromServer] });
  }
}

export class TillError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function totalsJson(t: DocumentTotals) {
  return {
    lineExtension: formatCents(t.lineExtensionAmount),
    gst: formatCents(t.gstAmount),
    tax: formatCents(t.taxAmount),
    taxInclusive: formatCents(t.taxInclusiveAmount),
    payable: formatCents(t.payableAmount),
    charges: formatCents(t.lines.reduce((n, l) => n + l.allowanceCharges.filter((a) => a.isCharge).reduce((m, a) => m + a.amount, 0n), 0n)),
  };
}

export function outboxRow(event: SyncEvent, label: string, payload: OutboxRow['payload']): OutboxRow {
  return { id: event.id, kind: event.kind as OutboxKind, status: 'pending', createdAt: event.at, attempts: 0, lastTriedAt: null, lastError: null, result: null, syncedAt: null, label, payload };
}
