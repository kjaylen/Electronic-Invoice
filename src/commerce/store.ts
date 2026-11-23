/**
 * The online store's core: store settings, prices shown to buyers, quoting a
 * cart, placing an order (stock reserved in the same transaction), and
 * turning a paid order into a BTS document.
 *
 * Prices are kept before GST, like the rest of the catalog. Buyers see prices
 * with GST included; totals always come from the engine's own calculation,
 * so the order, the quote and the e-invoice agree to the cent.
 */

import { moveStock, takeForOrder } from '../inventory/stock.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.ts';
import { toBigInt } from '../db/database.ts';
import { add, compare, formatCents, parseCents, parseDecimal, percentOf, roundToCents, ZERO } from '../engine/decimal.ts';
import { calculateDocument, type LineInput } from '../engine/calc.ts';
import { BELIZE_DISTRICTS, type Customer, type DistrictCode } from '../engine/ubl.ts';
import { issueDocument, type IssueRequest, type IssueResult, type PipelineDeps } from '../pipeline/issue.ts';
import { allocateDiscount, DiscountError, type DiscountKind, discountShare, findUsableDiscount } from './discounts.ts';
import { openShiftSql } from '../db/shifts.ts';

export class StoreError extends Error {
  override name = 'StoreError';
  readonly code: 'store_closed' | 'not_found' | 'out_of_stock' | 'invalid_order' | 'conflict';
  constructor(code: StoreError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// ---------- settings ----------

export interface DeliveryZone {
  name: string;
  /** Before GST, like every price. */
  fee: string;
}

export interface StoreSettings {
  enabled: boolean;
  tagline: string;
  about: string;
  /** Where new-order notifications go; the business email when empty. */
  notifyEmail: string;
  /** Shown to buyers as a "message us on WhatsApp" link. */
  whatsapp: string;
  delivery: { enabled: boolean; zones: DeliveryZone[] };
  pickup: { enabled: boolean; instructions: string };
  payments: {
    bankTransfer: { enabled: boolean; instructions: string };
    cashOnDelivery: { enabled: boolean };
    payAtPickup: { enabled: boolean };
    /** Card or PayPal at checkout, through the business's own payment account. */
    online: { enabled: boolean; provider: 'paypal' | 'test' | 'belizebank' | 'ekyash' };
  };
}

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  enabled: false,
  tagline: '',
  about: '',
  notifyEmail: '',
  whatsapp: '',
  delivery: { enabled: true, zones: [{ name: 'Belize City', fee: '10.00' }] },
  pickup: { enabled: true, instructions: '' },
  payments: { bankTransfer: { enabled: true, instructions: '' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true }, online: { enabled: false, provider: 'test' } },
};

/** Stored settings over the defaults, so older or partial settings always have every field. */
export function withDefaults(stored: Partial<StoreSettings> | null | undefined): StoreSettings {
  const s = stored ?? {};
  const d = DEFAULT_STORE_SETTINGS;
  return {
    enabled: s.enabled ?? d.enabled,
    tagline: s.tagline ?? d.tagline,
    about: s.about ?? d.about,
    notifyEmail: s.notifyEmail ?? d.notifyEmail,
    whatsapp: s.whatsapp ?? d.whatsapp,
    delivery: { enabled: s.delivery?.enabled ?? d.delivery.enabled, zones: s.delivery?.zones ?? d.delivery.zones },
    pickup: { enabled: s.pickup?.enabled ?? d.pickup.enabled, instructions: s.pickup?.instructions ?? d.pickup.instructions },
    payments: {
      bankTransfer: { enabled: s.payments?.bankTransfer?.enabled ?? d.payments.bankTransfer.enabled, instructions: s.payments?.bankTransfer?.instructions ?? '' },
      cashOnDelivery: { enabled: s.payments?.cashOnDelivery?.enabled ?? d.payments.cashOnDelivery.enabled },
      payAtPickup: { enabled: s.payments?.payAtPickup?.enabled ?? d.payments.payAtPickup.enabled },
      online: { enabled: s.payments?.online?.enabled ?? false, provider: s.payments?.online?.provider ?? 'test' },
    },
  };
}

export interface StoreRef {
  tenantId: string;
  slug: string;
  name: string;
  email: string;
  telephone: string;
  street: string;
  city: string;
  environment: string;
  settings: StoreSettings;
}

export async function loadStore(db: Queryable, slug: string, opts: { requireOpen?: boolean } = {}): Promise<StoreRef> {
  const r = (await db.query<{ id: string; slug: string; name: string; email: string; telephone: string; street: string; city: string; environment: string; store_settings: Partial<StoreSettings>; suspended: boolean }>(
    `select id, slug, coalesce(trade_name, legal_name) as name, email, telephone, street, city, environment, store_settings, suspended_at is not null as suspended from tenants where slug = $1`,
    [slug.toLowerCase()],
  )).rows[0];
  if (!r) throw new StoreError('not_found', 'There is no store at this address');
  if (r.suspended) throw new StoreError('store_closed', 'This store is not open right now');
  const settings = withDefaults(r.store_settings);
  if ((opts.requireOpen ?? true) && !settings.enabled) throw new StoreError('store_closed', 'This store is not open yet');
  return { tenantId: r.id, slug: r.slug, name: r.name, email: r.email, telephone: r.telephone, street: r.street, city: r.city, environment: r.environment, settings };
}

/** Which payment methods a fulfilment allows. */
export function paymentMethodsFor(settings: StoreSettings, fulfillment: 'delivery' | 'pickup'): PaymentMethod[] {
  const p = settings.payments;
  return [
    ...(p.bankTransfer.enabled ? ['bank_transfer' as const] : []),
    ...(p.cashOnDelivery.enabled && fulfillment === 'delivery' ? ['cash_on_delivery' as const] : []),
    ...(p.payAtPickup.enabled && fulfillment === 'pickup' ? ['pay_at_pickup' as const] : []),
    ...(p.online.enabled ? ['online' as const] : []),
  ];
}

export type PaymentMethod = 'bank_transfer' | 'cash_on_delivery' | 'pay_at_pickup' | 'online';

// ---------- prices ----------

/** What a buyer pays for one unit: net plus GST at the standard rate (12.5%) when standard-rated. */
export function priceWithGst(net: string, gstCategory: 'S' | 'Z' | 'E', ratePercent = '12.5'): string {
  const n = parseDecimal(net);
  return formatCents(roundToCents(gstCategory === 'S' ? add(n, percentOf(n, parseDecimal(ratePercent))) : n));
}

export const trimDecimal = (v: string) => String(v).replace(/(\.\d{2}\d*?)0+$/, '$1').replace(/\.$/, '');

// ---------- carts and quotes ----------

export interface CartLine {
  variantId: string;
  quantity: number;
}

export interface CheckoutChoice {
  fulfillment: 'delivery' | 'pickup';
  zone?: string;
  /** A discount code the buyer typed. */
  discountCode?: string;
}

interface VariantRow {
  id: string;
  product_id: string;
  title: string;
  status: string;
  option1: string | null;
  option2: string | null;
  seller_code: string | null;
  unit_code: string;
  unit_price: string;
  gst_category: 'S' | 'Z' | 'E';
  exemption_reason_code: string | null;
  stock_quantity: number | null;
  archived_at: string | Date | null;
}

export interface QuotedLine {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  sellerCode: string | null;
  quantity: number;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode: string | null;
  total: string;
  /** The line's share of the discount, before GST. */
  discountCents: bigint;
  /** The line's total without the discount (what the shelf price adds up to). */
  listTotal: string;
}

export interface Quote {
  lines: QuotedLine[];
  delivery: { zone: string; fee: string; total: string } | null;
  /** The discount applied: how much less the buyer pays (GST included). */
  discount: { id: string; code: string; kind: DiscountKind; saved: string; net: bigint } | null;
  totals: { lineExtension: string; gst: string; total: string };
  cents: { lineExtension: bigint; gst: bigint; total: bigint };
}

export const variantTitle = (v: { option1: string | null; option2: string | null }) => [v.option1, v.option2].filter(Boolean).join(' / ') || null;

const DELIVERY_UNIT = 'EA';

/** Price a cart from the live catalog: only active products, existing variants, positive whole quantities. */
export async function quoteCart(db: Queryable, deps: Pick<PipelineDeps, 'tax'>, store: StoreRef, cart: CartLine[], choice: CheckoutChoice): Promise<Quote> {
  if (cart.length === 0) throw new StoreError('invalid_order', 'The cart is empty');
  if (cart.length > 100) throw new StoreError('invalid_order', 'Too many different items in one order');
  const merged = new Map<string, number>();
  for (const l of cart) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 9999) throw new StoreError('invalid_order', 'Quantities must be whole numbers from 1 to 9999');
    merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
  }
  const rows = (await db.query<VariantRow>(
    `select i.id, i.product_id, p.title, p.status, i.option1, i.option2, i.seller_code, i.unit_code, i.unit_price::text as unit_price, i.gst_category,
            i.exemption_reason_code, i.stock_quantity::float8 as stock_quantity, i.archived_at
     from items i join products p on p.id = i.product_id
     where i.tenant_id = $1 and i.id = any($2::uuid[])`,
    [store.tenantId, [...merged.keys()]],
  )).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: QuotedLine[] = [];
  for (const [variantId, quantity] of merged) {
    const v = byId.get(variantId);
    if (!v || v.status !== 'active' || v.archived_at) throw new StoreError('not_found', 'An item in your cart is no longer available');
    if (v.stock_quantity !== null && v.stock_quantity < quantity) {
      throw new StoreError('out_of_stock', v.stock_quantity === 0 ? `${v.title} is sold out` : `Only ${v.stock_quantity} of ${v.title} left`);
    }
    lines.push({
      variantId, productTitle: v.title, variantTitle: variantTitle(v), sellerCode: v.seller_code, quantity, unitCode: v.unit_code,
      unitPrice: trimDecimal(v.unit_price), gstCategory: v.gst_category, exemptionReasonCode: v.exemption_reason_code, total: '0', discountCents: 0n, listTotal: '0',
    });
  }

  let delivery: Quote['delivery'] = null;
  if (choice.fulfillment === 'delivery') {
    if (!store.settings.delivery.enabled) throw new StoreError('invalid_order', 'This store does not deliver');
    const zone = store.settings.delivery.zones.find((z) => z.name === choice.zone);
    if (!zone) throw new StoreError('invalid_order', 'Choose where to deliver');
    delivery = { zone: zone.name, fee: zone.fee, total: '0' };
  } else if (!store.settings.pickup.enabled) {
    throw new StoreError('invalid_order', 'This store does not offer pickup');
  }

  // A discount code: each item line's share, as an allowance before GST.
  let discount: Quote['discount'] = null;
  if (choice.discountCode?.trim()) {
    const before = calculateDocument({ lines: toLineInputs(lines, null) }, deps.tax);
    let d;
    try {
      d = await findUsableDiscount(db, store.tenantId, choice.discountCode, before.taxInclusiveAmount);
    } catch (e) {
      if (e instanceof DiscountError) throw new StoreError('invalid_order', e.message);
      throw e;
    }
    const shares = allocateDiscount(d, before.lines.map((l) => ({ net: l.netAmount, total: l.lineTotal })));
    lines.forEach((l, i) => {
      l.discountCents = shares[i]!;
      l.listTotal = formatCents(before.lines[i]!.lineTotal);
    });
    if (d.kind === 'free_delivery' && delivery) delivery.fee = '0';
    discount = { id: d.id, code: d.code, kind: d.kind, saved: '0', net: shares.reduce((a, x) => a + x, 0n) };
  }

  const t = calculateDocument({ lines: toLineInputs(lines, delivery) }, deps.tax);
  lines.forEach((l, i) => {
    l.total = formatCents(t.lines[i]!.lineTotal);
    if (!discount) l.listTotal = l.total;
  });
  if (delivery) delivery.total = formatCents(t.lines[lines.length]!.lineTotal);
  if (discount) {
    // What the buyer saves: the same order without the code, minus this one.
    const withoutLines = lines.map((l) => ({ ...l, discountCents: 0n }));
    const zone = delivery && store.settings.delivery.zones.find((z) => z.name === delivery!.zone);
    const without = calculateDocument({ lines: toLineInputs(withoutLines, delivery && zone ? { zone: delivery.zone, fee: zone.fee } : null) }, deps.tax);
    discount.saved = formatCents(without.taxInclusiveAmount - t.taxInclusiveAmount);
  }
  return {
    lines,
    delivery,
    discount,
    totals: { lineExtension: formatCents(t.lineExtensionAmount), gst: formatCents(t.gstAmount), total: formatCents(t.taxInclusiveAmount) },
    cents: { lineExtension: t.lineExtensionAmount, gst: t.gstAmount, total: t.taxInclusiveAmount },
  };
}

