/**
 * Checkout reminders: a buyer who gave their email at checkout and left gets
 * a reminder with a link back to their cart (and once more a day later);
 * ordering, unsubscribing or the store turning them off ends it.
 */

import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { runCheckoutReminders } from '../src/commerce/checkouts.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC = 'https://app.example.test';

interface Ctx { f: PipelineFixture; app: FastifyInstance; mail: ReturnType<typeof memoryMailer>; slug: string; owner: Record<string, string>; variant: string; other: string }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withStore(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC, mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  const opened = await app.inject({
    method: 'PUT', url: '/v1/store-settings', headers: owner,
    payload: { enabled: true, delivery: { enabled: true, zones: [{ name: 'Belize City', fee: '8.00' }] }, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true } } },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  const product = await app.inject({ method: 'POST', url: '/v1/products', headers: owner, payload: { title: 'Island T-shirt', status: 'active', option1Name: 'Size', variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', stock: 5 }, { option1: 'M', price: '40.00', gstCategory: 'S', stock: 5 }] } });
  assert.equal(product.statusCode, 201, product.body);
  const [variant, other] = product.json().variants.map((v: { id: string }) => v.id);
  try {
    await fn({ f, app, mail, slug, owner, variant, other });
  } finally {
    await app.close();
    await f.close();
  }
}

const save = (c: Ctx, id: string, body: Record<string, unknown>) => c.app.inject({ method: 'PUT', url: `/v1/store/${c.slug}/checkouts/${id}`, payload: body });
/** Time passes: the checkout was last touched `hours` ago (and its last reminder, if any). */
const ago = (c: Ctx, id: string, hours: number) => c.f.db.query(`update store_checkouts set updated_at = now() - $2::float8 * interval '1 hour', last_reminded_at = case when last_reminded_at is null then null else now() - $2::float8 * interval '1 hour' end where id = $1`, [id, hours]);
const remind = (c: Ctx) => runCheckoutReminders(c.f.db, {}, { mailer: c.mail, publicUrl: PUBLIC });
const linkIn = (html: string, path: string) => new RegExp(`${PUBLIC}/[^/]+/shop/${path}\\?t=([A-Za-z0-9_-]+)`).exec(html)?.[1];

test('checkout reminders: an hour after leaving, then a day later; the link puts the cart back; ordering from it counts as recovered', () =>
  withStore(async (c) => {
    // The shop says reminders may be sent.
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json().reminders, true);
    const id = randomUUID();
    const saved = await save(c, id, { email: 'Ana@Example.com', name: 'Ana', lines: [{ variantId: c.variant, quantity: 2 }], fulfillment: 'delivery', zone: 'Belize City' });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json(), { saved: true });
    assert.equal((await save(c, id, { email: 'not an email', lines: [] })).statusCode, 400);

    // Too soon: nothing.
    assert.deepEqual(await remind(c), { sent: 0, ended: 0 });
    await ago(c, id, 1.1);
    assert.equal((await remind(c)).sent, 1);
    const first = c.mail.sent.at(-1)!;
    assert.equal(first.to, 'ana@example.com');
    assert.match(first.subject, /You left something in your cart at /);
    assert.match(first.html!, /Hello Ana/);
    assert.match(first.html!, /Island T-shirt[\s\S]*\(S\)[\s\S]*× 2[\s\S]*90\.00/, 'the items with GST');
    assert.match(first.html!, /Total[\s\S]*99\.00/, 'with delivery: 90 + 9');
    assert.match(first.headers!['List-Unsubscribe']!, /^<https:\/\/app\.example\.test\/v1\/store\/[^/]+\/checkouts\/unsubscribe\?t=/);
    const token = linkIn(first.html!, 'resume')!;
    assert.ok(token);
    assert.equal(linkIn(first.html!, 'unsubscribe'), token);

    // Not again until a day after the first.
    await ago(c, id, 5);
    assert.equal((await remind(c)).sent, 0);
    await ago(c, id, 25);
    assert.equal((await remind(c)).sent, 1);
    assert.match(c.mail.sent.at(-1)!.subject, /Still thinking it over\?/);
    assert.match(c.mail.sent.at(-1)!.html!, /it is the last reminder/);
    await ago(c, id, 48);
    assert.equal((await remind(c)).sent, 0, 'two at most');

    // The first email's link still works: the cart, as the store's cart keeps it.
    const restored = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/checkouts/restore?t=${token}` });
    assert.equal(restored.statusCode, 200, restored.body);
    const r = restored.json();
    assert.equal(r.ordered, false);
    assert.equal(r.checkoutId, id);
    assert.equal(r.email, 'ana@example.com');
    assert.equal(r.fulfillment, 'delivery');
    assert.deepEqual(r.lines.map((l: { variantId: string; quantity: number; handle: string; title: string; variantTitle: string; price: string }) => [l.variantId, l.quantity, l.handle, l.title, l.variantTitle, l.price]), [[c.variant, 2, 'island-t-shirt', 'Island T-shirt', 'S', '45.00']]);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/checkouts/restore?t=${'x'.repeat(32)}` })).statusCode, 404);

    // Ordered from the link: done, and counted as recovered.
    const order = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variant, quantity: 2 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: { name: 'Ana', phone: '+501 610-0000', email: 'ana@example.com' }, checkoutId: id } });
    assert.equal(order.statusCode, 201, order.body);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/checkouts/restore?t=${token}` })).json().ordered, true);
    const list = (await c.app.inject({ method: 'GET', url: '/v1/store-checkouts?view=recovered', headers: c.owner })).json();
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].order.number, order.json().number);
    assert.equal(list.data[0].remindersSent, 2);
    assert.deepEqual(list.summary, { left: 1, reminded: 1, recovered: 1, recoveredTotal: '90.00' });
    const orders = (await c.app.inject({ method: 'GET', url: '/v1/orders?view=all', headers: c.owner })).json().data;
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/orders/${orders[0].id}`, headers: c.owner })).json().recoveredByReminder, true);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-checkouts?view=open', headers: c.owner })).json().data.length, 0);
  }));

