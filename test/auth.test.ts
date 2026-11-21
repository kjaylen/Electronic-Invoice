import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { resetLoginAttempts } from '../src/api/auth.ts';
import { addMembership, createUser } from '../src/db/users.ts';
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
  resetLoginAttempts();
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

function cookieFrom(res: LightMyRequestResponse): string {
  const header = String(res.headers['set-cookie'] ?? '');
  const m = /etd_session=([^;]*)/.exec(header);
  assert.ok(m, 'session cookie set');
  return `etd_session=${m[1]}`;
}

async function signUp(app: FastifyInstance, email = 'owner@corozalhw.example') {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { name: 'Maria Owner', email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, res.body);
  return cookieFrom(res);
}

test('sign up sets a secure httpOnly session cookie; a new account must create a business first', () =>
  withApp(async (_f, app) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { name: 'Maria Owner', email: 'Owner@CorozalHW.example', password: PASSWORD } });
    assert.equal(res.statusCode, 201);
    const setCookie = String(res.headers['set-cookie']);
    for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(setCookie.includes(flag), flag);
    assert.equal(res.json().user.email, 'owner@corozalhw.example', 'emails are stored lower-case');
    assert.deepEqual(res.json().businesses, []);

    const cookie = cookieFrom(res);
    const session = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    assert.equal(session.statusCode, 200);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    assert.equal(me.statusCode, 409);
    assert.equal(me.json().error.code, 'no_business');

    const created = await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie, ...CSRF }, payload: BUSINESS });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().businesses[0].role, 'owner');
    assert.equal(created.json().businesses[0].environment, 'test', 'self-service businesses start in the test environment');
    const me2 = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    assert.equal(me2.statusCode, 200);
    assert.equal(me2.json().legalName, 'Corozal Hardware Ltd.');
  }));

test('sign-up rules: weak password, duplicate email, closed sign-up', async () => {
  await withApp(async (_f, app) => {
    const weak = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { name: 'A', email: 'a@b.example', password: 'short' } });
    assert.equal(weak.statusCode, 422);
    await signUp(app, 'dup@b.example');
    const dup = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { name: 'B', email: 'DUP@b.example', password: PASSWORD } });
    assert.equal(dup.statusCode, 422);
  });
  await withApp(async (_f, app) => {
    const closed = await app.inject({ method: 'POST', url: '/v1/auth/signup', headers: CSRF, payload: { name: 'A', email: 'a@b.example', password: PASSWORD } });
    assert.equal(closed.statusCode, 403);
  }, { allowSignup: false });
});

test('CSRF: cookie-authenticated changes need the X-Requested-With header; reads do not', () =>
  withApp(async (_f, app) => {
    const cookie = await signUp(app);
    await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie, ...CSRF }, payload: BUSINESS });
    const forged = await app.inject({ method: 'POST', url: '/v1/customers', headers: { cookie }, payload: { name: 'Forged' } });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.json().error.code, 'csrf');
    const forgedAuth = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    assert.equal(forgedAuth.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/customers', headers: { cookie, ...CSRF }, payload: { name: 'Real' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/customers', headers: { cookie } })).statusCode, 200);
  }));

test('log in and out; wrong password and unknown email look the same; repeated failures are throttled', () =>
  withApp(async (_f, app) => {
    await signUp(app);
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'owner@corozalhw.example', password: 'nope nope nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'nobody@corozalhw.example', password: 'nope nope nope' } });
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), unknown.json());

    const ok = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'OWNER@corozalhw.example', password: PASSWORD } });
    assert.equal(ok.statusCode, 200);
    const cookie = cookieFrom(ok);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode, 200);
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, ...CSRF } });
    assert.equal(out.statusCode, 204);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).statusCode, 401, 'the old cookie no longer works');

    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'owner@corozalhw.example', password: 'guess guess guess' } })).statusCode;
    }
    assert.equal(last, 429);
  }));

test('passwords and session tokens are never stored in plaintext', () =>
  withApp(async (f, app) => {
    const cookie = await signUp(app);
    const token = cookie.split('=')[1]!;
    const user = (await f.db.query<{ password_hash: string }>('select password_hash from users')).rows[0]!;
    assert.match(user.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!user.password_hash.includes(PASSWORD));
    const hit = (await f.db.query<{ n: number }>('select count(*)::int as n from sessions where token_hash = $1', [token])).rows[0]!.n;
    assert.equal(hit, 0, 'only a hash of the token is stored');
  }));

