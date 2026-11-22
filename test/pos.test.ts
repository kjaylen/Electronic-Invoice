/**
 * Tills (the iOS, Android and desktop apps): a manager adds a till and pairs
 * it with a one-time code, cashiers set a PIN and sign in on it, sell into
 * the till's own cash drawer, and the till can only do what a till does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { pinProblem } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  try {
    await fn({ f, app, owner: await login('olive@biz.example'), login });
  } finally {
    await app.close();
    await f.close();
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const receipt = (price: string, meansCode = '10') => ({
  type: '02', lines: [{ description: 'Coffee', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S' }], payment: { meansCode, terms: 'Paid' },
});

test('PIN rules', () => {
  assert.equal(pinProblem('4821'), null);
  assert.equal(pinProblem('90210'), null);
  assert.match(pinProblem('123')!, /4 to 8 digits/);
  assert.match(pinProblem('12a4')!, /4 to 8 digits/);
  assert.match(pinProblem('7777')!, /repeated/);
  assert.match(pinProblem('1234')!, /run/);
  assert.match(pinProblem('9876')!, /run/);
  assert.match(pinProblem('8901')!, /run/);
});

test('a till: add, pair with a one-time code, PINs, sign in, sell into its drawer, and only till things', () =>
  withBusiness(async (c) => {
    // A manager adds the till: it gets its own cash drawer and a pairing code.
    const added = await c.app.inject({ method: 'POST', url: '/v1/pos/devices', headers: c.owner, payload: { name: 'Front counter' } });
    assert.equal(added.statusCode, 201, added.body);
    const { device, pairing } = added.json();
    assert.match(pairing.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.deepEqual([device.status, device.register.name], ['waiting', 'Front counter']);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/pos/devices', headers: c.owner, payload: { name: 'front counter' } })).statusCode, 409);

    // Pairing: a wrong code fails, the right one (any case, with or without the dash) works once.
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/pos/pair', payload: { code: 'AAAA-AAAA' } })).statusCode, 422);
    const paired = await c.app.inject({ method: 'POST', url: '/v1/pos/pair', payload: { code: pairing.code.toLowerCase().replace('-', ''), platform: 'android', appVersion: '1.0.0' } });
    assert.equal(paired.statusCode, 200, paired.body);
    const till = paired.json();
    assert.match(till.token, /^till_/);
    assert.equal(till.till.device.name, 'Front counter');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/pos/pair', payload: { code: pairing.code } })).statusCode, 422, 'used once');
    const device_ = bearer(till.token);

    // Who can sign in here: people who sell (not accountants), and whether they have a PIN yet.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cash', email: 'cash@biz.example', role: 'cashier', password: PASSWORD });
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Ada', email: 'ada@biz.example', role: 'accountant', password: PASSWORD });
    const users = (await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: device_ })).json().users;
    assert.deepEqual(users.map((u: { name: string; hasPin: boolean }) => [u.name, u.hasPin]), [['Cash', false], ['Olive', false]]);
    const cashId = users[0].id;
    const oliveId = users[1].id;

    // The cashier sets a PIN on the till with their password (a weak PIN is refused); the owner sets one in the web app.
    const weak = await c.app.inject({ method: 'POST', url: '/v1/pos/pin', headers: device_, payload: { login: 'cash@biz.example', password: PASSWORD, pin: '1111' } });
    assert.equal(weak.statusCode, 422);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/pos/pin', headers: device_, payload: { login: 'cash@biz.example', password: 'nope', pin: '4821' } })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/pos/pin', headers: device_, payload: { login: 'cash@biz.example', password: PASSWORD, pin: '4821' } })).statusCode, 200);
    const ownPin = await c.app.inject({ method: 'PUT', url: '/v1/me/pin', headers: c.owner, payload: { pin: '90210' } });
    assert.equal(ownPin.statusCode, 200, ownPin.body);
    assert.equal(ownPin.json().hasPin, true);

    // Signing in: wrong PINs count down, then lock that person out of this till.
    const signIn = (userId: string, pin: string) => c.app.inject({ method: 'POST', url: '/v1/pos/sign-in', headers: device_, payload: { userId, pin } });
    const wrong = await signIn(oliveId, '00000');
    assert.equal(wrong.statusCode, 401);
    assert.match(wrong.json().error.message, /4 tries left/);
    const cash = await signIn(cashId, '4821');
    assert.equal(cash.statusCode, 200, cash.body);
    assert.deepEqual(cash.json().permissions, ['documents.issue', 'documents.send', 'orders.manage', 'payments.record']);
    const cashier = bearer(cash.json().token);

    // The cashier opens the till's shift: always the till's own drawer.
    const opened = await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: cashier, payload: { openingFloat: '50.00' } });
    assert.equal(opened.statusCode, 201, opened.body);
    assert.equal(opened.json().shift.register.name, 'Front counter');
    const sale = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: cashier, payload: receipt('10.00') });
    assert.equal(sale.statusCode, 201, sale.body);

    // The owner signs in on the same till and sells into the same drawer.
    const olive = bearer((await signIn(oliveId, '90210')).json().token);
    await c.app.inject({ method: 'POST', url: '/v1/documents', headers: olive, payload: receipt('20.00', '48') });
    const current = (await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: olive })).json();
    assert.equal(current.shift.number, opened.json().shift.number);
    assert.deepEqual([current.report.takings.cash, current.report.takings.card, current.report.cash.expected], ['11.25', '22.50', '61.25']);
    const docs = (await c.f.db.query<{ device_id: string; issued_by: string }>('select device_id, issued_by from documents order by created_at')).rows;
    assert.ok(docs.every((d) => d.device_id === device.id));
    // In the web app the owner has no shift of their own (the till's drawer is the till's).
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/shifts/current', headers: c.owner })).json().shift, null);

    // The printed copy's texts for the receipt printer.
    const view = (await c.app.inject({ method: 'GET', url: `/v1/documents/${sale.json().id}/view`, headers: cashier })).json();
    assert.equal(view.printed.printable, true);
    assert.match(view.printed.authorization, /^\d{44}$|Pending/);
    assert.match(view.qr.url, /QRCode\?UUID=\d{44}$/);

    // Only till things: no people, keys, settings or exports; a till token is never a browser cookie.
    for (const [method, url] of [['GET', '/v1/users'], ['GET', '/v1/api-keys'], ['PUT', '/v1/business'], ['GET', '/v1/reports/summary'], ['PUT', '/v1/me/pin']] as const) {
      const r = await c.app.inject({ method, url, headers: olive, ...(method === 'PUT' && { payload: {} }) });
      assert.equal(r.statusCode, 403, `${method} ${url}: ${r.body}`);
    }
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/pos/devices', headers: olive })).statusCode, 403);
    const slug = (await c.f.db.query<{ slug: string }>('select slug from tenants where id = $1', [c.f.tenantA])).rows[0]!.slug;
    const asCookie = await c.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `etd_s_${slug}=${cash.json().token.slice(4)}`, 'x-business': slug } });
    assert.equal(asCookie.statusCode, 401);

    // The till reports its hardware; the web app lists the till with who is on it.
    const hb = await c.app.inject({ method: 'POST', url: '/v1/pos/heartbeat', headers: device_, payload: { platform: 'android', appVersion: '1.0.1', hardware: { printers: [{ name: 'Kitchen', connection: 'bluetooth' }], scanner: 'camera' } } });
    assert.equal(hb.statusCode, 200, hb.body);
    const list = (await c.app.inject({ method: 'GET', url: '/v1/pos/devices', headers: c.owner })).json().data;
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].status, list[0].appVersion, list[0].hardware.printers[0].connection, list[0].openShift.openedBy, list[0].signedIn], ['paired', '1.0.1', 'bluetooth', 'Cash', ['Cash', 'Olive']]);

    // The cashier closes the till's shift (shared drawer).
    const closed = await c.app.inject({ method: 'POST', url: `/v1/shifts/${opened.json().shift.id}/close`, headers: cashier, payload: { countedCash: '61.25' } });
    assert.equal(closed.statusCode, 200, closed.body);

    // Removing the till: its token and every session on it stop working.
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/pos/devices/${device.id}`, headers: c.owner })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: cashier })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: device_ })).statusCode, 401);
    // Its name can be used again.
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/pos/devices', headers: c.owner, payload: { name: 'Front counter' } })).statusCode, 201);
  }));

test('PIN lockout, re-pairing signs everyone out, and the apps may call the API cross-origin', () =>
  withBusiness(async (c) => {
    const { device, pairing } = (await c.app.inject({ method: 'POST', url: '/v1/pos/devices', headers: c.owner, payload: { name: 'Bar' } })).json();
    const first = (await c.app.inject({ method: 'POST', url: '/v1/pos/pair', payload: { code: pairing.code } })).json();
    await c.app.inject({ method: 'PUT', url: '/v1/me/pin', headers: c.owner, payload: { pin: '5813' } });
    const userId = (await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: bearer(first.token) })).json().users[0].id;
    const signIn = (pin: string, token = first.token) => c.app.inject({ method: 'POST', url: '/v1/pos/sign-in', headers: bearer(token), payload: { userId, pin } });

    const session = bearer((await signIn('5813')).json().token);
    for (let i = 0; i < 5; i++) assert.equal((await signIn('0000')).statusCode, 401);
    assert.equal((await signIn('5813')).statusCode, 429, 'locked out even with the right PIN');

    // A new code pairs the till again: the old token and its sessions stop working.
    const again = (await c.app.inject({ method: 'POST', url: `/v1/pos/devices/${device.id}/code`, headers: c.owner })).json();
    const second = (await c.app.inject({ method: 'POST', url: '/v1/pos/pair', payload: { code: again.pairing.code } })).json();
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: bearer(first.token) })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: session })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: bearer(second.token) })).statusCode, 200);

    // Changing the PIN signs the person out of tills too.
    await c.f.db.query('delete from rate_limits');
    const s2 = bearer((await signIn('5813', second.token)).json().token);
    await c.app.inject({ method: 'PUT', url: '/v1/me/pin', headers: c.owner, payload: { pin: '2468' } });
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: s2 })).statusCode, 401);

    // CORS for the apps (Capacitor, Electron); nothing for other origins.
    const pre = await c.app.inject({ method: 'OPTIONS', url: '/v1/documents', headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'capacitor://localhost');
    assert.match(String(pre.headers['access-control-allow-headers']), /Authorization/);
    assert.equal(pre.headers['access-control-allow-credentials'], undefined);
    const fromApp = await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: { ...bearer(second.token), origin: 'app://pos' } });
    assert.equal(fromApp.headers['access-control-allow-origin'], 'app://pos');
    const elsewhere = await c.app.inject({ method: 'GET', url: '/v1/pos/till', headers: { ...bearer(second.token), origin: 'https://evil.example' } });
    assert.equal(elsewhere.headers['access-control-allow-origin'], undefined);
  }));
