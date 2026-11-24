/**
 * The store API in the reference (/docs): what each endpoint is for, an
 * example of what it answers, and the error codes it can answer with.
 * test/store-reference.test.ts checks every example against a real answer,
 * field for field, so the reference cannot describe an API that is not there.
 */

const BASE = 'https://app.example.bz';
const STORE = 'reef-goods';
const VARIANT = '5ccd1c08-9412-4ca7-9958-f2a0c011e996';
const TOKEN = 'IW1GjWh5f3htODjlhD5KSL6G6XS-y_ti';
const PAYMENT = '82d0e03c-428a-4a63-908d-e604cde60584';
const IMAGE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** Endpoints only the hosted store's own pages can use (a cookie of this app, or its own flow). */
export const hostedOnly = (path: string) => path === '/v1/store/{slug}' || /\/(account|test-payments|checkouts\/restore|checkouts\/unsubscribe)(\/|$)/.test(path);

export const STORE_SUMMARIES: Record<string, string> = {
  'GET /v1/store/{slug}': 'The store with the hosted site\'s design (theme, pages, sections). A site built elsewhere wants /info instead.',
  'GET /v1/store/{slug}/info': 'The store: its name and contact, whether it is a test store, delivery areas, pickup, the ways to pay, and its addresses',
  'GET /v1/store/{slug}/products': 'Products on sale, as cards. Narrow with q, category, collection, handles, onSale, relatedTo; order with sort; page with limit and cursor',
  'GET /v1/store/{slug}/products/{handle}': 'One product: its description, photos, options and variants (the thing a buyer orders is a variant)',
  'GET /v1/store/{slug}/collections': 'The store\'s published collections',
  'GET /v1/store/{slug}/collections/{handle}': 'A collection with its products',
  'GET /v1/store/{slug}/images/{id}': 'A product photo (cached for a year; any page may show it, no key needed)',
  'POST /v1/store/{slug}/quote': 'Price a cart: line totals, delivery, a discount code, a gift card, the total with GST, and the ways to pay for this order',
  'POST /v1/store/{slug}/orders': 'Place an order. Stock is taken in the same step. Paying online answers with payment.url, where to send the buyer. Send an Idempotency-Key so a retry never orders twice',
  'GET /v1/store/{slug}/orders/{number}': 'The buyer\'s order: progress, how to pay while it is owed, and its receipt once paid. Needs the order\'s token (t)',
  'GET /v1/store/{slug}/orders/{number}/document': 'The order\'s BTS receipt or invoice as a PDF, once it is paid',
  'POST /v1/store/{slug}/orders/{number}/pay': 'Start (or retry) paying an order online: where to send the buyer',
  'POST /v1/store/{slug}/orders/{number}/payments/{paymentId}/confirm': 'Back from the payment page: was it paid? Paid marks the order paid and issues its receipt',
  'POST /v1/store/{slug}/gift-cards/balance': 'A gift card\'s balance from its code',
  'POST /v1/store/{slug}/contact': 'A message from a contact form, emailed to the store',
  'POST /v1/store/{slug}/products/{handle}/notify': 'Email me when this sold-out variant is back',
  'PUT /v1/store/{slug}/checkouts/{id}': 'Keep a checkout as the buyer fills it in (once they gave an email), so the store can remind them if they leave. `id` is a UUID you make; send it as checkoutId on the order',
  'GET /v1/store/{slug}/checkouts/restore': 'A reminder\'s link: the cart and what the buyer had filled in',
  'POST /v1/store/{slug}/checkouts/unsubscribe': 'No more reminders from this store',
  'GET /v1/store/{slug}/test-payments/{id}': 'The pretend card page of a test store: the payment it is for',
  'POST /v1/store/{slug}/test-payments/{id}': 'The pretend card page: approve or decline. Answers where to send the buyer back when the order named a returnUrl',
  'GET /v1/store/{slug}/account': 'Who is signed in to their buyer account here',
  'PUT /v1/store/{slug}/account': 'Change the buyer\'s details',
  'DELETE /v1/store/{slug}/account': 'Close the buyer\'s account',
  'POST /v1/store/{slug}/account/code': 'Email a sign-in code',
  'POST /v1/store/{slug}/account/verify': 'Sign in with the code',
  'POST /v1/store/{slug}/account/sign-out': 'Sign out',
  'GET /v1/store/{slug}/account/orders': 'The buyer\'s orders at this store',
  'POST /v1/store/{slug}/account/addresses': 'Keep an address',
  'PUT /v1/store/{slug}/account/addresses/{id}': 'Change an address',
  'DELETE /v1/store/{slug}/account/addresses/{id}': 'Remove an address',
};