test('roles: a member can issue but cannot touch the certificate or API keys; an owner can', () =>
  withApp(async (f, app) => {
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const ownerCookie = await signUp(app);
    const business = (await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie: ownerCookie, ...CSRF }, payload: BUSINESS })).json();
    const businessId = business.currentBusinessId;

    const member = await createUser(f.db, { email: 'clerk@corozalhw.example', name: 'Clerk', password: PASSWORD });
    await addMembership(f.db, member.id, businessId, 'member');
    const memberCookie = cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'clerk@corozalhw.example', password: PASSWORD } }));
    const asMember = { cookie: memberCookie, ...CSRF };

    const pfx = readFileSync(new URL('./certs/signer-123456.pfx', import.meta.url)).toString('base64');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/certificate/pfx', headers: asMember, payload: { pfxBase64: pfx, password: 'test-pfx-password' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/api-keys', headers: asMember, payload: { name: 'x' } })).statusCode, 403);

    // The owner installs the certificate from the .pfx file.
    const asOwner = { cookie: ownerCookie, ...CSRF };
    const badPassword = await app.inject({ method: 'POST', url: '/v1/certificate/pfx', headers: asOwner, payload: { pfxBase64: pfx, password: 'wrong' } });
    assert.equal(badPassword.statusCode, 422);
    assert.equal(badPassword.json().error.code, 'certificate_problem');
    const installed = await app.inject({ method: 'POST', url: '/v1/certificate/pfx', headers: asOwner, payload: { pfxBase64: pfx, password: 'test-pfx-password' } });
    assert.equal(installed.statusCode, 200, installed.body);
    assert.equal(installed.json().tin, '123456');

    // The member issues a receipt.
    const receipt = await app.inject({
      method: 'POST', url: '/v1/documents', headers: asMember,
      payload: { type: '02', lines: [{ description: 'Hammer', quantity: '1', unitCode: 'H87', unitPrice: '35.00', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } },
    });
    assert.equal(receipt.statusCode, 201, receipt.body);
    assert.equal(receipt.json().status, 'authorized');

    // The owner creates an API key for the shop's POS, and it works.
    const key = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: asOwner, payload: { name: 'POS' } });
    assert.equal(key.statusCode, 201);
    const viaKey = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key.json().key}` } });
    assert.equal(viaKey.json().id, businessId);
    const listed = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: asOwner })).json().data;
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(key.json().key), 'secrets are never listed');
    // An API key cannot mint more API keys.
    assert.equal((await app.inject({ method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${key.json().key}` }, payload: { name: 'y' } })).statusCode, 403);
  }));

test('switching business, and only to businesses you belong to', () =>
  withApp(async (f, app) => {
    const cookie = await signUp(app);
    const a = (await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie, ...CSRF }, payload: BUSINESS })).json().currentBusinessId;
    const b = (await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie, ...CSRF }, payload: { ...BUSINESS, legalName: 'Second Shop', tin: '222333' } })).json();
    assert.equal(b.businesses.length, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json().legalName, 'Second Shop');
    await app.inject({ method: 'POST', url: '/v1/auth/switch', headers: { cookie, ...CSRF }, payload: { businessId: a } });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).json().legalName, 'Corozal Hardware Ltd.');
    const foreign = await app.inject({ method: 'POST', url: '/v1/auth/switch', headers: { cookie, ...CSRF }, payload: { businessId: f.tenantB } });
    assert.equal(foreign.statusCode, 404);
    const dup = await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie, ...CSRF }, payload: BUSINESS });
    assert.equal(dup.statusCode, 409, 'one business per TIN per environment');
  }));

test('preview returns exact totals for a draft without issuing anything', () =>
  withApp(async (f, app) => {
    const cookie = await signUp(app);
    await app.inject({ method: 'POST', url: '/v1/auth/businesses', headers: { cookie, ...CSRF }, payload: BUSINESS });
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
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>eInvoicing</title><div id="root"></div>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  try {
    await withApp(async (_f, app) => {
      const index = await app.inject({ method: 'GET', url: '/' });
      assert.equal(index.statusCode, 200);
      assert.match(index.body, /<div id="root">/);
      const route = await app.inject({ method: 'GET', url: '/documents/123' });
      assert.match(route.body, /<div id="root">/, 'client-side routes get index.html');
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
