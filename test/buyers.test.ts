/**
 * Buyer accounts at the online store: a code by email signs in (the first
 * time makes the account); the account shows the buyer's orders (placed
 * signed in, or as a guest with the same email), keeps addresses and
 * business details, and checkout remembers what was new. One store's account
 * never signs anyone in at another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC = 'https://app.example.test';

interface Ctx { f: PipelineFixture; app: FastifyInstance; mail: ReturnType<typeof memoryMailer>; slug: string; owner: Record<string, string>; variant: string }

function staffCookie(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withStore(fn: (c: Ctx) => Promise<void>, options: { mail?: boolean } = {}) {
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC, ...(options.mail !== false && { mailer: mail }) });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: staffCookie(res), 'x-business': slug };
  const opened = await app.inject({
    method: 'PUT', url: '/v1/store-settings', headers: owner,
    payload: { enabled: true, delivery: { enabled: true, zones: [{ name: 'Belize City', fee: '8.00' }] }, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true } } },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  const product = await app.inject({ method: 'POST', url: '/v1/products', headers: owner, payload: { title: 'Island T-shirt', status: 'active', variants: [{ price: '40.00', gstCategory: 'S', stock: 50 }] } });
  assert.equal(product.statusCode, 201, product.body);
  try {
    await fn({ f, app, mail, slug, owner, variant: product.json().variants[0].id });
  } finally {
    await app.close();
    await f.close();
  }
}

const askCode = (c: Ctx, email: string, slug = c.slug) => c.app.inject({ method: 'POST', url: `/v1/store/${slug}/account/code`, headers: CSRF, payload: { email } });
const verify = (c: Ctx, challenge: string, code: string, slug = c.slug) => c.app.inject({ method: 'POST', url: `/v1/store/${slug}/account/verify`, headers: CSRF, payload: { challenge, code } });
/** The code in the newest email to `to`. */
const codeFor = (c: Ctx, to: string) => {
  const m = [...c.mail.sent].reverse().find((x) => x.to === to);
  assert.ok(m, `no email to ${to}`);
  return /(\d{6}) is your sign-in code/.exec(m.subject)![1]!;
};
/** Sign in by email: the buyer's cookie header. */
async function signIn(c: Ctx, email: string): Promise<string> {
  const asked = await askCode(c, email);
  assert.equal(asked.statusCode, 200, asked.body);
  const res = await verify(c, asked.json().challenge, codeFor(c, email.toLowerCase()));
  assert.equal(res.statusCode, 200, res.body);
  const m = new RegExp(`(etd_b_${c.slug})=([^;]+)`).exec(String(res.headers['set-cookie']));
  assert.ok(m);
  return `${m[1]}=${m[2]}`;
}
const as = (cookie: string) => ({ ...CSRF, cookie });
const order = (c: Ctx, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, headers, payload: { lines: [{ variantId: c.variant, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'pay_at_pickup', customer: { name: 'Ana Pop', phone: '+501 610-0001' }, ...body } });

test('buyer accounts: a code by email signs in (the first time makes the account); wrong codes count; signing out ends it', () =>
  withStore(async (c) => {
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json().accounts, true);
    assert.deepEqual((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account` })).json(), { buyer: null, addresses: [] });

    // Changes need the CSRF header, like the rest of the app.
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/account/code`, payload: { email: 'ana@example.com' } })).statusCode, 403);
    assert.equal((await askCode(c, 'not an email')).statusCode, 400);

    const asked = await askCode(c, 'Ana@Example.com');
    assert.equal(asked.statusCode, 200, asked.body);
    assert.equal(asked.json().minutes, 10);
    const email = c.mail.sent.at(-1)!;
    assert.equal(email.to, 'ana@example.com');
    const code = codeFor(c, 'ana@example.com');
    assert.match(email.html!, new RegExp(`>${code}<`));
    assert.match(email.html!, /It works for 10 minutes, once/);

    // A wrong code, then the right one: signed in, with a cookie for this store only.
    const wrong = await verify(c, asked.json().challenge, code === '000000' ? '111111' : '000000');
    assert.equal(wrong.statusCode, 422);
    assert.equal(wrong.json().error.code, 'invalid_code');
    const ok = await verify(c, asked.json().challenge, code);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().created, true);
    assert.equal(ok.json().buyer.email, 'ana@example.com');
    const setCookie = String(ok.headers['set-cookie']);
    assert.match(setCookie, new RegExp(`^etd_b_${c.slug}=[A-Za-z0-9_-]{40,}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000; Secure$`));
    const cookie = setCookie.split(';')[0]!;
    // A code works once.
    assert.equal((await verify(c, asked.json().challenge, code)).json().error.code, 'code_expired');

    const me = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } });
    assert.equal(me.json().buyer.email, 'ana@example.com');
    assert.equal(me.headers['cache-control'], 'no-store');

    // Five wrong tries and the code is dead, even the right one.
    const second = await askCode(c, 'ana@example.com');
    const right = codeFor(c, 'ana@example.com');
    const bad = right === '999999' ? '999998' : '999999';
    for (let i = 1; i <= 4; i++) assert.equal((await verify(c, second.json().challenge, bad)).json().error.code, 'invalid_code');
    assert.match((await verify(c, second.json().challenge, bad)).json().error.message, /Too many wrong tries/);
    assert.equal((await verify(c, second.json().challenge, right)).json().error.code, 'code_expired');

    // Signing in again: the same account.
    const again = await askCode(c, 'ana@example.com');
    const back = await verify(c, again.json().challenge, codeFor(c, 'ana@example.com'));
    assert.equal(back.json().created, false);
    assert.equal((await c.f.db.query('select 1 from store_buyers where tenant_id = $1', [c.f.tenantA])).rows.length, 1);

    // Another store does not know this cookie, even renamed for it.
    const slugB = (await c.f.db.query<{ slug: string }>(`update tenants set store_settings = '{"enabled": true}' where id = $1 returning slug`, [c.f.tenantB])).rows[0]!.slug;
    const token = cookie.split('=')[1]!;
    assert.deepEqual((await c.app.inject({ method: 'GET', url: `/v1/store/${slugB}/account`, headers: { cookie: `etd_b_${slugB}=${token}` } })).json(), { buyer: null, addresses: [] });

    // Signing out ends the session (the old cookie no longer works) and clears the cookie.
    const out = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/account/sign-out`, headers: as(cookie) });
    assert.equal(out.statusCode, 204);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json().buyer, null);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account/orders`, headers: { cookie } })).statusCode, 401);
  }));