const CARD = {
  handle: 'island-t-shirt', title: 'Island T-shirt', imageId: IMAGE, price: '45.00', compareAt: null, priceVaries: false, soldOut: false, category: 'Clothing', badge: null,
  imageUrl: `${BASE}/v1/store/${STORE}/images/${IMAGE}`, url: `${BASE}/${STORE}/shop/products/island-t-shirt`,
};

const ORDER = {
  store: { name: 'Reef Goods', slug: STORE, whatsapp: null, telephone: '501-226-0000', email: 'hello@reefgoods.example' },
  number: 1003, status: 'open', paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled', paymentMethod: 'online', fulfillment: 'pickup', deliveryZone: null,
  customer: { name: 'Ana Buyer' }, address: null,
  lines: [{ lineNumber: 1, variantId: VARIANT, productTitle: 'Island T-shirt', variantTitle: 'S', quantity: 1, unitPrice: '40.00', gstCategory: 'S', total: '45.00' }],
  totals: { lineExtension: '40.00', gst: '5.00', total: '45.00', refunded: '0.00' },
  giftCard: null, amountDue: '45.00', createdAt: '2026-11-24T16:56:02.023Z', readyAt: null, cancelReason: null, instructions: null, discount: null,
  online: { canPay: false, lastStatus: 'paid', lastProblem: null, provider: 'test' },
  pickup: { address: '12 Front Street, San Pedro', instructions: 'Ask at the counter' },
  document: { type: '02', series: '001', number: '000000002', status: 'authorized', pdfUrl: `${BASE}/v1/store/${STORE}/orders/1003/document?t=${TOKEN}` },
  test: true, orderUrl: `${BASE}/${STORE}/shop/orders/1003?t=${TOKEN}`,
};

/** What each endpoint answers, by "METHOD path". */
export const STORE_EXAMPLES: Record<string, unknown> = {
  'GET /v1/store/{slug}/info': {
    slug: STORE, email: 'hello@reefgoods.example', street: '12 Front Street', name: 'Reef Goods', tagline: 'From the reef', about: '', whatsapp: null, telephone: '501-226-0000', city: 'San Pedro',
    currency: 'BZD', test: true,
    delivery: { enabled: true, zones: [{ name: 'San Pedro', fee: '9.00' }] },
    pickup: { enabled: true, address: '12 Front Street, San Pedro' },
    payments: { bankTransfer: true, cashOnDelivery: true, payAtPickup: true, online: 'test' },
    reminders: true, accounts: true,
    urls: { store: `${BASE}/${STORE}/shop`, cart: `${BASE}/${STORE}/shop/cart`, account: `${BASE}/${STORE}/shop/account`, api: `${BASE}/v1/store/${STORE}` },
  },
  'GET /v1/store/{slug}/products': { data: [CARD], nextCursor: 'bzox' },
  'GET /v1/store/{slug}/products/{handle}': {
    handle: 'island-t-shirt', title: 'Island T-shirt', description: 'Soft cotton, printed in San Pedro.', badge: null, options: ['Size'],
    images: [IMAGE], imageUrls: [`${BASE}/v1/store/${STORE}/images/${IMAGE}`], url: `${BASE}/${STORE}/shop/products/island-t-shirt`,
    variants: [
      { id: VARIANT, title: 'S', option1: 'S', option2: null, price: '45.00', compareAt: null, available: true, left: null },
      { id: '81c7efa0-158a-44f6-93e0-bb985f059da6', title: 'M', option1: 'M', option2: null, price: '45.00', compareAt: null, available: true, left: 3 },
    ],
  },
  'GET /v1/store/{slug}/collections': { data: [{ handle: 'summer', title: 'Summer', description: 'For the beach.', image: null, productCount: 1 }] },
  'GET /v1/store/{slug}/collections/{handle}': { handle: 'summer', title: 'Summer', description: 'For the beach.', image: null, seoTitle: null, seoDescription: null, products: [CARD] },
  'POST /v1/store/{slug}/quote': {
    lines: [{ variantId: VARIANT, productTitle: 'Island T-shirt', variantTitle: 'S', quantity: 1, total: '45.00', listTotal: '45.00' }],
    delivery: { zone: 'San Pedro', total: '9.00' }, discount: null,
    totals: { lineExtension: '48.00', gst: '6.00', total: '54.00' },
    giftCard: null, due: '54.00', paymentMethods: ['bank_transfer', 'cash_on_delivery', 'online'],
  },
  'POST /v1/store/{slug}/orders': {
    number: 1003, token: TOKEN, path: `/${STORE}/shop/orders/1003?t=${TOKEN}`, orderUrl: `${BASE}/${STORE}/shop/orders/1003?t=${TOKEN}`, test: true,
    totals: { lineExtension: '40.00', gst: '5.00', total: '45.00' },
    payment: { redirectUrl: `/${STORE}/shop/pay/${PAYMENT}`, paymentId: PAYMENT, url: `${BASE}/${STORE}/shop/pay/${PAYMENT}` },
  },
  'GET /v1/store/{slug}/orders/{number}': ORDER,
  'POST /v1/store/{slug}/orders/{number}/pay': { redirectUrl: `/${STORE}/shop/pay/${PAYMENT}`, paymentId: PAYMENT, url: `${BASE}/${STORE}/shop/pay/${PAYMENT}` },
  'POST /v1/store/{slug}/orders/{number}/payments/{paymentId}/confirm': { status: 'paid', problem: null },
  'POST /v1/store/{slug}/gift-cards/balance': { last4: 'K7QF', balance: '25.00', status: 'active', expiresOn: null },
  'POST /v1/store/{slug}/contact': { sent: true },
  'POST /v1/store/{slug}/products/{handle}/notify': { ok: true },
  'PUT /v1/store/{slug}/checkouts/{id}': { saved: true },
};

