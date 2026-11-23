/**
 * Signing in to a business: creating a business with its owner, logging in
 * by email or username at the business's address, cookies per business,
 * CSRF, the certificate upload and API keys, and serving the web app.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { base32Decode, stepAt, totpCode } from '../src/db/twofactor.ts';
import { createUser } from '../src/db/users.ts';
import { slugify } from '../src/db/tenants.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const BUSINESS = {
  legalName: 'Corozal Hardware Ltd.',
  tin: '123456',
  address: { street: '5 Main Street', city: 'Corozal Town', districtCode: '3' },
  contact: { telephone: '+501 422 0000', email: 'office@corozalhw.example' },
};

async function withApp(fn: (f: PipelineFixture, app: FastifyInstance) => Promise<void>, options: { allowSignup?: boolean; webRoot?: string } = {}) {
  const f = await setupPipeline();
  // The fixture's tenants use TINs 123456 and 654321 in "test"; free 123456 for the self-service business.
  await f.db.query(`update tenants set environment = 'production' where id = $1`, [f.tenantA]);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, ...options });
  try {
    await fn(f, app);
  } finally {
    await app.close();
    await f.close();
  }
}

/** The session cookie a response set, as a Cookie header value. */
function cookieFrom(res: LightMyRequestResponse): string {
  const header = String(res.headers['set-cookie'] ?? '');
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(header);
  assert.ok(m, `session cookie set: ${header} ${res.body}`);
  return `${m[1]}=${m[2]}`;
}

async function signUp(app: FastifyInstance, business: Record<string, unknown> = BUSINESS, email = 'owner@corozalhw.example') {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business, owner: { name: 'Maria Owner', email, password: PASSWORD } } });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: cookieFrom(res), slug: res.json().business.slug as string, body: res.json() };
}

const login = (app: FastifyInstance, business: string, loginName: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business, login: loginName, password } });

test('creating a business makes its owner, its address and a secure per-business cookie', () =>
  withApp(async (_f, app) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: BUSINESS, owner: { name: 'Maria Owner', email: 'Owner@CorozalHW.example', password: PASSWORD } } });
    assert.equal(res.statusCode, 201, res.body);
    const setCookie = String(res.headers['set-cookie']);
    assert.match(setCookie, /^etd_s_corozal-hardware-ltd=/, 'the cookie is named after the business address');
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(setCookie.includes(flag), flag);
    const body = res.json();
    assert.equal(body.business.slug, 'corozal-hardware-ltd');
    assert.equal(body.business.environment, 'test', 'self-service businesses start in the test environment');
    assert.equal(body.user.email, 'owner@corozalhw.example', 'emails are stored lower-case');
    assert.equal(body.user.role, 'owner');
    assert.ok(body.permissions.includes('users.manage'));

    const cookie = cookieFrom(res);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().legalName, 'Corozal Hardware Ltd.');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/auth/business/corozal-hardware-ltd' })).json(), { slug: 'corozal-hardware-ltd', name: 'Corozal Hardware Ltd.' });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/business/no-such-shop' })).statusCode, 404);
  }));

