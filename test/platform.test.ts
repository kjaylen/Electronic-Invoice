/**
 * The platform console: staff sign-in, the business list, readiness checks,
 * going live (numbering starts again in production), and going back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createPlatformAdmin, setPlatformAdminStatus } from '../src/db/platform.ts';
import { base32Decode, stepAt, totpCode } from '../src/db/twofactor.ts';
import { createUser } from '../src/db/users.ts';
import { platformOverview } from '../src/api/platform-overview.ts';
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
  /** The staff member's authenticator secret (base32). */
  secret: string;
}

function cookieFrom(res: LightMyRequestResponse, name: string): string {
  const m = new RegExp(`(${name})=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withConsole(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail });
  await createPlatformAdmin(f.db, { email: 'ops@platform.example', name: 'Olga Ops', password: PASSWORD });
  // First sign-in: the password gives the authenticator secret, the first code turns two-step sign-in on.
  const first = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: PASSWORD } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers['set-cookie'], undefined, 'no session from the password alone');
  const { challenge, secret, setup } = first.json();
  assert.equal(setup, true);
  const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge, code: totpCode(base32Decode(secret), stepAt(Date.now())) } });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().recoveryCodes.length, 10);
  const key = (await createApiKey(f.db, f.tenantB, 'tests')).key;
  try {
    await fn({ f, app, mail, staff: { ...CSRF, cookie: cookieFrom(login, 'etd_admin') }, key, secret });
  } finally {
    await app.close();
    await f.close();
  }
}

const receipt = { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } };

test('staff sign-in: own cookie, CSRF, failures throttled, business accounts cannot get in', () =>
  withConsole(async ({ f, app, staff, secret }) => {
    // Later sign-ins: password, then a code (never the same code twice).
    const again = (await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: PASSWORD } })).json();
    assert.equal(again.twoFactorRequired, true);
    assert.equal(again.secret, undefined, 'the secret is only shown at setup');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge: again.challenge, code: '000000' } })).statusCode, 401);
    const code = totpCode(base32Decode(secret), stepAt(Date.now()) + 1);
    const verified = await app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge: again.challenge, code } });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge: again.challenge, code } })).statusCode, 401, 'a challenge is used once');
    const third = (await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: PASSWORD } })).json();
    assert.equal((await app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge: third.challenge, code } })).statusCode, 401, 'a code cannot be replayed');
    const set = String(verified.headers['set-cookie']);
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

test('overview: growth, documents, health and the businesses that need a person, for staff only', () =>
  withConsole(async ({ f, app, staff, key }) => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/overview', headers: { ...CSRF, authorization: `Bearer ${key}` } })).statusCode, 401, 'staff only');

    // A test receipt that BTS authorizes, and one left waiting for BTS.
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/documents', headers: { authorization: `Bearer ${key}` }, payload: receipt })).statusCode, 201);
    f.deps.contingency = { enabled: false };
    f.bts.script(SUBMIT_PATHS['02'], { status: 500, body: 'Rejection: Server error' });
    await app.inject({ method: 'POST', url: '/v1/documents', headers: { authorization: `Bearer ${key}` }, payload: receipt });
    const waiting = (await f.db.query<{ status: string }>("select status from documents where tenant_id = $1 order by created_at desc limit 1", [f.tenantB])).rows[0]!.status;
    assert.equal(waiting, 'pending');
    // Tenant A: its certificate runs out in 10 days, and it is issuing offline.
    await f.db.query("update certificates set valid_to = now() + interval '10 days' where tenant_id = $1 and status = 'active'", [f.tenantA]);
    await f.db.query("insert into contingency_periods (id, tenant_id, reason, started_at) values (gen_random_uuid(), $1, 'BTS unreachable', now() - interval '2 hours')", [f.tenantA]);

    const res = await app.inject({ method: 'GET', url: '/v1/platform/overview', headers: staff });
    assert.equal(res.statusCode, 200, res.body);
    const o = res.json();
    const total = (await f.db.query<{ n: number }>('select count(*)::int as n from tenants')).rows[0]!.n;
    assert.equal(o.businesses.total, total);
    assert.equal(o.businesses.new7, total);
    assert.equal(o.businesses.signups.length, 12);
    assert.equal(o.businesses.signups.at(-1).count, total, 'all of them this week');
    assert.equal(o.documents.last30, 0, 'nothing in production yet');
    assert.ok(o.documents.test30 >= 1);
    assert.equal(o.health.queue.pending, 1);
    assert.ok(!o.attention.some((a: { kind: string }) => a.kind === 'documents_stuck'), 'not stuck yet');

    // An hour later the waiting document is stuck.
    const later = await platformOverview(f.db, new Date(Date.now() + 3600_000));
    const kinds = later.attention.map((a: { kind: string; tenant: { id: string } }) => `${a.kind}:${a.tenant.id === f.tenantA ? 'A' : a.tenant.id === f.tenantB ? 'B' : '?'}`);
    assert.ok(kinds.includes('documents_stuck:B'), kinds.join());
    assert.ok(kinds.includes('outage:A'), kinds.join());
    assert.ok(kinds.includes('certificate_expiring:A'), kinds.join());
    const cert = o.attention.find((a: { kind: string }) => a.kind === 'certificate_expiring');
    assert.equal(cert.days, 10);
    assert.equal(cert.severity, 'reminder');
    assert.ok(o.attention.some((a: { kind: string }) => a.kind === 'outage'));
    // Problems come before reminders.
    const severities = later.attention.map((a: { severity: string }) => a.severity);
    assert.deepEqual(severities, [...severities].sort((x: string, y: string) => (x === y ? 0 : x === 'problem' ? -1 : 1)));
    assert.deepEqual(o.newest.map((n: { tenant: { id: string } }) => n.tenant.id).sort(), [f.tenantA, f.tenantB].sort());
  }));
