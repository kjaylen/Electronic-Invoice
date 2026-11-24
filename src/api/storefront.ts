/**
 * The public storefront: no sign-in. Everything is scoped by the business's
 * address (slug), and only works while its store is open.
 *
 *   GET  /v1/store/:slug                         store details, delivery zones, payment methods, and the hosted site's design
 *   GET  /v1/store/:slug/info                    the same without the design: what a site built elsewhere needs
 *   GET  /v1/store/:slug/products                active products (q, category, collection, sort, limit, handles, onSale, relatedTo)
 *   GET  /v1/store/:slug/collections[/:handle]   published collections; one with its products
 *   POST /v1/store/:slug/contact                 a message from the contact form, emailed to the store
 *
 * The store's details include its published site (theme, header, footer,
 * pages and sections; see src/commerce/site.ts). Staff who can edit the site
 * may load a closed store with the header X-Site-Preview: 1 (the builder's preview).
 *   GET  /v1/store/:slug/products/:handle        one product with its variants
 *   GET  /v1/store/:slug/images/:id              a product photo (long-cached)
 *   POST /v1/store/:slug/orders/:n/pay?t=        start (or retry) paying an order online → where to send the buyer
 *   POST /v1/store/:slug/orders/:n/payments/:id/confirm?t=   back from the provider: was it paid?
 *   GET|POST /v1/store/:slug/test-payments/:id   the pretend card page of the test gateway
 *   POST /v1/store/:slug/products/:handle/notify { variantId, email }: email me when this sold-out variant is back
 *   POST /v1/store/:slug/quote                   price a cart, with delivery (and what a gift card would pay)
 *   POST /v1/store/:slug/gift-cards/balance      a gift card's balance { code }
 *   POST /v1/store/:slug/orders                  place an order
 *   GET  /v1/store/:slug/orders/:number?t=       the buyer's order page (the token from the order link,
 *                                                or none for a buyer signed in to their account)
 *   GET  /v1/store/:slug/orders/:number/document?t=   the receipt or invoice PDF, once paid
 *   .../account...                               buyer accounts (store-accounts.ts)
 *
 * Prices shown to buyers include GST. Totals come from the same calculation
 * that produces the e-invoice.
 *
 * A site built somewhere else calls the same routes with the store's
 * publishable key (store-access.ts). Answers carry full addresses beside the
 * older relative ones (imageUrl, url, orderUrl, payment.url), and an order or
 * a payment may name a returnUrl on that site to send the buyer back to.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { rememberFromOrder } from '../commerce/buyers.ts';
import { accountsOffered, buyerFromRequest, registerStoreAccountRoutes } from './store-accounts.ts';
import { requireCsrfHeader } from './auth.ts';
import { type CheckoutInput, markOrdered, restoreCheckout, saveCheckout, unsubscribe } from '../commerce/checkouts.ts';
import { loadOrder, loadStore, markOrderPaid, type OrderInput, paymentMethodsFor, placeOrder, priceWithGst, quoteCart, StoreError, type StoreRef, variantTitle } from '../commerce/store.ts';
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
import { cardJson, findCard, payingCard } from '../commerce/giftcards.ts';
import { catalog, type CatalogSort, collectionJson, listCollections, type ProductCard, SORTS } from '../commerce/catalog.ts';
import { customCodeSections, publishedSite } from '../commerce/site.ts';
import { renderStoreSection } from '../templates/render.ts';
import { sessionFromRequest } from './auth.ts';
import { can } from './permissions.ts';
import { publicBase } from './connect.ts';
import { checkedReturnUrl, registerStoreAccess, type StoreAccessOptions } from './store-access.ts';
import { claimIdempotency, idempotencyKey, STORE_ORDER_SCOPE } from './idempotency.ts';
import { sendDocumentEmail } from './documents.ts';


// Limits on placing orders (shared by every server process), so a script cannot flood a store.
const HOUR_MS = 60 * 60 * 1000;

/** Where a page of products starts, from the cursor the page before answered with. */
function cursorOffset(cursor: string): number {
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m) throw new ApiError(400, 'invalid_request', 'cursor is not one this API gave out. Send the nextCursor of the page before, unchanged.');
  return Number(m[1]);
}

