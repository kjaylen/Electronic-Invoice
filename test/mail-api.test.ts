/**
 * Email settings, the log and the do-not-send list over the API: who may see
 * and change what, that a password never comes back, the test email's exact
 * result, the unsubscribe page, and that a dead mail server never breaks what
 * a person is doing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { createPlatformAdmin } from '../src/db/platform.ts';
import { base32Decode, stepAt, totpCode } from '../src/db/twofactor.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { createMailService, type MailService } from '../src/mail/service.ts';
import { type MailCatcher, startMailCatcher } from './mail-catcher.ts';
import { type PipelineFixture, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const AUTH = { user: 'hello@corner.example', pass: 'app-password-123' };
const TLS = { ca: readFileSync(new URL('./certs/test-root-ca.cert.pem', import.meta.url), 'utf8'), servername: 'localhost' };

interface Ctx {
  f: PipelineFixture; app: FastifyInstance; memory: ReturnType<typeof memoryMailer>; catcher: MailCatcher; txt: Map<string, string[]>;
  owner: Record<string, string>; cashier: Record<string, string>; other: Record<string, string>; staff: Record<string, string>; slug: string;
}

function cookieFrom(res: LightMyRequestResponse, name = 'etd_s_[a-z0-9-]+'): string {
  const m = new RegExp(`(${name})=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withApp(fn: (c: Ctx) => Promise<void>, options: { mailer?: boolean; mail?: (f: PipelineFixture) => Promise<MailService> } = {}) {
  const f = await setupPipeline();
  const memory = memoryMailer();
  const catcher = await startMailCatcher({ auth: AUTH });
  const txt = new Map<string, string[]>();
  const app = await buildApp({
    pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test',
    ...(options.mail ? { mail: await options.mail(f) } : { ...(options.mailer !== false && { mailer: memory }), mailOptions: { allowPrivateHosts: true, tls: TLS, connectTimeoutMs: 3000, backoffMs: [0, 0, 0, 0] } }),
    resolveTxt: async (name) => {
      const found = txt.get(name);
      if (!found) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return found.map((r) => [r]);
    },
  });
  try {
    const slugOf = async (id: string) => (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [id])).rows[0]!.slug;
    const slug = await slugOf(f.tenantA);
    const signIn = async (tenantId: string, email: string, role: 'owner' | 'cashier') => {
      await createUser(f.db, { tenantId, name: email.split('@')[0]!, email, role, password: PASSWORD });
      const business = await slugOf(tenantId);
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business, login: email, password: PASSWORD } });
      return { ...CSRF, cookie: cookieFrom(res), 'x-business': business };
    };
    await createPlatformAdmin(f.db, { email: 'ops@platform.example', name: 'Olga Ops', password: PASSWORD });
    const first = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: PASSWORD } });
    const { challenge, secret } = first.json();
    const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge, code: totpCode(base32Decode(secret), stepAt(Date.now())) } });
    await fn({
      f, app, memory, catcher, txt, slug,
      owner: await signIn(f.tenantA, 'olive@corner.example', 'owner'),
      cashier: await signIn(f.tenantA, 'carl@corner.example', 'cashier'),
      other: await signIn(f.tenantB, 'omar@other.example', 'owner'),
      staff: { ...CSRF, cookie: cookieFrom(login, 'etd_admin') },
    });
  } finally {
    await app.close();
    await catcher.close();
    await f.close();
  }
}

const form = (c: Ctx, over: Record<string, unknown> = {}) => ({
  host: '127.0.0.1', port: c.catcher.port, security: 'none', username: AUTH.user, password: AUTH.pass, fromName: 'Corner Store', fromAddress: 'hello@corner.example', replyTo: 'orders@corner.example', ...over,
});

test('a business’s own mail server: owners and admins only, explained errors, a password that never comes back, a test that says exactly what happened', () =>
  withApp(async (c) => {
    const { app, owner, cashier, f, catcher } = c;
    const empty = await app.inject({ method: 'GET', url: '/v1/mail/settings', headers: owner });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().settings, null);
    assert.deepEqual(empty.json().presets.map((p: { key: string }) => p.key), ['google', 'microsoft', 'zoho', 'ses']);
    // Without a server of its own, its email goes from the platform's address under its name.
    assert.deepEqual(empty.json().platform, { available: true, fromAddress: 'no-reply@localhost', fromName: 'CaribFuel', replyTo: 'billing@caribfuel.example' });

    // Not for cashiers, not for API keys, not without signing in.
    for (const [method, url] of [['GET', '/v1/mail/settings'], ['PUT', '/v1/mail/settings'], ['DELETE', '/v1/mail/settings'], ['POST', '/v1/mail/settings/test'], ['GET', '/v1/mail/messages'], ['GET', '/v1/mail/suppressions'], ['GET', '/v1/mail/deliverability']] as const) {
      const payload = method === 'PUT' ? form(c) : method === 'POST' ? { to: 'x@y.example' } : undefined;
      assert.equal((await app.inject({ method, url, headers: cashier, ...(payload && { payload }) })).statusCode, 403, `${method} ${url} as a cashier`);
      assert.equal((await app.inject({ method, url, headers: CSRF, ...(payload && { payload }) })).statusCode, 401, `${method} ${url} signed out`);
    }
    const key = (await createApiKey(f.db, f.tenantA, 'tests')).key;
    assert.equal((await app.inject({ method: 'GET', url: '/v1/mail/settings', headers: { authorization: `Bearer ${key}` } })).statusCode, 403);

    // What is wrong, by field, in words.
    const bad = await app.inject({ method: 'PUT', url: '/v1/mail/settings', headers: owner, payload: { host: 'https://smtp.gmail.com', port: 99999, security: 'starttls', fromName: '', fromAddress: 'nope' } });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, 'invalid_mail_settings');
    assert.deepEqual(Object.keys(bad.json().error.details.fields).sort(), ['fromAddress', 'fromName', 'host', 'port']);
    assert.match(bad.json().error.details.fields.host, /Leave out the part before the name/);

    const saved = await app.inject({ method: 'PUT', url: '/v1/mail/settings', headers: owner, payload: form(c) });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().settings.passwordSet, true);
    assert.equal(saved.json().settings.host, '127.0.0.1');
    assert.match(saved.json().warnings[0], /unprotected/);
    // The password: not in the answer, not in a later read, not in the activity log, not readable in the database.
    const read = await app.inject({ method: 'GET', url: '/v1/mail/settings', headers: owner });
    const activity = await f.db.query('select * from audit_events');
    const stored = await f.db.query('select * from mail_settings');
    for (const text of [saved.body, read.body, JSON.stringify(activity.rows), JSON.stringify(stored.rows)]) assert.ok(!text.includes(AUTH.pass));
    assert.ok(JSON.stringify(activity.rows).includes('mail.settings_saved'));

    // A test with what is saved: a real message, and the server's own answer.
    const ok = await app.inject({ method: 'POST', url: '/v1/mail/settings/test', headers: owner, payload: { to: 'olive@corner.example' } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual([ok.json().ok, ok.json().to, ok.json().from], [true, 'olive@corner.example', '"Corner Store" <hello@corner.example>']);
    assert.match(ok.json().response, /^250 2\.0\.0 OK: caught as 1$/);
    assert.equal(catcher.mails[0]!.user, AUTH.user);
    assert.match(catcher.mails[0]!.subject, /Test email from Corner Store/);
    assert.ok((await app.inject({ method: 'GET', url: '/v1/mail/settings', headers: owner })).json().settings.verifiedAt);

    // A test of what is typed, before saving: a wrong password is the server's refusal plus a hint, and nothing is saved.
    const wrong = await app.inject({ method: 'POST', url: '/v1/mail/settings/test', headers: owner, payload: { to: 'olive@corner.example', settings: form(c, { password: 'not-the-password' }) } });
    assert.equal(wrong.statusCode, 200);
    assert.deepEqual([wrong.json().ok, wrong.json().error.kind], [false, 'auth']);
    assert.match(wrong.json().error.detail, /535 5\.7\.8/);
    assert.match(wrong.json().error.hint, /app password/);
    assert.ok(!wrong.body.includes('not-the-password'));
    // Typed without a password: the saved one is used.
    assert.equal((await app.inject({ method: 'POST', url: '/v1/mail/settings/test', headers: owner, payload: { to: 'olive@corner.example', settings: form(c, { password: undefined }) } })).json().ok, true);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/mail/settings/test', headers: owner, payload: { to: 'not an address' } })).statusCode, 422);

    // Its customers' email now comes from its own address.
    const link = await app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { business: c.slug, email: 'olive@corner.example' } });
    assert.equal(link.statusCode, 204);
    // (That one is the platform's own email: it does not go through the business's server.)
    const removed = await app.inject({ method: 'DELETE', url: '/v1/mail/settings', headers: owner });
    assert.equal(removed.json().settings, null);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/mail/settings/test', headers: owner, payload: { to: 'olive@corner.example' } })).statusCode, 422, 'nothing to test');
  }));

test('the email log: a business sees only its own and can send one again; staff see every business’s', () =>
  withApp(async (c) => {
    const { app, owner, other, staff, f, memory } = c;
    // Two real emails: an invitation in business A, a password reset in business B.
    const invited = await app.inject({ method: 'POST', url: '/v1/users', headers: owner, payload: { name: 'Nia New', email: 'nia@corner.example', role: 'cashier' } });
    assert.equal(invited.statusCode, 201, invited.body);
    assert.equal(invited.json().emailSent, true);
    // And one that can be sent again (a notice holds no secret).
    const mailA = await app.inject({ method: 'GET', url: '/v1/mail/messages', headers: owner });
    assert.equal(mailA.statusCode, 200, mailA.body);
    assert.deepEqual(mailA.json().data.map((m: { type: string; to: string; status: string; typeLabel: string; canResend: boolean }) => [m.type, m.to, m.status, m.typeLabel, m.canResend]), [['staff-invitation', 'nia@corner.example', 'sent', 'Invitation', false]]);
    assert.ok(!mailA.body.includes('reset-password?token='), 'the log never shows a link that signs someone in');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/mail/messages', headers: other })).json().data, []);

    const id = mailA.json().data[0].id;
    const refused = await app.inject({ method: 'POST', url: `/v1/mail/messages/${id}/resend`, headers: owner });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error.message, /held a link or code/);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/mail/messages/${id}/resend`, headers: other })).statusCode, 404, 'another business cannot touch it');

    // Something resendable, straight into A's log.
    await f.db.query(`update mail_messages set sensitive = false, payload = (select payload from mail_messages where id = $1) where id = $1`, [id]);
    const mail = await createMailService(f.db, f.deps.keys, { transport: memory, publicUrl: 'https://app.example.test' });
    const notice = await mail.send({ type: 'notice', tenantId: f.tenantA, to: 'olive@corner.example', subject: 'Your certificate expires in 5 days', text: 'Renew it.' });
    const again = await app.inject({ method: 'POST', url: `/v1/mail/messages/${notice.id}/resend`, headers: owner });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().status, 'sent');
    assert.equal(memory.sent.filter((m) => m.subject === 'Your certificate expires in 5 days').length, 2);
    const filtered = await app.inject({ method: 'GET', url: '/v1/mail/messages?type=notice&q=CERTIFICATE&status=sent', headers: owner });
    assert.equal(filtered.json().data.length, 2);
    assert.equal(filtered.json().data[0].resendOf, notice.id);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/mail/messages?tenantId=${f.tenantB}`, headers: owner })).json().data.length, 3, 'asking for another business changes nothing');

    // Staff: every business, by name; one business; resend.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/mail/messages' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/mail/messages', headers: owner })).statusCode, 401, 'a business account is not staff');
    const all = await app.inject({ method: 'GET', url: '/v1/platform/mail/messages', headers: staff });
    assert.equal(all.statusCode, 200, all.body);
    assert.equal(all.json().data.length, 3);
    assert.ok(all.json().data.every((m: { tenantName: string }) => m.tenantName === 'CaribFuel'));
    assert.equal((await app.inject({ method: 'GET', url: `/v1/platform/mail/messages?tenantId=${f.tenantB}`, headers: staff })).json().data.length, 0);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/platform/mail/messages/${notice.id}/resend`, headers: staff })).json().status, 'sent');
  }));

test('the do-not-send list: add an address, see why one is there, take it off', () =>
  withApp(async ({ app, owner, other, f, memory }) => {
    const added = await app.inject({ method: 'POST', url: '/v1/mail/suppressions', headers: owner, payload: { email: ' Ana@Buyer.example ' } });
    assert.equal(added.statusCode, 200, added.body);
    assert.deepEqual(added.json().data.map((s: { email: string; reason: string }) => [s.email, s.reason]), [['ana@buyer.example', 'manual']]);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/mail/suppressions', headers: owner, payload: { email: 'not an address' } })).statusCode, 422);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/mail/suppressions', headers: other })).json().data, []);

    const mail = await createMailService(f.db, f.deps.keys, { transport: memory });
    assert.equal((await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order', text: 'Thanks' })).status, 'suppressed');
    assert.equal(memory.sent.length, 0);
    const id = added.json().data[0].id;
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/mail/suppressions/${id}`, headers: other })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: 'DELETE', url: `/v1/mail/suppressions/${id}`, headers: owner })).json().data, []);
    assert.equal((await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order', text: 'Thanks' })).status, 'sent');
  }));

test('the platform’s mail server: staff only; saving it turns email on for everyone, and the password never comes back', () =>
  withApp(async (c) => {
    const { app, staff, owner, f, catcher } = c;
    // No mail at all on this server: what needs email says so.
    const forgot = () => app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { business: c.slug, email: 'olive@corner.example' } });
    assert.equal((await forgot()).statusCode, 503);
    for (const headers of [CSRF, owner]) assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/mail/settings', headers })).statusCode, 401);
    const empty = await app.inject({ method: 'GET', url: '/v1/platform/mail/settings', headers: staff });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual([empty.json().settings, empty.json().route], [null, { source: 'none', host: null, from: null }]);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/platform/mail/settings/test', headers: staff, payload: { to: 'ops@platform.example' } })).statusCode, 422);

    const saved = await app.inject({ method: 'PUT', url: '/v1/platform/mail/settings', headers: staff, payload: form(c, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example', replyTo: 'help@platform.example' }) });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().settings.passwordSet, true);
    assert.deepEqual(saved.json().route, { source: 'saved', host: '127.0.0.1', from: { name: 'Floreo', address: 'no-reply@platform.example' } });
    const audit = await f.db.query('select * from platform_audit');
    for (const text of [saved.body, JSON.stringify(audit.rows), JSON.stringify((await f.db.query('select * from mail_settings')).rows)]) assert.ok(!text.includes(AUTH.pass));
    assert.ok(JSON.stringify(audit.rows).includes('mail.settings_saved'));

    const tested = await app.inject({ method: 'POST', url: '/v1/platform/mail/settings/test', headers: staff, payload: { to: 'ops@platform.example' } });
    assert.deepEqual([tested.json().ok, tested.json().from], [true, '"Floreo" <no-reply@platform.example>']);

    // Email is on: the password reset that answered 503 now arrives, through the server just saved.
    assert.equal((await forgot()).statusCode, 204);
    const reset = await catcher.waitFor('olive@corner.example');
    assert.match(reset.subject, /Reset your CaribFuel password/);
    assert.equal(reset.headers.from, 'Floreo <no-reply@platform.example>');
    assert.match(reset.text, /https:\/\/app\.example\.test\/[a-z0-9-]+\/reset-password\?token=[A-Za-z0-9_-]{43}/);
    assert.match(reset.html, /Choose a new password/);

    // A business's email goes from the platform's address under the business's name.
    const info = await app.inject({ method: 'GET', url: '/v1/mail/settings', headers: owner });
    assert.equal(info.json().platform.fromAddress, 'no-reply@platform.example');

    const removed = await app.inject({ method: 'DELETE', url: '/v1/platform/mail/settings', headers: staff });
    assert.equal(removed.json().route.source, 'none');
    assert.equal((await forgot()).statusCode, 503);
  }, { mailer: false }));

test('deliverability: nothing to set up for a business sending from the platform; its own domain is checked once it has a server', () =>
  withApp(async (c) => {
    const { app, owner, staff, txt } = c;
    const none = await app.inject({ method: 'GET', url: '/v1/mail/deliverability', headers: owner });
    assert.deepEqual(none.json(), { sendsFrom: 'platform', domain: 'localhost', provider: null, checks: [] });
    await app.inject({ method: 'PUT', url: '/v1/mail/settings', headers: owner, payload: form(c) });
    txt.set('corner.example', ['v=spf1 include:_spf.google.com ~all']);
    txt.set('_dmarc.corner.example', ['v=DMARC1; p=none']);
    txt.set('mykey._domainkey.corner.example', ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA']);
    const checked = await app.inject({ method: 'GET', url: '/v1/mail/deliverability', headers: owner });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.deepEqual([checked.json().sendsFrom, checked.json().domain], ['own', 'corner.example']);
    assert.deepEqual(checked.json().checks.map((x: { record: string; status: string }) => [x.record, x.status]), [['spf', 'ok'], ['dkim', 'unknown'], ['dmarc', 'ok']]);
    const withSelector = await app.inject({ method: 'GET', url: '/v1/mail/deliverability?selector=mykey', headers: owner });
    assert.equal(withSelector.json().checks[1].status, 'ok');
    // The platform sends to a development outbox here: nothing to check.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/mail/deliverability', headers: staff })).json().sendsFrom, 'none');
  }));

test('the unsubscribe link: a page with one button; looking changes nothing, pressing (or a mail app’s one-click) stops those emails', () =>
  withApp(async ({ app, f, memory }) => {
    const mail = await createMailService(f.db, f.deps.keys, { transport: memory, publicUrl: 'https://app.example.test' });
    const summary = () => mail.send({ type: 'daily-summary', tenantId: f.tenantA, to: 'olive@corner.example', subject: 'Yesterday', text: 'Sales', html: '<html><body><p>Sales</p></body></html>' });
    await summary();
    const path = /<https:\/\/app\.example\.test(\/v1\/mail\/unsubscribe\/[A-Za-z0-9_-]+)>/.exec(memory.sent[0]!.headers!['List-Unsubscribe']!)![1]!;

    const page = await app.inject({ method: 'GET', url: path });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.match(page.body, /olive@corner\.example will no longer get emails like this one \(daily summary\) from CaribFuel/);
    assert.match(page.body, /<form method="post"><button type="submit"[^>]*>Stop these emails<\/button><\/form>/);
    assert.equal((await summary()).status, 'sent', 'opening the page stopped nothing');

    // What Gmail and Apple Mail send when "Unsubscribe" is pressed in the mail app.
    const done = await app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    assert.equal(done.statusCode, 200, done.body);
    assert.match(done.body, /will no longer get these emails from CaribFuel/);
    assert.equal((await summary()).status, 'suppressed');
    assert.equal((await app.inject({ method: 'POST', url: path })).statusCode, 200, 'pressing twice is fine');

    for (const bad of ['/v1/mail/unsubscribe/nope', '/v1/mail/unsubscribe/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      assert.equal((await app.inject({ method: 'GET', url: bad })).statusCode, 404);
      assert.equal((await app.inject({ method: 'POST', url: bad })).statusCode, 404);
    }
    // A hostile business name is text on the page, nothing more.
    await f.db.query('update tenants set trade_name = $2 where id = $1', [f.tenantA, '<script>alert(1)</script>']);
    assert.ok(!(await app.inject({ method: 'GET', url: path })).body.includes('<script>'));
  }));

test('a dead mail server never breaks or slows what a person is doing: the action succeeds, the email waits and goes when the server is back', async () => {
  const held = new Set<import('node:net').Socket>();
  const dead = createServer((socket) => void held.add(socket));
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
  const deadPort = (dead.address() as { port: number }).port;
  let service!: MailService;
  try {
    await withApp(async (c) => {
      const { app, owner, staff, f, catcher } = c;
      // The platform's server accepts the connection and then says nothing, for as long as anyone waits.
      const saved = await app.inject({ method: 'PUT', url: '/v1/platform/mail/settings', headers: staff, payload: { host: '127.0.0.1', port: deadPort, security: 'none', fromName: 'Floreo', fromAddress: 'no-reply@platform.example' } });
      assert.equal(saved.statusCode, 200, saved.body);

      const started = Date.now();
      const invited = await app.inject({ method: 'POST', url: '/v1/users', headers: owner, payload: { name: 'Nia New', email: 'nia@corner.example', role: 'cashier' } });
      const forgot = await app.inject({ method: 'POST', url: '/v1/auth/password/forgot', headers: CSRF, payload: { business: c.slug, email: 'olive@corner.example' } });
      const took = Date.now() - started;
      assert.equal(invited.statusCode, 201, invited.body);
      assert.equal(invited.json().emailSent, true);
      assert.ok(invited.json().welcomeUrl, 'and the link is there to share another way');
      assert.equal(forgot.statusCode, 204);
      // The mail server would keep each of them waiting six seconds; neither waits for it (with room for a busy machine).
      assert.ok(took < 4000, `both answered in ${took} ms while the mail server hung`);

      // The messages are safe in the queue, tried once and waiting. (The reset is queued just after its request is answered.)
      for (let i = 0; i < 100 && (await f.db.query('select 1 from mail_messages')).rows.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
      await service.stop();
      await service.runOnce();
      const waiting = (await f.db.query<{ type: string; status: string; attempts: number; error_code: string }>('select type, status, attempts, error_code from mail_messages order by type')).rows;
      assert.deepEqual(waiting, [
        { type: 'password-reset', status: 'queued', attempts: 1, error_code: 'connection' },
        { type: 'staff-invitation', status: 'queued', attempts: 1, error_code: 'connection' },
      ]);
      // The mail server is fixed.
      await app.inject({ method: 'PUT', url: '/v1/platform/mail/settings', headers: staff, payload: form(c, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example' }) });
      assert.equal(await service.runOnce(), 0, 'not due yet: the wait after a failure is a minute');
      await f.db.query('update mail_messages set next_attempt_at = now()');
      assert.equal(await service.runOnce(), 2);
      assert.match((await catcher.waitFor('nia@corner.example')).subject, /created your CaribFuel account/);
      assert.match((await catcher.waitFor('olive@corner.example')).subject, /Reset your CaribFuel password/);
      assert.deepEqual((await f.db.query<{ status: string; attempts: number }>('select status, attempts from mail_messages')).rows, [{ status: 'sent', attempts: 2 }, { status: 'sent', attempts: 2 }]);
    }, {
      mail: async (f) => (service = await createMailService(f.db, f.deps.keys, { publicUrl: 'https://app.example.test', background: true, connectTimeoutMs: 6000, socketTimeoutMs: 6000, allowPrivateHosts: true })),
    });
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise((r) => dead.close(r));
  }
});
