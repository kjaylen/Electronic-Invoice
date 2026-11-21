/**
 * Web app features: editing the catalog, document search, password reset,
 * teammates, sending documents (email, share links) and reports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { resetLoginAttempts } from '../src/api/auth.ts';
import { csvCell } from '../src/api/reports.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { addMembership, createUser } from '../src/db/users.ts';
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
  key: string;
  as: (key: string) => { authorization: string };
}

async function withApp(fn: (c: Ctx) => Promise<void>, options: { mail?: boolean; publicUrl?: boolean } = {}) {
  resetLoginAttempts();
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({
    pipeline: f.deps,
    cookieSecure: true,
    ...(options.mail !== false && { mailer: mail }),
    ...(options.publicUrl !== false && { publicUrl: PUBLIC_URL }),
  });
  const key = (await createApiKey(f.db, f.tenantA, 'tests')).key;
  try {
    await fn({ f, app, mail, key, as: (k) => ({ authorization: `Bearer ${k}` }) });
  } finally {
    await app.close();
    await f.close();
  }
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /etd_session=([^;]*)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, `session cookie set: ${res.body}`);
  return `etd_session=${m[1]}`;
}

/** A person with a session, as owner or member of tenant A. */
async function person(c: Ctx, email: string, role: 'owner' | 'member' = 'owner'): Promise<{ cookie: string; id: string }> {
  const user = await createUser(c.f.db, { email, name: email.split('@')[0]!, password: PASSWORD });
  await addMembership(c.f.db, user.id, c.f.tenantA, role);
  const res = await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: cookieFrom(res), id: user.id };
}

const linkToken = (text: string, path: string) => {
  const m = new RegExp(`${PUBLIC_URL}${path}\\?token=([A-Za-z0-9_-]{43})`).exec(text);
  assert.ok(m, `link to ${path} in: ${text}`);
  return m[1]!;
};

async function issue(c: Ctx, body: Record<string, unknown>) {
  const res = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.as(c.key), payload: { payment: { meansCode: '10', terms: 'Paid in cash' }, ...body } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

const line = (description: string, quantity: string, unitPrice: string, gstCategory = 'S') => ({ description, quantity, unitCode: 'H87', unitPrice, gstCategory, ...(gstCategory === 'E' && { exemptionReasonCode: 'MED' }) });

// ---------- catalog ----------

test('customers can be edited and archived; issued documents keep the old details', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const created = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.as(c.key), payload: { name: 'Old Name Ltd', address: { street: '1 Main', city: 'Belmopan', districtCode: '2' } } })).json();
    const doc = await issue(c, { type: '01', customerId: created.id, lines: [line('Desk', '1', '100')] });

    const put = await c.app.inject({ method: 'PUT', url: `/v1/customers/${created.id}`, headers: c.as(c.key), payload: { name: 'New Name Ltd', tin: '111222', contact: { email: 'a@new.example' } } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().name, 'New Name Ltd');
    assert.equal(put.json().address, null, 'PUT replaces every field');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: c.as(c.key) })).json().customer.name, 'Old Name Ltd');

    const found = (await c.app.inject({ method: 'GET', url: '/v1/customers?q=a@new', headers: c.as(c.key) })).json();
    assert.equal(found.data.length, 1, 'search also matches email');

    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/customers/${created.id}`, headers: c.as(c.key) })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/customers', headers: c.as(c.key) })).json().data.length, 0, 'archived customers leave the list');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/customers/${created.id}`, headers: c.as(c.key) })).json().archived, true);

    const otherKey = (await createApiKey(c.f.db, c.f.tenantB, 'b')).key;
    assert.equal((await c.app.inject({ method: 'PUT', url: `/v1/customers/${created.id}`, headers: c.as(otherKey), payload: { name: 'x' } })).statusCode, 404);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/customers/${created.id}`, headers: c.as(otherKey) })).statusCode, 404);
  }));

test('items: edit, favourite, barcode lookup, search, archive', () =>
  withApp(async (c) => {
    const post = (payload: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/items', headers: c.as(c.key), payload });
    const coffee = (await post({ name: 'Coffee', unitCode: 'H87', unitPrice: '4.50', gstCategory: 'S', barcode: '7501234567890', favorite: true })).json();
    await post({ name: 'Tea', sellerCode: 'TEA-1', unitCode: 'H87', unitPrice: '3', gstCategory: 'S' });
    const dup = await post({ name: 'Other', unitCode: 'H87', unitPrice: '1', gstCategory: 'S', barcode: '7501234567890' });
    assert.equal(dup.statusCode, 409);

    const get = async (q: string) => (await c.app.inject({ method: 'GET', url: `/v1/items?${q}`, headers: c.as(c.key) })).json().data.map((i: { name: string }) => i.name);
    assert.deepEqual(await get('code=7501234567890'), ['Coffee']);
    assert.deepEqual(await get('code=tea-1'), ['Tea'], 'your own code matches regardless of case');
    assert.deepEqual(await get('favorite=true'), ['Coffee']);
    assert.deepEqual(await get('q=te'), ['Tea']);

    const put = await c.app.inject({ method: 'PUT', url: `/v1/items/${coffee.id}`, headers: c.as(c.key), payload: { name: 'Coffee, large', unitCode: 'H87', unitPrice: '5.25', gstCategory: 'S', barcode: '7501234567890' } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().unitPrice, '5.25');
    assert.equal(put.json().favorite, false);

    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/items/${coffee.id}`, headers: c.as(c.key) })).statusCode, 204);
    assert.deepEqual(await get('code=7501234567890'), []);
    assert.equal((await post({ name: 'New coffee', unitCode: 'H87', unitPrice: '5', gstCategory: 'S', barcode: '7501234567890' })).statusCode, 201, 'archiving frees the barcode');
  }));