const slugParams = { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' } } as const;
const cartSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: { type: 'object', required: ['variantId', 'quantity'], additionalProperties: false, properties: { variantId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 9999 } } },
} as const;

const PAYMENT_TEXT = { bank_transfer: 'Bank transfer', cash_on_delivery: 'Cash on delivery', pay_at_pickup: 'Pay at pickup', online: 'Paid online', gift_card: 'Paid with a gift card' } as const;

const returnUrlSchema = { type: 'string', minLength: 8, maxLength: 1000 } as const;

export function registerStorefrontRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, payments: GatewayExtras = {}, access: StoreAccessOptions = {}) {
  const { db } = deps;
  registerStoreAccess(app, deps, ctx, access);
  /** Full addresses, for sites that are not this app: the store's hosted pages, and its API. */
  const shopUrl = (request: FastifyRequest, slug: string, path = '') => `${publicBase(ctx, request)}/${slug}/shop${path}`;
  const apiUrl = (request: FastifyRequest, slug: string, path = '') => `${publicBase(ctx, request)}/v1/store/${slug}${path}`;
  const slugOf = async (tenantId: string) => (await db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
  const gatewaySettings = gatewayOptions(deps, slugOf, payments);
  // The site builder's preview: staff who can edit the site see their store even while it is closed.
  const previewing = async (request: FastifyRequest<{ Params: { slug: string } }>) => {
    if (request.headers['x-site-preview'] !== '1') return false;
    const session = await sessionFromRequest(deps, request);
    return Boolean(session && session.business.slug === request.params.slug.toLowerCase() && can(session.user.role, 'business.manage'));
  };
  // A store on a plan without the online store (after a downgrade) is closed to buyers.
  const store = async (request: FastifyRequest<{ Params: { slug: string } }>) => {
    const preview = await previewing(request);
    const s = await loadStore(db, request.params.slug, { requireOpen: !preview });
    if (!preview && !hasFeature((await getSubscription(db, s.tenantId)).plan, 'store')) throw new StoreError('store_closed', 'This store is not open right now');
    return s;
  };

  app.get<{ Params: { slug: string } }>('/:slug', { schema: { params: { type: 'object', required: ['slug'], properties: slugParams } } }, async (request) => {
    const s = await store(request);
    // On the store's own domain the shop lives at /shop; on ours, at /<slug>/shop.
    const own = ctx.publicUrl ? new URL(ctx.publicUrl).hostname : null;
    const base = own && request.hostname.split(':')[0] !== own ? '/shop' : `/${s.slug}/shop`;
    const context = await storeContext(db, s.tenantId, { base });
    // The published site; its custom code sections rendered and cleaned here.
    const site = await publishedSite(db, s.tenantId);
    for (const section of customCodeSections(site)) section.settings.html = await renderStoreSection(db, s.tenantId, String(section.settings.code ?? ''), context);
    return {
      site,
      theme: await renderStoreTheme(db, s.tenantId, context),
      ...storeInfo(request, s),
    };
  });

  /** What every kind of storefront needs to know about the store. */
  const storeInfo = (request: FastifyRequest, s: StoreRef) => {
    const p = s.settings.payments;
    return {
      slug: s.slug,
      email: s.email,
      street: s.street,
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
      // The store's hosted pages and its API, as full addresses.
      urls: { store: shopUrl(request, s.slug), cart: shopUrl(request, s.slug, '/cart'), account: shopUrl(request, s.slug, '/account'), api: apiUrl(request, s.slug) },
    };
  };

  // The store without its hosted design: for a site built somewhere else.
  app.get<{ Params: { slug: string } }>('/:slug/info', { schema: { params: { type: 'object', required: ['slug'], properties: slugParams } } }, async (request) => storeInfo(request, await store(request)));

  /** A product card with its photo's and its hosted page's full address. */
  const productCard = (request: FastifyRequest, slug: string, p: ProductCard) => ({ ...p, imageUrl: p.imageId ? apiUrl(request, slug, `/images/${p.imageId}`) : null, url: shopUrl(request, slug, `/products/${p.handle}`) });

  app.get<{ Params: { slug: string }; Querystring: { q?: string; category?: string; collection?: string; sort?: CatalogSort; limit?: string; cursor?: string; handles?: string; onSale?: string; relatedTo?: string } }>(
    '/:slug/products',
    {
      schema: {
        params: { type: 'object', required: ['slug'], properties: slugParams },
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 }, category: { type: 'string', maxLength: 80 }, collection: { type: 'string', maxLength: 80 },
            sort: { type: 'string', enum: SORTS }, limit: { type: 'string', pattern: '^\\d{1,3}$' }, cursor: { type: 'string', maxLength: 40 }, handles: { type: 'string', maxLength: 1200 },
            onSale: { type: 'string', enum: ['1'] }, relatedTo: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
    async (request) => {
      const s = await store(request);
      const q = request.query;
      // Pages like the rest of the API: limit and cursor in, nextCursor out (null when there is no more). Without a limit, up to 500 as before.
      const limit = Math.min(500, Math.max(1, q.limit ? Number(q.limit) : 500));
      const offset = q.cursor ? cursorOffset(q.cursor) : 0;
      const rows = await catalog(db, s.tenantId, {
        ...(q.q && { q: q.q }), ...(q.category && { category: q.category }), ...(q.collection && { collection: q.collection }), ...(q.sort && { sort: q.sort }),
        limit: limit + 1, offset, ...(q.handles !== undefined && { handles: q.handles.split(',').map((h) => h.trim()).filter(Boolean).slice(0, 50) }),
        ...(q.onSale && { onSale: true }), ...(q.relatedTo && { relatedTo: q.relatedTo }),
      });
      return {
        data: rows.slice(0, limit).map((p) => productCard(request, s.slug, p)),
        nextCursor: rows.length > limit ? Buffer.from(`o:${offset + limit}`).toString('base64url') : null,
      };
    },
  );

  app.get<{ Params: { slug: string } }>('/:slug/collections', { schema: { params: { type: 'object', required: ['slug'], properties: slugParams } } }, async (request) => {
    const s = await store(request);
    const rows = await listCollections(db, s.tenantId, { publishedOnly: true });
    return {
      data: await Promise.all(rows.map(async (c) => {
        const j = await collectionJson(db, s.tenantId, c);
        return { handle: j.handle, title: j.title, description: j.description, image: j.image, productCount: j.productCount };
      })),
    };
  });

  app.get<{ Params: { slug: string; handle: string }; Querystring: { sort?: CatalogSort } }>(
    '/:slug/collections/:handle',
    { schema: { params: { type: 'object', required: ['slug', 'handle'], properties: { ...slugParams, handle: { type: 'string', maxLength: 80 } } }, querystring: { type: 'object', additionalProperties: false, properties: { sort: { type: 'string', enum: SORTS } } } } },
    async (request) => {
      const s = await store(request);
      const c = (await listCollections(db, s.tenantId, { publishedOnly: true })).find((x) => x.handle === request.params.handle);
      if (!c) throw new StoreError('not_found', 'This collection is not available');
      return {
        handle: c.handle, title: c.title, description: c.description, image: c.image, seoTitle: c.seo_title, seoDescription: c.seo_description,
        products: (await catalog(db, s.tenantId, { collection: c.handle, ...(request.query.sort && { sort: request.query.sort }) })).map((p) => productCard(request, s.slug, p)),
      };
    },
  );

  // A message from the store's contact form, emailed to the store (the buyer's address to reply to).
  app.post<{ Params: { slug: string }; Body: { name: string; email: string; phone?: string; message: string; website?: string } }>(
    '/:slug/contact',
    {
      schema: {
        params: { type: 'object', required: ['slug'], properties: slugParams },
        body: {
          type: 'object', required: ['name', 'email', 'message'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            email: { type: 'string', maxLength: 254, pattern: '^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' },
            phone: { type: 'string', maxLength: 30 },
            message: { type: 'string', minLength: 1, maxLength: 4000 },
            // Left empty by people; filled in by form-filling robots.
            website: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      const s = await store(request);
      if (request.body.website) return { sent: true };
      if (!ctx.mailConfigured) throw new ApiError(503, 'email_unavailable', 'This store cannot receive messages right now; call or message it instead');
      if (await overLimit(db, `contact|${request.ip}`, 5, HOUR_MS) || await overLimit(db, `contact|${s.tenantId}`, 100, 24 * HOUR_MS)) throw new ApiError(429, 'too_many_requests', 'Too many messages from here; try again later');
      const b = request.body;
      const lines = [`From: ${b.name.trim()} <${b.email.trim()}>`, ...(b.phone?.trim() ? [`Phone: ${b.phone.trim()}`] : []), '', b.message.trim()];
      await ctx.mailer.send({
        to: s.settings.notifyEmail || s.email,
        replyTo: b.email.trim(),
        subject: `Message from your store: ${b.name.trim().slice(0, 60)}`,
        text: lines.join('\n'),
        html: simpleHtml({ heading: `A message from ${b.name.trim()}`, paragraphs: lines.filter(Boolean) }),
      });
      await audit(db, { tenantId: s.tenantId, action: 'store.contact', target: b.email.trim().toLowerCase(), ip: request.ip });
      return { sent: true };
    },
  );

  app.get<{ Params: { slug: string; handle: string } }>(
    '/:slug/products/:handle',
    { schema: { params: { type: 'object', required: ['slug', 'handle'], properties: { ...slugParams, handle: { type: 'string', maxLength: 80 } } } } },
    async (request) => {
      const s = await store(request);
      const p = (await db.query<{ id: string; handle: string; title: string; description: string; option1_name: string | null; option2_name: string | null; badge: string | null }>(
        `select id, handle, title, description, option1_name, option2_name, badge from products where tenant_id = $1 and handle = $2 and status = 'active'`, [s.tenantId, request.params.handle],
      )).rows[0];
      if (!p) throw new StoreError('not_found', 'This product is not available');
      const variants = (await db.query<{ id: string; option1: string | null; option2: string | null; unit_price: string; compare_at_price: string | null; gst_category: 'S' | 'Z' | 'E'; stock_quantity: number | null }>(
        `select id, option1, option2, unit_price::text as unit_price, compare_at_price::text as compare_at_price, gst_category, stock_quantity::float8 as stock_quantity from items where product_id = $1 and archived_at is null order by position, created_at`, [p.id],
      )).rows;
      const images = (await db.query<{ id: string }>('select id from product_images where product_id = $1 order by position, created_at', [p.id])).rows;
      return {
        handle: p.handle,
        title: p.title,
        description: p.description,
        badge: p.badge,
        options: [p.option1_name, p.option2_name].filter((x): x is string => Boolean(x)),
        images: images.map((i) => i.id),
        imageUrls: images.map((i) => apiUrl(request, s.slug, `/images/${i.id}`)),
        url: shopUrl(request, s.slug, `/products/${p.handle}`),
        variants: variants.map((v) => ({
          id: v.id,
          title: variantTitle(v),
          option1: v.option1,
          option2: v.option2,
          price: priceWithGst(v.unit_price, v.gst_category),
          // The "was" price, while it is higher than the price.
          compareAt: v.compare_at_price && Number(v.compare_at_price) > Number(v.unit_price) ? priceWithGst(v.compare_at_price, v.gst_category) : null,
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

  app.post<{ Params: { slug: string }; Body: { lines: OrderInput['lines']; fulfillment: 'delivery' | 'pickup'; zone?: string; discountCode?: string; giftCard?: string } }>(
    '/:slug/quote',
    { schema: { params: { type: 'object', required: ['slug'], properties: slugParams }, body: { type: 'object', required: ['lines', 'fulfillment'], additionalProperties: false, properties: { lines: cartSchema, ...choiceProps, giftCard: { type: 'string', maxLength: 40 } } } } },
    async (request) => {
      const s = await store(request);
      const q = await quoteCart(db, deps, s, request.body.lines, request.body);
      // A gift card pays what it can; when that is everything, it is the only way to pay.
      let giftCard: { last4: string; balance: string; applied: string } | null = null;
      let due = q.cents.total;
      if (request.body.giftCard) {
        if (await overLimit(db, `gift-card|${request.ip}`, 60, HOUR_MS)) throw new ApiError(429, 'too_many_requests', 'Too many tries from here; try again later');
        const card = await payingCard(db, s.tenantId, request.body.giftCard);
        const balance = toBigInt(card.balance_cents);
        const applied = balance < q.cents.total ? balance : q.cents.total;
        due = q.cents.total - applied;
        giftCard = { last4: card.last4, balance: formatCents(balance), applied: formatCents(applied) };
      }
      return {
        lines: q.lines.map((l) => ({ variantId: l.variantId, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.quantity, total: l.total, listTotal: l.listTotal })),
        delivery: q.delivery && { zone: q.delivery.zone, total: q.delivery.total },
        discount: q.discount && { code: q.discount.code, kind: q.discount.kind, saved: q.discount.saved },
        totals: q.totals,
        giftCard,
        due: formatCents(due),
        paymentMethods: giftCard && due === 0n ? ['gift_card'] : paymentMethodsFor(s.settings, request.body.fulfillment),
      };
    },
  );

  // A gift card's balance (the link in its email).
  app.post<{ Params: { slug: string }; Body: { code: string } }>(
    '/:slug/gift-cards/balance',
    { schema: { params: { type: 'object', required: ['slug'], properties: slugParams }, body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 1, maxLength: 40 } } } } },
    async (request) => {
      const s = await store(request);
      if (await overLimit(db, `gift-card|${request.ip}`, 60, HOUR_MS)) throw new ApiError(429, 'too_many_requests', 'Too many tries from here; try again later');
      const card = await findCard(db, s.tenantId, request.body.code);
      if (!card) throw new ApiError(404, 'gift_card_not_found', 'There is no gift card with this code. Check it and try again.');
      const j = cardJson(card);
      return { last4: j.last4, balance: j.balance, status: j.status, expiresOn: j.expiresOn };
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
            paymentMethod: { type: 'string', enum: ['bank_transfer', 'cash_on_delivery', 'pay_at_pickup', 'online', 'gift_card'] },
            giftCard: { type: 'string', maxLength: 40 },
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
            // Paying online from a site built elsewhere: the page there to come back to.
            returnUrl: returnUrlSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const s = await store(request);
      if (await overLimit(db, `order|${request.ip}|${s.slug}`, 20, HOUR_MS) || await overLimit(db, `order|${request.ip}`, 60, HOUR_MS)) throw new ApiError(429, 'too_many_orders', 'Too many orders from here in the last hour; contact the store');
      // Signed in: the order goes in the buyer's account, which remembers what was new in it.
      const { returnUrl: wantedReturn, ...order } = request.body as OrderInput & { returnUrl?: string };
      const returnTo = checkedReturnUrl(request, wantedReturn);
      // A retry (a dropped connection, a second click) with the same Idempotency-Key gets the first answer back, and no second order.
      const idempotency = idempotencyKey(request);
      const claim = idempotency ? await claimIdempotency(db, deps.keys, reply, { tenantId: s.tenantId, scope: STORE_ORDER_SCOPE, key: idempotency, body: request.body }) : null;
      if (idempotency && !claim) return reply;
      const buyer = await buyerFromRequest(db, request, s);
      const placed = await placeOrder(db, deps, s, order, { ...(buyer && { buyerId: buyer.id }) }).catch(async (e) => {
        await claim?.release();
        throw e;
      });
      if (buyer) await rememberFromOrder(db, buyer, request.body).catch((e) => request.log.error({ err: e }, 'account not updated'));
      await markOrdered(db, s.tenantId, placed.id, request.body.checkoutId, request.body.customer.email).catch((e) => request.log.error({ err: e }, 'checkout not closed'));
      const path = `/${s.slug}/shop/orders/${placed.number}?t=${placed.token}`;
      await audit(db, { tenantId: s.tenantId, action: 'order.placed', target: `#${placed.number}`, details: { total: placed.quote.totals.total }, ip: request.ip });
      // Paid in full with a gift card: paid now, and the receipt issued and emailed.
      if (request.body.paymentMethod === 'gift_card') {
        try {
          const { order, document } = await markOrderPaid(deps, s.tenantId, placed.id, null);
          await audit(db, { tenantId: s.tenantId, action: 'order.paid', target: `#${order.number}`, details: { giftCard: true } });
          if (document && order.customer_email && ctx.mailConfigured && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(document.status)) {
            void sendDocumentEmail(deps, ctx, s.tenantId, document.documentId, { to: order.customer_email, message: PHRASES[await emailLanguage(db, s.tenantId)].orderPaid(order.number) }).catch((e) => request.log.error({ err: e }, 'receipt email failed'));
          }
        } catch (e) {
          // The card was charged and the order stands: staff can issue the receipt from it.
          request.log.error({ err: e }, 'gift card order not marked paid');
        }
      }
      void notify(request, s, placed, path).catch((e) => request.log.error({ err: e }, 'order notification failed'));
      // Paying online: straight to the provider's page. If that fails, the order stands and the buyer can retry from its page.
      let payment: { redirectUrl: string; url: string } | { error: string } | undefined;
      if (request.body.paymentMethod === 'online') {
        try {
          payment = await beginPayment(request, s, placed.id, placed.number, placed.token, returnTo);
        } catch (e) {
          payment = { error: e instanceof PaymentError ? e.message : 'The payment could not be started; try again from your order page' };
        }
      }
      const answer = {
        number: placed.number, token: placed.token, path,
        // The buyer's order page on the hosted store (progress, how to pay, the receipt once paid).
        orderUrl: shopUrl(request, s.slug, `/orders/${placed.number}?t=${placed.token}`),
        test: s.environment === 'test',
        totals: placed.quote.totals, ...(payment && { payment }),
      };
      await claim?.complete(201, answer).catch((e) => request.log.error({ err: e }, 'order answer not kept for retries'));
      return reply.code(201).send(answer);
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

  /**
   * Create a checkout with the store's provider; returns where to send the buyer. Afterwards the buyer comes back to the
   * order's link (or, signed in, its page in the account), or to `returnTo` on the site that asked, which gets
   * floreo_order, floreo_token and floreo_payment (or floreo_cancelled) added to its address.
   */
  async function beginPayment(request: FastifyRequest, s: StoreRef, orderId: string, number: number, token: string | undefined, returnTo?: string) {
    const gateway = await gatewayFor(db, s.tenantId, s.settings.payments.online.provider, await gatewaySettings(s.tenantId));
    const base = ctx.publicUrl?.replace(/\/$/, '') ?? '';
    if (gateway.provider !== 'test' && !base) throw new PaymentError('PUBLIC_URL is not set on this server, so the payment provider cannot send buyers back');
    // What is left after a gift card.
    const order = (await db.query<{ total_cents: unknown }>('select total_cents - gift_card_cents as total_cents from orders where id = $1', [orderId])).rows[0]!;
    const orderPage = `${base}/${s.slug}/shop/orders/${number}${token ? `?t=${token}` : ''}`;
    const and = token ? '&' : '?';
    const back = (extra: Record<string, string>) => {
      const u = new URL(returnTo!);
      for (const [k, v] of Object.entries({ floreo_order: String(number), ...(token && { floreo_token: token }), ...extra })) u.searchParams.set(k, v);
      return u.toString();
    };
    const started = await startPayment(db, gateway, {
      tenantId: s.tenantId, orderId, amountCents: toBigInt(order.total_cents), description: `${s.name} order #${number}`, invoiceRef: `${s.tenantId.slice(0, 8)}-${number}`,
    }, returnTo
      ? { returnUrl: (paymentId) => back({ floreo_payment: paymentId }), cancelUrl: back({ floreo_cancelled: '1' }) }
      : { returnUrl: (paymentId) => `${orderPage}${and}payment=${paymentId}`, cancelUrl: `${orderPage}${and}cancelled=1` });
    // The pretend card page is ours: it needs to know where the buyer came from.
    if (returnTo) {
      await db.query("update order_payments set detail = coalesce(detail, '{}'::jsonb) || $2::jsonb where id = $1", [started.paymentId, JSON.stringify({ returnUrl: back({ floreo_payment: started.paymentId }) })]);
    }
    // `url` is always a full address; `redirectUrl` stays as it was (relative for the test page).
    return { redirectUrl: started.redirectUrl, paymentId: started.paymentId, url: /^https?:/.test(started.redirectUrl) ? started.redirectUrl : `${publicBase(ctx, request)}${started.redirectUrl}` };
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
      // What a gift card paid, and what is left to pay the way chosen.
      const gift = toBigInt(o.gift_card_cents ?? 0);
      const due = `BZ$${formatCents(toBigInt(o.total_cents) - gift)}`;
      const how = [
        ...(gift > 0n ? [say.paidByGiftCard(`BZ$${formatCents(gift)}`)] : []),
        ...(o.payment_method === 'gift_card' ? []
          : o.payment_method === 'bank_transfer' ? [say.payByTransfer(due), s.settings.payments.bankTransfer.instructions || say.bankDetailsLater, say.orderReference(o.number)]
            : o.payment_method === 'cash_on_delivery' ? [say.payCashOnDelivery(due)]
              : o.payment_method === 'online' ? [say.paidOnline(due)] : [say.payAtPickup(due)]),
      ];
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
        giftCard: j.giftCard,
        amountDue: j.amountDue,
        createdAt: j.createdAt,
        readyAt: j.readyAt,
        cancelReason: j.cancelReason,
        // How to pay, while it is still owed.
        instructions: order.status === 'open' && order.payment_status === 'unpaid' && order.payment_method === 'bank_transfer' ? s.settings.payments.bankTransfer.instructions : null,
        discount: order.discount_code ? { code: order.discount_code } : null,
        online: order.payment_method === 'online' ? await onlineState(order.id, order.status === 'open' && order.payment_status === 'unpaid' && s.settings.payments.online.enabled) : null,
        pickup: order.fulfillment === 'pickup' ? { address: `${s.street}, ${s.city}`, instructions: s.settings.pickup.instructions } : null,
        document: doc && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(doc.status)
          ? { type: doc.type, series: doc.series, number: doc.number, status: doc.status, pdfUrl: apiUrl(request, s.slug, `/orders/${order.number}/document${request.query.t ? `?t=${encodeURIComponent(request.query.t)}` : ''}`) }
          : null,
        test: s.environment === 'test',
        orderUrl: shopUrl(request, s.slug, `/orders/${order.number}${request.query.t ? `?t=${encodeURIComponent(request.query.t)}` : ''}`),
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

  app.post<{ Params: { slug: string; number: string }; Querystring: { t?: string }; Body?: { returnUrl?: string } }>(
    '/:slug/orders/:number/pay',
    { schema: { params: orderParams, querystring: tokenQuery, body: { type: ['object', 'null'], additionalProperties: false, properties: { returnUrl: returnUrlSchema } } } },
    async (request) => {
      const returnTo = checkedReturnUrl(request, request.body?.returnUrl);
      const { s, order } = await buyerOrder(request);
      if (order.payment_method !== 'online' || order.status !== 'open' || order.payment_status !== 'unpaid') throw new StoreError('conflict', 'This order is not waiting for an online payment');
      if (!s.settings.payments.online.enabled) throw new StoreError('conflict', 'This store is not taking online payments right now; contact it to pay another way');
      if (await overLimit(db, `pay|${order.id}`, 20, HOUR_MS)) throw new ApiError(429, 'too_many_attempts', 'Too many payment attempts for this order; contact the store');
      try {
        return await beginPayment(request, s, order.id, order.number, request.query.t, returnTo);
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
      // An order placed from a site built elsewhere goes back there, the way a real provider would send the buyer back.
      return { ok: true, returnUrl: typeof p.detail?.returnUrl === 'string' ? p.detail.returnUrl : null };
    },
  );
}