function lineDescription(l: { productTitle: string; variantTitle: string | null }): string {
  return l.variantTitle ? `${l.productTitle} – ${l.variantTitle}` : l.productTitle;
}

type LineSource = Pick<QuotedLine, 'productTitle' | 'variantTitle' | 'sellerCode' | 'quantity' | 'unitCode' | 'unitPrice' | 'gstCategory' | 'exemptionReasonCode'> & { discountCents?: bigint; discountLabel?: string };

function toLineInputs(lines: LineSource[], delivery: { zone: string; fee: string } | null): LineInput[] {
  const out: LineInput[] = lines.map((l) => ({
    description: lineDescription(l),
    quantity: String(l.quantity),
    unitCode: l.unitCode,
    unitPrice: l.unitPrice,
    gstCategory: l.gstCategory,
    ...(l.sellerCode && { sellerItemCode: l.sellerCode }),
    ...(l.gstCategory === 'E' && l.exemptionReasonCode && { exemptionReasonCode: l.exemptionReasonCode }),
    ...(l.discountCents && l.discountCents > 0n && { allowanceCharges: [{ isCharge: false, reason: l.discountLabel ?? 'Discount', amount: formatCents(l.discountCents) }] }),
  }));
  // Delivery is a standard-rated service line (free delivery still appears, at zero).
  if (delivery) {
    out.push({ description: `Delivery: ${delivery.zone}`, quantity: '1', unitCode: DELIVERY_UNIT, unitPrice: compare(parseDecimal(delivery.fee), ZERO) > 0 ? delivery.fee : '0', gstCategory: 'S' });
  }
  return out;
}