// ---------- documents ----------

test('document search: number, customer name or TIN, date range, customer; detail has lines', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const cust = (await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.as(c.key), payload: { name: 'Sunrise Bakery', tin: '445566', address: { street: '2 Front St', city: 'Dangriga', districtCode: '5' } } })).json();
    const inv = await issue(c, { type: '01', customerId: cust.id, lines: [line('Flour sack', '3', '45.00')] });
    await issue(c, { type: '02', lines: [line('Bread', '2', '2.50')] });
    await issue(c, { type: '02', customer: { name: 'Maya Gomez' }, lines: [line('Cake', '1', '30')] });

    const ids = async (q: string) => (await c.app.inject({ method: 'GET', url: `/v1/documents?${q}`, headers: c.as(c.key) })).json().data.map((d: { id: string }) => d.id);
    assert.deepEqual(await ids('q=sunrise'), [inv.id]);
    assert.deepEqual(await ids('q=445566'), [inv.id]);
    assert.deepEqual(await ids(`q=${inv.etdui}`), [inv.id]);
    assert.deepEqual(await ids('q=001-000000001&type=01'), [inv.id]);
    assert.equal((await ids('q=1')).length, 2, 'serial 1 of the invoice series and of the receipt series');
    assert.equal((await ids(`customerId=${cust.id}`)).length, 1);
    assert.equal((await ids('q=maya')).length, 1);
    assert.equal((await ids(`from=${inv.issueDate}&to=${inv.issueDate}`)).length, 3);
    assert.equal((await ids('from=2001-01-01&to=2001-12-31')).length, 0);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents?from=yesterday', headers: c.as(c.key) })).statusCode, 400);

    const detail = (await c.app.inject({ method: 'GET', url: `/v1/documents/${inv.id}`, headers: c.as(c.key) })).json();
    assert.deepEqual(detail.lines, [{ lineNumber: 1, description: 'Flour sack', quantity: '3', unitCode: 'H87', unitPrice: '45.00', gstCategory: 'S', net: '135.00', gst: '16.88', tax: '16.88', total: '151.88' }]);
  }));

