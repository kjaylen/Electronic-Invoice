/**
 * The platform console: staff sign-in, the business list, readiness checks,
 * going live (numbering starts again in production), and going back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { resetLoginAttempts } from '../src/api/auth.ts';
import { resetPlatformLimits } from '../src/api/platform.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createPlatformAdmin, setPlatformAdminStatus } from '../src/db/platform.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'platform staff password';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  staff: Record<string, string>;
  /** An API key for tenant B (TIN 654321), which starts in the test environment like tenant A. */
  key: string;
}

function cookieFrom(res: LightMyRequestResponse, name: string): string {
  const m = new RegExp(`(${name})=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withConsole(fn: (c: Ctx) => Promise<void>) {
  resetLoginAttempts();
  resetPlatformLimits();
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail });
  await createPlatformAdmin(f.db, { email: 'ops@platform.example', name: 'Olga Ops', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const key = (await createApiKey(f.db, f.tenantB, 'tests')).key;
  try {
    await fn({ f, app, mail, staff: { ...CSRF, cookie: cookieFrom(login, 'etd_admin') }, key });
  } finally {
    await app.close();
    await f.close();
  }
}

const receipt = { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } };

test('staff sign-in: own cookie, CSRF, failures throttled, business accounts cannot get in', () =>
  withConsole(async ({ f, app, staff }) => {
    const set = String((await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: PASSWORD } })).headers['set-cookie']);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(set.includes(flag), flag);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/auth/session', headers: staff })).json().admin.name, 'Olga Ops');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/tenants' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/platform/auth/logout', headers: { cookie: staff.cookie } })).statusCode, 403, 'CSRF header required');

    // A business owner's session is not a staff session.
    await createUser(f.db, { tenantId: f.tenantA, name: 'Owner', email: 'owner@biz.example', role: 'owner', password: PASSWORD });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'owner@biz.example', password: PASSWORD } })).statusCode, 401);

    let last = 0;
    for (let i = 0; i < 6; i++) last = (await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: 'wrong wrong' } })).statusCode;
    assert.equal(last, 429);

    await setPlatformAdminStatus(f.db, 'ops@platform.example', 'disabled');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/tenants', headers: staff })).statusCode, 401, 'disabling signs staff out');
  }));

test('business list and details: readiness checks for production', () =>
  withConsole(async ({ f, app, staff, key }) => {
    const list = (await app.inject({ method: 'GET', url: '/v1/platform/tenants?environment=test', headers: staff })).json().data;
    assert.equal(list.length, 2);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/platform/tenants?q=654321', headers: staff })).json().data.map((t: { tin: string }) => t.tin), ['654321']);

    let detail = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${f.tenantB}`, headers: staff })).json();
    assert.equal(detail.environment, 'test');
    assert.equal(detail.readiness.ready, true, 'a certificate and nothing in flight');
    assert.equal(detail.readiness.checks.find((c: { key: string }) => c.key === 'tested').ok, false, 'not yet tested: a warning, not a blocker');

    // A document stuck waiting for BTS blocks going live.
    f.bts.script(SUBMIT_PATHS['02'], { status: 500, body: 'Rejection: Server error' });
    await app.inject({ method: 'POST', url: '/v1/documents', headers: { authorization: `Bearer ${key}` }, payload: receipt });
    detail = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${f.tenantB}`, headers: staff })).json();
    assert.equal(detail.readiness.ready, false);
    const blocked = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/go-live`, headers: staff, payload: { confirmTin: '654321', approvalReference: 'BTS-2026-001' } });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, 'not_ready');
  }));

