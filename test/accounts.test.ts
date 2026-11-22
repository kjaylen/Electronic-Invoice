/**
 * A business managing its own accounts: creating users (temporary password
 * or welcome link), roles and what each may do, deactivating, resetting
 * passwords, signing people out, the activity log, and the business profile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { resetLoginAttempts } from '../src/api/auth.ts';
import { can, canManageRole } from '../src/api/permissions.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { applicationResponse } from './fake-bts.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC_URL = 'https://app.example.test';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  slug: string;
  /** Sign in as a new account of tenant A with this role. */
  as: (role: 'owner' | 'admin' | 'manager' | 'cashier' | 'accountant', name?: string) => Promise<{ headers: Record<string, string>; id: string }>;
}

async function withApp(fn: (c: Ctx) => Promise<void>, options: { mail?: boolean } = {}) {
  resetLoginAttempts();
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC_URL, ...(options.mail !== false && { mailer: mail }) });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  let n = 0;
  const as: Ctx['as'] = async (role, name) => {
    const email = `${role}${++n}@shop.example`;
    const user = await createUser(f.db, { tenantId: f.tenantA, name: name ?? `${role} ${n}`, email, role, password: PASSWORD });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    assert.equal(res.statusCode, 200, res.body);
    return { headers: { ...CSRF, cookie: cookieFrom(res), 'x-business': slug }, id: user.id };
  };
  try {
    await fn({ f, app, mail, slug, as });
  } finally {
    await app.close();
    await f.close();
  }
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, `session cookie set: ${res.body}`);
  return `${m[1]}=${m[2]}`;
}

const tokenIn = (text: string) => {
  const m = /\/reset-password\?token=([A-Za-z0-9_-]{43})/.exec(text);
  assert.ok(m, `link in: ${text}`);
  return m[1]!;
};

test('the role table', () => {
  assert.equal(can('cashier', 'documents.issue'), true);
  assert.equal(can('cashier', 'documents.adjust'), false);
  assert.equal(can('cashier', 'documents.cancel'), false);
  assert.equal(can('accountant', 'documents.issue'), false);
  assert.equal(can('accountant', 'reports.view'), true);
  assert.equal(can('manager', 'users.manage'), false);
  assert.equal(can('api', 'users.manage'), false);
  assert.equal(canManageRole('owner', 'owner'), true);
  assert.equal(canManageRole('admin', 'manager'), true);
  assert.equal(canManageRole('admin', 'admin'), false);
  assert.equal(canManageRole('admin', 'owner'), false);
  assert.equal(canManageRole('manager', 'cashier'), false);
});