test('email a document: PDF and XML attached, recorded; needs email set up', async () => {
  await withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const doc = await issue(c, { type: '01', customer: { name: 'Coral Reef Tours', address: { street: '9 Barrier Rd', city: 'San Pedro', districtCode: '1' } }, lines: [line('Snorkel tour', '2', '80')] });
    const res = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/email`, headers: c.as(c.key), payload: { to: 'billing@coralreef.example', message: 'Thank you!' } });
    assert.equal(res.statusCode, 200, res.body);
    const sent = c.mail.sent.at(-1)!;
    assert.equal(sent.to, 'billing@coralreef.example');
    assert.match(sent.subject, /Tax Invoice 001-000000001/i);
    assert.match(sent.text, /Thank you!/);
    assert.deepEqual(sent.attachments!.map((a) => a.contentType), ['application/pdf', 'application/xml']);
    assert.equal((sent.attachments![0]!.content as Buffer).subarray(0, 5).toString(), '%PDF-');
    assert.ok(sent.replyTo, 'replies go to the business');

    const log = (await c.app.inject({ method: 'GET', url: `/v1/documents/${doc.id}/messages`, headers: c.as(c.key) })).json();
    assert.deepEqual(log.data.map((m: { recipient: string; status: string }) => [m.recipient, m.status]), [['billing@coralreef.example', 'sent']]);

    const bad = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/email`, headers: c.as(c.key), payload: { to: 'a@b.example, c@d.example' } });
    assert.equal(bad.statusCode, 400, 'one recipient only');
  });
  await withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    const doc = await issue(c, { type: '01', customer: { name: 'X', address: { street: '1', city: 'Y', districtCode: '1' } }, lines: [line('A', '1', '1')] });
    const res = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/email`, headers: c.as(c.key), payload: { to: 'a@b.example' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'email_unavailable');
  }, { mail: false });
});

test('share links: the customer opens the PDF without logging in; cancelled documents stop working', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['05'], { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: '0'.repeat(44) }) });
    const doc = await issue(c, { type: '02', lines: [line('Haircut', '1', '25')] });
    const res = await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/share`, headers: c.as(c.key) });
    assert.equal(res.statusCode, 201, res.body);
    const url = new URL(res.json().url);
    assert.equal(url.origin, PUBLIC_URL);
    assert.match(url.pathname, /^\/d\/[A-Za-z0-9_-]{43}$/);

    const pdf = await c.app.inject({ method: 'GET', url: url.pathname });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['x-robots-tag'], 'noindex');
    assert.match(String(pdf.headers['cache-control']), /no-store/);
    assert.equal((await c.app.inject({ method: 'GET', url: `${url.pathname}?format=receipt` })).statusCode, 200);

    const wrong = await c.app.inject({ method: 'GET', url: `/d/${'A'.repeat(43)}` });
    assert.equal(wrong.statusCode, 404);
    assert.match(String(wrong.headers['content-type']), /text\/html/);

    await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/cancel`, headers: c.as(c.key), payload: { reason: 'Wrong price' } });
    const after = await c.app.inject({ method: 'GET', url: url.pathname });
    assert.equal(after.statusCode, 404);
    assert.match(after.body, /no longer valid/);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/share`, headers: c.as(c.key) })).statusCode, 409);
  }));

// ---------- passwords ----------