test('going live: TIN confirmation, numbering starts again in production, owners told, logged on both sides', () =>
  withConsole(async ({ f, app, mail, staff, key }) => {
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    await createUser(f.db, { tenantId: f.tenantB, name: 'Pat Owner', email: 'pat@biz.example', role: 'owner', password: PASSWORD });
    const viaKey = { authorization: `Bearer ${key}` };
    const testDoc = (await app.inject({ method: 'POST', url: '/v1/documents', headers: viaKey, payload: receipt })).json();
    await app.inject({ method: 'POST', url: '/v1/documents', headers: viaKey, payload: receipt });
    assert.equal(testDoc.environment, 'test');

    const wrong = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/go-live`, headers: staff, payload: { confirmTin: '111111', approvalReference: 'BTS-2026-001' } });
    assert.equal(wrong.statusCode, 422);
    const live = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/go-live`, headers: staff, payload: { confirmTin: '654321', approvalReference: 'BTS-2026-001' } });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/go-live`, headers: staff, payload: { confirmTin: '654321', approvalReference: 'x-again' } })).statusCode, 409);

    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: viaKey })).json();
    assert.equal(me.environment, 'production');
    const prodDoc = (await app.inject({ method: 'POST', url: '/v1/documents', headers: viaKey, payload: receipt })).json();
    assert.equal(prodDoc.environment, 'production');
    assert.equal(prodDoc.number, '000000001', 'production numbering starts at 1');
    assert.equal(prodDoc.etdui.slice(32, 34), '01', 'the ETDUI says production');
    const sent = f.bts.requests.filter((r) => r.path === SUBMIT_PATHS['02']).at(-1)!.body;
    assert.doesNotMatch(sent, new RegExp(testDoc.etdui), 'the chain does not continue from test documents');

    const listed = (await app.inject({ method: 'GET', url: '/v1/documents', headers: viaKey })).json().data;
    assert.deepEqual(listed.map((d: { id: string }) => d.id), [prodDoc.id], 'the list shows production documents');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/documents?environment=test', headers: viaKey })).json().data.length, 2, 'test ones on request');
    const today = prodDoc.issueDate;
    assert.equal((await app.inject({ method: 'GET', url: `/v1/reports/summary?from=${today}&to=${today}`, headers: viaKey })).json().totals.documents, 1, 'reports count only production');

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(mail.sent.some((m) => m.to === 'pat@biz.example' && /is live with BTS/.test(m.subject)));
    const detail = (await app.inject({ method: 'GET', url: `/v1/platform/tenants/${f.tenantB}`, headers: staff })).json();
    assert.equal(detail.approvalReference, 'BTS-2026-001');
    assert.ok(detail.productionSince);
    assert.equal(detail.history[0].action, 'tenant.went_live');
    assert.equal(detail.history[0].admin, 'Olga Ops');
    const bizLog = (await f.db.query<{ action: string }>(`select action from audit_events where tenant_id = $1 order by id desc limit 1`, [f.tenantB])).rows[0]!;
    assert.equal(bizLog.action, 'business.went_live', 'the business sees it in its own activity log');
    const platformLog = (await app.inject({ method: 'GET', url: '/v1/platform/audit', headers: staff })).json().data.map((e: { action: string }) => e.action);
    assert.ok(platformLog.includes('tenant.went_live'));

    // Once something was issued in production, there is no going back.
    const back = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/back-to-test`, headers: staff, payload: { confirmTin: '654321', reason: 'oops' } });
    assert.equal(back.statusCode, 409);
    assert.equal(back.json().error.code, 'has_production_documents');
  }));

test('back to test works while nothing was issued in production; retiring the certificate on go-live', () =>
  withConsole(async ({ f, app, staff, key }) => {
    const live = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/go-live`, headers: staff, payload: { confirmTin: '654321', approvalReference: 'BTS-7', retireCertificate: true } });
    assert.equal(live.statusCode, 200);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(me.certificate, null, 'the business installs its production certificate');
    const back = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${f.tenantB}/back-to-test`, headers: staff, payload: { confirmTin: '654321', reason: 'BTS approval was for another TIN' } });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/platform/tenants/${f.tenantB}`, headers: staff })).json().environment, 'test');
  }));
