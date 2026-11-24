/**
 * The public API's OpenAPI 3.1 description, built from the routes' own
 * validation schemas (so it can never drift from what the server accepts),
 * served at GET /v1/openapi.json. The web app renders it at /docs.
 *
 * Two parts: the store API (/v1/store/:slug/..., public, for sites built
 * elsewhere, with example answers from store-reference.ts) and the API for a
 * business's own systems (a secret key). Webhook events are listed with a
 * sample of what each carries.
 */

import type { RouteOptions } from 'fastify';
import { WEBHOOK_EVENTS } from '../webhooks/webhooks.ts';
import { SAMPLE_EVENT_DATA } from '../webhooks/samples.ts';
import { hostedOnly, STORE_ERRORS, STORE_EXAMPLES, STORE_REQUESTS, STORE_SUMMARIES } from './store-reference.ts';
import { AREA_COVERS, AREA_NAMES, areaOfRoute, KEY_AREAS, readOnlyMayUse } from './key-scope.ts';

interface CollectedRoute {
  method: string;
  url: string;
  schema: { params?: Schema; querystring?: Schema; body?: Schema } | undefined;
}
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: readonly string[]; [k: string]: unknown };

const STOREFRONT = { name: 'Storefront', description: 'A store for buyers: products, pricing a cart, orders, paying, receipts. Public; a page on another site sends the store\'s publishable key. Prices include GST.' };
const HOSTED = { name: 'Storefront: hosted pages', description: 'What only the store\'s own hosted pages use: its design, buyer accounts (a cookie), the pretend card page, reminder links. Listed so nothing is hidden; a site built elsewhere does not need them.' };

/** Areas of the API usable with an API key, in the order the reference shows them. */
const TAGS: Array<{ prefix: string; name: string; description: string }> = [
  { prefix: '/v1/documents', name: 'Documents', description: 'Issue tax invoices, receipts, credit and debit notes; read them back as JSON, signed XML or PDF; cancel; email; share.' },
  { prefix: '/v1/customers', name: 'Customers', description: 'Saved customers, to issue invoices to by id.' },
  { prefix: '/v1/items', name: 'Items', description: 'Catalog items (with barcodes), to issue lines by id.' },
  { prefix: '/v1/products', name: 'Products', description: 'The online store\'s products, their variants and photos.' },
  { prefix: '/v1/orders', name: 'Orders', description: 'Online orders: mark paid (issues the BTS document), delivered, cancelled, refunded.' },
  { prefix: '/v1/reports', name: 'Reports', description: 'Totals and GST for a period, sales by customer and item, the document register and the archive.' },
  { prefix: '/v1/webhooks', name: 'Webhooks', description: 'Be told when documents are authorized or rejected, and when orders change.' },
  { prefix: '/v1/me', name: 'Business', description: 'The business the key belongs to: details, certificate, contingency state, plan.' },
  { prefix: '/v1/certificate', name: 'Business', description: '' },
  { prefix: '/v1/business', name: 'Business', description: '' },
  { prefix: '/v1/store-settings', name: 'Products', description: '' },
  { prefix: '/v1/templates', name: 'Templates', description: 'The Liquid templates behind emails, printed documents and the online store (as in a Shopify theme), and the images and logo they use.' },
  { prefix: '/v1/pos', name: 'Tills', description: 'The till apps (iOS, Android, desktop): add a till and pair it with a one-time code, see what it runs and has plugged in, remove it.' },
];

