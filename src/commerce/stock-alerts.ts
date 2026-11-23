/**
 * "Email me when it's back": a buyer leaves their email on a sold-out variant; once it is in stock
 * again (and its product still for sale), housekeeping emails them once, with a link to the product.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import type { Mailer } from '../mail/mailer.ts';
import { emailLanguage } from '../templates/lang.ts';
import { renderEmail } from '../templates/render.ts';
import { priceWithGst, withDefaults } from './store.ts';

export class StockAlertError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A buyer waiting for a sold-out variant (once per email and variant while waiting). */
export async function addStockAlert(db: Queryable, tenantId: string, productHandle: string, variantId: string, email: string): Promise<void> {
  const v = (await db.query<{ stock_quantity: number | null }>(
    `select i.stock_quantity::float8 as stock_quantity from items i join products p on p.id = i.product_id
     where i.id = $1 and i.tenant_id = $2 and p.handle = $3 and p.status = 'active' and i.archived_at is null`, [variantId, tenantId, productHandle],
  )).rows[0];
  if (!v) throw new StockAlertError('not_found', 'This product is not available');
  if (v.stock_quantity === null || v.stock_quantity > 0) throw new StockAlertError('in_stock', 'This is in stock: you can order it now');
  await db.query(
    `insert into stock_alerts (id, tenant_id, item_id, email) values ($1, $2, $3, $4)
     on conflict (item_id, lower(email)) where notified_at is null do nothing`,
    [randomUUID(), tenantId, variantId, email.trim().toLowerCase()],
  );
}

/** Email everyone whose variant is back (each once), from open stores. */
export async function runStockAlerts(db: Queryable, options: { mailer: Mailer; publicUrl?: string; limit?: number }): Promise<{ sent: number }> {
  if (!options.publicUrl) return { sent: 0 };
  const due = (await db.query<{
    id: string; tenant_id: string; email: string; slug: string; store_name: string; city: string; telephone: string; reply_to: string; store_settings: unknown;
    handle: string; title: string; option1: string | null; option2: string | null; unit_price: string; gst_category: 'S' | 'Z' | 'E';
  }>(
    `select a.id, a.tenant_id, a.email, t.slug, coalesce(t.trade_name, t.legal_name) as store_name, t.city, t.telephone, t.email as reply_to, t.store_settings,
       p.handle, p.title, i.option1, i.option2, i.unit_price::text as unit_price, i.gst_category
     from stock_alerts a join items i on i.id = a.item_id join products p on p.id = i.product_id join tenants t on t.id = a.tenant_id
     where a.notified_at is null and p.status = 'active' and i.archived_at is null and (i.stock_quantity is null or i.stock_quantity > 0)
     order by a.created_at limit $1`,
    [options.limit ?? 200],
  )).rows;
  let sent = 0;
  for (const a of due) {
    if (!withDefaults(a.store_settings as never).enabled) continue;
    // Claimed first, so two runs never email twice.
    const claimed = await db.query('update stock_alerts set notified_at = now() where id = $1 and notified_at is null returning id', [a.id]);
    if (!claimed.rows.length) continue;
    try {
      const url = `${options.publicUrl.replace(/\/$/, '')}/${a.slug}/shop/products/${a.handle}`;
      const lang = await emailLanguage(db, a.tenant_id);
      const mail = await renderEmail(db, a.tenant_id, 'email.back-in-stock', {
        store: { name: a.store_name, city: a.city, telephone: a.telephone },
        product: { title: a.title, variant: [a.option1, a.option2].filter(Boolean).join(' / ') || null, price: priceWithGst(a.unit_price, a.gst_category), url },
      }, { publicUrl: options.publicUrl, lang });
      await options.mailer.send({ to: a.email, replyTo: a.reply_to, subject: mail.subject, text: mail.text, html: mail.html });
      sent++;
    } catch {
      // Try again next run.
      await db.query('update stock_alerts set notified_at = null where id = $1', [a.id]);
    }
  }
  return { sent };
}
