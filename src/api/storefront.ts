/**
 * The public storefront: no sign-in. Everything is scoped by the business's
 * address (slug), and only works while its store is open.
 *
 *   GET  /v1/store/:slug                         store details, delivery zones, payment methods
 *   GET  /v1/store/:slug/products                active products
 *   GET  /v1/store/:slug/products/:handle        one product with its variants
 *   GET  /v1/store/:slug/images/:id              a product photo (long-cached)
 *   POST /v1/store/:slug/orders/:n/pay?t=        start (or retry) paying an order online → where to send the buyer
 *   POST /v1/store/:slug/orders/:n/payments/:id/confirm?t=   back from the provider: was it paid?
 *   GET|POST /v1/store/:slug/test-payments/:id   the pretend card page of the test gateway
 *   POST /v1/store/:slug/products/:handle/notify { variantId, email }: email me when this sold-out variant is back
 *   POST /v1/store/:slug/quote                   price a cart, with delivery
 *   POST /v1/store/:slug/orders                  place an order
 *   GET  /v1/store/:slug/orders/:number?t=       the buyer's order page (the token from the order link,
 *                                                or none for a buyer signed in to their account)
 *   GET  /v1/store/:slug/orders/:number/document?t=   the receipt or invoice PDF, once paid
 *   .../account...                               buyer accounts (store-accounts.ts)
 *
 * Prices shown to buyers include GST. Totals come from the same calculation
 * that produces the e-invoice.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { rememberFromOrder } from '../commerce/buyers.ts';
import { accountsOffered, buyerFromRequest, registerStoreAccountRoutes } from './store-accounts.ts';
import { requireCsrfHeader } from './auth.ts';
import { type CheckoutInput, markOrdered, restoreCheckout, saveCheckout, unsubscribe } from '../commerce/checkouts.ts';
import { loadOrder, loadStore, type OrderInput, paymentMethodsFor, placeOrder, priceWithGst, quoteCart, StoreError, type StoreRef, variantTitle } from '../commerce/store.ts';
import { simpleHtml } from '../mail/mailer.ts';
import { renderEmail, renderStoreTheme, storeContext } from '../templates/render.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, type ServerContext } from './context.ts';
import { printedCopy } from './documents.ts';
import { ApiError } from './errors.ts';
import { documentSummary, orderJson } from './orders.ts';
import { uuid } from './schemas.ts';
import { overLimit } from '../db/ratelimit.ts';
import { type PhotoRow, sendPhoto } from './products.ts';
import { getSubscription } from '../billing/billing.ts';
import { hasFeature } from '../billing/plans.ts';
import { confirmPayment, gatewayFor, PaymentError, type Provider, startPayment, walletDisplay } from '../commerce/payments.ts';
import { type GatewayExtras, gatewayOptions, settlePaidOrder } from './payments.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import { emailLanguage, PHRASES } from '../templates/lang.ts';
import { addStockAlert, StockAlertError } from '../commerce/stock-alerts.ts';


// Limits on placing orders (shared by every server process), so a script cannot flood a store.
const HOUR_MS = 60 * 60 * 1000;

const slugParams = { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' } } as const;
const cartSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: { type: 'object', required: ['variantId', 'quantity'], additionalProperties: false, properties: { variantId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 9999 } } },
} as const;

const PAYMENT_TEXT = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup', online: 'Paid online' } as const;

export function registerStorefrontRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, payments: GatewayExtras = {}) {
  const { db } = deps;
  const slugOf = async (tenantId: string) => (await db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
  const gatewaySettings = gatewayOptions(deps, slugOf, payments);
  // A store on a plan without the online store (after a downgrade) is closed to buyers.
  const store = async (request: FastifyRequest<{ Params: { slug: string } }>) => {
    const s = await loadStore(db, request.params.slug);
    if (!hasFeature((await getSubscription(db, s.tenantId)).plan, 'store')) throw new StoreError('store_closed', 'This store is not open right now');
    return s;
  };

  app.get<{ Params: { slug: string } }>('/:slug', { schema: { params: { type: 'object', required: ['slug'], properties: slugParams } } }, async (request) => {
    const s = await store(request);
    const p = s.settings.payments;
    // On the store's own domain the shop lives at /shop; on ours, at /<slug>/shop.
    const own = ctx.publicUrl ? new URL(ctx.publicUrl).hostname : null;
    const base = own && request.hostname.split(':')[0] !== own ? '/shop' : `/${s.slug}/shop`;
    return {
      slug: s.slug,
      theme: await renderStoreTheme(db, s.tenantId, await storeContext(db, s.tenantId, { base })),
      name: s.name,
      tagline: s.settings.tagline,
      about: s.settings.about,
      whatsapp: s.settings.whatsapp || null,
      telephone: s.telephone,
      city: s.city,
      currency: 'BZD',
      test: s.environment === 'test',
      delivery: { enabled: s.settings.delivery.enabled, zones: s.settings.delivery.enabled ? s.settings.delivery.zones.map((z) => ({ name: z.name, fee: priceWithGst(z.fee, 'S') })) : [] },
      pickup: { enabled: s.settings.pickup.enabled, address: s.settings.pickup.enabled ? `${s.street}, ${s.city}` : null },
      payments: { bankTransfer: p.bankTransfer.enabled, cashOnDelivery: p.cashOnDelivery.enabled, payAtPickup: p.payAtPickup.enabled, online: p.online.enabled ? p.online.provider : null },
      // Buyers are told at checkout that they may get a reminder.
      reminders: s.settings.reminders.enabled,
      // Buyers can sign in (a code by email) to see their orders and check out faster.
      accounts: accountsOffered(s, ctx),
    };
  });

  app.get<{ Params: { slug: string }; Querystring: { q?: string; category?: string } }>(
    '/:slug/products',
    { schema: { params: { type: 'object', required: ['slug'], properties: slugParams }, querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 }, category: { type: 'string', maxLength: 80 } } } } },
    async (request) => {
      const s = await store(request);
      const params: unknown[] = [s.tenantId];
      let where = `p.tenant_id = $1 and p.status = 'active'`;
      if (request.query.q?.trim()) {
        params.push(`%${request.query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where += ` and (p.title ilike $${params.length} or p.description ilike $${params.length})`;
      }
      // A product's category is its variants' (the items' categories).
      const category = `(select min(i.category) from items i where i.product_id = p.id and i.archived_at is null and i.category is not null)`;
      if (request.query.category) {
        params.push(request.query.category);
        where += ` and lower(${category}) = lower($${params.length})`;
      }
      const rows = (await db.query<{ id: string; handle: string; title: string; image_id: string | null; category: string | null; prices: Array<{ price: string; gst: 'S' | 'Z' | 'E'; stock: number | null }> | null }>(
        `select p.id, p.handle, p.title, ${category} as category,
           (select g.id from product_images g where g.product_id = p.id order by g.position, g.created_at limit 1) as image_id,
           (select json_agg(json_build_object('price', i.unit_price::text, 'gst', i.gst_category, 'stock', i.stock_quantity::float8)) from items i where i.product_id = p.id and i.archived_at is null) as prices
         from products p where ${where} order by p.created_at desc limit 500`,
        params,
      )).rows;
      return {
        data: rows.filter((r) => r.prices?.length).map((r) => {
          const prices = r.prices!.map((x) => priceWithGst(x.price, x.gst)).map(Number);
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          return {
            handle: r.handle,
            title: r.title,
            imageId: r.image_id,
            price: min.toFixed(2),
            priceVaries: min !== max,
            soldOut: r.prices!.every((x) => x.stock !== null && x.stock <= 0),
            category: r.category,
          };
        }),
      };
    },
  );

  app.get<{ Params: { slug: string; handle: string } }>(
    '/:slug/products/:handle',
    { schema: { params: { type: 'object', required: ['slug', 'handle'], properties: { ...slugParams, handle: { type: 'string', maxLength: 80 } } } } },
    async (request) => {
      const s = await store(request);
      const p = (await db.query<{ id: string; handle: string; title: string; description: string; option1_name: string | null; option2_name: string | null }>(
        `select id, handle, title, description, option1_name, option2_name from products where tenant_id = $1 and handle = $2 and status = 'active'`, [s.tenantId, request.params.handle],
      )).rows[0];
      if (!p) throw new StoreError('not_found', 'This product is not available');
      const variants = (await db.query<{ id: string; option1: string | null; option2: string | null; unit_price: string; gst_category: 'S' | 'Z' | 'E'; stock_quantity: number | null }>(
        `select id, option1, option2, unit_price::text as unit_price, gst_category, stock_quantity::float8 as stock_quantity from items where product_id = $1 and archived_at is null order by position, created_at`, [p.id],
      )).rows;
      const images = (await db.query<{ id: string }>('select id from product_images where product_id = $1 order by position, created_at', [p.id])).rows;
      return {
        handle: p.handle,
        title: p.title,
        description: p.description,
        options: [p.option1_name, p.option2_name].filter((x): x is string => Boolean(x)),
        images: images.map((i) => i.id),
        variants: variants.map((v) => ({
          id: v.id,
          title: variantTitle(v),
          option1: v.option1,
          option2: v.option2,
          price: priceWithGst(v.unit_price, v.gst_category),
          available: v.stock_quantity === null || v.stock_quantity > 0,
          // Only say how many are left when it is few.
          left: v.stock_quantity !== null && v.stock_quantity <= 5 ? v.stock_quantity : null,
        })),
      };
    },
  );

  app.get<{ Params: { slug: string; id: string } }>(
    '/:slug/images/:id',
    { schema: { params: { type: 'object', required: ['slug', 'id'], properties: { ...slugParams, id: uuid } } } },
    async (request, reply) => {
      const img = (await db.query<PhotoRow>(
        `select g.content_type, g.data, g.storage_key from product_images g join tenants t on t.id = g.tenant_id join products p on p.id = g.product_id
         where g.id = $1 and t.slug = $2 and p.status = 'active'`,
        [request.params.id, request.params.slug],
      )).rows[0];
      if (!img) throw new StoreError('not_found', 'Photo not found');
      // Photo ids never change content: cache for a year (the CDN redirect too).
      return sendPhoto(reply, ctx, img, 'public, max-age=31536000, immutable');
    },
  );

  const choiceProps = {
    fulfillment: { type: 'string', enum: ['delivery', 'pickup'] },
    zone: { type: 'string', maxLength: 80 },
    discountCode: { type: 'string', maxLength: 40 },
  } as const;

  app.post<{ Params: { slug: string }; Body: { lines: OrderInput['lines']; fulfillment: 'delivery' | 'pickup'; zone?: string; discountCode?: string } }>(
    '/:slug/quote',
    { schema: { params: { type: 'object', required: ['slug'], properties: slugParams }, body: { type: 'object', required: ['lines', 'fulfillment'], additionalProperties: false, properties: { lines: cartSchema, ...choiceProps } } } },
    async (request) => {
      const s = await store(request);
      const q = await quoteCart(db, deps, s, request.body.lines, request.body);
      return {
        lines: q.lines.map((l) => ({ variantId: l.variantId, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.quantity, total: l.total, listTotal: l.listTotal })),
        delivery: q.delivery && { zone: q.delivery.zone, total: q.delivery.total },
        discount: q.discount && { code: q.discount.code, kind: q.discount.kind, saved: q.discount.saved },
        totals: q.totals,
        paymentMethods: paymentMethodsFor(s.settings, request.body.fulfillment),
      };
    },
  );

  app.post<{ Params: { slug: string }; Body: OrderInput }>(
    '/:slug/orders',
    {
      schema: {
        params: { type: 'object', required: ['slug'], properties: slugParams },
        body: {
          type: 'object',
          required: ['lines', 'fulfillment', 'paymentMethod', 'customer'],
          additionalProperties: false,
          properties: {
            lines: cartSchema,
            ...choiceProps,
            paymentMethod: { type: 'string', enum: ['bank_transfer', 'cash_on_delivery', 'pay_at_pickup', 'online'] },
            customer: {
              type: 'object',
              required: ['name', 'phone'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 200 },
                email: { type: 'string', maxLength: 254, pattern: '^$|^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' },
                phone: { type: 'string', minLength: 7, maxLength: 30, pattern: '^[0-9+()\\-\\s]+$' },
              },
            },
            address: {
              type: 'object',
              required: ['street', 'city', 'districtCode'],
              additionalProperties: false,
              properties: { street: { type: 'string', minLength: 1, maxLength: 200 }, city: { type: 'string', minLength: 1, maxLength: 100 }, districtCode: { type: 'string', enum: ['1', '2', '3', '4', '5', '6'] } },
            },
            business: {
              type: 'object',
              required: ['tin', 'name'],
              additionalProperties: false,
              properties: { tin: { type: 'string', pattern: '^\\d{6}$' }, name: { type: 'string', minLength: 1, maxLength: 300 } },
            },
            note: { type: 'string', maxLength: 1000 },
            checkoutId: uuid,
            saveAddress: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const s = await store(request);
      if (await overLimit(db, `order|${request.ip}|${s.slug}`, 20, HOUR_MS) || await overLimit(db, `order|${request.ip}`, 60, HOUR_MS)) throw new ApiError(429, 'too_many_orders', 'Too many orders from here in the last hour; contact the store');
      // Signed in: the order goes in the buyer's account, which remembers what was new in it.
      const buyer = await buyerFromRequest(db, request, s);
      const placed = await placeOrder(db, deps, s, request.body, { ...(buyer && { buyerId: buyer.id }) });
      if (buyer) await rememberFromOrder(db, buyer, request.body).catch((e) => request.log.error({ err: e }, 'account not updated'));
      await markOrdered(db, s.tenantId, placed.id, request.body.checkoutId, request.body.customer.email).catch((e) => request.log.error({ err: e }, 'checkout not closed'));
      const path = `/${s.slug}/shop/orders/${placed.number}?t=${placed.token}`;
      await audit(db, { tenantId: s.tenantId, action: 'order.placed', target: `#${placed.number}`, details: { total: placed.quote.totals.total }, ip: request.ip });
      void notify(request, s, placed, path).catch((e) => request.log.error({ err: e }, 'order notification failed'));
      // Paying online: straight to the provider's page. If that fails, the order stands and the buyer can retry from its page.
      let payment: { redirectUrl: string } | { error: string } | undefined;
      if (request.body.paymentMethod === 'online') {
        try {
          payment = await beginPayment(s, placed.id, placed.number, placed.token);
        } catch (e) {
          payment = { error: e instanceof PaymentError ? e.message : 'The payment could not be started; try again from your order page' };
        }
      }
      return reply.code(201).send({ number: placed.number, token: placed.token, path, totals: placed.quote.totals, ...(payment && { payment }) });
    },
  );

  // ---------- checkout reminders ----------

  // The buyer's checkout as they fill it in (only once they have given an email).
  app.put<{ Params: { slug: string; id: string }; Body: CheckoutInput }>(
    '/:slug/checkouts/:id',
    {
      schema: {
        params: { type: 'object', required: ['slug', 'id'], properties: { ...slugParams, id: uuid } },
        body: {
          type: 'object', required: ['email', 'lines'], additionalProperties: false,
          properties: {
            email: { type: 'string', maxLength: 254, pattern: '^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' },
            name: { type: 'string', maxLength: 200 },
            lines: { type: 'array', maxItems: 100, items: { type: 'object', required: ['variantId', 'quantity'], additionalProperties: false, properties: { variantId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 9999 } } } },
            ...choiceProps,
          },
        },
      },
    },
    async (request, reply) => {
      const s = await store(request);
      if (await overLimit(db, `checkout|${request.ip}`, 120, HOUR_MS)) throw new ApiError(429, 'too_many_requests', 'Too many requests from here; try again later');
      const r = await saveCheckout(db, deps, s, request.params.id, request.body);
      return reply.send(r);
    },
  );

  // The link in a reminder: the cart and what the buyer had filled in.
  app.get<{ Params: { slug: string }; Querystring: { t: string } }>(
    '/:slug/checkouts/restore',
    { schema: { params: { type: 'object', required: ['slug'], properties: slugParams }, querystring: { type: 'object', required: ['t'], properties: { t: { type: 'string', maxLength: 100 } } } } },
    async (request) => restoreCheckout(db, await store(request), request.query.t),
  );

  // No more reminders from this store (the page's button, and one-click unsubscribe from mail apps).
  app.post<{ Params: { slug: string }; Querystring: { t: string } }>(
    '/:slug/checkouts/unsubscribe',
    { schema: { params: { type: 'object', required: ['slug'], properties: slugParams }, querystring: { type: 'object', required: ['t'], properties: { t: { type: 'string', maxLength: 100 } } } } },
    async (request) => {
      return unsubscribe(db, await loadStore(db, request.params.slug, { requireOpen: false }), request.query.t);
    },
  );

  /** Create a checkout with the store's provider; returns where to send the buyer (back to the order's link, or, signed in, its page in the account). */
  async function beginPayment(s: StoreRef, orderId: string, number: number, token: string | undefined) {
    const gateway = await gatewayFor(db, s.tenantId, s.settings.payments.online.provider, await gatewaySettings(s.tenantId));
    const base = ctx.publicUrl?.replace(/\/$/, '') ?? '';
    if (gateway.provider !== 'test' && !base) throw new PaymentError('PUBLIC_URL is not set on this server, so the payment provider cannot send buyers back');
    const order = (await db.query<{ total_cents: unknown }>('select total_cents from orders where id = $1', [orderId])).rows[0]!;
    const orderPage = `${base}/${s.slug}/shop/orders/${number}${token ? `?t=${token}` : ''}`;
    const and = token ? '&' : '?';
    const started = await startPayment(db, gateway, {
      tenantId: s.tenantId, orderId, amountCents: toBigInt(order.total_cents), description: `${s.name} order #${number}`, invoiceRef: `${s.tenantId.slice(0, 8)}-${number}`,
    }, { returnUrl: (paymentId) => `${orderPage}${and}payment=${paymentId}`, cancelUrl: `${orderPage}${and}cancelled=1` });
    return { redirectUrl: started.redirectUrl, paymentId: started.paymentId };
  }

  /** Order confirmation to the buyer and a heads-up to the business, by email when set up. */
  async function notify(request: FastifyRequest, s: StoreRef, placed: { id: string; number: number; quote: { totals: { total: string } } }, path: string) {
    if (!ctx.mailConfigured || !ctx.publicUrl) return;
    const loaded = (await loadOrder(db, s.tenantId, { id: placed.id }))!;
    const o = loaded.order;
    const items = loaded.lines.map((l) => `${Number(l.quantity)} × ${l.product_title}${l.variant_title ? ` (${l.variant_title})` : ''}`);
    const total = `BZ$${placed.quote.totals.total}`;
    if (o.customer_email) {
      const lang = await emailLanguage(db, s.tenantId);
      const say = PHRASES[lang];
      const how = o.payment_method === 'bank_transfer'
        ? [say.payByTransfer(total), s.settings.payments.bankTransfer.instructions || say.bankDetailsLater, say.orderReference(o.number)]
        : o.payment_method === 'cash_on_delivery' ? [say.payCashOnDelivery(total)]
          : o.payment_method === 'online' ? [say.paidOnline(total)] : [say.payAtPickup(total)];
      const link = publicLink(ctx, path);
      const mail = await renderEmail(db, s.tenantId, 'email.order', {
        store: { name: s.name, city: s.city, telephone: s.telephone, email: s.email },
        order: {
          number: o.number, customer_name: o.customer_name, payment_method: o.payment_method, payment_lines: how,
          items: loaded.lines.map((l) => ({ name: l.product_title, variant: l.variant_title, quantity: Number(l.quantity), total: formatCents(toBigInt(l.total_cents)) })),
          delivery: o.fulfillment === 'delivery', address: o.delivery_zone, delivery_fee: o.delivery_fee, total: placed.quote.totals.total,
          paid: o.payment_status === 'paid', url: link,
        },
      }, { publicUrl: ctx.publicUrl, lang });
      await ctx.mailer.send({ to: o.customer_email, replyTo: s.email, subject: mail.subject, text: mail.text, html: mail.html });
    }
    const merchant = s.settings.notifyEmail || s.email;
    const admin = publicLink(ctx, `/${s.slug}/orders/${o.id}`);
    await ctx.mailer.send({
      to: merchant,
      subject: `New order #${o.number}: ${total}`,
      text: [`${o.customer_name} (${o.customer_phone}) ordered:`, items.join('\n'), `${PAYMENT_TEXT[o.payment_method]}, ${o.fulfillment === 'delivery' ? `delivery to ${o.delivery_zone}` : 'pickup'}.`, admin].join('\n\n'),
      html: simpleHtml({ heading: `New order #${o.number}: ${total}`, paragraphs: [`${o.customer_name} (${o.customer_phone}) ordered:`, ...items, `${PAYMENT_TEXT[o.payment_method]}, ${o.fulfillment === 'delivery' ? `delivery to ${o.delivery_zone}` : 'pickup'}.`], button: { label: 'Open the order', url: admin } }),
    });
    void request;
  }

  app.post<{ Params: { slug: string; handle: string }; Body: { variantId: string; email: string } }>(
    '/:slug/products/:handle/notify',
    {
      schema: {
        params: { type: 'object', required: ['slug', 'handle'], properties: { ...slugParams, handle: { type: 'string', maxLength: 80 } } },
        body: { type: 'object', required: ['variantId', 'email'], additionalProperties: false, properties: { variantId: uuid, email: { type: 'string', format: 'email', maxLength: 254 } } },
      },
    },
    async (request) => {
      const s = await store(request);
      if (await overLimit(db, `stock-alert|${request.ip}`, 20, HOUR_MS)) throw new ApiError(429, 'too_many_requests', 'Too many requests from here; try again later');
      try {
        await addStockAlert(db, s.tenantId, request.params.handle, request.body.variantId, request.body.email);
      } catch (e) {
        if (e instanceof StockAlertError) throw new ApiError(e.code === 'not_found' ? 404 : 409, e.code, e.message);
        throw e;
      }
      return { ok: true };
    },
  );

  const orderParams = { type: 'object', required: ['slug', 'number'], properties: { ...slugParams, number: { type: 'string', pattern: '^\\d{1,9}$' } } } as const;
  // The token from the order's link; without one, the buyer signed in to their account.
  const tokenQuery = { type: 'object', additionalProperties: false, properties: { t: { type: 'string', minLength: 20, maxLength: 64 } } } as const;

  const buyerOrder = async (request: FastifyRequest<{ Params: { slug: string; number: string }; Querystring: { t?: string } }>) => {
    const s = await loadStore(db, request.params.slug, { requireOpen: false });
    const number = Number(request.params.number);
    let loaded = null;
    if (request.query.t) {
      loaded = await loadOrder(db, s.tenantId, { number, token: request.query.t });
    } else {
      // Signed in by cookie: changes need the CSRF header.
      if (!['GET', 'HEAD'].includes(request.method)) requireCsrfHeader(request);
      const buyer = await buyerFromRequest(db, request, s);
      if (buyer) loaded = await loadOrder(db, s.tenantId, { number, buyer });
    }
    if (!loaded) throw new StoreError('not_found', 'Order not found. Use the link from your confirmation.');
    return { s, ...loaded };
  };

  app.get<{ Params: { slug: string; number: string }; Querystring: { t?: string } }>(
    '/:slug/orders/:number',
    { schema: { params: orderParams, querystring: tokenQuery } },
    async (request, reply) => {
      const { s, order, lines } = await buyerOrder(request);
      const doc = await documentSummary(deps, s.tenantId, order.document_id);
      const j = orderJson(order, lines, doc);
      reply.header('Cache-Control', 'no-store');
      return {
        store: { name: s.name, slug: s.slug, whatsapp: s.settings.whatsapp || null, telephone: s.telephone, email: s.email },
        number: j.number,
        status: j.status,
        paymentStatus: j.paymentStatus,
        fulfillmentStatus: j.fulfillmentStatus,
        paymentMethod: j.paymentMethod,
        fulfillment: j.fulfillment,
        deliveryZone: j.deliveryZone,
        customer: { name: j.customer.name },
        address: j.address,
        lines: j.lines,
        totals: j.totals,
        createdAt: j.createdAt,
        readyAt: j.readyAt,
        cancelReason: j.cancelReason,
        // How to pay, while it is still owed.
        instructions: order.status === 'open' && order.payment_status === 'unpaid' && order.payment_method === 'bank_transfer' ? s.settings.payments.bankTransfer.instructions : null,
        discount: order.discount_code ? { code: order.discount_code } : null,
        online: order.payment_method === 'online' ? await onlineState(order.id, order.status === 'open' && order.payment_status === 'unpaid' && s.settings.payments.online.enabled) : null,
        pickup: order.fulfillment === 'pickup' ? { address: `${s.street}, ${s.city}`, instructions: s.settings.pickup.instructions } : null,
        document: doc && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(doc.status)
          ? { type: doc.type, series: doc.series, number: doc.number, status: doc.status }
          : null,
      };
    },
  );

  app.get<{ Params: { slug: string; number: string }; Querystring: { t?: string } }>(
    '/:slug/orders/:number/document',
    { schema: { params: orderParams, querystring: tokenQuery } },
    async (request, reply) => {
      const { s, order } = await buyerOrder(request);
      if (!order.document_id) throw new StoreError('not_found', 'The receipt is issued once the payment is confirmed');
      const copy = await printedCopy(deps, s.tenantId, order.document_id);
      return reply.type('application/pdf').header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex')
        .header('Content-Disposition', `inline; filename="${copy.filename}.pdf"`).send(copy.pdf);
    },
  );

  async function onlineState(orderId: string, canPay: boolean) {
    const last = (await db.query<{ status: string; provider: string; detail: { reason?: string; error?: string } | null }>(
      'select status, provider, detail from order_payments where order_id = $1 order by created_at desc limit 1', [orderId],
    )).rows[0];
    return { canPay, lastStatus: last?.status ?? null, lastProblem: last?.detail?.reason ?? last?.detail?.error ?? null, provider: last?.provider ?? null };
  }

  app.post<{ Params: { slug: string; number: string }; Querystring: { t?: string } }>(
    '/:slug/orders/:number/pay',
    { schema: { params: orderParams, querystring: tokenQuery } },
    async (request) => {
      const { s, order } = await buyerOrder(request);
      if (order.payment_method !== 'online' || order.status !== 'open' || order.payment_status !== 'unpaid') throw new StoreError('conflict', 'This order is not waiting for an online payment');
      if (!s.settings.payments.online.enabled) throw new StoreError('conflict', 'This store is not taking online payments right now; contact it to pay another way');
      if (await overLimit(db, `pay|${order.id}`, 20, HOUR_MS)) throw new ApiError(429, 'too_many_attempts', 'Too many payment attempts for this order; contact the store');
      try {
        return await beginPayment(s, order.id, order.number, request.query.t);
      } catch (e) {
        if (e instanceof PaymentError) throw new StoreError('conflict', e.message);
        throw e;
      }
    },
  );

  app.post<{ Params: { slug: string; number: string; paymentId: string }; Querystring: { t?: string } }>(
    '/:slug/orders/:number/payments/:paymentId/confirm',
    { schema: { params: { ...orderParams, required: ['slug', 'number', 'paymentId'], properties: { ...orderParams.properties, paymentId: uuid } }, querystring: tokenQuery } },
    async (request) => {
      const { s, order } = await buyerOrder(request);
      const p = (await db.query<{ id: string; provider: Provider; order_id: string }>('select id, provider, order_id from order_payments where id = $1 and order_id = $2', [request.params.paymentId, order.id])).rows[0];
      if (!p) throw new StoreError('not_found', 'Payment not found');
      const gateway = await gatewayFor(db, s.tenantId, p.provider, await gatewaySettings(s.tenantId));
      const now = await confirmPayment(db, gateway, p.id);
      if (now.status === 'paid') await settlePaidOrder(deps, ctx, now);
      return { status: now.status, problem: (now.detail as { reason?: string } | null)?.reason ?? null, ...(now.status === 'pending' && { wallet: await walletDisplay(now) }) };
    },
  );

  // ---------- the test gateway's pretend card page ----------
  const testParams = { type: 'object', required: ['slug', 'id'], properties: { ...slugParams, id: uuid } } as const;
  const testPayment = async (slug: string, id: string) => {
    const r = (await db.query<{ id: string; status: string; amount_cents: unknown; number: number; store: string; detail: Record<string, unknown> | null; order_id: string }>(
      `select p.id, p.status, p.amount_cents, o.number, coalesce(t.trade_name, t.legal_name) as store, p.detail, p.order_id
       from order_payments p join orders o on o.id = p.order_id join tenants t on t.id = p.tenant_id
       where p.id = $1 and t.slug = $2 and p.provider = 'test'`, [id, slug],
    )).rows[0];
    if (!r) throw new StoreError('not_found', 'Payment not found');
    return r;
  };
  app.get<{ Params: { slug: string; id: string } }>('/:slug/test-payments/:id', { schema: { params: testParams } }, async (request) => {
    const p = await testPayment(request.params.slug, request.params.id);
    return { store: p.store, orderNumber: p.number, amount: formatCents(toBigInt(p.amount_cents)), status: p.status, decided: Boolean(p.detail?.testDecision) };
  });
  registerStoreAccountRoutes(app, deps, ctx, store);

  app.post<{ Params: { slug: string; id: string }; Body: { decision: 'approved' | 'declined' } }>(
    '/:slug/test-payments/:id',
    { schema: { params: testParams, body: { type: 'object', required: ['decision'], additionalProperties: false, properties: { decision: { type: 'string', enum: ['approved', 'declined'] } } } } },
    async (request) => {
      const p = await testPayment(request.params.slug, request.params.id);
      if (p.status !== 'pending' || p.detail?.testDecision) throw new StoreError('conflict', 'This test payment was already decided');
      await db.query("update order_payments set detail = coalesce(detail, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1", [p.id, JSON.stringify({ testDecision: request.body.decision })]);
      return { ok: true };
    },
  );
}