test('password reset by email: one-time link, signs out old sessions, no account enumeration', () =>
  withApp(async (c) => {
    const owner = await person(c, 'reset@shop.example');
    const forgot = (email: string) => c.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { email } });

    assert.equal((await forgot('nobody@shop.example')).statusCode, 204, 'same answer for unknown emails');
    assert.equal((await forgot('RESET@shop.example')).statusCode, 204);
    await new Promise((r) => setTimeout(r, 50)); // the email is sent in the background
    assert.equal(c.mail.sent.length, 1, 'only the real account gets an email');
    const token = linkToken(c.mail.sent[0]!.text, '/reset-password');

    const weak = await c.app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token, password: 'short' } });
    assert.equal(weak.statusCode, 422);
    const ok = await c.app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token, password: 'a brand new password' } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().currentBusinessId, c.f.tenantA, 'signed straight back in');
    const fresh = cookieFrom(ok);

    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: owner.cookie } })).statusCode, 401, 'old sessions are signed out');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: fresh } })).statusCode, 200);
    const reuse = await c.app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token, password: 'another new password' } });
    assert.equal(reuse.statusCode, 400, 'the link works once');
    const login = await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'reset@shop.example', password: 'a brand new password' } });
    assert.equal(login.statusCode, 200);

    // A second request replaces the first link.
    await forgot('reset@shop.example');
    await forgot('reset@shop.example');
    await new Promise((r) => setTimeout(r, 50));
    const [older, newer] = c.mail.sent.slice(-2).map((m) => linkToken(m.text, '/reset-password'));
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token: older, password: 'x'.repeat(12) } })).statusCode, 400);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/auth/password/reset', headers: CSRF, payload: { token: newer, password: 'x'.repeat(12) } })).statusCode, 200);
  }));

test('change password: needs the current one, keeps this session, signs out others', () =>
  withApp(async (c) => {
    const a = await person(c, 'change@shop.example');
    const other = cookieFrom(await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'change@shop.example', password: PASSWORD } }));
    const change = (currentPassword: string) => c.app.inject({ method: 'POST', url: '/v1/auth/password/change', headers: { ...CSRF, cookie: a.cookie }, payload: { currentPassword, newPassword: 'my new password!' } });
    assert.equal((await change('wrong password')).statusCode, 422);
    assert.equal((await change(PASSWORD)).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: a.cookie } })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: other } })).statusCode, 401);
  }));

test('forgot password without email or PUBLIC_URL configured answers 503', async () => {
  await withApp(async (c) => {
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { email: 'a@b.example' } })).statusCode, 503);
  }, { mail: false });
  await withApp(async (c) => {
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { email: 'a@b.example' } })).statusCode, 503);
  }, { publicUrl: false });
});

// ---------- team ----------

test('invite a teammate: new account from the link, then roles and removal', () =>
  withApp(async (c) => {
    const owner = await person(c, 'owner@shop.example');
    const asOwner = { ...CSRF, cookie: owner.cookie };
    const invite = await c.app.inject({ method: 'POST', url: '/v1/team/invitations', headers: asOwner, payload: { email: 'Cashier@Shop.example', role: 'member' } });
    assert.equal(invite.statusCode, 201, invite.body);
    assert.equal(invite.json().emailSent, true);
    const token = linkToken(c.mail.sent[0]!.text, '/invite');
    assert.equal(new URL(invite.json().inviteUrl).searchParams.get('token'), token, 'the owner also gets the link to share another way');
    assert.equal(c.mail.sent[0]!.to, 'cashier@shop.example');

    const info = await c.app.inject({ method: 'GET', url: `/v1/auth/invitations/${token}`, headers: CSRF });
    assert.equal(info.statusCode, 200);
    assert.equal(info.json().accountExists, false);
    assert.equal(info.json().role, 'member');

    const accepted = await c.app.inject({ method: 'POST', url: '/v1/auth/invitations/accept', headers: CSRF, payload: { token, name: 'Carla Cashier', password: PASSWORD } });
    assert.equal(accepted.statusCode, 201, accepted.body);
    assert.equal(accepted.json().currentBusinessId, c.f.tenantA);
    const cashier = cookieFrom(accepted);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/auth/invitations/accept', headers: CSRF, payload: { token, name: 'X', password: PASSWORD } })).statusCode, 404, 'one use');

    // Members can issue but not manage the team.
    const asCashier = { ...CSRF, cookie: cashier };
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: asCashier })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/team/invitations', headers: asCashier, payload: { email: 'x@y.example', role: 'owner' } })).statusCode, 403);
    const team = (await c.app.inject({ method: 'GET', url: '/v1/team', headers: asCashier })).json();
    assert.equal(team.members.length, 2);
    assert.deepEqual(team.invitations, [], 'members do not see invitations');

    const cashierId = team.members.find((m: { email: string }) => m.email === 'cashier@shop.example').userId;
    assert.equal((await c.app.inject({ method: 'PATCH', url: `/v1/team/members/${owner.id}`, headers: asOwner, payload: { role: 'member' } })).statusCode, 409, 'the last owner stays an owner');
    assert.equal((await c.app.inject({ method: 'PATCH', url: `/v1/team/members/${cashierId}`, headers: asOwner, payload: { role: 'owner' } })).statusCode, 200);
    assert.equal((await c.app.inject({ method: 'PATCH', url: `/v1/team/members/${owner.id}`, headers: asOwner, payload: { role: 'member' } })).statusCode, 200, 'fine once there is another owner');
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/team/members/${cashierId}`, headers: { ...CSRF, cookie: cashier } })).statusCode, 409, 'cannot leave as the last owner');

    // The (now) owner removes the original account; it loses access at once.
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/team/members/${owner.id}`, headers: asCashier })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/me', headers: asOwner })).statusCode, 409);

    // API keys cannot manage people.
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/team', headers: c.as(c.key) })).statusCode, 403);
  }));

