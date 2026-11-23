/**
 * The public API's OpenAPI 3.1 description, built from the routes' own
 * validation schemas (so it can never drift from what the server accepts),
 * served at GET /v1/openapi.json. The web app renders it at /docs.
 */

import type { RouteOptions } from 'fastify';
import { WEBHOOK_EVENTS } from '../webhooks/webhooks.ts';

interface CollectedRoute {
  method: string;
  url: string;
  schema: { params?: Schema; querystring?: Schema; body?: Schema } | undefined;
}
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: readonly string[]; [k: string]: unknown };

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
  'POST /v1/inventory/receipts': 'Receive stock (unit costs update the average cost), optionally recording the bill as an expense',
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
  'GET /v1/items': 'List and search catalog items (q, barcode code, favorites)',
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

const DESCRIPTION = `Issue Belize electronic tax documents (BTS e-invoicing) from your own systems.

## Authentication
Create an API key in the web app (Settings → API keys) and send it as \`Authorization: Bearer etd_…\`.
The key belongs to one business; every request acts for that business.

## Money and quantities
Decimal strings, never numbers: \`"24.99"\`, \`"2"\`. Totals come from the same calculation BTS checks, to the cent.

## Errors
Always \`{ "error": { "code", "message", "details"? } }\`. 400 malformed request, 401 bad key, 402 your plan's limit,
403 not allowed, 404 not found, 409 wrong state, 422 a document BTS would refuse (the message names the rule), 429 too many requests.

## Idempotency
Send \`Idempotency-Key: <unique per sale>\` when issuing. A retry returns the original answer (\`Idempotent-Replayed: true\`) and never issues twice.

## Rate limits
600 requests a minute per key by default. Every answer carries \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\`; over the limit you get 429 with \`Retry-After\`.

## Webhooks
Events: ${WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(', ')}.
Each delivery is a JSON POST \`{ id, type, createdAt, data }\` signed with your endpoint's secret:
\`X-EInvoicing-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">\`.
Check the signature and that \`t\` is recent, answer 2xx within 10 seconds, and handle the same \`id\` twice gracefully. Failed deliveries are retried for about a day.
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

function parameters(schema: Schema | undefined, where: 'path' | 'query') {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties)
    .filter(([name]) => !(where === 'query' && name === 'b'))
    .map(([name, s]) => ({ name, in: where, required: where === 'path' || Boolean(schema.required?.includes(name)), schema: s }));
}

export function buildOpenApi(routes: CollectedRoute[], options: { serverUrl?: string } = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const tag = TAGS.find((t) => r.url === t.prefix || r.url.startsWith(`${t.prefix}/`));
    if (!tag) continue;
    const path = toOpenApiPath(r.url);
    const key = `${r.method} ${path}`;
    const op: Record<string, unknown> = {
      tags: [tag.name],
      summary: SUMMARIES[key] ?? `${r.method} ${path}`,
      operationId: key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      parameters: [...parameters(r.schema?.params, 'path'), ...parameters(r.schema?.querystring, 'query')],
      responses: {
        [r.method === 'POST' && (path === '/v1/documents' || path === '/v1/customers' || path === '/v1/items' || path === '/v1/webhooks') ? '201' : '200']: { description: 'Success' },
        default: { description: 'An error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    if (r.schema?.body) op.requestBody = { required: true, content: { 'application/json': { schema: r.schema.body } } };
    if (key === 'POST /v1/documents') {
      (op.parameters as unknown[]).push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Unique per sale; a retry returns the original answer.' });
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  const tags = [...new Map(TAGS.filter((t) => t.description).map((t) => [t.name, { name: t.name, description: t.description }])).values()];
  return {
    openapi: '3.1.0',
    info: { title: 'eInvoicing API', version: '1.0', description: DESCRIPTION },
    servers: [{ url: options.serverUrl ?? '/' }],
    security: [{ apiKey: [] }],
    tags,
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => {
      const ta = TAGS.findIndex((t) => a.startsWith(t.prefix));
      const tb = TAGS.findIndex((t) => b.startsWith(t.prefix));
      return ta - tb || a.localeCompare(b);
    })),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'An API key from Settings → API keys: etd_<prefix>_<secret>' } },
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
