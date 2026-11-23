/**
 * Credit limits: an invoice on account may not take a customer over what they may owe, unless an
 * owner, admin or manager allows it. Paid invoices and receipts are not held back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('credit limits hold back invoices on account; a manager can allow one', async () => {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const login = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } })), 'x-business': slug });
    const owner = await login('olive@biz.example');
    const cashier = await login('cass@biz.example');
    const address = { street: '1 Main St', city: 'Belize City', districtCode: '1' };

    const shop = (await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Corner Shop', tin: '111222', address, creditLimit: '100.00' } })).json();
    assert.equal(shop.creditLimit, '100.00');
    // A cashier saving a customer cannot give them credit.
    const walkIn = (await app.inject({ method: 'POST', url: '/v1/customers', headers: cashier, payload: { name: 'Ana', tin: '333444', address, creditLimit: '5000' } })).json();
    assert.equal(walkIn.creditLimit, null);

    const invoice = (headers: typeof owner, price: string, extra: Record<string, unknown> = {}) => app.inject({
      method: 'POST', url: '/v1/documents', headers,
      payload: { type: '01', customerId: shop.id, lines: [{ description: 'Rice 25 lb', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S' }], payment: { meansCode: '30', dueDate: '2099-12-31' }, ...extra },
    });
    // 80 + GST = 90.00: within the limit.
    assert.equal((await invoice(cashier, '80.00')).statusCode, 201);
    // Another 22.50 would make 112.50.
    const over = await invoice(cashier, '20.00');
    assert.equal(over.statusCode, 422);
    assert.equal(over.json().error.code, 'credit_limit');
    assert.match(over.json().error.message, /over their credit limit of BZ\$100\.00 \(they owe BZ\$90\.00\)/);
    assert.equal(over.json().error.details.available, '10.00');
    // A cashier cannot allow it; the owner can.
    assert.equal((await invoice(cashier, '20.00', { overrideCreditLimit: true })).statusCode, 403);
    assert.equal((await invoice(owner, '20.00', { overrideCreditLimit: true })).statusCode, 201);
    // Paid on the spot, or a receipt: not on account.
    assert.equal((await invoice(cashier, '20.00', { paid: { method: 'cash' } })).statusCode, 201);
    const receipt = await app.inject({ method: 'POST', url: '/v1/documents', headers: cashier, payload: { type: '02', customerId: shop.id, lines: [{ description: 'Rice 25 lb', quantity: '1', unitCode: 'H87', unitPrice: '20.00', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Paid' } } });
    assert.equal(receipt.statusCode, 201, receipt.body);

    // An edit without the limit keeps it; null removes it.
    const kept = (await app.inject({ method: 'PUT', url: `/v1/customers/${shop.id}`, headers: owner, payload: { name: 'Corner Shop', tin: '111222', address } })).json();
    assert.equal(kept.creditLimit, '100.00');
    const removed = (await app.inject({ method: 'PUT', url: `/v1/customers/${shop.id}`, headers: owner, payload: { name: 'Corner Shop', tin: '111222', address, creditLimit: null } })).json();
    assert.equal(removed.creditLimit, null);
    assert.equal((await invoice(cashier, '20.00')).statusCode, 201);
  } finally {
    await app.close();
    await f.close();
  }
});
