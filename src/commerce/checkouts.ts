/**
 * Checkout reminders. A buyer who has given their email at checkout and has
 * something in the cart is saved as an open checkout (updated as they go).
 * If they leave without ordering, housekeeping emails them: once after a
 * while (an hour by default) and, if the store wants, once more a day later.
 * Each email has a link that puts the cart back and one to stop the emails.
 *
 * It ends when they order (from that checkout, or any order with the same
 * email at the store), when they unsubscribe, when nothing in the cart is for
 * sale any more, or after a week. An order placed after a reminder counts as
 * recovered.
 *
 * Nothing is saved when the store has reminders turned off, or for a buyer
 * who asked that store not to send them.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import type { Mailer } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { emailLanguage } from '../templates/lang.ts';
import { renderEmail } from '../templates/render.ts';
import { type CartLine, priceWithGst, quoteCart, StoreError, type StoreRef, variantTitle, withDefaults } from './store.ts';

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const EXPIRE_DAYS = 7;
const SECOND_AFTER_HOURS = 24;

export interface CheckoutInput {
  email: string;
  name?: string;
  lines: CartLine[];
  fulfillment?: 'delivery' | 'pickup';
  zone?: string;
  discountCode?: string;
}

const isOptedOut = async (db: Queryable, tenantId: string, email: string) =>
  (await db.query('select 1 from store_email_optouts where tenant_id = $1 and email = $2', [tenantId, email.trim().toLowerCase()])).rows.length > 0;

/** The cart priced as it stands (GST included), or null when it cannot be priced (nothing left for sale). */
async function priceCart(db: Queryable, deps: Pick<PipelineDeps, 'tax'>, store: StoreRef, input: Pick<CheckoutInput, 'lines' | 'fulfillment' | 'zone' | 'discountCode'>): Promise<bigint | null> {
  const tries = [
    { fulfillment: input.fulfillment ?? 'pickup', ...(input.zone && { zone: input.zone }), ...(input.discountCode && { discountCode: input.discountCode }) },
    { fulfillment: 'pickup' as const },
  ];
  for (const choice of tries) {
    try {
      return (await quoteCart(db, deps, store, input.lines, choice)).cents.total;
    } catch {
      // The next, simpler choice.
    }
  }
  return null;
}

/** Save (or update) the buyer's checkout as they fill it in. */
export async function saveCheckout(db: Queryable, deps: Pick<PipelineDeps, 'tax'>, store: StoreRef, id: string, input: CheckoutInput): Promise<{ saved: boolean }> {
  if (!store.settings.reminders.enabled) return { saved: false };
  const email = input.email.trim().toLowerCase();
  if (await isOptedOut(db, store.tenantId, email)) return { saved: false };
  if (!input.lines.length) {
    await db.query("update store_checkouts set status = 'expired', updated_at = now() where id = $1 and tenant_id = $2 and status = 'open'", [id, store.tenantId]);
    return { saved: false };
  }
  const total = await priceCart(db, deps, store, input);
  await db.query(
    `insert into store_checkouts (id, tenant_id, email, name, lines, fulfillment, zone, discount_code, total_cents)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set email = excluded.email, name = excluded.name, lines = excluded.lines, fulfillment = excluded.fulfillment,
       zone = excluded.zone, discount_code = excluded.discount_code, total_cents = excluded.total_cents, updated_at = now()
     where store_checkouts.tenant_id = excluded.tenant_id and store_checkouts.status = 'open'`,
    [id, store.tenantId, email, input.name?.trim() || null, JSON.stringify(input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }))),
      input.fulfillment ?? null, input.zone ?? null, input.discountCode?.trim() || null, total === null ? null : total.toString()],
  );
  return { saved: true };
}

