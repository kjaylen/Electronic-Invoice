/**
 * Webhook events about the store's products, stock and failed payments
 * (raised by the code that makes the change), the delivery log in full, and
 * test deliveries of any event's sample.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/api/app.ts';
import { getSubscription } from '../src/billing/billing.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { SAMPLE_EVENT_DATA } from '../src/webhooks/samples.ts';
import { dispatchWebhooks, verifySignature, WEBHOOK_EVENTS } from '../src/webhooks/webhooks.ts';
import { setupPipeline } from './pipeline-setup.ts';

interface Event {
  id: string;
  type: string;
  createdAt: string;
  test?: boolean;
  data: Record<string, any>;
}

/** A local endpoint that records what it gets. */
async function receiver() {
  const got: Array<{ headers: IncomingMessage['headers']; body: string; event: Event }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body, event: JSON.parse(body) });
      res.writeHead(200).end('thanks, noted');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The names of an answer's fields, all the way down (a list by its first item), to compare a sample with the real thing. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return null;
}

test('every event type has a sample, and the samples are listed with the events', async () => {
  assert.deepEqual(Object.keys(SAMPLE_EVENT_DATA).sort(), [...WEBHOOK_EVENTS].sort());
  for (const type of ['order.payment_failed', 'stock.changed', 'product.created', 'product.updated', 'product.deleted'] as const) assert.ok(WEBHOOK_EVENTS.includes(type), type);
});