test('invitations for existing accounts: must log in as that email; revoked links stop working', () =>
  withApp(async (c) => {
    const owner = await person(c, 'boss@shop.example');
    const asOwner = { ...CSRF, cookie: owner.cookie };
    await createUser(c.f.db, { email: 'existing@else.example', name: 'Existing', password: PASSWORD });
    const stranger = await createUser(c.f.db, { email: 'stranger@else.example', name: 'Stranger', password: PASSWORD });
    void stranger;

    await c.app.inject({ method: 'POST', url: '/v1/team/invitations', headers: asOwner, payload: { email: 'existing@else.example', role: 'owner' } });
    const token = linkToken(c.mail.sent.at(-1)!.text, '/invite');
    const anon = await c.app.inject({ method: 'POST', url: '/v1/auth/invitations/accept', headers: CSRF, payload: { token } });
    assert.equal(anon.statusCode, 409);
    assert.equal(anon.json().error.code, 'login_required');

    const strangerCookie = cookieFrom(await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'stranger@else.example', password: PASSWORD } }));
    const wrong = await c.app.inject({ method: 'POST', url: '/v1/auth/invitations/accept', headers: { ...CSRF, cookie: strangerCookie }, payload: { token } });
    assert.equal(wrong.statusCode, 403, 'a forwarded link cannot be used by someone else');

    const existingCookie = cookieFrom(await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { email: 'existing@else.example', password: PASSWORD } }));
    const ok = await c.app.inject({ method: 'POST', url: '/v1/auth/invitations/accept', headers: { ...CSRF, cookie: existingCookie }, payload: { token } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().businesses.find((b: { id: string }) => b.id === c.f.tenantA).role, 'owner');

    // Already on the team.
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/team/invitations', headers: asOwner, payload: { email: 'existing@else.example', role: 'member' } })).statusCode, 422);

    // Revoke.
    const inv = (await c.app.inject({ method: 'POST', url: '/v1/team/invitations', headers: asOwner, payload: { email: 'later@else.example', role: 'member' } })).json();
    const laterToken = new URL(inv.inviteUrl).searchParams.get('token')!;
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/team', headers: asOwner })).json().invitations.length, 1);
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/team/invitations/${inv.invitation.id}`, headers: asOwner })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/auth/invitations/${laterToken}`, headers: CSRF })).statusCode, 404);
  }));