/** An order was placed: its checkout (and any other open one with the same email at the store) is done. */
export async function markOrdered(db: Queryable, tenantId: string, orderId: string, checkoutId: string | undefined, email: string | undefined): Promise<void> {
  await db.query(
    `update store_checkouts set status = 'ordered', order_id = $3, recovered = reminders_sent > 0, updated_at = now()
     where tenant_id = $1 and status = 'open' and (id = $2::uuid or ($4::text is not null and lower(email) = lower($4)))`,
    [tenantId, checkoutId ?? null, orderId, email?.trim() || null],
  );
}

interface CartItem { variantId: string; quantity: number; handle: string; title: string; variantTitle: string | null; price: string; imageId: string | null }

/** The cart's lines still for sale, as the store's cart keeps them (prices with GST). */
async function cartItems(db: Queryable, tenantId: string, lines: Array<{ variantId: string; quantity: number }>): Promise<CartItem[]> {
  if (!lines.length) return [];
  const rows = (await db.query<{ id: string; handle: string; title: string; option1: string | null; option2: string | null; unit_price: string; gst_category: 'S' | 'Z' | 'E'; image_id: string | null }>(
    `select i.id, p.handle, p.title, i.option1, i.option2, i.unit_price::text as unit_price, i.gst_category,
       (select g.id from product_images g where g.product_id = p.id order by g.position, g.created_at limit 1) as image_id
     from items i join products p on p.id = i.product_id
     where i.tenant_id = $1 and i.id = any($2::uuid[]) and i.archived_at is null and p.status = 'active'`,
    [tenantId, lines.map((l) => l.variantId)],
  )).rows;
  return lines.flatMap((l) => {
    const r = rows.find((x) => x.id === l.variantId);
    return r ? [{ variantId: r.id, quantity: l.quantity, handle: r.handle, title: r.title, variantTitle: variantTitle(r), price: priceWithGst(r.unit_price, r.gst_category), imageId: r.image_id }] : [];
  });
}

interface CheckoutRow {
  id: string; tenant_id: string; email: string; name: string | null; lines: Array<{ variantId: string; quantity: number }>; fulfillment: 'delivery' | 'pickup' | null;
  zone: string | null; discount_code: string | null; status: string; reminders_sent: number; last_reminded_at: Date | null; created_at: Date; updated_at: Date;
}

async function byToken(db: Queryable, store: StoreRef, token: string): Promise<CheckoutRow> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new StoreError('not_found', 'This link is not valid');
  const c = (await db.query<CheckoutRow>('select * from store_checkouts where tenant_id = $1 and $2 = any(token_hashes)', [store.tenantId, tokenHash(token)])).rows[0];
  if (!c) throw new StoreError('not_found', 'This link is not valid any more');
  return c;
}

/** The reminder's link: the cart to put back, and what the buyer had filled in. */
export async function restoreCheckout(db: Queryable, store: StoreRef, token: string) {
  const c = await byToken(db, store, token);
  if (c.status === 'ordered') return { ordered: true as const };
  return {
    ordered: false as const,
    checkoutId: c.id,
    email: c.email,
    name: c.name,
    fulfillment: c.fulfillment,
    zone: c.zone,
    discountCode: c.discount_code,
    lines: await cartItems(db, store.tenantId, c.lines),
  };
}

/** No more reminders from this store to this buyer. */
export async function unsubscribe(db: Queryable, store: StoreRef, token: string): Promise<{ email: string }> {
  const c = await byToken(db, store, token);
  await db.query('insert into store_email_optouts (tenant_id, email) values ($1, $2) on conflict do nothing', [store.tenantId, c.email.toLowerCase()]);
  await db.query("update store_checkouts set status = 'expired', updated_at = now() where tenant_id = $1 and lower(email) = $2 and status = 'open'", [store.tenantId, c.email.toLowerCase()]);
  return { email: c.email };
}

// ---------- the reminders ----------