// ---------- placing an order ----------

export interface OrderInput extends CheckoutChoice {
  lines: CartLine[];
  paymentMethod: PaymentMethod;
  customer: { name: string; email?: string; phone: string };
  address?: { street: string; city: string; districtCode: DistrictCode };
  /** For a tax invoice instead of a receipt. */
  business?: { tin: string; name: string };
  note?: string;
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export async function placeOrder(db: Database, deps: Pick<PipelineDeps, 'tax'>, store: StoreRef, input: OrderInput): Promise<{ id: string; number: number; token: string; quote: Quote }> {
  if (!paymentMethodsFor(store.settings, input.fulfillment).includes(input.paymentMethod)) {
    throw new StoreError('invalid_order', 'This payment method is not available for this order');
  }
  if (input.fulfillment === 'delivery' && !input.address) throw new StoreError('invalid_order', 'Give the delivery address');
  if (input.business && !input.address) throw new StoreError('invalid_order', 'A tax invoice needs the business address');

  return db.transaction(async (tx) => {
    const quote = await quoteCart(tx, deps, store, input.lines, input);
    if (quote.discount) {
      const used = await tx.query("update discount_codes set uses = uses + 1 where id = $1 and active and (max_uses is null or uses < max_uses) returning id", [quote.discount.id]);
      if (!used.rows.length) throw new StoreError('invalid_order', 'This discount code has just been used up');
    }
    const number = (await tx.query<{ n: number }>('update tenants set next_order_number = next_order_number + 1 where id = $1 returning next_order_number - 1 as n', [store.tenantId])).rows[0]!.n;
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const a = input.address;
    await tx.query(
      `insert into orders (id, tenant_id, number, token_hash, payment_method, fulfillment, delivery_zone, delivery_fee, customer_name, customer_email, customer_phone,
         street, city, district_code, buyer_tin, buyer_name, note, line_extension_cents, gst_cents, total_cents, discount_code_id, discount_code, discount_cents)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [id, store.tenantId, number, tokenHash(token), input.paymentMethod, input.fulfillment, quote.delivery?.zone ?? null, quote.delivery?.fee ?? '0',
        input.customer.name.trim(), input.customer.email?.trim().toLowerCase() || null, input.customer.phone.trim(),
        a?.street ?? null, a?.city ?? null, a?.districtCode ?? null, input.business?.tin ?? null, input.business?.name.trim() ?? null, input.note?.trim() || null,
        String(quote.cents.lineExtension), String(quote.cents.gst), String(quote.cents.total),
        quote.discount?.id ?? null, quote.discount?.code ?? null, String(quote.discount?.net ?? 0n)],
    );
    let n = 0;
    for (const l of quote.lines) {
      await tx.query(
        `insert into order_lines (order_id, tenant_id, line_number, item_id, product_title, variant_title, seller_code, quantity, unit_code, unit_price, gst_category, exemption_reason_code, total_cents, discount_cents)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, store.tenantId, ++n, l.variantId, l.productTitle, l.variantTitle, l.sellerCode, l.quantity, l.unitCode, l.unitPrice, l.gstCategory, l.exemptionReasonCode,
          String(parseCents(l.total)), String(l.discountCents)],
      );
    }
    // Reserve the stock (in the same transaction): fails for a variant that sold out since the quote.
    for (const l of quote.lines) {
      if (!(await takeForOrder(tx, store.tenantId, l.variantId, l.quantity, id))) throw new StoreError('out_of_stock', `${l.productTitle} just sold out`);
    }
    return { id, number, token, quote };
  });
}

