/**
 * Purchase orders: suggestions from low stock, ordering, sending to the supplier, receiving in
 * deliveries (stock and the order's progress), editing rules and cancelling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('purchase orders: suggest, order, send, receive in parts, and close', async () => {
  const f = await setupPipeline();
  const mailer = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, mailer, publicUrl: 'https://app.example.test' });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const login = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } })), 'x-business': slug });
    const owner = await login('olive@biz.example');
    const cashier = await login('cass@biz.example');
    const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = owner) => app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });

    const item = async (name: string, unitPrice: string) => (await call('POST', '/v1/items', { name, unitCode: 'H87', unitPrice, gstCategory: 'S' })).json() as { id: string };
    const beans = await item('Coffee beans 1lb', '22.00');
    const cups = await item('Paper cups (50)', '9.00');
    const sugar = await item('Sugar 4 lb', '6.00');
    const supplier = (await call('POST', '/v1/suppliers', { name: 'Bze Wholesale Ltd.', tin: '654321', email: 'orders@wholesale.example' })).json() as { id: string };
    assert.ok(supplier.id);

    // Stock from this supplier earlier; then levels to warn at.
    const first = await call('POST', '/v1/inventory/receipts', { supplierId: supplier.id, receivedOn: belizeToday(), lines: [{ itemId: beans.id, quantity: '10', unitCost: '12.50' }, { itemId: cups.id, quantity: '4', unitCost: '6.00' }] });
    assert.equal(first.statusCode, 201, first.body);
    await call('PUT', `/v1/inventory/${beans.id}/settings`, { track: true, lowStock: '12' });
    await call('PUT', `/v1/inventory/${cups.id}/settings`, { track: true, lowStock: '2' });
    await call('PUT', `/v1/inventory/${sugar.id}/settings`, { track: true, quantity: '0' });

    // Suggestions: beans (10 ≤ 12) and sugar (0, no level) need ordering; cups (4 > 2) do not.
    const sug = (await call('GET', '/v1/purchase-orders/suggestions')).json().data as Array<{ itemId: string; quantity: string; unitCost: string | null; supplier: { id: string } | null }>;
    assert.deepEqual(sug.map((s) => s.itemId).sort(), [beans.id, sugar.id].sort());
    const beanSug = sug.find((s) => s.itemId === beans.id)!;
    assert.equal(beanSug.quantity, '14'); // up to twice the level: 24 − 10
    assert.equal(beanSug.unitCost, '12.50');
    assert.equal(beanSug.supplier?.id, supplier.id);
    const bySupplier = (await call('GET', `/v1/purchase-orders/suggestions?supplierId=${supplier.id}`)).json().data as unknown[];
    assert.equal(bySupplier.length, 1);
    // Cashiers neither see nor order.
    assert.equal((await call('GET', '/v1/purchase-orders', undefined, cashier)).statusCode, 403);

    // An order: the cost is filled in from the last delivery when left out.
    const created = await call('POST', '/v1/purchase-orders', { supplierId: supplier.id, expectedOn: '2099-01-10', lines: [{ itemId: beans.id, quantity: '14' }, { itemId: sugar.id, quantity: '6', unitCost: '3.25' }] });
    assert.equal(created.statusCode, 201, created.body);
    const po = created.json();
    assert.equal(po.number, 'PO-1');
    assert.equal(po.status, 'draft');
    assert.equal(po.supplier.email, 'orders@wholesale.example');
    assert.deepEqual(po.lines.map((l: { unitCost: string; total: string }) => [l.unitCost, l.total]), [['12.50', '175.00'], ['3.25', '19.50']]);
    assert.equal(po.total, '194.50');
    assert.equal((await call('POST', '/v1/purchase-orders', { supplierName: 'X', lines: [{ itemId: beans.id, quantity: '1' }, { itemId: beans.id, quantity: '2' }] })).statusCode, 422);

    // What is on order counts: beans no longer need ordering.
    const after = (await call('GET', '/v1/purchase-orders/suggestions')).json().data as Array<{ itemId: string }>;
    assert.deepEqual(after.map((s) => s.itemId), []);

    // Edited while a draft.
    const edited = await call('PUT', `/v1/purchase-orders/${po.id}`, { supplierId: supplier.id, expectedOn: '2099-01-10', note: 'Morning delivery', lines: [{ itemId: beans.id, quantity: '20', unitCost: '12.50' }, { itemId: sugar.id, quantity: '6', unitCost: '3.25' }] });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().total, '269.50');

    // Sent by email with the PDF.
    const sent = await call('POST', `/v1/purchase-orders/${po.id}/send`, { message: 'Thanks!' });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().status, 'sent');
    const mail = mailer.sent.at(-1)!;
    assert.equal(mail.to, 'orders@wholesale.example');
    assert.match(mail.subject, /Purchase order PO-1/);
    assert.match(mail.text, /Coffee beans 1lb/);
    assert.equal(mail.attachments?.[0]?.filename, 'PO-1.pdf');
    assert.ok(Buffer.from(mail.attachments?.[0]?.content ?? '').subarray(0, 5).toString().startsWith('%PDF'));
    const pdf = await call('GET', `/v1/purchase-orders/${po.id}/pdf`);
    assert.equal(pdf.headers['content-type'], 'application/pdf');

    // The first delivery: part of the beans. The receipt takes the order's number as its reference.
    const d1 = await call('POST', '/v1/inventory/receipts', { purchaseOrderId: po.id, receivedOn: belizeToday(), lines: [{ itemId: beans.id, quantity: '12', unitCost: '12.50' }] });
    assert.equal(d1.statusCode, 201, d1.body);
    let view = (await call('GET', `/v1/purchase-orders/${po.id}`)).json();
    assert.equal(view.status, 'partial');
    assert.deepEqual(view.lines.map((l: { received: string; remaining: string }) => [l.received, l.remaining]), [['12', '8'], ['0', '6']]);
    assert.deepEqual(view.receipts.map((r: { reference: string; totalCost: string }) => [r.reference, r.totalCost]), [['PO-1', '150.00']]);
    const stock = (await call('GET', `/v1/inventory/${beans.id}`)).json();
    assert.equal(Number(stock.item?.stock ?? stock.stock), 22);
    // Part of it has come: no more changes.
    assert.equal((await call('PUT', `/v1/purchase-orders/${po.id}`, { supplierId: supplier.id, lines: [{ itemId: beans.id, quantity: '1' }] })).statusCode, 409);

    // The rest arrives, with the bill.
    const d2 = await call('POST', '/v1/inventory/receipts', { purchaseOrderId: po.id, receivedOn: belizeToday(), reference: 'INV-889', lines: [{ itemId: beans.id, quantity: '8', unitCost: '12.50' }, { itemId: sugar.id, quantity: '6', unitCost: '3.25' }], expense: { gstTreatment: 'standard', paid: null, dueDate: '2099-02-01' } });
    assert.equal(d2.statusCode, 201, d2.body);
    view = (await call('GET', `/v1/purchase-orders/${po.id}`)).json();
    assert.equal(view.status, 'received');
    assert.equal(view.receipts.length, 2);
    const bill = (await f.db.query<{ supplier_name: string; supplier_tin: string | null; reference: string }>('select supplier_name, supplier_tin, reference from expenses where id = $1', [d2.json().expenseId])).rows[0]!;
    assert.deepEqual(bill, { supplier_name: 'Bze Wholesale Ltd.', supplier_tin: '654321', reference: 'INV-889' });
    // Nothing more against a received order.
    assert.equal((await call('POST', '/v1/inventory/receipts', { purchaseOrderId: po.id, receivedOn: belizeToday(), lines: [{ itemId: beans.id, quantity: '1', unitCost: '12.50' }] })).statusCode, 409);

    // A second order, marked sent by phone, part-received, then closed short.
    const po2 = (await call('POST', '/v1/purchase-orders', { supplierName: 'Corner Supplies', lines: [{ itemId: cups.id, quantity: '10', unitCost: '6.00' }] })).json();
    assert.equal(po2.number, 'PO-2');
    assert.equal((await call('POST', `/v1/purchase-orders/${po2.id}/send`, { email: true })).statusCode, 422); // no email for this supplier
    const marked = (await call('POST', `/v1/purchase-orders/${po2.id}/send`, { email: false })).json();
    assert.equal(marked.status, 'sent');
    await call('POST', '/v1/inventory/receipts', { purchaseOrderId: po2.id, receivedOn: belizeToday(), lines: [{ itemId: cups.id, quantity: '4', unitCost: '6.00' }] });
    const closed = (await call('POST', `/v1/purchase-orders/${po2.id}/cancel`)).json();
    assert.equal(closed.status, 'cancelled');
    assert.equal((await call('POST', `/v1/purchase-orders/${po2.id}/cancel`)).statusCode, 409);

    const open = (await call('GET', '/v1/purchase-orders?status=open')).json().data;
    assert.equal(open.length, 0);
    const all = (await call('GET', '/v1/purchase-orders?q=po-2')).json().data as Array<{ number: string; progress: number }>;
    assert.deepEqual(all.map((p) => [p.number, p.progress]), [['PO-2', 0.4]]);
    // The supplier's page: the unpaid bill, deliveries, and what was bought with its last cost.
    const sum = (await call('GET', `/v1/suppliers/${supplier.id}/summary`)).json();
    assert.equal(sum.supplier.name, 'Bze Wholesale Ltd.');
    assert.equal(sum.owed.total, '134.44'); // (8 × 12.50 + 6 × 3.25) + 12.5% GST
    assert.equal(sum.orders.length, 0);
    assert.equal(sum.deliveries.length, 3);
    assert.deepEqual(sum.items.map((i: { name: string; lastCost: string; received: string }) => [i.name, i.lastCost, i.received]), [['Coffee beans 1lb', '12.50', '30'], ['Paper cups (50)', '6.00', '4'], ['Sugar 4 lb', '3.25', '6']]);
    assert.equal((await call('GET', `/v1/suppliers/${supplier.id}/summary`, undefined, cashier)).statusCode, 403);

    const logged = (await f.db.query<{ action: string }>(`select action from audit_events where tenant_id = $1 and action like 'purchase_order.%' order by id`, [f.tenantA])).rows.map((r) => r.action);
    assert.deepEqual(logged, ['purchase_order.created', 'purchase_order.sent', 'purchase_order.created', 'purchase_order.sent', 'purchase_order.closed']);
  } finally {
    await app.close();
    await f.close();
  }
});