test('webhooks: products, stock and failed payments; one delivery in full; a test delivery of any event', async () => {
  const f = await setupPipeline();
  const hook = await receiver();
  const app = await buildApp({ pipeline: f.deps, webhooksAllowPrivate: true, publicUrl: 'https://app.example.test' });
  const send = () => dispatchWebhooks(f.db, { keys: f.deps.keys, allowPrivate: true });
  const since = (n: number) => hook.got.slice(n).map((g) => g.event);
  try {
    const h = { authorization: `Bearer ${(await createApiKey(f.db, f.tenantA, 'site')).key}` };
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await getSubscription(f.db, f.tenantA);
    await f.db.query("update subscriptions set plan = 'pro' where tenant_id = $1", [f.tenantA]);
    const made = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: h, payload: { url: hook.url, events: ['*'] } });
    assert.equal(made.statusCode, 201, made.body);
    const { id: endpointId, secret } = made.json();

    // A product is made: one event with the product as the API answers it, one per variant whose stock started being counted.
    const product = (await app.inject({ method: 'POST', url: '/v1/products', headers: h, payload: { title: 'Island T-shirt', status: 'active', option1Name: 'Size', tags: ['clothing'], variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', sellerCode: 'TEE-S', stock: 5 }, { option1: 'M', price: '40.00', gstCategory: 'S' }] } })).json();
    const [s, m] = product.variants as Array<{ id: string }>;
    await send();
    let events = since(0);
    assert.deepEqual(events.map((e) => e.type).sort(), ['product.created', 'stock.changed']);
    const created = events.find((e) => e.type === 'product.created')!;
    assert.deepEqual(created.data.product, (await app.inject({ method: 'GET', url: `/v1/products/${product.id}`, headers: h })).json(), 'the same as GET /v1/products/:id');
    assert.deepEqual(shape(created.data), shape({ product: { ...(SAMPLE_EVENT_DATA['product.created'].product as object), images: [] } }), 'the sample has the same fields');
    const stock = events.find((e) => e.type === 'stock.changed')!;
    assert.deepEqual(stock.data.item, { id: s!.id, name: 'Island T-shirt – S', code: 'TEE-S', quantity: '5', available: true, lowStock: false, product: { id: product.id, handle: 'island-t-shirt' } });
    assert.deepEqual(shape(stock.data), shape(SAMPLE_EVENT_DATA['stock.changed']));
    assert.ok(verifySignature(secret, String(hook.got[0]!.headers['x-floreo-signature']), hook.got[0]!.body));

    // Changed twice and counted three times before the next run: one event each, saying how it is now.
    let at = hook.got.length;
    for (const title of ['Island Tee', 'Island T-shirt']) {
      assert.equal((await app.inject({ method: 'PUT', url: `/v1/products/${product.id}`, headers: h, payload: { title, status: 'active', option1Name: 'Size', variants: [{ id: s!.id, option1: 'S', price: '42.00', gstCategory: 'S', sellerCode: 'TEE-S', stock: 5 }, { id: m!.id, option1: 'M', price: '42.00', gstCategory: 'S' }] } })).statusCode, 200);
    }
    for (const quantity of ['9', '7', '2']) assert.equal((await app.inject({ method: 'POST', url: `/v1/inventory/${s!.id}/adjust`, headers: h, payload: { mode: 'set', quantity, reason: 'count' } })).statusCode, 200);
    await send();
    events = since(at);
    assert.deepEqual(events.map((e) => e.type).sort(), ['product.updated', 'stock.changed']);
    assert.equal(events.find((e) => e.type === 'product.updated')!.data.product.variants[0].price, '42.00');
    assert.equal(events.find((e) => e.type === 'stock.changed')!.data.item.quantity, '2');

    // An order from the store takes stock: the order, and the level that is left.
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/store-settings', headers: h, payload: { enabled: true, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: 'x' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true }, online: { enabled: true, provider: 'test' } } } })).statusCode, 200);
    at = hook.got.length;
    const order = { lines: [{ variantId: s!.id, quantity: 2 }], fulfillment: 'pickup', paymentMethod: 'online', customer: { name: 'Ana Buyer', phone: '+501 610-0000' } };
    const placed = (await app.inject({ method: 'POST', url: `/v1/store/${slug}/orders`, payload: order })).json();
    await send();
    events = since(at);
    assert.deepEqual(events.map((e) => e.type).sort(), ['order.placed', 'stock.changed']);
    assert.equal(events.find((e) => e.type === 'stock.changed')!.data.item.quantity, '0');
    assert.equal(events.find((e) => e.type === 'stock.changed')!.data.item.available, false);
    assert.deepEqual(shape(events.find((e) => e.type === 'order.placed')!.data), shape(SAMPLE_EVENT_DATA['order.placed']));

    // The card is declined: the business's systems are told, once, with the reason.
    at = hook.got.length;
    await app.inject({ method: 'POST', url: `/v1/store/${slug}/test-payments/${placed.payment.paymentId}`, payload: { decision: 'declined' } });
    const confirm = () => app.inject({ method: 'POST', url: `/v1/store/${slug}/orders/${placed.number}/payments/${placed.payment.paymentId}/confirm?t=${placed.token}` });
    assert.equal((await confirm()).json().status, 'failed');
    assert.equal((await confirm()).json().status, 'failed', 'asked again');
    await send();
    events = since(at);
    assert.deepEqual(events.map((e) => e.type), ['order.payment_failed']);
    assert.equal(events[0]!.data.order.number, placed.number);
    assert.equal(events[0]!.data.order.paymentStatus, 'unpaid');
    assert.deepEqual({ ...events[0]!.data.payment, createdAt: null }, { id: placed.payment.paymentId, provider: 'test', status: 'failed', reason: 'The test card was declined', amount: '94.50', createdAt: null });
    assert.deepEqual(shape(events[0]!.data), shape(SAMPLE_EVENT_DATA['order.payment_failed']));

    // Archived: the last word about the product.
    at = hook.got.length;
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/products/${product.id}`, headers: h })).statusCode, 204);
    await send();
    events = since(at);
    assert.deepEqual(events.map((e) => e.type), ['product.deleted']);
    assert.equal(events[0]!.data.product.status, 'archived');

    // One delivery in full: the body exactly as sent, and what the endpoint answered.
    const list = (await app.inject({ method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries?type=order.payment_failed`, headers: h })).json().data;
    assert.equal(list.length, 1);
    const detail = (await app.inject({ method: 'GET', url: `/v1/webhooks/deliveries/${list[0].id}`, headers: h })).json();
    const sent = hook.got.find((g) => g.event.id === list[0].id)!;
    assert.deepEqual(detail.body, sent.event);
    assert.equal(JSON.stringify(detail.body), sent.body, 'byte for byte what was signed');
    assert.equal(detail.endpointId, endpointId);
    assert.equal(detail.status, 'delivered');
    assert.equal(detail.responseStatus, 200);
    assert.equal(detail.responseBody, 'thanks, noted');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries?status=failed`, headers: h })).json().data.length, 0);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries?status=lost`, headers: h })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/webhooks/deliveries/00000000-0000-4000-8000-000000000000', headers: h })).statusCode, 404);
    // Another business cannot read it.
    const other = { authorization: `Bearer ${(await createApiKey(f.db, f.tenantB, 'other')).key}` };
    assert.equal((await app.inject({ method: 'GET', url: `/v1/webhooks/deliveries/${list[0].id}`, headers: other })).statusCode, 404);

    // The events on offer, each with a sample; a test delivery sends one, signed like any other and marked as a test.
    const catalog = (await app.inject({ method: 'GET', url: '/v1/webhooks/events', headers: h })).json().data;
    assert.deepEqual(catalog.map((e: { type: string }) => e.type), [...WEBHOOK_EVENTS]);
    assert.deepEqual(catalog.find((e: { type: string }) => e.type === 'order.paid').sample.data, SAMPLE_EVENT_DATA['order.paid']);
    at = hook.got.length;
    const tried = await app.inject({ method: 'POST', url: `/v1/webhooks/${endpointId}/test`, headers: h, payload: { event: 'order.paid' } });
    assert.equal(tried.statusCode, 200, tried.body);
    assert.equal(tried.json().ok, true);
    const got = hook.got[at]!;
    assert.equal(got.headers['x-floreo-event'], 'order.paid');
    assert.equal(got.event.test, true);
    assert.equal(got.event.id, tried.json().deliveryId);
    assert.deepEqual(got.event.data, SAMPLE_EVENT_DATA['order.paid']);
    assert.ok(verifySignature(secret, String(got.headers['x-floreo-signature']), got.body));
    assert.equal((await app.inject({ method: 'POST', url: `/v1/webhooks/${endpointId}/test`, headers: h, payload: { event: 'order.shipped' } })).statusCode, 400);
    // Without a body it is still the ping it always was.
    await app.inject({ method: 'POST', url: `/v1/webhooks/${endpointId}/test`, headers: h });
    assert.equal(hook.got.at(-1)!.event.type, 'ping');
    assert.equal(hook.got.at(-1)!.event.test, undefined);
  } finally {
    await app.close();
    await hook.close();
    await f.close();
  }
});