// ---------- reading orders ----------

export interface OrderRow {
  id: string;
  tenant_id: string;
  number: number;
  status: 'open' | 'cancelled';
  payment_status: 'unpaid' | 'paid';
  fulfillment_status: 'unfulfilled' | 'fulfilled';
  payment_method: PaymentMethod;
  fulfillment: 'delivery' | 'pickup';
  delivery_zone: string | null;
  delivery_fee: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string;
  street: string | null;
  city: string | null;
  district_code: DistrictCode | null;
  buyer_tin: string | null;
  buyer_name: string | null;
  note: string | null;
  line_extension_cents: unknown;
  gst_cents: unknown;
  total_cents: unknown;
  refunded_cents: unknown;
  discount_code: string | null;
  discount_cents: unknown;
  document_id: string | null;
  created_at: string | Date;
  paid_at: string | Date | null;
  fulfilled_at: string | Date | null;
  ready_at?: string | Date | null;
  cancelled_at: string | Date | null;
  cancel_reason: string | null;
}

export interface OrderLineRow {
  line_number: number;
  item_id: string | null;
  product_title: string;
  variant_title: string | null;
  seller_code: string | null;
  quantity: string;
  unit_code: string;
  unit_price: string;
  gst_category: 'S' | 'Z' | 'E';
  exemption_reason_code: string | null;
  total_cents: unknown;
  discount_cents: unknown;
}