test('business addresses: suggestions, format, reserved words, taken', () =>
  withApp(async (_f, app) => {
    assert.equal(slugify('Café Belize & Co.'), 'cafe-belize-and-co');
    assert.equal(slugify('A'), 'a-bz');
    const check = async (q: string) => (await app.inject({ method: 'GET', url: `/v1/auth/slug?${q}`, headers: CSRF })).json();
    assert.equal((await check('name=Corozal%20Hardware%20Ltd.')).slug, 'corozal-hardware-ltd');
    assert.equal((await check('slug=Bad_Address')).available, false);
    assert.equal((await check('slug=signup')).available, false, 'reserved for the app');
    assert.equal((await check('slug=v1')).available, false);
    const first = await signUp(app, { ...BUSINESS, tradeName: 'Corozal HW' });
    assert.equal(first.slug, 'corozal-hw', 'the address is made from the trade name');
    assert.deepEqual(await check('slug=corozal-hw'), { slug: 'corozal-hw', available: false, problem: 'Another business already uses this address' });
    assert.equal((await check('name=Corozal%20HW')).slug, 'corozal-hw-2', 'suggestions skip taken addresses');
    const second = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: { ...BUSINESS, tin: '777777', tradeName: 'Corozal HW' }, owner: { name: 'X', email: 'x@y.example', password: PASSWORD } } });
    assert.equal(second.json().business.slug, 'corozal-hw-2', 'a taken address gets a number');
    const chosen = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: { ...BUSINESS, tin: '888888', slug: 'my-pick' }, owner: { name: 'Y', email: 'y@y.example', password: PASSWORD } } });
    assert.equal(chosen.statusCode, 400, 'a business cannot choose its own address');
    const reserved = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: { ...BUSINESS, tin: '888888', legalName: 'Admin' }, owner: { name: 'Y', email: 'y@y.example', password: PASSWORD } } });
    assert.notEqual(reserved.json().business.slug, 'admin', 'reserved words are never given out');
  }));

test('sign-up rules: weak password, duplicate TIN, closed sign-up', async () => {
  await withApp(async (_f, app) => {
    const weak = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: BUSINESS, owner: { name: 'A', email: 'a@b.example', password: 'short' } } });
    assert.equal(weak.statusCode, 422);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/slug?slug=corozal-hardware-ltd' })).json().available, true, 'a failed sign-up leaves nothing behind');
    await signUp(app);
    const dup = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: { ...BUSINESS, tradeName: 'Other Name' }, owner: { name: 'B', email: 'b@b.example', password: PASSWORD } } });
    assert.equal(dup.statusCode, 409, 'one business per TIN per environment');
  });
  await withApp(async (_f, app) => {
    const closed = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { business: BUSINESS, owner: { name: 'A', email: 'a@b.example', password: PASSWORD } } });
    assert.equal(closed.statusCode, 403);
  }, { allowSignup: false });
});

test('log in at the business with email or username; other businesses do not know the account', () =>
  withApp(async (f, app) => {
    const { slug, body } = await signUp(app);
    await createUser(f.db, { tenantId: body.business.id, name: 'Till 1', username: 'till1', role: 'cashier', password: PASSWORD });

    assert.equal((await login(app, slug, 'OWNER@corozalhw.example')).statusCode, 200);
    const byUsername = await login(app, slug, 'Till1');
    assert.equal(byUsername.statusCode, 200, byUsername.body);
    assert.equal(byUsername.json().user.role, 'cashier');

    const elsewhere = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantB])).rows[0]!.slug;
    assert.equal((await login(app, elsewhere, 'owner@corozalhw.example')).statusCode, 401, 'accounts belong to one business');
    assert.equal((await login(app, 'no-such-shop', 'owner@corozalhw.example')).statusCode, 404);

    const wrong = await login(app, slug, 'owner@corozalhw.example', 'nope nope nope');
    const unknown = await login(app, slug, 'nobody@corozalhw.example', 'nope nope nope');
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), unknown.json(), 'wrong password and unknown account look the same');

    // Kept signed in by default (a lasting cookie); not when they untick it (gone when the browser closes).
    assert.match(String(byUsername.headers['set-cookie']), /Max-Age=\d+/);
    const brief = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'till1', password: PASSWORD, remember: false } });
    assert.equal(brief.statusCode, 200, brief.body);
    assert.doesNotMatch(String(brief.headers['set-cookie']), /Max-Age/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: cookieFrom(brief) } })).statusCode, 200);

    const cookie = cookieFrom(byUsername);
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, ...CSRF, 'x-business': slug } });
    assert.equal(out.statusCode, 204);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode, 401, 'the old cookie no longer works');

    // Successful sign-ins never count toward the limit (a shop's staff all sign in from one IP).
    for (let i = 0; i < 12; i++) assert.equal((await login(app, slug, 'till1')).statusCode, 200);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login(app, slug, 'owner@corozalhw.example', 'guess guess guess')).statusCode;
    assert.equal(last, 429);
    assert.equal((await login(app, slug, 'owner@corozalhw.example')).statusCode, 429, 'locked even with the right password, for 15 minutes');
  }));