test('buyer accounts: limits on codes per email, and wrong codes per day', () =>
  withStore(async (c) => {
    for (let i = 0; i < 5; i++) assert.equal((await askCode(c, 'ben@example.com')).statusCode, 200);
    assert.equal((await askCode(c, 'ben@example.com')).statusCode, 429);

    // Ten wrong codes in a day: no more codes for that email until tomorrow.
    const challenges: string[] = [];
    await c.f.db.query("delete from rate_limits where key like 'buyer-code|%'");
    for (let i = 0; i < 3; i++) challenges.push((await askCode(c, 'cara@example.com')).json().challenge);
    const right = codeFor(c, 'cara@example.com');
    const bad = right === '123456' ? '123457' : '123456';
    let tries = 0;
    let last: LightMyRequestResponse | undefined;
    for (const ch of challenges) {
      for (let i = 0; i < 5 && tries < 10; i++, tries++) last = await verify(c, ch, bad);
    }
    assert.match(last!.json().error.message, /Too many wrong codes for this email today/);
    assert.equal((await verify(c, challenges[2]!, right)).json().error.code, 'code_expired', 'its codes are withdrawn');
    const refused = await askCode(c, 'cara@example.com');
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().error.code, 'too_many_attempts');
  }));

test('buyer accounts: orders (signed in, and as a guest with the same email), addresses, details; checkout remembers; closing the account', () =>
  withStore(async (c) => {
    // Before the account: a guest order with this email, and someone else's.
    const guest = await order(c, { customer: { name: 'Ana Pop', phone: '+501 610-0001', email: 'ANA@example.com' } });
    assert.equal(guest.statusCode, 201, guest.body);
    const other = await order(c, { customer: { name: 'Dan', phone: '+501 610-0002', email: 'dan@example.com' } });
    assert.equal(other.statusCode, 201, other.body);

    const cookie = await signIn(c, 'ana@example.com');
    // A new account for a guest buyer: the name and phone from their last order.
    const fresh = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json().buyer;
    assert.deepEqual([fresh.name, fresh.phone], ['Ana Pop', '+501 610-0001']);
    const details = await c.app.inject({ method: 'PUT', url: `/v1/store/${c.slug}/account`, headers: as(cookie), payload: { name: 'Ana Pop', phone: '', business: null } });
    assert.equal(details.statusCode, 200, details.body);
    assert.equal(details.json().buyer.name, 'Ana Pop');
    assert.equal(details.json().buyer.phone, null);
    assert.equal((await c.app.inject({ method: 'PUT', url: `/v1/store/${c.slug}/account`, headers: as(cookie), payload: { name: 'Ana', phone: '', business: { tin: '12', name: 'X' } } })).statusCode, 400);

    // An address: the first is the default.
    const home = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/account/addresses`, headers: as(cookie), payload: { street: '12 Albert St', city: 'Belize City', districtCode: '1' } });
    assert.equal(home.statusCode, 201, home.body);
    assert.equal(home.json().isDefault, true);

    // Ordering signed in: delivery to a new address (saved), with a tax invoice for the business.
    const placed = await order(c, {
      fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'cash_on_delivery', customer: { name: 'Ana Pop', phone: '+501 610-0001', email: 'ana@example.com' },
      address: { street: '4 Cleghorn St', city: 'Belize City', districtCode: '1' }, business: { tin: '000123', name: 'Pop Imports' }, saveAddress: true,
    }, as(cookie));
    assert.equal(placed.statusCode, 201, placed.body);
    const placedNumber = placed.json().number;
    assert.equal((await c.f.db.query<{ buyer_id: string | null }>('select buyer_id from orders where tenant_id = $1 and number = $2', [c.f.tenantA, placedNumber])).rows[0]!.buyer_id !== null, true);

    const account = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json();
    assert.equal(account.buyer.phone, '+501 610-0001', 'the phone filled in from the order');
    assert.deepEqual(account.buyer.business, { tin: '000123', name: 'Pop Imports' });
    assert.deepEqual(account.addresses.map((a: { street: string; isDefault: boolean }) => [a.street, a.isDefault]), [['12 Albert St', true], ['4 Cleghorn St', false]]);

    // The same address again is not kept twice.
    await order(c, { fulfillment: 'delivery', zone: 'Belize City', paymentMethod: 'cash_on_delivery', address: { street: '4 cleghorn st', city: 'Belize City', districtCode: '1' }, saveAddress: true }, as(cookie));
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json().addresses.length, 2);

    // The orders: the guest one too, newest first; not Dan's.
    const orders = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account/orders`, headers: { cookie } })).json().data;
    assert.deepEqual(orders.map((o: { number: number }) => o.number), [placedNumber + 1, placedNumber, guest.json().number]);
    assert.equal(orders[1].total, '54.00', '40 + GST 5 + delivery 9');
    assert.equal(orders[1].items, 1);

    // Its page without the link's token: signed in, it opens; signed out, or someone else's, it does not.
    const page = await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${guest.json().number}`, headers: { cookie } });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().number, guest.json().number);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${guest.json().number}` })).statusCode, 404);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${other.json().number}`, headers: { cookie } })).statusCode, 404);
    // Changing an order by cookie needs the CSRF header.
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${placedNumber}/pay`, headers: { cookie } })).statusCode, 403);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders/${placedNumber}/pay`, headers: as(cookie) })).statusCode, 409, 'not an online payment');

    // Addresses: make the second the default; removing the default passes it on.
    const second = account.addresses[1].id;
    const made = await c.app.inject({ method: 'PUT', url: `/v1/store/${c.slug}/account/addresses/${second}`, headers: as(cookie), payload: { street: '4 Cleghorn Street', city: 'Belize City', districtCode: '1', isDefault: true } });
    assert.equal(made.statusCode, 200, made.body);
    assert.deepEqual([made.json().street, made.json().isDefault], ['4 Cleghorn Street', true]);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/store/${c.slug}/account/addresses/${second}`, headers: as(cookie) })).statusCode, 204);
    const left = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json().addresses;
    assert.deepEqual(left.map((a: { street: string; isDefault: boolean }) => [a.street, a.isDefault]), [['12 Albert St', true]]);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/store/${c.slug}/account/addresses/${second}`, headers: as(cookie) })).statusCode, 404);
    for (let i = 0; i < 9; i++) await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/account/addresses`, headers: as(cookie), payload: { street: `${i} Front St`, city: 'Orange Walk', districtCode: '4' } });
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/account/addresses`, headers: as(cookie), payload: { street: 'One too many', city: 'Corozal', districtCode: '3' } })).statusCode, 409);

    // The owner sees the buyer, with their orders.
    const buyers = await c.app.inject({ method: 'GET', url: '/v1/store-buyers', headers: c.owner });
    assert.equal(buyers.statusCode, 200, buyers.body);
    assert.equal(buyers.json().data.length, 1);
    assert.equal(buyers.json().data[0].email, 'ana@example.com');
    assert.equal(buyers.json().data[0].orders, 3);
    assert.equal(buyers.json().data[0].business, 'Pop Imports');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-buyers?q=nobody', headers: c.owner })).json().data.length, 0);

    // Closing the account: gone, signed out; the store keeps the orders.
    const closed = await c.app.inject({ method: 'DELETE', url: `/v1/store/${c.slug}/account`, headers: as(cookie) });
    assert.equal(closed.statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json().buyer, null);
    assert.equal((await c.f.db.query('select 1 from store_buyers')).rows.length, 0);
    assert.equal((await c.f.db.query('select 1 from store_buyer_addresses')).rows.length, 0);
    assert.equal((await c.f.db.query('select 1 from orders where tenant_id = $1', [c.f.tenantA])).rows.length, 4);
  }));

test('buyer accounts are off when the store turns them off, or when the server cannot send email', async () => {
  await withStore(async (c) => {
    const cookie = await signIn(c, 'eve@example.com');
    const off = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { accounts: { enabled: false } } });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json().accounts, false);
    const asked = await askCode(c, 'eve@example.com');
    assert.equal(asked.statusCode, 404);
    assert.equal(asked.json().error.code, 'accounts_off');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/account`, headers: { cookie } })).json().buyer, null);
  });
  await withStore(async (c) => {
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json().accounts, false);
    assert.equal((await askCode(c, 'eve@example.com')).statusCode, 404);
  }, { mail: false });
});
