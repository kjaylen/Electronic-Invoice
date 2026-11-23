/**
 * A customer's account page: a private link shows what they owe and their documents, opens their
 * documents (and only theirs), gives their statement, and stops working when revoked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('account links: what a customer owes, their documents, their statement', async () => {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const mailer = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, mailer, publicUrl: 'https://app.example.test' });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
    const address = { street: '1 Main St', city: 'Belize City', districtCode: '1' };
    const customer = async (name: string, tin: string) => (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name, tin, address, contact: { email: `${tin}@cust.example` } } })).json() as { id: string };
    const shop = await customer('Corner Shop', '111222');
    const other = await customer('Someone Else', '333444');
    const invoice = async (customerId: string, price: string) => {
      const r = await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { type: '01', customerId, lines: [{ description: 'Rice', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'Z' }], payment: { meansCode: '30', dueDate: '2099-12-31' } } });
      assert.equal(r.statusCode, 201, r.body);
      return r.json() as { id: string };
    };
    const a = await invoice(shop.id, '100.00');
    await invoice(shop.id, '50.00');
    const theirs = await invoice(other.id, '70.00');

    const made = await app.inject({ method: 'POST', url: `/v1/customers/${shop.id}/account-link`, headers: owner });
    assert.equal(made.statusCode, 200, made.body);
    const url = made.json().url as string;
    assert.match(url, /^https:\/\/app\.example\.test\/a\/[A-Za-z0-9_-]{43}$/);
    const token = url.split('/a/')[1]!;

    // No sign-in: the link is the permission.
    const page = await app.inject({ method: 'GET', url: `/v1/account/${token}` });
    assert.equal(page.statusCode, 200, page.body);
    const info = page.json();
    assert.equal(info.customer.name, 'Corner Shop');
    assert.equal(info.owed.total, '150.00');
    assert.equal(info.open.length, 2);
    assert.equal(info.recent.length, 2);
    assert.equal(page.headers['cache-control'], 'private, no-store');

    // Their own documents open; someone else's do not.
    const doc = await app.inject({ method: 'POST', url: `/v1/account/${token}/documents/${a.id}/link` });
    assert.equal(doc.statusCode, 200, doc.body);
    assert.match(doc.json().payUrl, /\/pay\/[A-Za-z0-9_-]{43}$/);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/account/${token}/documents/${theirs.id}/link` })).statusCode, 404);
    const st = await app.inject({ method: 'GET', url: `/v1/account/${token}/statement.pdf` });
    assert.equal(st.statusCode, 200);
    assert.equal(st.rawPayload.subarray(0, 5).toString(), '%PDF-');

    // Emailed to the customer.
    const sent = await app.inject({ method: 'POST', url: `/v1/customers/${shop.id}/account-link/send`, headers: owner, payload: {} });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(mailer.sent.at(-1)!.to, '111222@cust.example');
    assert.match(mailer.sent.at(-1)!.text, /\/a\/[A-Za-z0-9_-]{43}/);

    // Revoked: every link stops.
    const revoked = (await app.inject({ method: 'DELETE', url: `/v1/customers/${shop.id}/account-links`, headers: owner })).json();
    assert.equal(revoked.revoked, 2);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/account/${token}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/account/not-a-token' })).statusCode, 404);
  } finally {
    await app.close();
    await f.close();
  }
});