export async function loadOrder(db: Queryable, tenantId: string, where: { id: string } | { number: number; token: string }): Promise<{ order: OrderRow; lines: OrderLineRow[] } | null> {
  const order = 'id' in where
    ? (await db.query<OrderRow>('select * from orders where id = $1 and tenant_id = $2', [where.id, tenantId])).rows[0]
    : (await db.query<OrderRow>('select * from orders where tenant_id = $1 and number = $2 and token_hash = $3', [tenantId, where.number, tokenHash(where.token)])).rows[0];
  if (!order) return null;
  const lines = (await db.query<OrderLineRow>(
    `select line_number, item_id, product_title, variant_title, seller_code, quantity::text as quantity, unit_code, unit_price::text as unit_price, gst_category, exemption_reason_code, total_cents, discount_cents
     from order_lines where order_id = $1 order by line_number`,
    [order.id],
  )).rows;
  return { order, lines };
}

// ---------- the e-invoice ----------

const MEANS: Record<PaymentMethod, string> = { bank_transfer: '30', cash_on_delivery: '10', pay_at_pickup: '10', online: '68' };
const MEANS_TEXT: Record<PaymentMethod, string> = { bank_transfer: 'bank transfer', cash_on_delivery: 'cash on delivery', pay_at_pickup: 'payment at pickup', online: 'online payment' };

