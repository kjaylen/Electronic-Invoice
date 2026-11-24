/**
 * The mail service against a real SMTP conversation (test/mail-catcher.ts):
 * settings, each encryption mode, sign-in, an unreachable server, retries,
 * falling back from a business's server to the platform's, the do-not-send
 * list, messages that hold secrets, header injection, and the layout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkAddress, cleanHeaders, cleanSubject, formatFrom, MailAddressError } from '../src/mail/address.ts';
import { checkDeliverability, presetForHost } from '../src/mail/dns.ts';
import { emailHtml, emailText, safeUrl } from '../src/mail/layout.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { createMailService, type MailServiceOptions } from '../src/mail/service.ts';
import { loadMailSettings, MAIL_PRESETS, type MailSettingsInput, MailSettingsError, PLATFORM_SCOPE, publicSettings, saveMailSettings, settingsFromEnv, validateMailSettings } from '../src/mail/settings.ts';
import { explainFailure, smtpSend } from '../src/mail/smtp.ts';
import { MAIL_TYPES } from '../src/mail/types.ts';
import { type MailCatcher, startMailCatcher } from './mail-catcher.ts';
import { type PipelineFixture, setupPipeline } from './pipeline-setup.ts';

const certs = new URL('./certs/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, certs), 'utf8');
const KEY = read('server-localhost.key.pem');
const CERT = read('server-localhost.cert.pem');
// The catcher's certificate is for "localhost", signed by the tests' own authority.
const TLS = { ca: read('test-root-ca.cert.pem'), servername: 'localhost' };
const AUTH = { user: 'mailer@corner.example', pass: 'app-password-123' };
const PUBLIC_URL = 'https://app.example.test';

const form = (port: number, over: MailSettingsInput = {}): MailSettingsInput => ({
  host: '127.0.0.1', port, security: 'none', fromName: 'Corner Store', fromAddress: 'hello@corner.example', ...over,
});

interface Ctx { f: PipelineFixture; catchers: MailCatcher[]; memory: ReturnType<typeof memoryMailer> }

async function withMail(fn: (c: Ctx & { service: (o?: MailServiceOptions) => ReturnType<typeof createMailService>; catcher: (o?: Parameters<typeof startMailCatcher>[0]) => Promise<MailCatcher> }) => Promise<void>) {
  const f = await setupPipeline();
  const catchers: MailCatcher[] = [];
  const memory = memoryMailer();
  try {
    await fn({
      f, catchers, memory,
      service: (o = {}) => createMailService(f.db, f.deps.keys, { transport: memory, publicUrl: PUBLIC_URL, tls: TLS, allowPrivateHosts: true, connectTimeoutMs: 3000, backoffMs: [0, 0, 0, 0], ...o }),
      catcher: async (o = {}) => {
        const c = await startMailCatcher(o);
        catchers.push(c);
        return c;
      },
    });
  } finally {
    for (const c of catchers) await c.close();
    await f.close();
  }
}

const row = async (f: PipelineFixture, id: string) =>
  (await f.db.query<{ status: string; attempts: number; error: string | null; error_code: string | null; note: string | null; via: string | null; from_address: string | null; payload: string | null; server_response: string | null }>(
    'select status, attempts, error, error_code, note, via, from_address, payload, server_response from mail_messages where id = $1', [id],
  )).rows[0]!;

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

// ---------- settings ----------

test('settings: a complete form is accepted; each wrong field is explained in plain words', () => {
  const ok = validateMailSettings({ host: ' SMTP.Gmail.com ', port: '587', security: 'starttls', username: 'me@gmail.com', password: 'abcd efgh ijkl mnop', fromName: 'Corner Store', fromAddress: 'me@gmail.com', replyTo: '' });
  assert.deepEqual(ok.settings, { host: 'smtp.gmail.com', port: 587, security: 'starttls', username: 'me@gmail.com', password: 'abcd efgh ijkl mnop', fromName: 'Corner Store', fromAddress: 'me@gmail.com', replyTo: null });
  assert.deepEqual(ok.warnings, []);

  const fields = (input: MailSettingsInput, options = {}) => {
    try {
      validateMailSettings(input, options);
    } catch (e) {
      assert.ok(e instanceof MailSettingsError);
      return e.fields;
    }
    return {};
  };
  const all = fields({});
  assert.deepEqual(Object.keys(all).sort(), ['fromAddress', 'fromName', 'host', 'port', 'security']);
  assert.match(all.host!, /like smtp\.gmail\.com/);
  assert.match(all.port!, /usually 587 or 465/);

  const good = { host: 'smtp.example.com', port: 587, security: 'starttls', fromName: 'Shop', fromAddress: 'shop@example.com' };
  assert.match(fields({ ...good, host: 'smtp://smtp.example.com' }).host!, /Leave out the part before the name/);
  assert.match(fields({ ...good, host: 'smtp.example.com:587' }).host!, /port in its own box/);
  assert.match(fields({ ...good, host: 'me@example.com' }).host!, /looks like an email address/);
  assert.match(fields({ ...good, host: 'my server' }).host!, /cannot have spaces/);
  assert.match(fields({ ...good, port: 70000 }).port!, /number/);
  assert.match(fields({ ...good, port: 'abc' }).port!, /number/);
  assert.match(fields({ ...good, security: 'ssl' }).security!, /STARTTLS, SSL\/TLS or none/);
  assert.match(fields({ ...good, fromAddress: 'not an address' }).fromAddress!, /one address/);
  assert.match(fields({ ...good, fromAddress: 'shop@example' }).fromAddress!, /name@example\.com/);
  assert.match(fields({ ...good, fromName: 'Shop\r\nBcc: x@evil.example' }).fromName!, /one line/);
  assert.match(fields({ ...good, replyTo: 'a@b.c, d@e.f' }).replyTo!, /one address/);
  // A username needs a password, unless one is already saved; a password needs a username.
  assert.match(fields({ ...good, username: 'shop@example.com' }).password!, /Enter the password/);
  assert.deepEqual(fields({ ...good, username: 'shop@example.com' }, { hasPassword: true }), {});
  assert.match(fields({ ...good, password: 'secret' }).username!, /username that goes with this password/);
  // A business's own server: mail ports only.
  assert.match(fields({ ...good, port: 5432 }, { restrictPorts: true }).port!, /25, 465, 587, 2525/);
  assert.deepEqual(fields({ ...good, port: 5432 }), {});

  // Things that are allowed but probably a mistake are warnings, not errors.
  assert.match(validateMailSettings({ ...good, port: 465 }).warnings[0]!, /Port 465 normally uses SSL\/TLS/);
  assert.match(validateMailSettings({ ...good, port: 587, security: 'tls' }).warnings[0]!, /Port 587 normally uses STARTTLS/);
  assert.match(validateMailSettings({ ...good, security: 'none' }).warnings[0]!, /unprotected/);
});

test('settings: the password is encrypted at rest, bound to its row, kept when the form leaves it out, and never part of what a browser gets', async () => {
  await withMail(async ({ f }) => {
    const { settings } = await saveMailSettings(f.db, f.deps.keys, f.tenantA, { ...form(587), username: 'hello@corner.example', password: 'app-password-123' });
    assert.equal(settings.password, 'app-password-123');
    const stored = (await f.db.query<{ password_enc: string; tenant_id: string }>('select password_enc, tenant_id from mail_settings where scope = $1', [f.tenantA])).rows[0]!;
    assert.match(stored.password_enc, /^v2:/);
    assert.ok(!stored.password_enc.includes('app-password-123'));
    assert.equal(stored.tenant_id, f.tenantA);

    const shown = publicSettings(settings);
    assert.equal(shown.passwordSet, true);
    assert.ok(!JSON.stringify(shown).includes('app-password-123'));
    assert.ok(!('password' in shown));

    // Saved again without a password: the saved one stays. With null and no username: it goes.
    const again = await saveMailSettings(f.db, f.deps.keys, f.tenantA, { ...form(2525), username: 'hello@corner.example' });
    assert.equal(again.settings.password, 'app-password-123');
    assert.equal(again.settings.port, 2525);
    const cleared = await saveMailSettings(f.db, f.deps.keys, f.tenantA, { ...form(2525), username: '', password: null });
    assert.equal(cleared.settings.password, null);
    assert.equal(publicSettings(cleared.settings).passwordSet, false);

    // Another business's row with this business's blob does not decrypt.
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, { ...form(587), username: 'u', password: 'p-of-a' });
    await saveMailSettings(f.db, f.deps.keys, f.tenantB, { ...form(587), username: 'u', password: 'p-of-b' });
    await f.db.query('update mail_settings set password_enc = (select password_enc from mail_settings where scope = $1) where scope = $2', [f.tenantA, f.tenantB]);
    await assert.rejects(loadMailSettings(f.db, f.deps.keys, f.tenantB), /Could not decrypt/);
  });
});

test('settings: SMTP_URL and MAIL_FROM read as settings; the presets fill in what the providers publish', () => {
  assert.deepEqual(settingsFromEnv('smtps://user%40example.com:p%40ss@smtp.example.com:465', 'Floreo <no-reply@example.bz>'), {
    host: 'smtp.example.com', port: 465, security: 'tls', username: 'user@example.com', password: 'p@ss', fromName: 'Floreo', fromAddress: 'no-reply@example.bz', replyTo: null,
  });
  const plain = settingsFromEnv('smtp://localhost:1025', 'no-reply@localhost');
  assert.deepEqual([plain.host, plain.port, plain.security, plain.opportunisticTls, plain.username, plain.fromName], ['localhost', 1025, 'starttls', true, null, 'Floreo']);
  assert.throws(() => settingsFromEnv('https://smtp.example.com', 'a@b.c'), /smtp:\/\/ or smtps:\/\//);

  const byKey = Object.fromEntries(MAIL_PRESETS.map((p) => [p.key, p]));
  assert.deepEqual([byKey.google!.host, byKey.google!.port, byKey.google!.security, byKey.google!.appPassword], ['smtp.gmail.com', 587, 'starttls', true]);
  assert.deepEqual([byKey.microsoft!.host, byKey.microsoft!.port, byKey.microsoft!.security], ['smtp.office365.com', 587, 'starttls']);
  assert.deepEqual([byKey.zoho!.host, byKey.zoho!.port, byKey.zoho!.security], ['smtp.zoho.com', 465, 'tls']);
  assert.deepEqual([byKey.ses!.port, byKey.ses!.security], [587, 'starttls']);
  assert.match(byKey.google!.note, /app password/);
  for (const p of MAIL_PRESETS) assert.doesNotThrow(() => validateMailSettings({ host: p.host, port: p.port, security: p.security, fromName: 'X', fromAddress: 'x@example.com' }, { restrictPorts: true }));
  assert.equal(presetForHost('smtp.gmail.com')?.key, 'google');
  assert.equal(presetForHost('email-smtp.eu-west-1.amazonaws.com')?.key, 'ses');
  assert.equal(presetForHost('mail.example.bz'), null);
});

// ---------- the three encryption modes ----------

const MAIL = { from: '"Corner Store" <hello@corner.example>', to: 'ana@buyer.example', subject: 'Hello', text: 'Hi Ana' };
const settingsFor = (port: number, security: 'none' | 'starttls' | 'tls', auth = true) => ({
  host: '127.0.0.1', port, security, username: auth ? AUTH.user : null, password: auth ? AUTH.pass : null, fromName: 'Corner Store', fromAddress: 'hello@corner.example', replyTo: null,
});

test('encryption none: plain from start to end', async () => {
  const c = await startMailCatcher({ auth: AUTH });
  try {
    const d = await smtpSend(settingsFor(c.port, 'none'), MAIL, { connectTimeoutMs: 3000 });
    assert.match(d.response, /^250 /);
    assert.equal(c.mails.length, 1);
    assert.deepEqual([c.mails[0]!.encrypted, c.mails[0]!.user, c.mails[0]!.from, c.mails[0]!.to], [false, AUTH.user, 'hello@corner.example', ['ana@buyer.example']]);
    assert.equal(c.mails[0]!.text.trim(), 'Hi Ana');
  } finally {
    await c.close();
  }
});

test('encryption STARTTLS: connects plain, upgrades before signing in; refuses to carry on when the server cannot upgrade', async () => {
  const c = await startMailCatcher({ starttls: true, key: KEY, cert: CERT, auth: AUTH });
  const plain = await startMailCatcher({ auth: AUTH });
  try {
    await smtpSend(settingsFor(c.port, 'starttls'), MAIL, { tls: TLS, connectTimeoutMs: 3000 });
    assert.deepEqual([c.mails[0]!.encrypted, c.mails[0]!.user], [true, AUTH.user]);

    // The server offers no STARTTLS: nothing is sent, least of all the password.
    await assert.rejects(smtpSend(settingsFor(plain.port, 'starttls'), MAIL, { tls: TLS, connectTimeoutMs: 3000 }), (e: unknown) => {
      const err = explainFailure(e);
      assert.equal(err.kind, 'tls');
      assert.match(err.hint, /STARTTLS/);
      return true;
    });
    assert.equal(plain.mails.length, 0);

    // A certificate nobody vouches for is refused.
    await assert.rejects(smtpSend(settingsFor(c.port, 'starttls'), MAIL, { tls: { servername: 'localhost' }, connectTimeoutMs: 3000 }), (e: unknown) => {
      const err = explainFailure(e);
      assert.equal(err.kind, 'tls');
      assert.match(err.hint, /certificate/);
      return true;
    });
  } finally {
    await c.close();
    await plain.close();
  }
});

test('encryption SSL/TLS: encrypted from the first byte; the wrong mode for the port is explained', async () => {
  const c = await startMailCatcher({ secure: true, key: KEY, cert: CERT, auth: AUTH });
  const plain = await startMailCatcher({ auth: AUTH });
  try {
    await smtpSend(settingsFor(c.port, 'tls'), MAIL, { tls: TLS, connectTimeoutMs: 3000 });
    assert.deepEqual([c.mails[0]!.encrypted, c.mails[0]!.user], [true, AUTH.user]);

    // SSL/TLS chosen for a port that speaks plain SMTP.
    await assert.rejects(smtpSend(settingsFor(plain.port, 'tls'), MAIL, { tls: TLS, connectTimeoutMs: 3000 }), (e: unknown) => {
      const err = explainFailure(e);
      assert.equal(err.kind, 'tls');
      assert.match(err.hint, /Port 465 uses SSL\/TLS; port 587 uses STARTTLS/);
      return true;
    });
    // STARTTLS chosen for a port that is encrypted from the start: the server never says hello in the clear.
    await assert.rejects(smtpSend(settingsFor(c.port, 'starttls'), MAIL, { tls: TLS, connectTimeoutMs: 1500 }), (e: unknown) => {
      const err = explainFailure(e);
      assert.ok(err.serverFault, err.kind);
      assert.match(err.hint, /encryption does not match the port|did not answer|STARTTLS/);
      return true;
    });
  } finally {
    await c.close();
    await plain.close();
  }
});

// ---------- what can go wrong, and what a person is told ----------

test('wrong password: the server’s own words and a hint about app passwords; the password is in neither', async () => {
  await withMail(async ({ f, service, catcher }) => {
    const c = await catcher({ auth: AUTH });
    const mail = await service();
    const result = await mail.sendTest(f.tenantA, { ...settingsFor(c.port, 'none'), password: 'the-wrong-password' }, 'owner@corner.example');
    assert.equal(result.ok, false);
    assert.equal(result.error!.kind, 'auth');
    assert.match(result.error!.detail, /535 5\.7\.8 Username and Password not accepted/);
    assert.match(result.error!.hint, /username or password was refused/);
    assert.match(result.error!.hint, /app password/);
    assert.ok(!JSON.stringify(result).includes('the-wrong-password'));
    assert.equal(c.mails.length, 0);
    // The test is in the log, failed, with the reason.
    const log = await mail.list({ tenantId: f.tenantA });
    assert.deepEqual([log.data[0]!.type, log.data[0]!.status, log.data[0]!.errorCode], ['test', 'failed', 'auth']);
    assert.ok(!JSON.stringify(log).includes('the-wrong-password'));

    // The right password: the server's answer, word for word.
    const ok = await mail.sendTest(f.tenantA, settingsFor(c.port, 'none'), 'owner@corner.example');
    assert.equal(ok.ok, true);
    assert.match(ok.response!, /^250 2\.0\.0 OK: caught as 1$/);
    assert.equal(ok.from, '"Corner Store" <hello@corner.example>');
    assert.match(c.mails[0]!.subject, /Test email from Corner Store/);
    assert.match(c.mails[0]!.html, /Your email settings work/);
  });
});

test('server unreachable: a closed port and an unknown name are told apart; the queue keeps the message', async () => {
  await withMail(async ({ f, service }) => {
    const mail = await service();
    const port = await closedPort();
    const refused = await mail.sendTest(PLATFORM_SCOPE, settingsFor(port, 'none', false), 'staff@platform.example');
    assert.equal(refused.ok, false);
    assert.equal(refused.error!.kind, 'connection');
    assert.match(refused.error!.hint, /refused the connection on this port/);

    const unknown = await mail.sendTest(PLATFORM_SCOPE, { ...settingsFor(587, 'starttls', false), host: 'no-such-mail-server.invalid' }, 'staff@platform.example');
    assert.equal(unknown.error!.kind, 'connection');
    assert.match(unknown.error!.hint, /No server was found with this name/);

    // The platform's server is down when a real message is sent: nothing is thrown, the message waits.
    await saveMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE, form(port, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example' }));
    await mail.refresh();
    const waiting = await service({ backoffMs: [60_000] });
    const receipt = await waiting.send({ type: 'notice', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Hello', text: 'Hi' });
    assert.equal(receipt.status, 'queued');
    const r = await row(f, receipt.id);
    assert.deepEqual([r.status, r.attempts, r.error_code], ['queued', 1, 'connection']);
    assert.match(r.error!, /refused the connection/);
    // Not due yet: a run leaves it alone.
    assert.equal(await waiting.runOnce(), 0);
    // The platform's settings page says what is wrong.
    const platform = await loadMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE);
    assert.match(platform!.lastError!, /refused the connection/);
  });
});

test('retry, then success: a temporary refusal is tried again and the message goes out', async () => {
  await withMail(async ({ f, service, catcher }) => {
    const c = await catcher();
    await saveMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE, form(c.port, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example' }));
    const mail = await service();
    let refusals = 2;
    c.refuse.rcptTo = () => (refusals-- > 0 ? '451 4.7.1 Greylisted, try again later' : null);
    const receipt = await mail.send({ type: 'notice', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Your certificate expires soon', text: 'Renew it.' });
    assert.equal(receipt.status, 'queued');
    let r = await row(f, receipt.id);
    assert.deepEqual([r.status, r.attempts, r.error_code], ['queued', 1, 'temporary']);
    assert.match(r.error!, /451 4\.7\.1 Greylisted/);

    assert.equal(await mail.runOnce(), 1);
    assert.deepEqual([(await row(f, receipt.id)).status, (await row(f, receipt.id)).attempts], ['queued', 2]);
    assert.equal(await mail.runOnce(), 1);
    r = await row(f, receipt.id);
    assert.deepEqual([r.status, r.attempts, r.error, r.via], ['sent', 3, null, 'platform']);
    assert.match(r.server_response!, /^250 2\.0\.0 OK/);
    assert.equal(c.mails.length, 1);
    assert.equal(c.mails[0]!.subject, 'Your certificate expires soon');
    // Sent once: another run finds nothing.
    assert.equal(await mail.runOnce(), 0);
    assert.equal(c.mails.length, 1);
  });
});

test('retry, then permanent failure: marked failed after five attempts, with the last reason', async () => {
  await withMail(async ({ f, service, catcher }) => {
    const c = await catcher();
    await saveMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE, form(c.port, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example' }));
    const mail = await service();
    c.refuse.data = () => '452 4.2.2 Mailbox full, try again later';
    const receipt = await mail.send({ type: 'notice', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Hello', text: 'Hi' });
    for (let attempt = 2; attempt <= 5; attempt++) {
      assert.equal((await row(f, receipt.id)).status, 'queued', `still trying before attempt ${attempt}`);
      assert.equal(await mail.runOnce(), 1);
    }
    const r = await row(f, receipt.id);
    assert.deepEqual([r.status, r.attempts], ['failed', 5]);
    assert.match(r.error!, /452 4\.2\.2 Mailbox full/);
    assert.match(r.error!, /gave up after 5 attempts/);
    assert.equal(await mail.runOnce(), 0);
    assert.equal(c.mails.length, 0);
    // A temporary failure is no reason to stop writing to someone.
    assert.equal((await f.db.query('select 1 from mail_suppressions')).rows.length, 0);
  });
});

test('a mailbox that does not exist: failed at once, the address goes on the do-not-send list, and the next email to it is not sent', async () => {
  await withMail(async ({ f, service, catcher }) => {
    const c = await catcher();
    await saveMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE, form(c.port, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example' }));
    const mail = await service();
    c.refuse.rcptTo = (a) => (a === 'gone@buyer.example' ? '550 5.1.1 The email account that you tried to reach does not exist' : null);
    const first = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'gone@buyer.example', subject: 'Order #1', text: 'Thanks' });
    assert.equal(first.status, 'failed');
    const r = await row(f, first.id);
    assert.deepEqual([r.attempts, r.error_code], [1, 'mailbox']);
    assert.match(r.error!, /does not exist/);
    const list = (await f.db.query<{ email: string; reason: string; tenant_id: string }>('select email, reason, tenant_id from mail_suppressions')).rows;
    assert.deepEqual(list, [{ email: 'gone@buyer.example', reason: 'bounced', tenant_id: f.tenantA }]);

    const before = c.connections;
    const second = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'Gone@Buyer.example', subject: 'Order #2', text: 'Thanks' });
    assert.equal(second.status, 'suppressed');
    assert.equal(c.connections, before, 'no connection is even made');
    assert.match((await row(f, second.id)).error!, /came back/);
    // Another business has its own list.
    assert.equal((await mail.send({ type: 'order', tenantId: f.tenantB, to: 'ok@buyer.example', subject: 'Order', text: 'Thanks' })).status, 'sent');
    // Taken off the list, the address is tried again.
    await f.db.query('delete from mail_suppressions');
    c.refuse.rcptTo = undefined;
    assert.equal((await mail.send({ type: 'order', tenantId: f.tenantA, to: 'gone@buyer.example', subject: 'Order #3', text: 'Thanks' })).status, 'sent');
  });
});

// ---------- a business's own server, and the platform's behind it ----------

test('a business with its own server sends from its own address; one without goes from the platform under the business’s name', async () => {
  await withMail(async ({ f, service, catcher, memory }) => {
    const own = await catcher({ starttls: true, key: KEY, cert: CERT, auth: AUTH });
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(own.port, { security: 'starttls', username: AUTH.user, password: AUTH.pass, replyTo: 'orders@corner.example' }));
    const mail = await service();

    const a = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', replyTo: 'billing@caribfuel.example', subject: 'Order #7', text: 'Thanks', html: '<p>Thanks</p>' });
    assert.equal(a.status, 'sent');
    assert.equal(own.mails.length, 1);
    const m = own.mails[0]!;
    // On the wire the name is quoted only when it has to be.
    assert.equal(m.headers.from, 'Corner Store <hello@corner.example>');
    assert.equal(m.headers['reply-to'], 'orders@corner.example');
    assert.equal(m.headers['x-floreo-type'], 'order');
    assert.equal(m.encrypted, true);
    assert.deepEqual([(await row(f, a.id)).via, (await row(f, a.id)).from_address], ['business', '"Corner Store" <hello@corner.example>']);
    assert.ok((await loadMailSettings(f.db, f.deps.keys, f.tenantA))!.verifiedAt);
    assert.equal(memory.sent.length, 0);

    // Business B has no server: the platform's sender, B's name, replies to B.
    const b = await mail.send({ type: 'order', tenantId: f.tenantB, to: 'ben@buyer.example', subject: 'Order #1', text: 'Thanks' });
    assert.equal(b.status, 'sent');
    assert.equal(memory.sent.length, 1);
    assert.equal(memory.sent[0]!.from, '"Other Business Ltd." <no-reply@localhost>');
    assert.equal(memory.sent[0]!.replyTo, 'office@other.example');
    assert.equal((await row(f, b.id)).via, 'platform');

    // An email from the platform itself never goes through a business's server, even one about that business.
    await mail.send({ type: 'password-reset', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Reset your password', text: 'Link' });
    assert.equal(own.mails.length, 1);
    assert.equal(memory.sent[1]!.from, '"Floreo" <no-reply@localhost>');
  });
});

test('fallback: when a business’s server refuses, the same message goes out from the platform, and the business is told what is wrong', async () => {
  await withMail(async ({ f, service, catcher, memory }) => {
    const own = await catcher({ auth: AUTH });
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(own.port, { username: AUTH.user, password: 'an-old-password' }));
    const mail = await service();

    const first = await mail.send({ type: 'document', tenantId: f.tenantA, to: 'ana@buyer.example', replyTo: 'billing@caribfuel.example', subject: 'Tax Invoice 001-000000001', text: 'Attached.', attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf' }] });
    assert.equal(first.status, 'sent', 'the customer still gets the invoice');
    assert.equal(own.mails.length, 0);
    assert.equal(memory.sent.length, 1);
    const sent = memory.sent[0]!;
    assert.equal(sent.from, '"CaribFuel" <no-reply@localhost>', 'the platform’s address, the business’s name');
    assert.equal(sent.replyTo, 'billing@caribfuel.example');
    assert.equal(sent.attachments![0]!.filename, 'invoice.pdf');
    assert.equal((sent.attachments![0]!.content as Buffer).toString(), '%PDF-1.4 test');
    const r = await row(f, first.id);
    assert.deepEqual([r.status, r.via, r.attempts], ['sent', 'platform', 1]);
    assert.match(r.note!, /own mail server did not take it/);
    assert.match(r.note!, /535 5\.7\.8/);
    let settings = (await loadMailSettings(f.db, f.deps.keys, f.tenantA))!;
    assert.equal(settings.failures, 1);
    assert.match(settings.lastError!, /username or password was refused/);
    assert.equal(settings.pausedUntil, null);

    // Three in a row: the server is left alone for a while, and the business gets one email about it.
    await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order #2', text: 'Thanks' });
    await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order #3', text: 'Thanks' });
    settings = (await loadMailSettings(f.db, f.deps.keys, f.tenantA))!;
    assert.equal(settings.failures, 3);
    assert.ok(settings.pausedUntil && settings.pausedUntil.getTime() > Date.now());
    const notices = memory.sent.filter((s) => s.type === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.to, 'billing@caribfuel.example');
    assert.match(notices[0]!.subject, /your mail server is not accepting email/);
    assert.match(notices[0]!.text, /Settings → Email/);

    // While it is left alone no connection is made to it; mail still goes.
    const connections = own.connections;
    const fourth = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order #4', text: 'Thanks' });
    assert.equal(fourth.status, 'sent');
    assert.equal(own.connections, connections);
    assert.match((await row(f, fourth.id)).note!, /left alone for a few minutes/);
    assert.equal(memory.sent.filter((s) => s.type === 'notice').length, 1, 'told once');

    // The password is fixed and saved: a fresh start, and mail goes through the business's server again.
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(own.port, { username: AUTH.user, password: AUTH.pass }));
    const fixed = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order #5', text: 'Thanks' });
    assert.equal((await row(f, fixed.id)).via, 'business');
    assert.equal(own.mails.length, 1);
  });
});

test('fallback: a business’s server that cannot be reached, or will not send from its address, falls back too; a dead mailbox does not', async () => {
  await withMail(async ({ f, service, catcher, memory }) => {
    const mail = await service();
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(await closedPort()));
    const down = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order', text: 'Thanks' });
    assert.deepEqual([(await row(f, down.id)).status, (await row(f, down.id)).via], ['sent', 'platform']);
    assert.match((await row(f, down.id)).note!, /refused the connection/);

    const own = await catcher();
    own.refuse.mailFrom = () => '553 5.7.1 Sender address rejected: not owned by user';
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(own.port));
    const sender = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order', text: 'Thanks' });
    assert.equal((await row(f, sender.id)).via, 'platform');
    assert.match((await row(f, sender.id)).note!, /will not send from this from address/);
    assert.equal(memory.sent.length, 2);

    // The recipient's mailbox does not exist: the platform would be told the same, so it is not tried.
    own.refuse.mailFrom = undefined;
    own.refuse.rcptTo = () => '550 5.1.1 User unknown';
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(own.port));
    const dead = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'typo@buyer.example', subject: 'Order', text: 'Thanks' });
    assert.equal(dead.status, 'failed');
    assert.equal(memory.sent.length, 2);
    assert.equal((await loadMailSettings(f.db, f.deps.keys, f.tenantA))!.failures, 0, 'not the server’s fault');
  });
});

test('a business’s server may not be an address inside the platform’s own network', async () => {
  await withMail(async ({ f, service, catcher }) => {
    const inside = await catcher();
    const mail = await service({ allowPrivateHosts: false });
    for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '169.254.169.254', '[::1]'.replace(/[[\]]/g, '')]) {
      const result = await mail.sendTest(f.tenantA, { ...settingsFor(inside.port, 'none', false), host }, 'owner@corner.example');
      assert.equal(result.ok, false, host);
      assert.equal(result.error!.kind, 'settings', host);
      assert.match(result.error!.hint, /inside a private network/);
    }
    assert.equal(inside.connections, 0);
    // In the queue too: the message goes out from the platform instead.
    await saveMailSettings(f.db, f.deps.keys, f.tenantA, form(inside.port));
    const receipt = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order', text: 'Thanks' });
    assert.equal((await row(f, receipt.id)).via, 'platform');
    assert.equal(inside.connections, 0);
    // The platform's own server is the operator's choice: a relay on the same machine is fine.
    assert.equal((await mail.sendTest(PLATFORM_SCOPE, settingsFor(inside.port, 'none', false), 'staff@platform.example')).ok, true);
  });
});

// ---------- the queue ----------

test('the queue: send() returns before delivery in the background; a message left "sending" by a crash is taken again; a slow server holds nothing up', async () => {
  await withMail(async ({ f, service, memory }) => {
    const mail = await service({ background: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deliver = memory.deliver.bind(memory);
    memory.deliver = async (m, about) => {
      await gate;
      return deliver(m, about);
    };
    const started = Date.now();
    const receipt = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order', text: 'Thanks' });
    assert.equal(receipt.status, 'queued');
    assert.ok(Date.now() - started < 1000, 'the caller is not kept waiting for the mail server');
    assert.equal(memory.sent.length, 0);
    release();
    await mail.stop();
    assert.equal((await row(f, receipt.id)).status, 'sent');
    assert.equal(memory.sent.length, 1);

    // A server process died mid-send ten minutes ago.
    await f.db.query(`update mail_messages set status = 'sending', sent_at = null, locked_until = now() - interval '1 minute' where id = $1`, [receipt.id]);
    assert.equal(await mail.runOnce(), 1);
    assert.equal((await row(f, receipt.id)).status, 'sent');
    // One that is still being sent by another process is left alone.
    await f.db.query(`update mail_messages set status = 'sending', locked_until = now() + interval '5 minutes' where id = $1`, [receipt.id]);
    assert.equal(await mail.runOnce(), 0);
  });
});

test('the queue: what a message carries is encrypted at rest, and survives exactly', async () => {
  await withMail(async ({ f, service, memory }) => {
    const mail = await service({ background: true });
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
    const receipt = await mail.send({ type: 'document', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Invoice — Señor Ñandú', text: 'Total BZ$1,234.50 ✓', html: '<p>Total <b>BZ$1,234.50</b> ✓</p>', attachments: [{ filename: 'factura ñ.pdf', content: pdf, contentType: 'application/pdf' }, { filename: 'doc.xml', content: '<Invoice>ñ</Invoice>', contentType: 'application/xml' }] });
    await mail.stop();
    const stored = (await f.db.query<{ payload: string | null }>('select payload from mail_messages where id = $1', [receipt.id])).rows[0]!.payload!;
    assert.match(stored, /^v2:/);
    assert.ok(!stored.includes('1,234.50') && !Buffer.from(stored.split(':')[2]!, 'base64').toString('latin1').includes('1,234.50'));
    const m = memory.sent[0]!;
    assert.deepEqual([m.subject, m.text, m.html], ['Invoice — Señor Ñandú', 'Total BZ$1,234.50 ✓', '<p>Total <b>BZ$1,234.50</b> ✓</p>']);
    assert.deepEqual(m.attachments!.map((a) => [a.filename, a.contentType]), [['factura ñ.pdf', 'application/pdf'], ['doc.xml', 'application/xml']]);
    assert.ok((m.attachments![0]!.content as Buffer).equals(pdf));
    assert.equal((m.attachments![1]!.content as Buffer).toString('utf8'), '<Invoice>ñ</Invoice>');
  });
});

test('messages that hold a secret: scrubbed once delivered, never resent, not sent after they stop working; others can be sent again', async () => {
  await withMail(async ({ f, service, memory }) => {
    const mail = await service();
    const reset = await mail.send({ type: 'password-reset', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Reset your password', text: 'https://app.example.test/reset?token=SECRET-TOKEN' });
    assert.equal(reset.status, 'sent');
    assert.equal((await row(f, reset.id)).payload, null, 'the link is not kept');
    await assert.rejects(mail.resend(reset.id, { tenantId: f.tenantA }), /held a link or code/);

    // A sign-in code that could not go out for eleven minutes is not worth sending.
    const waiting = await service({ background: true });
    const code = await waiting.send({ type: 'sign-in-code', tenantId: f.tenantA, to: 'ana@buyer.example', subject: '482913 is your sign-in code', text: '482913' });
    await waiting.stop();
    await f.db.query(`update mail_messages set status = 'queued', sent_at = null, payload = 'x', expires_at = now() - interval '1 minute' where id = $1`, [code.id]);
    const sentBefore = memory.sent.length;
    await waiting.runOnce();
    const r = await row(f, code.id);
    assert.deepEqual([r.status, r.error_code, r.payload], ['failed', 'expired', null]);
    assert.equal(memory.sent.length, sentBefore);

    // An order confirmation is kept, and can be sent again: a new row, the same message.
    const order = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Order #9', text: 'Thanks', html: '<p>Thanks</p>' });
    assert.ok((await row(f, order.id)).payload);
    await assert.rejects(mail.resend(order.id, { tenantId: f.tenantB }), /not in the log/, 'another business cannot resend it');
    const again = await mail.resend(order.id, { tenantId: f.tenantA });
    assert.equal(again.status, 'sent');
    assert.notEqual(again.id, order.id);
    const last = memory.sent.at(-1)!;
    assert.deepEqual([last.to, last.subject, last.html], ['ana@buyer.example', 'Order #9', '<p>Thanks</p>']);
    const log = await mail.list({ tenantId: f.tenantA });
    assert.equal(log.data[0]!.resendOf, order.id);
    assert.equal(log.data.find((e) => e.id === reset.id)!.canResend, false);
    assert.equal(log.data.find((e) => e.id === order.id)!.canResend, true);
  });
});

test('rate limit per business: mail over the limit waits its turn, it is not lost and nothing is thrown; another business is not held up', async () => {
  await withMail(async ({ f, service, memory }) => {
    const mail = await service({ ratePerHour: 2 });
    const send = (tenantId: string, n: number) => mail.send({ type: 'order', tenantId, to: 'ana@buyer.example', subject: `Order #${n}`, text: 'Thanks' });
    assert.equal((await send(f.tenantA, 1)).status, 'sent');
    assert.equal((await send(f.tenantA, 2)).status, 'sent');
    const third = await send(f.tenantA, 3);
    assert.equal(third.status, 'queued');
    const r = await row(f, third.id);
    assert.equal(r.attempts, 0, 'waiting is not a failed attempt');
    assert.match(r.note!, /sent as many emails as it may for now/);
    assert.equal((await send(f.tenantB, 1)).status, 'sent');
    // Emails from the platform to the business (a password reset) are not the business's sending.
    assert.equal((await mail.send({ type: 'password-reset', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Reset', text: 'Link' })).status, 'sent');
    // When the hour is over it goes.
    await f.db.query(`update rate_limits set reset_at = now() - interval '1 second' where key like 'mail|%'`);
    await f.db.query(`update mail_messages set next_attempt_at = now() where id = $1`, [third.id]);
    assert.equal(await mail.runOnce(), 1);
    assert.equal((await row(f, third.id)).status, 'sent');
    assert.equal(memory.sent.filter((m) => m.subject === 'Order #3').length, 1);
  });
});

test('the log is kept 90 days and message bodies 30; a business sees only its own', async () => {
  await withMail(async ({ f, service }) => {
    const mail = await service();
    const old = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Old order', text: 'Thanks' });
    const older = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'Very old order', text: 'Thanks' });
    const fresh = await mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'New order', text: 'Thanks' });
    await mail.send({ type: 'order', tenantId: f.tenantB, to: 'ben@buyer.example', subject: 'B’s order', text: 'Thanks' });
    await mail.send({ type: 'support-notice', to: 'staff@platform.example', subject: 'Platform’s own', text: 'Hello' });
    await f.db.query(`update mail_messages set created_at = now() - interval '40 days' where id = $1`, [old.id]);
    await f.db.query(`update mail_messages set created_at = now() - interval '91 days' where id = $1`, [older.id]);
    assert.deepEqual(await mail.purge(), { deleted: 1, scrubbed: 1 });
    const a = await mail.list({ tenantId: f.tenantA });
    assert.deepEqual(a.data.map((e) => e.subject), ['New order', 'Old order']);
    assert.deepEqual(a.data.map((e) => e.canResend), [true, false]);
    await assert.rejects(mail.resend(old.id, { tenantId: f.tenantA }), /too old to send again/);
    assert.deepEqual((await mail.list({ tenantId: f.tenantB })).data.map((e) => e.subject), ['B’s order']);
    assert.deepEqual((await mail.list({ tenantId: null })).data.map((e) => e.subject), ['Platform’s own']);
    // Staff see everything, with the business's name, and can narrow it down.
    const all = await mail.list({ all: true });
    assert.equal(all.data.length, 4);
    assert.equal(all.data.find((e) => e.subject === 'New order')!.tenantName, 'CaribFuel');
    assert.deepEqual((await mail.list({ all: true, q: 'ben@' })).data.map((e) => e.subject), ['B’s order']);
    assert.deepEqual((await mail.list({ all: true, tenantId: f.tenantA, status: 'sent', limit: 1 })).data.map((e) => e.id), [fresh.id]);
    assert.ok((await mail.list({ all: true, limit: 1 })).nextBefore);
  });
});

// ---------- safeguards ----------

test('recipient addresses: one plain address or nothing', () => {
  for (const good of ['ana@buyer.example', ' Ana.Smith+shop@mail.buyer.co.bz ', "o'neil@example.com"]) assert.equal(checkAddress(good), good.trim());
  for (const bad of ['', 'ana', 'ana@', '@buyer.example', 'ana@buyer', 'a b@buyer.example', 'ana@buyer.example, eve@evil.example', 'Ana <ana@buyer.example>', 'ana@buyer.example\r\nBcc: eve@evil.example', 'ana@buyer..example', '.ana@buyer.example', `${'a'.repeat(65)}@buyer.example`, 'ana@-buyer.example']) {
    assert.throws(() => checkAddress(bad), MailAddressError, JSON.stringify(bad));
  }
  assert.throws(() => checkAddress(undefined), /is missing/);
  assert.equal(cleanSubject('Order\r\nBcc: eve@evil.example\u0000 #5'), 'Order Bcc: eve@evil.example #5');
  assert.equal(formatFrom('Corner "Store"\r\nBcc: eve@evil.example <x>', 'hello@corner.example'), '"Corner Store Bcc: eve@evil.example x" <hello@corner.example>');
  assert.deepEqual(cleanHeaders({ 'List-Unsubscribe': '<https://x.example/u>', 'list-unsubscribe-post': 'List-Unsubscribe=One-Click', Bcc: 'eve@evil.example', 'X-Evil': 'a\r\nBcc: eve@evil.example', 'Auto-Submitted': 'auto\r\nBcc: e@e.e' }),
    { 'List-Unsubscribe': '<https://x.example/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
});

test('header injection: nothing a person typed can add a header or a recipient to the message that goes over the wire', async () => {
  await withMail(async ({ f, service, catcher }) => {
    const c = await catcher();
    await saveMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE, form(c.port, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example' }));
    const mail = await service();
    await assert.rejects(mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example\r\nBcc: eve@evil.example', subject: 'x', text: 'x' }), MailAddressError);
    await assert.rejects(mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example,eve@evil.example', subject: 'x', text: 'x' }), /one address/);
    assert.equal((await f.db.query('select 1 from mail_messages')).rows.length, 0, 'refused before anything is queued');

    // A business whose name carries a line break and a header of its own.
    await f.db.query(`update tenants set trade_name = $2 where id = $1`, [f.tenantA, 'Corner\r\nBcc: eve@evil.example\r\nX-Evil: 1']);
    const receipt = await mail.send({
      type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', replyTo: 'x@corner.example\r\nBcc: eve@evil.example',
      subject: 'Order #5\r\nBcc: eve@evil.example\r\n\r\nInjected body', text: 'Thanks', headers: { 'X-Evil': 'yes', Bcc: 'eve@evil.example' },
      attachments: [{ filename: 'receipt.pdf', content: Buffer.from('x'), contentType: 'application/pdf' }],
    });
    assert.equal(receipt.status, 'sent');
    const m = c.mails[0]!;
    assert.deepEqual(m.to, ['ana@buyer.example'], 'one recipient on the envelope');
    const head = m.raw.slice(0, m.raw.search(/\r?\n\r?\n/));
    assert.ok(!/^bcc:/im.test(head), head);
    assert.ok(!/^x-evil:/im.test(head), head);
    assert.equal(m.headers.subject, 'Order #5 Bcc: eve@evil.example Injected body');
    assert.equal(m.headers.from, '"Corner Bcc: eve@evil.example X-Evil: 1" <no-reply@platform.example>');
    // The reply-to that was not an address is replaced by the business's own, not passed on.
    assert.equal(m.headers['reply-to'], 'billing@caribfuel.example');
    assert.equal(m.text.trim(), 'Thanks');
    await assert.rejects(mail.send({ type: 'order', tenantId: f.tenantA, to: 'ana@buyer.example', subject: 'x', text: 'x', attachments: [{ filename: 'a.pdf\r\nContent-Type: text/html', content: 'x', contentType: 'application/pdf' }] }), /line break/);
  });
});

test('emails that are not transactional carry a way to stop them, by link and by header; stopping them stops only those', async () => {
  await withMail(async ({ f, service, memory }) => {
    const mail = await service();
    const optional = Object.entries(MAIL_TYPES).filter(([, d]) => d.category === 'optional').map(([k]) => k);
    assert.deepEqual(optional.sort(), ['checkout-reminder', 'daily-summary']);

    const summary = () => mail.send({ type: 'daily-summary', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Yesterday', text: 'BZ$120 in sales', html: '<html><body><p>BZ$120 in sales</p></body></html>' });
    assert.equal((await summary()).status, 'sent');
    const m = memory.sent[0]!;
    const link = /<(https:\/\/app\.example\.test\/v1\/mail\/unsubscribe\/([A-Za-z0-9_-]+))>/.exec(m.headers!['List-Unsubscribe']!)!;
    assert.equal(m.headers!['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(m.text.includes(`To stop getting these emails: ${link[1]}`));
    assert.match(m.html!, new RegExp(`<a href="${link[1]!.replace(/[/.]/g, '\\$&')}"[^>]*>Stop getting these emails</a></div></body>`));
    // The token itself is not kept, only its hash.
    assert.ok(!JSON.stringify((await f.db.query('select * from mail_messages')).rows).includes(link[2]!));

    // Looking at the link changes nothing (mail scanners open links); confirming does.
    assert.deepEqual(await mail.unsubscribe(link[2]!, false), { email: 'owner@corner.example', business: 'CaribFuel', what: 'Daily summary' });
    assert.equal((await summary()).status, 'sent');
    assert.ok(await mail.unsubscribe(link[2]!, true));
    assert.equal(await mail.unsubscribe('not-a-real-token-not-a-real-token', true), null);
    const stopped = await summary();
    assert.equal(stopped.status, 'suppressed');
    assert.equal(memory.sent.length, 2);
    // What they are owed is still sent: a receipt, a password reset.
    assert.equal((await mail.send({ type: 'notice', tenantId: f.tenantA, to: 'owner@corner.example', subject: 'Your certificate expires', text: 'Renew' })).status, 'sent');
    // And another business's summaries are its own matter.
    assert.equal((await mail.send({ type: 'daily-summary', tenantId: f.tenantB, to: 'owner@corner.example', subject: 'Yesterday', text: 'x' })).status, 'sent');

    // An optional email that brings its own link (checkout reminders) is left as it is.
    await mail.send({ type: 'checkout-reminder', tenantId: f.tenantB, to: 'ana@buyer.example', subject: 'Still thinking?', text: 'Your cart', headers: { 'List-Unsubscribe': '<https://app.example.test/v1/store/x/checkouts/unsubscribe?t=abc>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    assert.equal(memory.sent.at(-1)!.headers!['List-Unsubscribe'], '<https://app.example.test/v1/store/x/checkouts/unsubscribe?t=abc>');
    assert.ok(!memory.sent.at(-1)!.text.includes('To stop getting'));
    // Without a public address there is no link to give, so the email is not sent at all.
    await assert.rejects((await service({ publicUrl: undefined as never })).send({ type: 'daily-summary', tenantId: f.tenantB, to: 'x@y.example', subject: 's', text: 't' }), /unsubscribe link/);
  });
});

test('no mail server at all: sending says so instead of queueing into nowhere; saving the platform’s settings turns email on', async () => {
  await withMail(async ({ f, catcher }) => {
    const mail = await createMailService(f.db, f.deps.keys, { publicUrl: PUBLIC_URL });
    assert.equal(mail.configured, false);
    await assert.rejects(mail.send({ type: 'notice', tenantId: f.tenantA, to: 'owner@corner.example', subject: 's', text: 't' }), /Email is not set up on this server/);
    assert.deepEqual(await mail.describe(), { source: 'none', host: null, from: null });
    const c = await catcher();
    await saveMailSettings(f.db, f.deps.keys, PLATFORM_SCOPE, form(c.port, { fromName: 'Floreo', fromAddress: 'no-reply@platform.example', replyTo: 'help@platform.example' }));
    assert.equal(await mail.refresh(), true);
    assert.equal(mail.configured, true);
    assert.deepEqual(await mail.describe(), { source: 'saved', host: '127.0.0.1', from: { name: 'Floreo', address: 'no-reply@platform.example' } });
    assert.equal((await mail.send({ type: 'support-notice', to: 'owner@corner.example', subject: 's', text: 't' })).status, 'sent');
    assert.equal(c.mails[0]!.headers.from, 'Floreo <no-reply@platform.example>');
    assert.equal(c.mails[0]!.headers['reply-to'], 'help@platform.example');
  });
});

// ---------- the layout ----------

test('the layout: one column for a phone, the brand at the top, text and HTML versions, and nothing a value can break out of', () => {
  const html = emailHtml({ heading: 'Reset your password', paragraphs: ['Hello Rosa,', 'The link works for one hour.'], button: { label: 'Choose a new password', url: 'https://app.example.test/reset?token=abc&x=1' }, footer: ['You get this because you asked.'] });
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /max-width:560px/);
  assert.match(html, /<div style="font-size:13px;color:#646b7b">Floreo<\/div>/);
  assert.match(html, /<h1[^>]*>Reset your password<\/h1>/);
  assert.match(html, /href="https:\/\/app\.example\.test\/reset\?token=abc&amp;x=1"/);
  const logo = emailHtml({ heading: 'h', paragraphs: [], brand: { name: 'Corner Store', logoUrl: 'https://app.example.test/assets/logo.png' } });
  assert.match(logo, /<img src="https:\/\/app\.example\.test\/assets\/logo\.png" alt="Corner Store" height="40"/);
  assert.equal(emailText({ heading: 'Reset your password', paragraphs: ['Hello Rosa,', 'One hour.'], button: { label: 'Choose a new password', url: 'https://app.example.test/reset' }, footer: ['Small print.'] }),
    'Hello Rosa,\n\nOne hour.\n\nChoose a new password:\nhttps://app.example.test/reset\n\n\n\nSmall print.');

  // Hostile values: a name with markup, a link that is a script, a logo that is one.
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const hostile = emailHtml({ heading: evil, paragraphs: [evil, '{{ secrets }} ${process.env}'], button: { label: evil, url: 'javascript:alert(3)' }, brand: { name: evil, logoUrl: 'javascript:alert(4)' }, footer: [evil] });
  assert.ok(!/<script/i.test(hostile));
  assert.ok(!/<img/i.test(hostile), 'no image from a hostile value');
  assert.ok(!/javascript:/i.test(hostile));
  assert.ok(!/<a /i.test(hostile), 'a link that is not http(s) or mailto is left out entirely');
  assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(hostile, /\{\{ secrets \}\} \$\{process\.env\}/, 'template syntax in a value is just text');
  // Missing pieces leave a tidy email, not "undefined".
  const bare = emailHtml({ heading: 'Hello', paragraphs: [] });
  assert.ok(!/undefined|null/.test(bare));
  assert.equal(safeUrl('https://x.example/a b'), null);
  assert.equal(safeUrl('data:text/html,<script>'), null);
  assert.equal(safeUrl(' mailto:help@example.com '), 'mailto:help@example.com');
});

// ---------- deliverability ----------

test('deliverability: SPF, DKIM and DMARC are read from DNS and explained', async () => {
  const dns = (records: Record<string, string[]>) => async (name: string) => {
    if (name in records) return records[name]!.map((r) => [r.slice(0, 20), r.slice(20)]);
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  };
  const good = await checkDeliverability('Corner.Example', {
    host: 'smtp.gmail.com',
    resolveTxt: dns({
      'corner.example': ['google-site-verification=abc', 'v=spf1 include:_spf.google.com ~all'],
      'google._domainkey.corner.example': ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'],
      '_dmarc.corner.example': ['v=DMARC1; p=quarantine; rua=mailto:postmaster@corner.example'],
    }),
  });
  assert.deepEqual([good.domain, good.provider], ['corner.example', 'google']);
  assert.deepEqual(good.checks.map((c) => [c.record, c.status]), [['spf', 'ok'], ['dkim', 'ok'], ['dmarc', 'ok']]);
  assert.match(good.checks[1]!.message, /the key named “google”/);

  const none = await checkDeliverability('corner.example', { host: 'smtp.gmail.com', resolveTxt: dns({}) });
  assert.deepEqual(none.checks.map((c) => [c.record, c.status]), [['spf', 'missing'], ['dkim', 'unknown'], ['dmarc', 'missing']]);
  assert.equal(none.checks[0]!.suggestion, 'v=spf1 include:_spf.google.com ~all');
  assert.match(none.checks[0]!.message, /lists Gmail \/ Google Workspace as allowed to send for you/);
  assert.equal(none.checks[2]!.suggestion, 'v=DMARC1; p=none; rua=mailto:postmaster@corner.example');
  assert.match(none.checks[1]!.message, /selector/);

  const flawed = await checkDeliverability('corner.example', {
    host: 'smtp.gmail.com', selector: 'mykey',
    resolveTxt: dns({ 'corner.example': ['v=spf1 include:zohomail.com ~all'], '_dmarc.corner.example': ['v=DMARC1; rua=mailto:x@corner.example'] }),
  });
  assert.deepEqual(flawed.checks.map((c) => [c.record, c.status]), [['spf', 'warning'], ['dkim', 'missing'], ['dmarc', 'warning']]);
  assert.match(flawed.checks[0]!.message, /does not mention Gmail/);
  assert.match(flawed.checks[1]!.message, /named “mykey”/);

  const two = await checkDeliverability('corner.example', { resolveTxt: dns({ 'corner.example': ['v=spf1 a ~all', 'v=spf1 mx -all'] }) });
  assert.deepEqual([two.checks[0]!.status, two.provider], ['warning', null]);
  assert.match(two.checks[0]!.message, /two SPF records/);
  assert.equal((await checkDeliverability('corner.example', { resolveTxt: dns({ 'corner.example': ['v=spf1 +all'] }) })).checks[0]!.status, 'warning');

  // DNS itself not answering is not "missing".
  const down = await checkDeliverability('corner.example', { resolveTxt: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); } });
  assert.deepEqual(down.checks.map((c) => c.status), ['unknown', 'unknown', 'unknown']);
});

// ---------- one way out ----------

test('only src/mail/smtp.ts talks to nodemailer, and every email names a type in the catalogue', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.ts')) files.push(join(dir, e.name));
    }
  };
  walk(root);
  const importing = files.filter((file) => /from 'nodemailer|require\('nodemailer|import\('nodemailer/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length).replace(/\\/g, '/'));
  assert.deepEqual(importing, ['mail/smtp.ts']);
  // Sockets to a mail port are opened nowhere else either.
  const sockets = files.filter((file) => /createTransport\(/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length).replace(/\\/g, '/'));
  assert.deepEqual(sockets, ['mail/smtp.ts']);
  for (const [key, def] of Object.entries(MAIL_TYPES)) {
    assert.match(key, /^[a-z][a-z-]+$/);
    assert.ok(def.label && (def.sender === 'business' || def.sender === 'platform'), key);
  }
});

// ---------- the templates a business can edit ----------

test('every email template renders with hostile values as text, and with values missing as a tidy email', async () => {
  const { TEMPLATES } = await import('../src/templates/catalog.ts');
  const { businessContext, renderEmail, sampleContext } = await import('../src/templates/render.ts');
  await withMail(async ({ f }) => {
    const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
    // A business and a customer whose names are markup.
    await f.db.query('update tenants set trade_name = $2 where id = $1', [f.tenantA, evil]);
    const biz = await businessContext(f.db, f.tenantA);
    const hostile = (value: unknown): unknown => (typeof value === 'string' ? (/^https?:/.test(value) ? value : evil) : Array.isArray(value) ? value.map(hostile)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hostile(v)])) : value);
    const emails = TEMPLATES.filter((t) => t.group === 'emails');
    assert.equal(emails.length, 12);
    for (const def of emails) {
      for (const lang of ['en', 'es'] as const) {
        const { context } = await sampleContext(def, biz, lang);
        const mail = await renderEmail(f.db, f.tenantA, def.key, hostile(context) as Record<string, unknown>, { publicUrl: PUBLIC_URL, lang });
        assert.ok(!/<script/i.test(mail.html), `${def.key} ${lang}: a script tag got through`);
        assert.ok(!/<img src=x/i.test(mail.html) && !/onerror=alert\(2\)>/.test(mail.html.replace(/&[a-z]+;/g, '')), `${def.key} ${lang}: markup got through`);
        assert.ok(mail.html.includes('&lt;script&gt;'), `${def.key} ${lang}: the value is there, as text`);
        assert.ok(!/[\r\n]/.test(mail.subject), `${def.key} ${lang}: a subject is one line`);
        assert.ok(mail.text.trim().length > 20, `${def.key} ${lang}: a plain-text version`);
        assert.match(mail.html, /max-width:\d+px/, `${def.key} ${lang}: sized for a phone`);

        // Nothing given at all: no crash, no "undefined", no leftover template syntax.
        const bare = await renderEmail(f.db, f.tenantA, def.key, {}, { publicUrl: PUBLIC_URL, lang });
        assert.ok(!/undefined|\[object Object\]|\{\{|\{%/.test(bare.html + bare.subject + bare.text), `${def.key} ${lang}: missing values leave a tidy email`);
      }
    }
  });
});