test('invitations still work without email: the owner gets a link to share', () =>
  withApp(async (c) => {
    const owner = await person(c, 'nomail@shop.example');
    const res = await c.app.inject({ method: 'POST', url: '/v1/team/invitations', headers: { ...CSRF, cookie: owner.cookie }, payload: { email: 'friend@shop.example', role: 'member' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().emailSent, false);
    assert.match(res.json().inviteUrl, /\/invite\?token=/);
  }, { mail: false }));

// ---------- reports ----------

test('reports: totals and GST by rate, credit notes subtract, rejected documents do not count, CSV', () =>
  withApp(async (c) => {
    c.f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    c.f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
    const customer = { name: '=HYPERLINK("http://evil")', tin: '998877', address: { street: '1 A St', city: 'Orange Walk', districtCode: '4' } };
    const inv = await issue(c, { type: '01', customer, lines: [line('Cement bag', '10', '20.00'), line('Rice', '5', '2.00', 'Z')] });
    await issue(c, { type: '02', lines: [line('Cement bag', '2', '20.00'), line('Clinic fee', '1', '50', 'E')] });
    await issue(c, { type: '04', reference: { documentId: inv.id, reason: 'Returned 1 bag' }, customer, lines: [line('Cement bag', '1', '20.00')] });
    c.f.bts.script(SUBMIT_PATHS['02'], { status: 201, body: applicationResponse({ responseCode: '003', referencedEtdui: '0'.repeat(44), conditions: [{ code: '271', description: 'x' }] }) });
    const rejected = await issue(c, { type: '02', lines: [line('Ignored', '1', '1000')] });
    assert.equal(rejected.status, 'rejected');

    const day = inv.issueDate;
    const summary = (await c.app.inject({ method: 'GET', url: `/v1/reports/summary?from=${day}&to=${day}`, headers: c.as(c.key) })).json();
    // Standard: 200 + 40 - 20 = 220 net, GST 25.00 + 5.00 - 2.50 = 27.50. Zero-rated 10. Exempt 50.
    assert.deepEqual(summary.byRate.map((r: { category: string; net: string; gst: string }) => [r.category, r.net, r.gst]), [['E', '50.00', '0.00'], ['S', '220.00', '27.50'], ['Z', '10.00', '0.00']]);
    assert.deepEqual(summary.totals, { documents: 3, net: '280.00', gst: '27.50', tax: '27.50', total: '307.50' });
    assert.deepEqual(summary.byDay, [{ date: day, documents: 3, total: '307.50' }]);
    assert.equal(summary.byType.find((t: { type: string }) => t.type === '04').total, '22.50', 'per type, credit notes are shown as issued');

    const customers = (await c.app.inject({ method: 'GET', url: `/v1/reports/customers?from=${day}&to=${day}`, headers: c.as(c.key) })).json();
    assert.deepEqual(customers.data.map((r: { name: string; total: string }) => [r.name, r.total]), [['=HYPERLINK("http://evil")', '212.50'], ['Walk-in customers', '95.00']]);
    const items = (await c.app.inject({ method: 'GET', url: `/v1/reports/items?from=${day}&to=${day}`, headers: c.as(c.key) })).json();
    assert.deepEqual(items.data.find((r: { description: string }) => r.description === 'Cement bag'), { description: 'Cement bag', unitCode: 'H87', quantity: '11', net: '220.00', gst: '27.50', total: '247.50' });

    const csv = await c.app.inject({ method: 'GET', url: `/v1/reports/customers?from=${day}&to=${day}&format=csv`, headers: c.as(c.key) });
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /attachment; filename="sales-by-customer-/);
    assert.ok(csv.body.includes(`"'=HYPERLINK(""http://evil"")"`), 'formulas are neutralised and quotes escaped');
    assert.ok(csv.body.includes(',212.50'), 'amounts stay numbers');

    const register = await c.app.inject({ method: 'GET', url: `/v1/reports/documents?from=${day}&to=${day}`, headers: c.as(c.key) });
    const rows = register.body.trim().split('\r\n');
    assert.equal(rows.length, 1 + 4, 'the register lists every document, rejected ones included');
    assert.ok(rows.some((r) => r.includes(',rejected,')));

    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/reports/summary?from=${day}`, headers: c.as(c.key) })).statusCode, 400);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/reports/summary?from=2026-02-01&to=2026-01-01', headers: c.as(c.key) })).statusCode, 400);
  }));

test('csvCell neutralises formulas and quotes', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('-5', false), '-5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
});