const SUMMARIES: Record<string, string> = {
  'GET /v1/templates': 'Every template, and whether the business has customized it',
  'GET /v1/templates/{key}': 'A template: its source (customized or the default), subject, variables and rules',
  'PUT /v1/templates/{key}': 'Save a template (checked first: 422 with the problems and their lines)',
  'DELETE /v1/templates/{key}': 'Back to the default template',
  'POST /v1/templates/{key}/preview': 'Render a draft with sample data; any problems, with their lines',
  'GET /v1/templates/{key}/versions': 'The last 30 saves',
  'GET /v1/templates/{key}/versions/{id}': "One save's source",
  'GET /v1/templates/assets': "The business's images, and which one is its logo",
  'POST /v1/templates/assets': 'Upload an image (PNG, JPEG, GIF, WebP or SVG, up to 2 MB, as Base64)',
  'DELETE /v1/templates/assets/{id}': 'Delete an image (refused while a saved template uses it)',
  'PUT /v1/templates/logo': 'Choose the logo, or none',
  'POST /v1/documents': 'Issue a document. Answers 201 whenever a document was created, whatever BTS decided: check status. A receipt paid in parts sends `tenders` (they must add up to the total).',
  'GET /v1/documents': 'List documents (filters, cursor pagination)',
  'POST /v1/documents/preview': 'Calculate totals without issuing',
  'GET /v1/documents/{id}': 'A document, its lines and (for invoices and receipts) what is left to credit',
  'GET /v1/documents/{id}/xml': 'The signed XML exactly as sent to BTS',
  'GET /v1/documents/{id}/pdf': 'The printed copy (A4/Letter sheet or thermal receipt)',
  'GET /v1/documents/{id}/view': 'The document as signed, for rendering, with its QR code',
  'POST /v1/documents/{id}/cancel': 'Cancel an authorized document with BTS (event 050)',
  'POST /v1/documents/{id}/email': 'Email the PDF and signed XML to one address',
  'GET /v1/documents/{id}/messages': 'Emails sent for a document',
  'POST /v1/documents/{id}/share': 'A link that opens the PDF without signing in (90 days); /pay/<token> is the page to pay it',
  'GET /v1/documents/{id}/payments': 'An invoice\'s balance (paid, credited, due date, status) and its payments',
  'POST /v1/documents/{id}/payments': 'Record money received against a tax invoice or debit note',
  'POST /v1/payments/{id}/void': 'Void a payment recorded by mistake (kept in the history)',
  'POST /v1/documents/{id}/remind': 'Email the customer a payment reminder now, with a pay link',
  'GET /v1/receivables': 'What customers owe: totals and the ageing by customer',
  'GET /v1/receivables/invoices': 'Open, overdue or all receivable invoices, oldest due first',
  'GET /v1/receivables/ageing.csv': 'The ageing by customer (CSV)',
  'GET /v1/receivables/statement': 'A customer\'s statement of account',
  'GET /v1/receivables/statement.pdf': 'A customer\'s statement of account (PDF)',
  'POST /v1/receivables/statement/send': 'Email a customer their statement, with pay links',
  'GET /v1/receivable-settings': 'Reminders, paying online and payment instructions',
  'GET /v1/quotes': 'Quotes (open, accepted, invoiced, all; search by customer or number)',
  'POST /v1/quotes': 'Draft a quote: the document it will issue, valid-until date, days to pay',
  'GET /v1/quotes/{id}': 'A quote with its lines and totals',
  'PUT /v1/quotes/{id}': 'Change a draft or sent quote',
  'GET /v1/quotes/{id}/pdf': 'The quote as a PDF',
  'POST /v1/quotes/{id}/send': 'Email the quote with its PDF and a link to accept it online',
  'POST /v1/quotes/{id}/link': 'A link to the quote, to share another way',
  'POST /v1/quotes/{id}/status': 'Mark a quote accepted, declined or cancelled',
  'POST /v1/quotes/{id}/invoice': 'Issue the tax invoice (or receipt) from a quote',
  'GET /v1/recurring': 'Recurring invoices',
  'POST /v1/recurring': 'Schedule a recurring invoice',
  'GET /v1/recurring/{id}': 'A recurring invoice, its next dates and the invoices it issued',
  'PUT /v1/recurring/{id}': 'Change a recurring invoice',
  'POST /v1/recurring/{id}/{action}': 'Pause, resume or end a recurring invoice',
  'POST /v1/recurring/{id}/run': 'Issue the next invoice of a schedule now',
  'GET /v1/suppliers': 'Suppliers, with what was spent and is still to pay',
  'POST /v1/suppliers': 'Add a supplier',
  'PUT /v1/suppliers/{id}': 'Change a supplier',
  'DELETE /v1/suppliers/{id}': 'Archive a supplier',
  'GET /v1/expenses': 'Expenses and bills with totals (period, paid or not, category, supplier, search)',
  'GET /v1/expenses.csv': 'Expenses (CSV)',
  'POST /v1/expenses': 'Record an expense or a bill to pay',
  'GET /v1/expenses/{id}': 'An expense',
  'PUT /v1/expenses/{id}': 'Change an expense',
  'DELETE /v1/expenses/{id}': 'Delete an expense',
  'POST /v1/expenses/{id}/pay': 'Mark a bill paid',
  'POST /v1/expenses/{id}/receipt': 'Attach the receipt (JPEG, PNG, WebP or PDF, Base64)',
  'GET /v1/expenses/{id}/receipt': 'The receipt',
  'DELETE /v1/expenses/{id}/receipt': 'Remove the receipt',
  'POST /v1/customers/{id}/account-link': 'A link to the customer\'s account page (what they owe, paying online, their invoices and statement)',
  'POST /v1/customers/{id}/account-link/send': 'Email the customer a link to their account page',
  'DELETE /v1/customers/{id}/account-links': 'Stop every account page link of a customer',
  'GET /v1/loyalty-settings': 'Loyalty points: on or off, points per BZ$1, what a point is worth, the fewest used at once',
  'PUT /v1/loyalty-settings': 'Change the loyalty points settings',
  'GET /v1/customers/{id}/loyalty': 'A customer\'s points: balance, its value, recent entries',
  'POST /v1/customers/{id}/loyalty/adjust': 'Give or take points by hand, with a note',
  'GET /v1/recurring-expenses': 'Repeating expenses (rent, internet…) and about what they come to each month',
  'POST /v1/recurring-expenses': 'Add a repeating expense (recorded on its own on schedule, as a bill or as paid)',
  'PUT /v1/recurring-expenses/{id}': 'Change, pause or resume a repeating expense',
  'DELETE /v1/recurring-expenses/{id}': 'Delete a repeating expense (what it recorded stays)',
  'GET /v1/expense-categories': 'Usual expense categories and those the business uses',
  'GET /v1/reports/gst-return': 'GST return worksheet: sales and purchases by GST treatment, what to pay (JSON or CSV)',
  'GET /v1/reports/gst-return.pdf': 'GST return worksheet (PDF)',
  'GET /v1/reports/profit': 'Profit and loss by month and by expense category',
  'GET /v1/inventory': 'Stock levels, low and out of stock, value at average cost',
  'GET /v1/inventory.csv': 'Stock levels (CSV)',
  'GET /v1/inventory/{itemId}': 'An item\'s stock and its movements',
  'POST /v1/inventory/{itemId}/adjust': 'Add, take off or set stock, with a reason',
  'PUT /v1/inventory/{itemId}/settings': 'Track an item\'s stock or stop, and its low-stock level',
  'POST /v1/inventory/count': 'A stock count: set the levels counted',
  'GET /v1/inventory/receipts': 'Stock received from suppliers',
  'POST /v1/inventory/receipts': 'Receive stock (unit costs update the average cost), optionally recording the bill as an expense; purchaseOrderId receives against an order',
  'GET /v1/timeclock/me': 'Your time clock: clocked in or not, hours today and this week',
  'POST /v1/timeclock/in': 'Clock in',
  'POST /v1/timeclock/out': 'Clock out',
  'GET /v1/timeclock': 'Hours worked by each person in a period, with every entry (JSON or CSV)',
  'PUT /v1/timeclock/{id}': 'Correct a time entry (kept in the activity log)',
  'GET /v1/held-sales': 'Sales on hold at the counter, shared by every till',
  'POST /v1/held-sales': 'Put a counter sale on hold',
  'POST /v1/held-sales/{id}/recall': 'Take a sale off hold (once)',
  'DELETE /v1/held-sales/{id}': 'Delete a held sale',
  'GET /v1/suppliers/{id}/summary': 'A supplier at a glance: spending, bills to pay, open orders, deliveries, items bought from them',
  'GET /v1/purchase-orders': 'Purchase orders (open, received, cancelled; search by supplier or number)',
  'POST /v1/purchase-orders': 'Order from a supplier (costs default to the last delivery\'s)',
  'GET /v1/purchase-orders/suggestions': 'Items to reorder: at or below their low-stock level, with a quantity for about four weeks of sales',
  'GET /v1/purchase-orders/{id}': 'A purchase order with its lines and deliveries',
  'PUT /v1/purchase-orders/{id}': 'Change a purchase order until something is received',
  'POST /v1/purchase-orders/{id}/send': 'Email the order to the supplier with its PDF, or mark it sent',
  'POST /v1/purchase-orders/{id}/cancel': 'Cancel an order, or close a part-received one',
  'GET /v1/purchase-orders/{id}/pdf': 'The purchase order (PDF)',
  'GET /v1/registers': 'Cash registers (drawers) and who has each open',
  'POST /v1/registers': 'Add a cash register',
  'PUT /v1/registers/{id}': 'Rename a cash register',
  'DELETE /v1/registers/{id}': 'Archive a cash register with no open shift',
  'GET /v1/shifts': 'Register shifts (managers see everyone\'s, cashiers their own)',
  'POST /v1/shifts': 'Open a shift on a register with the opening float',
  'GET /v1/shifts/current': 'Your open shift and its report so far (an X report)',
  'GET /v1/shifts/{id}': 'A shift and its report',
  'POST /v1/shifts/{id}/cash': 'Put cash into or take cash out of the drawer, with a reason',
  'POST /v1/shifts/{id}/close': 'Close a shift with the counted cash (optionally by notes and coins)',
  'GET /v1/shifts/{id}/report.pdf': 'The end-of-day (Z) report, for the receipt printer or A4',
  'GET /v1/pos/devices': 'Tills: waiting to pair or paired, last seen, open shift, who is signed in, the hardware they report',
  'POST /v1/pos/devices': 'Add a till (with its own cash drawer) and get a one-time pairing code',
  'POST /v1/pos/devices/{id}/code': 'A new pairing code for a till (pairing again replaces its token)',
  'PATCH /v1/pos/devices/{id}': 'Rename a till or move it to another cash drawer',
  'DELETE /v1/pos/devices/{id}': 'Remove a till: its token and everyone signed in on it stop working',
  'PUT /v1/users/{id}/pin': 'Set someone\'s PIN for signing in on tills',
  'DELETE /v1/users/{id}/pin': 'Remove someone\'s till PIN',
  'PUT /v1/me/pin': 'Set your own till PIN',
  'DELETE /v1/me/pin': 'Remove your own till PIN',
  'GET /v1/bill-payments': 'Belize Bank bill payments: set up or not, the addresses for the bank, payments to apply by hand',
  'POST /v1/bill-payments': 'Turn on Belize Bank bill payments, or issue a new token (shown once)',
  'PUT /v1/bill-payments': 'Change the invoice number field, or turn bill payments off',
  'PUT /v1/receivable-settings': 'Change reminders, paying online and payment instructions',
  'GET /v1/customers': 'List and search saved customers',
  'POST /v1/customers': 'Save a customer',
  'GET /v1/customers/{id}': 'A customer',
  'PUT /v1/customers/{id}': 'Replace a customer\'s details',
  'DELETE /v1/customers/{id}': 'Archive a customer',
  'GET /v1/items': 'List and search catalog items (q, barcode code, favorites, category)',
  'GET /v1/items/price-list.pdf': 'The price list as a PDF, by category (retail or wholesale, with or without GST)',
  'GET /v1/items/{id}/summary': 'An item at a glance: sales by period and month, margin, stock and days of cover, suppliers and costs',
  'GET /v1/items/categories': 'Item categories in use, with how many items each has',
  'POST /v1/items/reprice': 'Change many prices at once (by percent, by amount, or to a price; a category or every item; dryRun to preview)',
  'POST /v1/items': 'Add a catalog item',
  'GET /v1/items/{id}': 'An item',
  'PUT /v1/items/{id}': 'Replace an item',
  'DELETE /v1/items/{id}': 'Archive an item (frees its barcode)',
  'GET /v1/reports/summary': 'Totals, GST by rate, by type and by day',
  'GET /v1/reports/customers': 'Sales by customer',
  'GET /v1/reports/items': 'Sales by item',
  'POST /v1/items/import': 'Import items from CSV (dryRun to check first); matched by code, then barcode',
  'POST /v1/customers/import': 'Import customers from CSV (dryRun to check first); matched by TIN, then email',
  'GET /v1/reports/staff': 'Sales by person: documents, total, discounts given, average receipt',
  'GET /v1/reports/categories': 'Sales by item category',
  'GET /v1/reports/margins': 'Gross margin by category or item: sales before GST against cost when sold',
  'GET /v1/reports/hours': 'Sales by hour of the day (Belize time)',
  'PUT /v1/business/daily-summary': 'Turn the morning summary email to owners and admins on or off',
  'GET /v1/reports/documents': 'The document register (CSV)',
  'GET /v1/reports/archive': 'Everything for a period as one ZIP: signed XML, BTS replies, events, register, PDFs',
  'GET /v1/orders': 'List online orders',
  'GET /v1/orders/{id}': 'An order with its lines, document and refunds',
  'POST /v1/orders/{id}/paid': 'Payment received: issues the BTS receipt or invoice and emails it',
  'POST /v1/orders/{id}/fulfilled': 'Delivered or picked up',
  'POST /v1/orders/{id}/cancel': 'Cancel an unpaid order (stock goes back)',
  'POST /v1/orders/{id}/refund': 'Refund a paid order, all or some lines: a credit note',
  'GET /v1/me': 'The business, its certificate, contingency state and plan',
  'PUT /v1/certificate': 'Install or renew the BTS certificate (PEM)',
  'POST /v1/certificate/pfx': 'Install or renew the BTS certificate (.pfx)',
  'GET /v1/webhooks': 'Webhook endpoints and the event types on offer',
  'POST /v1/webhooks': 'Add an endpoint; the signing secret is shown once',
  'PATCH /v1/webhooks/{id}': 'Change an endpoint, or switch it on or off',
  'DELETE /v1/webhooks/{id}': 'Remove an endpoint',
  'POST /v1/webhooks/{id}/rotate-secret': 'A new signing secret (shown once)',
  'POST /v1/webhooks/{id}/test': 'Send a ping now and report the answer',
  'GET /v1/webhooks/{id}/deliveries': 'The last 50 deliveries',
  'POST /v1/webhooks/deliveries/{id}/retry': 'Send a failed delivery again',
};