test('the same email can have separate accounts in two businesses, both signed in in one browser', () =>
  withApp(async (_f, app) => {
    const a = await signUp(app, BUSINESS, 'sam@example.com');
    const b = await signUp(app, { ...BUSINESS, legalName: 'Sam’s Second Shop', tin: '222333' }, 'sam@example.com');
    assert.notEqual(a.slug, b.slug);
    const browser = `${a.cookie}; ${b.cookie}`;
    const meA = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: browser, 'x-business': a.slug } });
    const meB = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: browser, 'x-business': b.slug } });
    assert.equal(meA.json().legalName, 'Corozal Hardware Ltd.');
    assert.equal(meB.json().legalName, 'Sam’s Second Shop');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: browser } })).statusCode, 401, 'which business must be said when signed in to several');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/me?b=${b.slug}`, headers: { cookie: browser } })).json().legalName, 'Sam’s Second Shop', '?b= works for plain links');
    // A cookie for business A cannot be used to reach business B.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: a.cookie.replace(a.slug, b.slug), 'x-business': b.slug } })).statusCode, 401);
  }));

test('CSRF: cookie-authenticated changes need the X-Requested-With header; reads do not', () =>
  withApp(async (_f, app) => {
    const { cookie } = await signUp(app);
    const forged = await app.inject({ method: 'POST', url: '/v1/customers', headers: { cookie }, payload: { name: 'Forged' } });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.json().error.code, 'csrf');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/customers', headers: { cookie, ...CSRF }, payload: { name: 'Real' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/customers', headers: { cookie } })).statusCode, 200);
  }));

test('passwords and session tokens are never stored in plaintext', () =>
  withApp(async (f, app) => {
    const { cookie } = await signUp(app);
    const token = cookie.split('=')[1]!;
    const user = (await f.db.query<{ password_hash: string }>(`select password_hash from users where email = 'owner@corozalhw.example'`)).rows[0]!;
    assert.match(user.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!user.password_hash.includes(PASSWORD));
    const hit = (await f.db.query<{ n: number }>('select count(*)::int as n from sessions where token_hash = $1', [token])).rows[0]!.n;
    assert.equal(hit, 0, 'only a hash of the token is stored');
  }));

test('certificate from a .pfx and API keys: owners yes, cashiers no; keys cannot mint keys', () =>
  withApp(async (f, app) => {
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const { cookie: ownerCookie, slug, body } = await signUp(app);
    await createUser(f.db, { tenantId: body.business.id, name: 'Clerk', email: 'clerk@corozalhw.example', role: 'cashier', password: PASSWORD });
    const asCashier = { cookie: cookieFrom(await login(app, slug, 'clerk@corozalhw.example')), ...CSRF };

    const pfx = readFileSync(new URL('./certs/signer-123456.pfx', import.meta.url)).toString('base64');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/certificate/pfx', headers: asCashier, payload: { pfxBase64: pfx, password: 'test-pfx-password' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/api-keys', headers: asCashier, payload: { name: 'x' } })).statusCode, 403);

    const asOwner = { cookie: ownerCookie, ...CSRF };
    const badPassword = await app.inject({ method: 'POST', url: '/v1/certificate/pfx', headers: asOwner, payload: { pfxBase64: pfx, password: 'wrong' } });
    assert.equal(badPassword.statusCode, 422);
    assert.equal(badPassword.json().error.code, 'certificate_problem');
    const installed = await app.inject({ method: 'POST', url: '/v1/certificate/pfx', headers: asOwner, payload: { pfxBase64: pfx, password: 'test-pfx-password' } });
    assert.equal(installed.statusCode, 200, installed.body);
    assert.equal(installed.json().tin, '123456');

    const receipt = await app.inject({
      method: 'POST', url: '/v1/documents', headers: asCashier,
      payload: { type: '02', lines: [{ description: 'Hammer', quantity: '1', unitCode: 'H87', unitPrice: '35.00', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } },
    });
    assert.equal(receipt.statusCode, 201, receipt.body);
    assert.equal(receipt.json().status, 'authorized');
    assert.equal(receipt.json().issuedBy, 'Clerk', 'documents record who issued them');

    const key = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: asOwner, payload: { name: 'POS' } });
    assert.equal(key.statusCode, 201);
    const viaKey = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key.json().key}` } });
    assert.equal(viaKey.json().id, body.business.id);
    const listed = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: asOwner })).json().data;
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(key.json().key), 'secrets are never listed');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${key.json().key}` }, payload: { name: 'y' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/users', headers: { authorization: `Bearer ${key.json().key}` } })).statusCode, 403, 'keys never manage people');
  }));

test('preview returns exact totals for a draft without issuing anything', () =>
  withApp(async (f, app) => {
    const { cookie } = await signUp(app);
    const res = await app.inject({
      method: 'POST', url: '/v1/documents/preview', headers: { cookie, ...CSRF },
      payload: { type: '02', lines: [{ description: 'Coffee', quantity: '3', unitCode: 'H87', unitPrice: '0.04', gstCategory: 'S' }] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().totals, { lineExtension: '0.12', gst: '0.02', tax: '0.02', taxInclusive: '0.14', payable: '0.14' });
    assert.equal(f.bts.requests.length, 0);
    assert.equal((await f.db.query<{ n: number }>('select count(*)::int as n from documents')).rows[0]!.n, 0);
  }));

test('serves the web app: files, client-side routes, JSON 404s for the API, security headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'etd-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Floreo</title><div id="root"></div>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  try {
    await withApp(async (_f, app) => {
      const index = await app.inject({ method: 'GET', url: '/' });
      assert.equal(index.statusCode, 200);
      assert.match(index.body, /<div id="root">/);
      const route = await app.inject({ method: 'GET', url: '/corner-store/documents/123' });
      assert.match(route.body, /<div id="root">/, "a business's pages get index.html");
      assert.equal((await app.inject({ method: 'GET', url: '/app.js' })).body, 'console.log(1)');
      const api = await app.inject({ method: 'GET', url: '/v1/nope', headers: { authorization: 'Bearer x' } });
      assert.equal(api.headers['content-type']?.toString().includes('json'), true);
      assert.match(String(index.headers['content-security-policy']), /default-src 'self'/);
      assert.equal(index.headers['x-content-type-options'], 'nosniff');
    }, { webRoot: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two-step sign-in: setup with a code, sign-in needs the code, recovery codes, required by the business, reset by an admin', () =>
  withApp(async (f, app) => {
    const { cookie, slug } = await signUp(app);
    const owner = { ...CSRF, cookie, 'x-business': slug };
    const code = (secret: string, offset = 0) => totpCode(base32Decode(secret), stepAt(Date.now()) + offset);

    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/two-factor', headers: owner })).json().enabled, false);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/two-factor/setup', headers: owner, payload: { password: 'wrong password' } })).statusCode, 403, 'the password is needed');
    const setup = await app.inject({ method: 'POST', url: '/v1/auth/two-factor/setup', headers: owner, payload: { password: PASSWORD } });
    assert.equal(setup.statusCode, 200, setup.body);
    const { secret, otpauthUrl } = setup.json();
    assert.match(otpauthUrl, /^otpauth:\/\/totp\/.+\?secret=[A-Z2-7]+&issuer=/);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/two-factor/confirm', headers: owner, payload: { code: '123456' } })).statusCode, 422);
    const confirmed = await app.inject({ method: 'POST', url: '/v1/auth/two-factor/confirm', headers: owner, payload: { code: code(secret) } });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const recovery: string[] = confirmed.json().recoveryCodes;
    assert.equal(recovery.length, 10);
    assert.match(recovery[0]!, /^[a-z0-9]{5}-[a-z0-9]{5}$/);

    // Signing in: the password gives a challenge, not a session.
    const step1 = await login(app, slug, 'owner@corozalhw.example');
    assert.equal(step1.statusCode, 200);
    assert.equal(step1.json().twoFactorRequired, true);
    assert.equal(step1.headers['set-cookie'], undefined);
    const verify = (challenge: string, c: string) => app.inject({ method: 'POST', url: '/v1/auth/login/verify', headers: CSRF, payload: { challenge, code: c } });
    assert.equal((await verify(step1.json().challenge, '000000')).statusCode, 401);
    const ok = await verify(step1.json().challenge, code(secret, 1));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(cookieFrom(ok));
    assert.equal(ok.json().twoFactor.enabled, true);

    // A recovery code works once (spaces and capitals do not matter).
    const step2 = (await login(app, slug, 'owner@corozalhw.example')).json();
    assert.equal((await verify(step2.challenge, ` ${recovery[0]!.toUpperCase()} `)).statusCode, 200);
    const step3 = (await login(app, slug, 'owner@corozalhw.example')).json();
    assert.equal((await verify(step3.challenge, recovery[0]!)).statusCode, 401, 'used already');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/two-factor', headers: owner })).json().recoveryCodesLeft, 9);

    // The business requires it for owners and admins: an admin without it must set it up first.
    const admin = await createUser(f.db, { tenantId: (await f.db.query<{ id: string }>('select id from tenants where slug = $1', [slug])).rows[0]!.id, name: 'Ana Admin', email: 'admin@corozalhw.example', role: 'admin', password: PASSWORD });
    const adminLogin = await login(app, slug, 'admin@corozalhw.example');
    const adminHeaders = { ...CSRF, cookie: cookieFrom(adminLogin), 'x-business': slug };
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/business/security', headers: adminHeaders, payload: { requireTwoFactor: true } })).statusCode, 403, 'only an owner');
    const required = await app.inject({ method: 'PUT', url: '/v1/business/security', headers: owner, payload: { requireTwoFactor: true } });
    assert.equal(required.statusCode, 200, required.body);
    assert.equal(required.json().requireTwoFactor, true);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/documents', headers: adminHeaders })).json().error.code, 'two_factor_setup_required');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: adminHeaders })).json().twoFactor.setupRequired, true);
    const adminSecret = (await app.inject({ method: 'POST', url: '/v1/auth/two-factor/setup', headers: adminHeaders, payload: { password: PASSWORD } })).json().secret;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/two-factor/confirm', headers: adminHeaders, payload: { code: code(adminSecret) } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/documents', headers: adminHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/two-factor/disable', headers: adminHeaders, payload: { password: PASSWORD } })).statusCode, 409, 'required for admins');

    // Lost phone: the owner resets the admin's two-step sign-in; their sessions end.
    const users = (await app.inject({ method: 'GET', url: '/v1/users', headers: owner })).json().data;
    assert.equal(users.find((u: { id: string }) => u.id === admin.id).twoFactor, true);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/users/${admin.id}/two-factor/reset`, headers: owner })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: adminHeaders })).statusCode, 401, 'signed out');
    const log = (await app.inject({ method: 'GET', url: '/v1/audit', headers: owner })).json().data.map((e: { action: string }) => e.action);
    for (const a of ['two_factor.enabled', 'business.two_factor_required', 'user.two_factor_reset']) assert.ok(log.includes(a), a);
  }));