/** A paid order as a BTS document: a tax invoice when the buyer gave a TIN, otherwise a tax receipt. */
export function orderToIssueRequest(order: OrderRow, lines: OrderLineRow[]): IssueRequest {
  const invoice = Boolean(order.buyer_tin);
  const address = order.street && order.city && order.district_code
    ? { street: order.street, city: order.city, districtName: BELIZE_DISTRICTS[order.district_code], districtCode: order.district_code }
    : undefined;
  const contact = { ...(order.customer_email && { email: order.customer_email }), ...(order.customer_phone && { telephone: order.customer_phone }) };
  const customer: Customer = invoice
    ? { name: order.buyer_name ?? order.customer_name, tin: order.buyer_tin!, ...(address && { address }), contact }
    : { name: order.customer_name, contact };
  const delivery = order.fulfillment === 'delivery' ? { zone: order.delivery_zone ?? 'Delivery', fee: trimDecimal(order.delivery_fee) } : null;
  return {
    etdType: invoice ? '01' : '02',
    customer,
    lines: toLineInputs(
      lines.map((l) => ({
        productTitle: l.product_title, variantTitle: l.variant_title, sellerCode: l.seller_code, quantity: Number(l.quantity), unitCode: l.unit_code,
        unitPrice: trimDecimal(l.unit_price), gstCategory: l.gst_category, exemptionReasonCode: l.exemption_reason_code,
        discountCents: BigInt(String(l.discount_cents ?? 0)), discountLabel: order.discount_code ? `Discount ${order.discount_code}` : 'Discount',
      })),
      delivery,
    ),
    payment: { meansCode: MEANS[order.payment_method], terms: `Paid by ${MEANS_TEXT[order.payment_method]}, online order #${order.number}` },
    note: `Online order #${order.number}`,
  };
}

const VALID_DOCUMENT = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];

/**
 * Mark an order paid and issue its document. Safe to call again: a document
 * that is valid (or still on its way) is kept; a rejected one is replaced.
 */
export async function markOrderPaid(deps: PipelineDeps, tenantId: string, orderId: string, userId: string | null, deviceId: string | null = null): Promise<{ order: OrderRow; document: IssueResult | null }> {
  const loaded = await loadOrder(deps.db, tenantId, { id: orderId });
  if (!loaded) throw new StoreError('not_found', 'Order not found');
  const { order, lines } = loaded;
  if (order.status === 'cancelled') throw new StoreError('conflict', 'A cancelled order cannot be paid');
  if (order.document_id) {
    const doc = (await deps.db.query<{ status: string }>('select status from documents where id = $1', [order.document_id])).rows[0];
    if (doc && VALID_DOCUMENT.includes(doc.status)) {
      if (order.payment_status !== 'paid') await deps.db.query(`update orders set payment_status = 'paid', paid_at = now(), paid_by = $2 where id = $1`, [order.id, userId]);
      return { order: (await loadOrder(deps.db, tenantId, { id: orderId }))!.order, document: null };
    }
  }
  const result = await issueDocument(deps, tenantId, orderToIssueRequest(order, lines));
  await deps.db.query(
    `update orders set payment_status = 'paid', paid_at = coalesce(paid_at, now()), paid_by = coalesce(paid_by, $3), document_id = $2 where id = $1`,
    [order.id, result.documentId, userId],
  );
  // Marked paid at the counter (paid at pickup, cash on delivery): in that person's open shift.
  if (userId) {
    await deps.db.query(
      `update documents set issued_by = $3, device_id = $4, shift_id = ${openShiftSql('$1', '$3', '$4')}
       where tenant_id = $1 and (id = $2 or supersedes_document_id = $2)`,
      [tenantId, result.documentId, userId, deviceId],
    );
  }
  return { order: (await loadOrder(deps.db, tenantId, { id: orderId }))!.order, document: result };
}

export async function fulfillOrder(db: Queryable, tenantId: string, orderId: string): Promise<void> {
  const r = await db.query(`update orders set fulfillment_status = 'fulfilled', fulfilled_at = now() where id = $1 and tenant_id = $2 and status = 'open' returning id`, [orderId, tenantId]);
  if (!r.rows.length) throw new StoreError('conflict', 'Only an open order can be marked fulfilled');
}