/** A body to send, where the generated one (required fields only) would not show how. */
export const STORE_REQUESTS: Record<string, unknown> = {
  'POST /v1/store/{slug}/quote': { lines: [{ variantId: VARIANT, quantity: 1 }], fulfillment: 'delivery', zone: 'San Pedro' },
  'POST /v1/store/{slug}/orders': {
    lines: [{ variantId: VARIANT, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'online',
    customer: { name: 'Ana Buyer', phone: '501-610-0000', email: 'ana@example.com' },
    returnUrl: 'https://www.reefgoods.example/thanks',
  },
  'POST /v1/store/{slug}/orders/{number}/pay': { returnUrl: 'https://www.reefgoods.example/thanks' },
};

/** Every error code the store API answers with: its status, and what to do about it. */
export const STORE_ERRORS: Array<{ code: string; status: number; meaning: string }> = [
  { code: 'invalid_request', status: 400, meaning: 'The request does not fit: the message names the field and what it must be. Fix the request; sending it again unchanged will fail again.' },
  { code: 'publishable_key_required', status: 401, meaning: 'A page on another site called without a key. Send the store\'s publishable key.' },
  { code: 'invalid_publishable_key', status: 401, meaning: 'The key is not one of this store. Check the store name and copy the key again.' },
  { code: 'publishable_key_revoked', status: 401, meaning: 'The key was revoked. Make a new one and put it in the site.' },
  { code: 'origin_not_allowed', status: 403, meaning: 'The site is not on the key\'s list. Add its address in Settings → Developers.' },
  { code: 'test_key_on_live_store', status: 403, meaning: 'A test key, and the store is live now. Use a live key.' },
  { code: 'live_key_on_test_store', status: 403, meaning: 'A live key, and the store is in test mode. Use its test key.' },
  { code: 'secret_key_in_browser', status: 403, meaning: 'A secret key (etd_…) was sent from a web page. Revoke it and use a publishable key in pages.' },
  { code: 'hosted_only', status: 403, meaning: 'Buyer accounts work on the store\'s hosted pages only. Link buyers to urls.account.' },
  { code: 'not_found', status: 404, meaning: 'No store, product, collection, order or photo at this address (for an order: the token is wrong).' },
  { code: 'store_closed', status: 404, meaning: 'The store is not open. Open it in Settings → Online store.' },
  { code: 'gift_card_not_found', status: 404, meaning: 'No gift card has this code.' },
  { code: 'out_of_stock', status: 409, meaning: 'Something in the cart sold out, or there are fewer left than asked for. The message says which; change the cart and price it again.' },
  { code: 'conflict', status: 409, meaning: 'The order or payment is not in a state for this (already paid, cancelled, not paid online).' },
  { code: 'request_in_progress', status: 409, meaning: 'A request with this Idempotency-Key is still being worked on. Wait a moment and send it again.' },
  { code: 'invalid_order', status: 422, meaning: 'The order cannot be placed as asked: the message says why (no delivery to that area, a discount code that does not apply, an address missing, a payment method not offered).' },
  { code: 'invalid_return_url', status: 422, meaning: 'returnUrl is not a page on one of the key\'s sites, or no key was sent.' },
  { code: 'idempotency_key_reused', status: 422, meaning: 'This Idempotency-Key was used for a different order. Use a new key for each checkout.' },
  { code: 'rate_limited', status: 429, meaning: 'Too many requests in a minute. Wait the seconds Retry-After says, then carry on.' },
  { code: 'too_many_orders', status: 429, meaning: 'Too many orders from one visitor in an hour.' },
  { code: 'too_many_requests', status: 429, meaning: 'Too many tries (gift card codes, messages, reminders) from one visitor.' },
  { code: 'too_many_attempts', status: 429, meaning: 'Too many payment attempts for one order.' },
  { code: 'email_unavailable', status: 503, meaning: 'This server cannot send email right now (contact form).' },
  { code: 'internal_error', status: 500, meaning: 'Something went wrong on our side. Nothing you sent is at fault; try again, and tell us if it persists.' },
];