const DESCRIPTION = `Sell from your own site with a Floreo store, and issue Belize electronic tax documents (BTS e-invoicing) from your own systems.

## Authentication
There are two kinds of keys, both made in Settings → Developers and both sent as \`Authorization: Bearer …\`.

A publishable key (\`pk_test_…\` or \`pk_live_…\`) is for web pages. It opens only the store API (\`/v1/store/{store}/…\`), which is what buyers see anyway, and only from the sites on the key's list; a test key also works from any page on your own computer. It is safe to show. On a GET it may go in the address instead (\`?key=pk_…\`), which spares the browser a second request.

A secret key (\`etd_…\`) is for servers and your own software. It acts as the business (orders, products, documents, reports), so it must never be put in a page or in code others can read; a secret key sent from a page is refused. Every request with a key acts for the business the key belongs to.

## Limiting a secret key
When you make a secret key you may give it less than everything, so that a program holds only what it needs. Read only: it may GET, and may not change anything (a 403 \`key_read_only\` otherwise; working something out, such as \`POST /v1/documents/preview\`, counts as reading). Some parts only: ${KEY_AREAS.map((a) => `\`${a}\` (${AREA_NAMES[a]}: ${AREA_COVERS[a].toLowerCase()})`).join('; ')}; anything outside them answers 403 \`key_scope\` and names the part it needs. A last day: after it the key answers 401 \`api_key_expired\`. Each endpoint below says which part it belongs to. \`GET /v1/me\` always answers, and with a key says what that key may do (\`apiKey\`). A key keeps the limits it was made with: to change them, make another key and revoke the old one. A key made without limits does everything and does not end.

Calls to the store API from a server (no \`Origin\` header) need no key.

## Money and quantities
Decimal strings, never numbers: \`"24.99"\`, \`"2"\`. Totals come from the same calculation BTS checks, to the cent.

## Test and live
A business is in test mode or live, as a whole. A new business starts in test mode: documents go to the BTS test environment and have no fiscal value, and the store can take test payments (a pretend card page, no money moves). Keys say which they are for: \`pk_test_…\` works only while the store is in test mode, \`pk_live_…\` only once it is live, and each is refused on the other with the reason. Store answers carry \`"test": true\` in test mode. To keep trying things after going live, use a second business that stays in test mode.

## Errors
Always \`{ "error": { "code", "message", "details"? } }\`. The message says what is wrong and what to do; show it to the person building the site, and to buyers when the status is 409 or 422 (sold out, a code that does not apply). 400 the request does not fit (the message names the field), 401 no key or a wrong one, 402 your plan's limit,
403 not allowed, 404 not found, 409 wrong state, 422 it cannot be done as asked (an order, or a document BTS would refuse; the message names the rule), 429 too many requests.

## Pagination
Lists answer \`{ "data": [...], "nextCursor": "…" | null }\`. Send \`limit\`, and to get the next page send the \`nextCursor\` you were given as \`cursor\`, unchanged. \`null\` means there is no more.

## Idempotency
Send \`Idempotency-Key: <unique per sale>\` when issuing a document or placing a store order. A retry with the same key and body returns the original answer (\`Idempotent-Replayed: true\`) and never issues or orders twice.

## Rate limits
A secret key: 600 requests a minute by default. A publishable key: 300 a minute from each visitor. Every answer carries \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\`; over the limit you get 429 with \`Retry-After\`. Placing orders, gift card codes and messages have their own limits per visitor.

## Webhooks
Events: ${WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(', ')}.
Each delivery is a JSON POST \`{ id, type, createdAt, data }\` signed with your endpoint's secret:
\`X-Floreo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">\`.
Check the signature and that \`t\` is recent, answer 2xx within 10 seconds, and handle the same \`id\` twice gracefully. Failed deliveries are retried after 1 minute, 5 minutes, 30 minutes, 2, 6 and 12 hours; an endpoint that fails 20 in a row is switched off. Each delivery, with what was sent and what your endpoint answered, is in Settings → Developers → Webhooks. A test delivery carries \`"test": true\`.

An endpoint must be on the internet over https. While you build, point it at a tunnel to your own computer.
`;