/** Cancel an unpaid order and put its stock back. (A paid order is refunded instead: refundOrder.) */
export async function cancelOrder(db: Database, tenantId: string, orderId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = (await tx.query<{ status: string; payment_status: string }>('select status, payment_status from orders where id = $1 and tenant_id = $2 for update', [orderId, tenantId])).rows[0];
    if (!order) throw new StoreError('not_found', 'Order not found');
    if (order.status === 'cancelled') throw new StoreError('conflict', 'This order is already cancelled');
    if (order.payment_status === 'paid') throw new StoreError('conflict', 'A paid order is refunded with a credit note, not cancelled');
    await tx.query(`update orders set status = 'cancelled', cancelled_at = now(), cancel_reason = $3 where id = $1 and tenant_id = $2`, [orderId, tenantId, reason]);
    const lines = (await tx.query<{ item_id: string; quantity: string }>('select item_id, quantity::text as quantity from order_lines where order_id = $1 and item_id is not null', [orderId])).rows;
    for (const l of lines) await moveStock(tx, { tenantId, itemId: l.item_id, quantity: l.quantity, reason: 'order_cancelled', orderId });
  });
}

export const centsString = (v: unknown) => formatCents(toBigInt(v));

// ---------- refunds (each one a credit note against the order's document) ----------

export interface RefundInput {
  reason: string;
  /** Which lines and how many; every quantity not yet refunded when left out. */
  lines?: Array<{ lineNumber: number; quantity: number }>;
  /** Refund the delivery fee too. Defaults to true for a full refund, false otherwise. */
  delivery?: boolean;
  /** Put the refunded quantities back in stock. */
  restock?: boolean;
}

export interface RefundRow {
  id: string;
  document_id: string;
  amount_cents: unknown;
  lines: Array<{ lineNumber: number; quantity: number }>;
  delivery: boolean;
  reason: string;
  restocked: boolean;
  created_by: string | null;
  created_at: string | Date;
}

/** The order's refunds whose credit notes are valid (or still on their way to BTS). */
export async function loadRefunds(db: Queryable, tenantId: string, orderId: string): Promise<RefundRow[]> {
  return (await db.query<RefundRow>(
    `select r.id, r.document_id, r.amount_cents, r.lines, r.delivery, r.reason, r.restocked, r.created_by, r.created_at
     from order_refunds r join documents d on d.id = r.document_id
     where r.tenant_id = $1 and r.order_id = $2 and d.status = any($3::text[]) order by r.created_at`,
    [tenantId, orderId, VALID_DOCUMENT],
  )).rows;
}

/** What is still refundable on each line, and whether delivery is. */
export function refundable(order: OrderRow, lines: OrderLineRow[], refunds: RefundRow[]): { lines: Map<number, number>; delivery: boolean } {
  const left = new Map(lines.map((l) => [l.line_number, Number(l.quantity)]));
  for (const r of refunds) for (const l of r.lines) left.set(l.lineNumber, (left.get(l.lineNumber) ?? 0) - l.quantity);
  const deliveryCharged = order.fulfillment === 'delivery' && compare(parseDecimal(order.delivery_fee), ZERO) > 0;
  return { lines: left, delivery: deliveryCharged && !refunds.some((r) => r.delivery) };
}

/**
 * Refund some or all of a paid order: issues a credit note against its BTS
 * document, records the refund, and (if asked) puts the stock back.
 * `check` runs on the credit note before it is issued (the credit limit).
 */