test('checkout reminders end with an order from another device, an unsubscribe, an empty cart, or the store turning them off', () =>
  withStore(async (c) => {
    // Ordered on the phone instead (same email, no checkout id): no reminder, not "recovered".
    const a = randomUUID();
    await save(c, a, { email: 'ben@example.com', lines: [{ variantId: c.variant, quantity: 1 }] });
    await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variant, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: { name: 'Ben', phone: '+501 610-0001', email: 'BEN@example.com' } } });
    await ago(c, a, 2);
    assert.equal((await remind(c)).sent, 0);
    assert.equal((await c.f.db.query<{ status: string; recovered: boolean }>('select status, recovered from store_checkouts where id = $1', [a])).rows[0]!.status, 'ordered');

    // Unsubscribed from the first reminder: none after, and not saved again.
    const b = randomUUID();
    await save(c, b, { email: 'cara@example.com', lines: [{ variantId: c.other, quantity: 1 }] });
    await ago(c, b, 2);
    assert.equal((await remind(c)).sent, 1);
    const token = linkIn(c.mail.sent.at(-1)!.html!, 'unsubscribe')!;
    const unsub = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/checkouts/unsubscribe?t=${token}` });
    assert.equal(unsub.statusCode, 200, unsub.body);
    assert.equal(unsub.json().email, 'cara@example.com');
    await ago(c, b, 30);
    assert.equal((await remind(c)).sent, 0);
    assert.deepEqual((await save(c, randomUUID(), { email: 'Cara@example.com', lines: [{ variantId: c.variant, quantity: 1 }] })).json(), { saved: false });

    // The cart emptied before leaving: nothing to remind about.
    const d = randomUUID();
    await save(c, d, { email: 'dan@example.com', lines: [{ variantId: c.variant, quantity: 1 }] });
    await save(c, d, { email: 'dan@example.com', lines: [] });
    await ago(c, d, 2);
    assert.equal((await remind(c)).sent, 0);

    // What was in it is no longer sold: ended without an email.
    const e = randomUUID();
    await save(c, e, { email: 'eve@example.com', lines: [{ variantId: c.variant, quantity: 1 }] });
    await c.f.db.query('update items set archived_at = now() where id = $1', [c.variant]);
    await ago(c, e, 2);
    assert.equal((await remind(c)).sent, 0);
    assert.equal((await c.f.db.query<{ status: string }>('select status from store_checkouts where id = $1', [e])).rows[0]!.status, 'expired');

    // The store sets the first reminder for 6 hours: not at 2.
    await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { reminders: { enabled: true, afterHours: 6, second: false } } });
    const g = randomUUID();
    await save(c, g, { email: 'gil@example.com', lines: [{ variantId: c.other, quantity: 3 }] });
    await ago(c, g, 2);
    assert.equal((await remind(c)).sent, 0);
    await ago(c, g, 7);
    assert.equal((await remind(c)).sent, 1);
    assert.match(c.mail.sent.at(-1)!.html!, /it is the last reminder/, 'no second one in this store');
    await ago(c, g, 30);
    assert.equal((await remind(c)).sent, 0);

    // Turned off: nothing is saved at all, and the shop does not mention reminders.
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { reminders: { enabled: false } } })).statusCode, 200);
    assert.deepEqual((await save(c, randomUUID(), { email: 'hal@example.com', lines: [{ variantId: c.other, quantity: 1 }] })).json(), { saved: false });
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json().reminders, false);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { reminders: { afterHours: 5 } } })).statusCode, 400, 'only the offered delays');

    // Only staff who handle orders see them.
    const cashierEmail = 'kim@shop.example';
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Kim', email: cashierEmail, role: 'accountant', password: PASSWORD });
    const login = await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: c.slug, login: cashierEmail, password: PASSWORD } });
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-checkouts', headers: { ...CSRF, cookie: cookieFrom(login), 'x-business': c.slug } })).statusCode, 403);
  }));

test('checkout reminders: a reminder that fails to send is tried again; a week-old checkout is let go', () =>
  withStore(async (c) => {
    const id = randomUUID();
    await save(c, id, { email: 'ivy@example.com', lines: [{ variantId: c.variant, quantity: 1 }] });
    await ago(c, id, 2);
    const failing = { async send() { throw new Error('SMTP down'); } };
    assert.equal((await runCheckoutReminders(c.f.db, {}, { mailer: failing, publicUrl: PUBLIC })).sent, 0);
    assert.equal((await c.f.db.query<{ reminders_sent: number; token_hashes: string[] }>('select reminders_sent, token_hashes from store_checkouts where id = $1', [id])).rows[0]!.reminders_sent, 0);
    assert.equal((await remind(c)).sent, 1, 'sent at the next run');

    const old = randomUUID();
    await save(c, old, { email: 'joe@example.com', lines: [{ variantId: c.variant, quantity: 1 }] });
    await c.f.db.query("update store_checkouts set created_at = now() - interval '8 days', updated_at = now() - interval '8 days' where id = $1", [old]);
    assert.equal((await remind(c)).sent, 0);
    assert.equal((await c.f.db.query<{ status: string }>('select status from store_checkouts where id = $1', [old])).rows[0]!.status, 'expired');
  }));