export async function runCheckoutReminders(db: Queryable, deps: Pick<PipelineDeps, 'tax'>, options: { mailer: Mailer; publicUrl?: string; limit?: number }): Promise<{ sent: number; ended: number }> {
  const out = { sent: 0, ended: 0 };
  // A week on, a checkout is not coming back.
  out.ended += (await db.query(`update store_checkouts set status = 'expired', updated_at = now() where status = 'open' and created_at < now() - make_interval(days => ${EXPIRE_DAYS}) returning id`)).rows.length;
  // Old ones are not kept: a month after their last change.
  await db.query("delete from store_checkouts where updated_at < now() - interval '30 days'");
  if (!options.publicUrl) return out;
  const base = options.publicUrl.replace(/\/$/, '');
  const due = (await db.query<CheckoutRow & { slug: string; store_name: string; city: string; telephone: string; reply_to: string; store_settings: unknown; suspended: boolean; street: string; environment: string }>(
    `select c.*, t.slug, coalesce(t.trade_name, t.legal_name) as store_name, t.city, t.street, t.telephone, t.email as reply_to, t.environment, t.store_settings, (t.suspended_at is not null or t.closed_at is not null) as suspended
     from store_checkouts c join tenants t on t.id = c.tenant_id
     where c.status = 'open' and c.reminders_sent < 2 and c.updated_at < now() - interval '1 hour'
     order by c.updated_at limit $1`,
    [options.limit ?? 200],
  )).rows;
  const now = Date.now();
  for (const c of due) {
    const settings = withDefaults(c.store_settings as never);
    if (!settings.enabled || c.suspended || !settings.reminders.enabled) continue;
    const r = settings.reminders;
    const isDue = c.reminders_sent === 0
      ? now - new Date(c.updated_at).getTime() >= r.afterHours * 3_600_000
      : r.second && c.last_reminded_at !== null && now - new Date(c.last_reminded_at).getTime() >= SECOND_AFTER_HOURS * 3_600_000;
    if (!isDue) continue;
    const end = async (status: 'expired' | 'ordered', orderId: string | null = null) => {
      await db.query(`update store_checkouts set status = $2, order_id = coalesce($3, order_id), recovered = ($2 = 'ordered' and reminders_sent > 0), updated_at = now() where id = $1 and status = 'open'`, [c.id, status, orderId]);
      out.ended++;
    };
    if (await isOptedOut(db, c.tenant_id, c.email)) {
      await end('expired');
      continue;
    }
    // Ordered from another device (or after calling the store): no reminder.
    const ordered = (await db.query<{ id: string }>('select id from orders where tenant_id = $1 and lower(customer_email) = lower($2) and created_at >= $3 order by created_at limit 1', [c.tenant_id, c.email, c.created_at])).rows[0];
    if (ordered) {
      await end('ordered', ordered.id);
      continue;
    }
    const items = await cartItems(db, c.tenant_id, c.lines);
    if (!items.length) {
      await end('expired');
      continue;
    }
    const store: StoreRef = { tenantId: c.tenant_id, slug: c.slug, name: c.store_name, email: c.reply_to, telephone: c.telephone, street: c.street, city: c.city, environment: c.environment, settings };
    const total = await priceCart(db, deps, store, { lines: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), ...(c.fulfillment && { fulfillment: c.fulfillment }), ...(c.zone && { zone: c.zone }), ...(c.discount_code && { discountCode: c.discount_code }) });
    // Claimed first (with this reminder's link), so two runs never send the same reminder.
    const token = randomBytes(24).toString('base64url');
    const claimed = await db.query(
      `update store_checkouts set reminders_sent = reminders_sent + 1, last_reminded_at = now(), token_hashes = array_append(token_hashes, $3)
       where id = $1 and reminders_sent = $2 and status = 'open' returning id`,
      [c.id, c.reminders_sent, tokenHash(token)],
    );
    if (!claimed.rows.length) continue;
    const number = c.reminders_sent + 1;
    try {
      const lang = await emailLanguage(db, c.tenant_id);
      const unsubscribeUrl = `${base}/${c.slug}/shop/unsubscribe?t=${token}`;
      const mail = await renderEmail(db, c.tenant_id, 'email.checkout-reminder', {
        store: { name: c.store_name, city: c.city, telephone: c.telephone, url: `${base}/${c.slug}/shop` },
        buyer: { name: c.name ?? '' },
        items: items.map((i) => ({ title: i.title, variant: i.variantTitle, quantity: i.quantity, price: i.price, total: (Number(i.price) * i.quantity).toFixed(2) })),
        total: total === null ? null : (Number(total) / 100).toFixed(2),
        url: `${base}/${c.slug}/shop/resume?t=${token}`,
        unsubscribe_url: unsubscribeUrl,
        reminder: { number, last: number >= 2 || !r.second },
      }, { publicUrl: options.publicUrl, lang });
      await options.mailer.send({
        to: c.email, replyTo: c.reply_to, subject: mail.subject, text: mail.text, html: mail.html,
        // One-click unsubscribe from the mail app (RFC 8058): a POST to the store's API.
        headers: { 'List-Unsubscribe': `<${base}/v1/store/${c.slug}/checkouts/unsubscribe?t=${token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      out.sent++;
    } catch {
      // Not sent: the reminder is tried again next run.
      await db.query('update store_checkouts set reminders_sent = reminders_sent - 1, token_hashes = array_remove(token_hashes, $2) where id = $1', [c.id, tokenHash(token)]);
    }
  }
  return out;
}

// ---------- for the store's owner ----------

export async function listCheckouts(db: Queryable, tenantId: string, view: 'open' | 'recovered' | 'all') {
  const where = view === 'open' ? "c.status = 'open'" : view === 'recovered' ? 'c.recovered' : 'true';
  const rows = (await db.query<{ id: string; email: string; name: string | null; items: number; total_cents: string | null; status: string; reminders_sent: number; last_reminded_at: Date | null; recovered: boolean; order_number: number | null; order_id: string | null; order_total: string | null; created_at: Date; updated_at: Date }>(
    `select c.id, c.email, c.name, (select coalesce(sum((l->>'quantity')::int), 0) from jsonb_array_elements(c.lines) l)::int as items, c.total_cents::text as total_cents,
       c.status, c.reminders_sent, c.last_reminded_at, c.recovered, o.number as order_number, o.id as order_id, o.total_cents::text as order_total, c.created_at, c.updated_at
     from store_checkouts c left join orders o on o.id = c.order_id
     where c.tenant_id = $1 and ${where} order by c.updated_at desc limit 200`,
    [tenantId],
  )).rows;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    items: r.items,
    total: r.total_cents === null ? null : (Number(r.total_cents) / 100).toFixed(2),
    status: r.status,
    remindersSent: r.reminders_sent,
    lastRemindedAt: iso(r.last_reminded_at),
    recovered: r.recovered,
    order: r.order_id ? { id: r.order_id, number: r.order_number, total: (Number(r.order_total) / 100).toFixed(2) } : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }));
}

/** The last 30 days: checkouts left, reminders sent, and what came back. */
export async function checkoutSummary(db: Queryable, tenantId: string) {
  const r = (await db.query<{ left: number; reminded: number; recovered: number; recovered_cents: string | null }>(
    `select count(*) filter (where c.status <> 'ordered' or c.recovered)::int as left,
       count(*) filter (where c.reminders_sent > 0)::int as reminded,
       count(*) filter (where c.recovered)::int as recovered,
       coalesce(sum(o.total_cents) filter (where c.recovered), 0)::text as recovered_cents
     from store_checkouts c left join orders o on o.id = c.order_id
     where c.tenant_id = $1 and c.created_at > now() - interval '30 days'`,
    [tenantId],
  )).rows[0]!;
  return { left: r.left, reminded: r.reminded, recovered: r.recovered, recoveredTotal: (Number(r.recovered_cents ?? 0) / 100).toFixed(2) };
}