export async function refundOrder(
  deps: PipelineDeps, tenantId: string, orderId: string, input: RefundInput, userId: string | null,
  check?: (req: IssueRequest) => Promise<void>,
): Promise<{ refundId: string; document: IssueResult; amount: string }> {
  const loaded = await loadOrder(deps.db, tenantId, { id: orderId });
  if (!loaded) throw new StoreError('not_found', 'Order not found');
  const { order, lines } = loaded;
  if (order.payment_status !== 'paid' || !order.document_id) throw new StoreError('conflict', 'Only a paid order can be refunded; cancel an unpaid one instead');
  const original = (await deps.db.query<{ status: string; etdui: string; issue_date: string; issue_time: string }>(
    `select status, etdui, to_char(issue_date, 'YYYY-MM-DD') as issue_date, issue_time::text as issue_time from documents where id = $1 and tenant_id = $2`,
    [order.document_id, tenantId],
  )).rows[0];
  if (!original || !VALID_DOCUMENT.includes(original.status)) throw new StoreError('conflict', 'The order’s receipt is not valid, so there is nothing to credit');
  if (original.status === 'pending') throw new StoreError('conflict', 'The order’s receipt is still on its way to BTS; refund it once BTS has answered');

  const left = refundable(order, lines, await loadRefunds(deps.db, tenantId, orderId));
  const full = !input.lines;
  const wanted = input.lines ?? [...left.lines.entries()].filter(([, q]) => q > 0).map(([lineNumber, quantity]) => ({ lineNumber, quantity }));
  const delivery = input.delivery ?? (full && left.delivery);
  if (delivery && !left.delivery) throw new StoreError('invalid_order', 'The delivery fee was not charged or was already refunded');
  const seen = new Set<number>();
  const chosen: Array<{ line: OrderLineRow; quantity: number; discount: bigint }> = [];
  const refundedBefore = (lineNumber: number) => Number(lines.find((l) => l.line_number === lineNumber)!.quantity) - (left.lines.get(lineNumber) ?? 0);
  for (const w of wanted) {
    const line = lines.find((l) => l.line_number === w.lineNumber);
    if (!line || seen.has(w.lineNumber)) throw new StoreError('invalid_order', `Line ${w.lineNumber} is not on this order`);
    seen.add(w.lineNumber);
    if (!Number.isInteger(w.quantity) || w.quantity < 0) throw new StoreError('invalid_order', 'Refund quantities must be whole numbers');
    if (w.quantity === 0) continue;
    const max = left.lines.get(w.lineNumber) ?? 0;
    if (w.quantity > max) throw new StoreError('invalid_order', max <= 0 ? `${line.product_title} was already refunded` : `Only ${max} of ${line.product_title} can still be refunded`);
    chosen.push({ line, quantity: w.quantity, discount: discountShare(BigInt(String(line.discount_cents ?? 0)), Number(line.quantity), refundedBefore(w.lineNumber), w.quantity) });
  }
  if (chosen.length === 0 && !delivery) throw new StoreError('invalid_order', 'Nothing left to refund on this order');

  const base = orderToIssueRequest(order, lines);
  const request: IssueRequest = {
    etdType: '04',
    ...(base.customer && { customer: base.customer }),
    lines: toLineInputs(
      chosen.map(({ line: l, quantity, discount }) => ({
        productTitle: l.product_title, variantTitle: l.variant_title, sellerCode: l.seller_code, quantity, unitCode: l.unit_code,
        unitPrice: trimDecimal(l.unit_price), gstCategory: l.gst_category, exemptionReasonCode: l.exemption_reason_code,
        discountCents: discount, discountLabel: order.discount_code ? `Discount ${order.discount_code}` : 'Discount',
      })),
      delivery ? { zone: order.delivery_zone ?? 'Delivery', fee: trimDecimal(order.delivery_fee) } : null,
    ),
    reference: { etdui: original.etdui, issueDate: original.issue_date, issueTime: original.issue_time.slice(0, 8), reason: input.reason.trim() },
    payment: { meansCode: MEANS[order.payment_method], terms: `Refund for online order #${order.number}` },
    note: `Refund for online order #${order.number}`,
  };
  const amount = calculateDocument({ lines: request.lines }, deps.tax).taxInclusiveAmount;
  if (check) await check(request);

  const document = await issueDocument(deps, tenantId, request);
  if (!VALID_DOCUMENT.includes(document.status)) {
    throw new StoreError('conflict', 'BTS rejected the credit note, so nothing was refunded. See it under Documents for the reason.');
  }
  if (userId) await deps.db.query('update documents set issued_by = $3 where tenant_id = $1 and (id = $2 or supersedes_document_id = $2)', [tenantId, document.documentId, userId]);
  const refundId = randomUUID();
  const restock = Boolean(input.restock) && chosen.length > 0;
  await deps.db.transaction(async (tx) => {
    await tx.query(
      `insert into order_refunds (id, tenant_id, order_id, document_id, amount_cents, lines, delivery, reason, restocked, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [refundId, tenantId, orderId, document.documentId, String(amount), JSON.stringify(chosen.map((c) => ({ lineNumber: c.line.line_number, quantity: c.quantity }))),
        delivery, input.reason.trim(), restock, userId],
    );
    await tx.query('update orders set refunded_cents = refunded_cents + $3 where id = $1 and tenant_id = $2', [orderId, tenantId, String(amount)]);
    if (restock) {
      for (const c of chosen) {
        if (c.line.item_id) await moveStock(tx, { tenantId, itemId: c.line.item_id, quantity: String(c.quantity), reason: 'refund', orderId, userId });
      }
    }
  });
  return { refundId, document, amount: formatCents(amount) };
}