export function routeCollector() {
  const routes: CollectedRoute[] = [];
  return {
    routes,
    onRoute: (r: RouteOptions) => {
      for (const method of ([] as string[]).concat(r.method as string | string[])) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        routes.push({ method, url: r.url, schema: r.schema as CollectedRoute['schema'] });
      }
    },
  };
}

const toOpenApiPath = (url: string) => url.replace(/:([A-Za-z_]+)/g, '{$1}');
const tagOf = (path: string) => (path.startsWith('/v1/store/') ? (hostedOnly(path) ? HOSTED : STOREFRONT) : TAGS.find((t) => path === t.prefix || path.startsWith(`${t.prefix}/`)));

function parameters(schema: Schema | undefined, where: 'path' | 'query') {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties)
    .filter(([name]) => !(where === 'query' && name === 'b'))
    .map(([name, s]) => ({ name, in: where, required: where === 'path' || Boolean(schema.required?.includes(name)), schema: s }));
}

export function buildOpenApi(routes: CollectedRoute[], options: { serverUrl?: string } = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = toOpenApiPath(r.url);
    const tag = tagOf(path);
    if (!tag) continue;
    const key = `${r.method} ${path}`;
    const store = path.startsWith('/v1/store/');
    const example = STORE_EXAMPLES[key];
    const created = r.method === 'POST' && (path === '/v1/documents' || path === '/v1/customers' || path === '/v1/items' || path === '/v1/webhooks' || path === '/v1/store/{slug}/orders');
    const op: Record<string, unknown> = {
      tags: [tag.name],
      summary: SUMMARIES[key] ?? STORE_SUMMARIES[key] ?? `${r.method} ${path}`,
      operationId: key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      parameters: [...parameters(r.schema?.params, 'path'), ...parameters(r.schema?.querystring, 'query')],
      responses: {
        [created ? '201' : '200']: { description: 'Success', ...(example !== undefined && { content: { 'application/json': { example } } }) },
        default: { description: 'An error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    // The store API is public: no key from a server, the store's publishable key from a page on another site.
    if (store) op.security = [{}, { publishableKey: [] }];
    // The part of the API a limited secret key must include to use this endpoint, and whether a read-only key may.
    const area = store ? undefined : areaOfRoute(r.url);
    if (area && area !== 'people') {
      op['x-key-area'] = area;
      op['x-key-read-only'] = readOnlyMayUse(r.method, r.url);
    }
    if (r.schema?.body) op.requestBody = { required: true, content: { 'application/json': { schema: r.schema.body, ...(STORE_REQUESTS[key] !== undefined && { example: STORE_REQUESTS[key] }) } } };
    if (key === 'POST /v1/documents' || key === 'POST /v1/store/{slug}/orders') {
      (op.parameters as unknown[]).push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Unique per sale; a retry returns the original answer.' });
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  const tags = [STOREFRONT, ...new Map(TAGS.filter((t) => t.description).map((t) => [t.name, { name: t.name, description: t.description }])).values(), HOSTED];
  // The store API first, in the order a storefront uses it (as store-reference.ts lists it); the hosted pages' own endpoints last.
  const storeOrder = [...new Set(Object.keys(STORE_SUMMARIES).map((k) => k.split(' ')[1]!))];
  const order = (path: string) => (path.startsWith('/v1/store/')
    ? (hostedOnly(path) ? 1000 : -1000) + storeOrder.indexOf(path)
    : TAGS.findIndex((t) => path === t.prefix || path.startsWith(`${t.prefix}/`)));
  return {
    openapi: '3.1.0',
    info: { title: 'Floreo API', version: '1.0', description: DESCRIPTION },
    servers: [{ url: options.serverUrl ?? '/' }],
    security: [{ apiKey: [] }],
    tags,
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))),
    // What each webhook event carries (OpenAPI 3.1's own place for it).
    webhooks: Object.fromEntries(WEBHOOK_EVENTS.map((type) => [type, {
      post: {
        summary: type,
        requestBody: { content: { 'application/json': { example: { id: '3f6c1d1e-7a2b-4c5d-8e9f-0a1b2c3d4e5f', type, createdAt: '2026-11-24T16:07:02.511Z', data: SAMPLE_EVENT_DATA[type] } } } },
        responses: { '200': { description: 'Any 2xx within 10 seconds means delivered' } },
      },
    }])),
    // Every error code of the store API: its status and what to do about it.
    'x-store-errors': STORE_ERRORS,
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'A secret key from Settings → Developers: etd_<prefix>_<secret>. For servers; never in a page.' },
        publishableKey: { type: 'http', scheme: 'bearer', description: 'A publishable key from Settings → Developers: pk_test_… or pk_live_…. For pages on the sites listed on the key; on a GET it may be sent as ?key= instead.' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
      },
    },
  };
}