test('what each role may do, enforced by the server', () =>
  withApp(async ({ f, app, as }) => {
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
    const cashier = await as('cashier');
    const accountant = await as('accountant');
    const manager = await as('manager');
    const receipt = (h: Record<string, string>) => app.inject({ method: 'POST', url: '/v1/documents', headers: h, payload: { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } } });

    const sold = await receipt(cashier.headers);
    assert.equal(sold.statusCode, 201, 'cashiers issue receipts');
    const doc = sold.json();
    assert.equal((await receipt(accountant.headers)).statusCode, 403, 'accountants do not issue');
    const credit = { type: '04', reference: { documentId: doc.id, reason: 'Returned' }, lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Refund' } };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/documents', headers: cashier.headers, payload: credit })).statusCode, 403, 'cashiers do not issue credit notes');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/documents', headers: manager.headers, payload: credit })).statusCode, 201, 'managers do');
    assert.equal((await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: cashier.headers, payload: { reason: 'x' } })).statusCode, 403, 'cashiers do not cancel');

    assert.equal((await app.inject({ method: 'GET', url: '/v1/reports/summary?from=2000-01-01&to=2001-01-01', headers: cashier.headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/reports/summary?from=2000-01-01&to=2001-01-01', headers: accountant.headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: accountant.headers })).statusCode, 200, 'everyone can read documents');

    // Cashiers can save a new customer while selling, but not edit or archive the catalog.
    const cust = await app.inject({ method: 'POST', url: '/v1/customers', headers: cashier.headers, payload: { name: 'Walk-in Wanda' } });
    assert.equal(cust.statusCode, 201);
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/customers/${cust.json().id}`, headers: cashier.headers, payload: { name: 'W' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/items', headers: cashier.headers, payload: { name: 'X', unitCode: 'H87', unitPrice: '1', gstCategory: 'S' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/customers', headers: accountant.headers, payload: { name: 'No' } })).statusCode, 403);

    for (const h of [cashier.headers, accountant.headers, manager.headers]) {
      assert.equal((await app.inject({ method: 'GET', url: '/v1/users', headers: h })).statusCode, 403);
      assert.equal((await app.inject({ method: 'GET', url: '/v1/audit', headers: h })).statusCode, 403);
      assert.equal((await app.inject({ method: 'PUT', url: '/v1/business', headers: h, payload: { legalName: 'X', address: { street: 'a', city: 'b', districtCode: '1' }, contact: { telephone: '1', email: 'a@b.example' } } })).statusCode, 403);
    }
  }));

test('create a cashier with a username and a temporary password; they must choose their own first', () =>
  withApp(async ({ app, slug, as }) => {
    const owner = await as('owner');
    const res = await app.inject({ method: 'POST', url: '/v1/users', headers: owner.headers, payload: { name: 'Till Two', username: 'Till2', role: 'cashier', password: 'temporary pass 1' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().user.username, 'till2');
    assert.equal(res.json().user.mustChangePassword, true);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/users', headers: owner.headers, payload: { name: 'Dup', username: 'till2', role: 'cashier', password: 'temporary pass 1' } })).statusCode, 422, 'usernames are unique in a business');

    const signedIn = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'till2', password: 'temporary pass 1' } });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.json().user.mustChangePassword, true);
    const h = { ...CSRF, cookie: cookieFrom(signedIn), 'x-business': slug };
    const blocked = await app.inject({ method: 'GET', url: '/v1/documents', headers: h });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.code, 'password_change_required');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/password/change', headers: h, payload: { currentPassword: 'temporary pass 1', newPassword: 'temporary pass 1' } })).statusCode, 422, 'a new password, not the same one');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/password/change', headers: h, payload: { currentPassword: 'temporary pass 1', newPassword: 'my own password' } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/documents', headers: h })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/session', headers: h })).json().user.mustChangePassword, false);
  }));

test('create a manager by email: a welcome link to set their password, also returned to share', () =>
  withApp(async ({ app, mail, slug, as }) => {
    const admin = await as('admin', 'Ada Admin');
    const res = await app.inject({ method: 'POST', url: '/v1/users', headers: admin.headers, payload: { name: 'Mo Manager', email: 'Mo@Shop.example', role: 'manager' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().emailSent, true);
    const sent = mail.sent.at(-1)!;
    assert.equal(sent.to, 'mo@shop.example');
    assert.match(sent.subject, /Ada Admin created your .* account/);
    const token = tokenIn(sent.text);
    assert.equal(new URL(res.json().welcomeUrl).searchParams.get('token'), token);
    assert.equal(new URL(res.json().welcomeUrl).pathname, `/${slug}/reset-password`);

    const info = await app.inject({ method: 'GET', url: `/v1/auth/password/link/${token}` });
    const infoBody = info.json() as Record<string, unknown> & { business: { slug: string } };
    assert.deepEqual({ ...infoBody, business: infoBody.business.slug }, { purpose: 'welcome', name: 'Mo Manager', login: 'mo@shop.example', business: slug });
    const done = await app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token, password: 'manager password' } });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().user.role, 'manager');
    assert.match(String(done.headers['set-cookie']), new RegExp(`^etd_s_${slug}=`));
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token, password: 'again password' } })).statusCode, 400, 'links work once');

    assert.equal((await app.inject({ method: 'POST', url: '/v1/users', headers: admin.headers, payload: { name: 'Nobody', role: 'cashier' } })).statusCode, 422, 'a password or an email is needed');
  }));

test('role hierarchy: admins cannot touch owners or admins; nobody changes their own role; an owner always remains', () =>
  withApp(async ({ app, as }) => {
    const owner = await as('owner');
    const admin = await as('admin');
    const otherAdmin = await as('admin');
    const cashier = await as('cashier');
    const patch = (h: Record<string, string>, id: string, body: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/v1/users/${id}`, headers: h, payload: body });

    assert.equal((await app.inject({ method: 'POST', url: '/v1/users', headers: admin.headers, payload: { name: 'X', email: 'x@shop.example', role: 'owner', password: PASSWORD } })).statusCode, 403);
    assert.equal((await patch(admin.headers, otherAdmin.id, { role: 'cashier' })).statusCode, 403);
    assert.equal((await patch(admin.headers, owner.id, { name: 'Renamed' })).statusCode, 403);
    assert.equal((await patch(admin.headers, cashier.id, { role: 'manager' })).statusCode, 200);
    assert.equal((await patch(admin.headers, cashier.id, { role: 'admin' })).statusCode, 403, 'admins cannot make admins');
    assert.equal((await patch(admin.headers, admin.id, { role: 'owner' })).statusCode, 409, 'not your own role');
    assert.equal((await patch(owner.headers, owner.id, { role: 'manager' })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/users/${owner.id}/disable`, headers: owner.headers })).statusCode, 409, 'not yourself');

    // The only owner cannot be demoted or deactivated, even by another owner made later... until there are two.
    const owner2 = await as('owner');
    assert.equal((await patch(owner2.headers, owner.id, { role: 'admin' })).statusCode, 200, 'fine: owner2 remains');
    assert.equal((await patch(owner.headers, owner2.id, { role: 'admin' })).statusCode, 403, 'owner was demoted, so is an admin now');
    const lastOwner = await app.inject({ method: 'POST', url: `/v1/users/${owner2.id}/disable`, headers: otherAdmin.headers });
    assert.equal(lastOwner.statusCode, 403, 'admins cannot deactivate owners');

    const list = (await app.inject({ method: 'GET', url: '/v1/users', headers: admin.headers })).json().data;
    const self = list.find((u: { id: string }) => u.id === admin.id);
    assert.equal(self.manageable, false, 'the list says what the caller may manage');
    assert.equal(list.find((u: { id: string }) => u.id === cashier.id).manageable, true);
  }));

test('deactivating an account ends its sessions and blocks sign-in; reactivating restores it', () =>
  withApp(async ({ app, slug, as }) => {
    const admin = await as('admin');
    const cashier = await as('cashier');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: cashier.headers })).statusCode, 200);
    const off = await app.inject({ method: 'POST', url: `/v1/users/${cashier.id}/disable`, headers: admin.headers });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().status, 'disabled');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: cashier.headers })).statusCode, 401, 'signed out at once');
    const email = (await app.inject({ method: 'GET', url: '/v1/users', headers: admin.headers })).json().data.find((u: { id: string }) => u.id === cashier.id).email;
    const tryLogin = () => app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    const blocked = await tryLogin();
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.code, 'account_disabled');
    assert.equal((await app.inject({ method: 'POST', url: `/v1/users/${cashier.id}/enable`, headers: admin.headers })).statusCode, 200);
    assert.equal((await tryLogin()).statusCode, 200);
  }));

test('an admin resets a password (temporary, or by link) and signs someone out everywhere', () =>
  withApp(async ({ app, mail, slug, as }) => {
    const admin = await as('admin');
    const cashier = await as('cashier');
    const res = await app.inject({ method: 'POST', url: `/v1/users/${cashier.id}/password`, headers: admin.headers, payload: { password: 'temporary pass 2' } });
    assert.equal(res.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: cashier.headers })).statusCode, 401, 'old sessions end');
    const email = mail.sent.length; // nothing emailed for a temporary password
    const link = await app.inject({ method: 'POST', url: `/v1/users/${cashier.id}/password`, headers: admin.headers, payload: { sendLink: true } });
    assert.equal(link.statusCode, 200);
    assert.equal(mail.sent.length, email + 1);
    assert.match(link.json().link, new RegExp(`/${slug}/reset-password\\?token=`));

    const again = await as('manager');
    const out = await app.inject({ method: 'POST', url: `/v1/users/${again.id}/sign-out`, headers: admin.headers });
    assert.equal(out.json().sessionsEnded, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: again.headers })).statusCode, 401);
  }));

test('forgot password at the business: emailed one-time link, no account enumeration', () =>
  withApp(async ({ app, mail, slug, as }) => {
    const owner = await as('owner', 'Rosa');
    const email = (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: owner.headers })).json().user.email;
    const forgot = (e: string) => app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { business: slug, email: e } });
    assert.equal((await forgot('nobody@shop.example')).statusCode, 204);
    assert.equal((await forgot(email.toUpperCase())).statusCode, 204);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mail.sent.length, 1);
    const token = tokenIn(mail.sent[0]!.text);
    const ok = await app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token, password: 'a brand new password' } });
    assert.equal(ok.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: owner.headers })).statusCode, 401, 'old sessions end');
  }));

test('forgot password without email configured answers 503; welcome links still come back to share', () =>
  withApp(async ({ app, slug, as }) => {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { business: slug, email: 'a@b.example' } })).statusCode, 503);
    const owner = await as('owner');
    const res = await app.inject({ method: 'POST', url: '/v1/users', headers: owner.headers, payload: { name: 'Mo', email: 'mo@shop.example', role: 'manager' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().emailSent, false);
    assert.match(res.json().welcomeUrl, /\/reset-password\?token=/);
  }, { mail: false }));

test('the activity log records sign-ins, account changes, certificate and cancellations', () =>
  withApp(async ({ f, app, slug, as }) => {
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    f.bts.script(SUBMIT_PATHS['05'], { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: '0'.repeat(44) }) });
    const owner = await as('owner', 'Olive Owner');
    await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'ghost@shop.example', password: 'wrong wrong' } });
    const created = (await app.inject({ method: 'POST', url: '/v1/users', headers: owner.headers, payload: { name: 'Cal', username: 'cal', role: 'cashier', password: PASSWORD } })).json().user;
    await app.inject({ method: 'PATCH', url: `/v1/users/${created.id}`, headers: owner.headers, payload: { role: 'manager' } });
    const doc = (await app.inject({ method: 'POST', url: '/v1/documents', headers: owner.headers, payload: { type: '02', lines: [{ description: 'Pen', quantity: '1', unitCode: 'H87', unitPrice: '2', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } } })).json();
    await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: owner.headers, payload: { reason: 'Mistake' } });

    const log = (await app.inject({ method: 'GET', url: '/v1/audit?limit=20', headers: owner.headers })).json().data;
    const actions = log.map((e: { action: string }) => e.action);
    for (const a of ['login', 'login.failed', 'user.created', 'user.updated', 'document.cancelled']) assert.ok(actions.includes(a), a);
    const change = log.find((e: { action: string }) => e.action === 'user.updated');
    assert.deepEqual(change.details, { role: { from: 'cashier', to: 'manager' } });
    assert.equal(change.user.name, 'Olive Owner');
    assert.equal(change.target, 'cal');
    assert.equal(log.find((e: { action: string }) => e.action === 'login.failed').target, 'ghost@shop.example');

    const page1 = (await app.inject({ method: 'GET', url: '/v1/audit?limit=2', headers: owner.headers })).json();
    assert.equal(page1.data.length, 2);
    const page2 = (await app.inject({ method: 'GET', url: `/v1/audit?limit=2&before=${page1.nextBefore}`, headers: owner.headers })).json();
    assert.ok(page2.data[0].id < page1.data[1].id, 'the next page continues before the last one shown');
    await assert.rejects(f.db.query('delete from audit_events'), /permanent/, 'the log cannot be erased');
  }));

test('business profile: edit details; only owners change the address, and their session follows it', () =>
  withApp(async ({ app, slug, as }) => {
    const admin = await as('admin');
    const owner = await as('owner');
    const current = (await app.inject({ method: 'GET', url: '/v1/business', headers: admin.headers })).json();
    assert.equal(current.slug, slug);
    const body = { legalName: current.legalName, tradeName: 'Shiny New Name', address: current.address, contact: current.contact };
    const ok = await app.inject({ method: 'PUT', url: '/v1/business', headers: admin.headers, payload: body });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().tradeName, 'Shiny New Name');
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/business', headers: admin.headers, payload: { ...body, slug: 'shiny-new' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/business', headers: owner.headers, payload: { ...body, slug: 'login' } })).statusCode, 422);

    const moved = await app.inject({ method: 'PUT', url: '/v1/business', headers: owner.headers, payload: { ...body, slug: 'shiny-new' } });
    assert.equal(moved.statusCode, 200);
    const cookies = moved.headers['set-cookie'] as string[];
    assert.ok(cookies.some((c) => c.startsWith('etd_s_shiny-new=')), 'the session moves to the new cookie name');
    assert.ok(cookies.some((c) => c.startsWith(`etd_s_${slug}=;`)), 'and the old one is cleared');
    const newCookie = cookies.find((c) => c.startsWith('etd_s_shiny-new='))!.split(';')[0]!;
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: newCookie, 'x-business': 'shiny-new' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/business/shiny-new' })).json().name, 'Shiny New Name');
  }));
