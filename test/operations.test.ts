/**
 * Operations: notification emails (each sent once), monitoring status,
 * alerts to a webhook, metrics, shared rate limits and the TOTP algorithm.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteDatabase } from '../src/db/database.ts';
import { keyringProtector, localKeyProtector } from '../src/db/keystore.ts';
import { rotateSecrets } from '../src/db/rotation.ts';
import { addCertificate, createTenant, loadTenantContext } from '../src/db/tenants.ts';
import { buildApp } from '../src/api/app.ts';
import { runHousekeepingOnce } from '../src/api/housekeeping.ts';
import { atLimit, countHit, overLimit, sweepRateLimits } from '../src/db/ratelimit.ts';
import { base32Decode, base32Encode, beginTwoFactorSetup, confirmTwoFactorSetup, matchTotp, totpCode } from '../src/db/twofactor.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { type Mailer, memoryMailer } from '../src/mail/mailer.ts';
import { runNotifications } from '../src/notify/notifications.ts';
import { heartbeat, opsStatus, sendAlerts } from '../src/ops/monitoring.ts';
import { issueDocument } from '../src/pipeline/issue.ts';
import { invoiceRequest, readCert, rejectedWith, setupPipeline, TENANT_A } from './pipeline-setup.ts';

test('TOTP matches the RFC 6238 reference values and base32 round-trips', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.deepEqual(base32Decode('mzxw 6ytb oi'), Buffer.from('foobar'));
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(matchTotp(secret, totpCode(secret, step - 1), now), step - 1, 'one step of clock drift is fine');
  assert.equal(matchTotp(secret, totpCode(secret, step - 2), now), null, 'two steps is not');
});

test('rate limits are shared through the database: count, limit, window, sweep', async () => {
  const f = await setupPipeline();
  try {
    for (let i = 0; i < 3; i++) assert.equal(await overLimit(f.db, 'k', 3, 60_000), false);
    assert.equal(await overLimit(f.db, 'k', 3, 60_000), true, 'the fourth hit is over');
    assert.equal(await atLimit(f.db, 'fail', 2), false);
    await countHit(f.db, 'fail', 60_000);
    await countHit(f.db, 'fail', 60_000);
    assert.equal(await atLimit(f.db, 'fail', 2), true);
    await f.db.query("update rate_limits set reset_at = now() - interval '1 second'");
    assert.equal(await atLimit(f.db, 'fail', 2), false, 'an expired window does not count');
    assert.equal(await overLimit(f.db, 'k', 3, 60_000), false, 'a new window starts at 1');
    assert.equal(await sweepRateLimits(f.db), 1, 'the expired "fail" window is swept');
  } finally {
    await f.close();
  }
});

test('notifications: a rejection, an outage and an expiring certificate each email the owners once', async () => {
  const f = await setupPipeline();
  try {
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive Owner', email: 'olive@caribfuel.example', role: 'owner', password: 'correct horse battery' });
    await createUser(f.db, { tenantId: f.tenantA, name: 'Carl Cashier', email: 'carl@caribfuel.example', role: 'cashier', password: 'correct horse battery' });
    const mail = memoryMailer();
    const options = { mailer: mail, publicUrl: 'https://app.example.test' };

    f.bts.script(SUBMIT_PATHS['01'], rejectedWith('271', 'The customer TIN is not registered'));
    const doc = await issueDocument(f.deps, f.tenantA, invoiceRequest());
    assert.equal(doc.status, 'rejected');
    let r = await runNotifications(f.db, options);
    assert.equal(r.sent, 1);
    assert.equal(mail.sent.length, 1, 'owners and admins only, not cashiers');
    assert.equal(mail.sent[0]!.to, 'olive@caribfuel.example');
    assert.match(mail.sent[0]!.subject, /CaribFuel: BTS rejected a document/);
    assert.match(mail.sent[0]!.text, /not registered/);
    assert.match(mail.sent[0]!.text, /https:\/\/app\.example\.test\/[a-z0-9-]+\/documents\?status=rejected/);
    assert.equal((await runNotifications(f.db, options)).sent, 0, 'never twice');

    // An outage: one email when it starts, one when it ends.
    const period = '11111111-1111-4111-8111-111111111111';
    await f.db.query("insert into contingency_periods (id, tenant_id, reason, started_at) values ($1, $2, 'BTS did not answer', now())", [period, f.tenantA]);
    r = await runNotifications(f.db, options);
    assert.equal(r.sent, 1);
    assert.match(mail.sent.at(-1)!.subject, /BTS cannot be reached/);
    await f.db.query('update contingency_periods set ended_at = now() where id = $1', [period]);
    await runNotifications(f.db, options);
    assert.match(mail.sent.at(-1)!.subject, /BTS is back/);
    assert.equal((await runNotifications(f.db, options)).sent, 0);

    // A certificate with five days left: one email (not one per threshold), then the next at 1 day.
    await f.db.query("update certificates set valid_to = now() + interval '5 days 2 hours' where tenant_id = $1", [f.tenantA]);
    const before = mail.sent.length;
    await runNotifications(f.db, options);
    assert.equal(mail.sent.length, before + 1);
    assert.match(mail.sent.at(-1)!.subject, /certificate expires in 5 days/);
    assert.equal((await runNotifications(f.db, options)).sent, 0);
    await f.db.query("update certificates set valid_to = now() + interval '20 hours' where tenant_id = $1", [f.tenantA]);
    await runNotifications(f.db, options);
    assert.match(mail.sent.at(-1)!.subject, /expires in 0 days/);

    // A failed send is retried on the next run.
    await f.db.query("update certificates set valid_to = now() - interval '1 hour' where tenant_id = $1", [f.tenantA]);
    const broken: Mailer = { send: async () => { throw new Error('SMTP down'); } };
    assert.equal((await runNotifications(f.db, { mailer: broken })).failed, 1);
    assert.equal((await runNotifications(f.db, options)).sent, 1);
    assert.match(mail.sent.at(-1)!.subject, /has expired/);
  } finally {
    await f.close();
  }
});

test('monitoring: worker heartbeat, stuck documents, alerts when problems start and end, /health and /metrics', async () => {
  const f = await setupPipeline();
  try {
    let s = await opsStatus(f.db);
    assert.equal(s.status, 'degraded');
    assert.deepEqual(s.problems.map((p) => p.key), ['worker_stale']);
    await heartbeat(f.db, 'worker');
    s = await opsStatus(f.db);
    assert.equal(s.status, 'ok');
    assert.equal(s.worker.stale, false);

    const posted: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)).text);
      return new Response('ok');
    }) as typeof fetch;
    await f.db.query("update worker_heartbeats set at = now() - interval '10 minutes' where name = 'worker'");
    let alerts = await sendAlerts(f.db, await opsStatus(f.db), { webhookUrl: 'https://hooks.example.test/x', environment: 'staging', fetch: fakeFetch });
    assert.deepEqual(alerts.fired, ['worker_stale']);
    assert.match(posted[0]!, /staging.*worker last reported 10 minutes ago/);
    alerts = await sendAlerts(f.db, await opsStatus(f.db), { webhookUrl: 'https://hooks.example.test/x', fetch: fakeFetch });
    assert.deepEqual(alerts.fired, [], 'not repeated while it lasts');
    await heartbeat(f.db, 'worker');
    alerts = await sendAlerts(f.db, await opsStatus(f.db), { webhookUrl: 'https://hooks.example.test/x', fetch: fakeFetch });
    assert.deepEqual(alerts.resolved, ['worker_stale']);
    assert.match(posted.at(-1)!, /resolved/);

    // Housekeeping runs the lot and reports in.
    const h = await runHousekeepingOnce(f.db, { mailer: memoryMailer() });
    assert.deepEqual(h.notifications, { sent: 0, failed: 0 });
    assert.equal((await f.db.query("select count(*)::int as n from worker_heartbeats where name = 'housekeeping'")).rows[0]!.n, 1);

    const token = 'm'.repeat(40);
    const app = await buildApp({ pipeline: f.deps, metricsToken: token });
    try {
      assert.deepEqual((await app.inject({ method: 'GET', url: '/health' })).json(), { status: 'ok', worker: 'ok' });
      assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
      const metrics = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${token}` } });
      assert.equal(metrics.statusCode, 200);
      assert.match(metrics.body, /^einvoicing_up 1$/m);
      assert.match(metrics.body, /^einvoicing_documents_pending 0$/m);
      assert.match(metrics.body, /^einvoicing_http_requests_total \d+$/m);
    } finally {
      await app.close();
    }
    const noMetrics = await buildApp({ pipeline: f.deps });
    assert.equal((await noMetrics.inject({ method: 'GET', url: '/metrics' })).statusCode, 404, 'off without a token');
    await noMetrics.close();
  } finally {
    await f.close();
  }
});

test('key rotation re-encrypts certificate keys and two-step secrets under the new key, once', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    const OLD = randomBytes(32);
    const NEW = randomBytes(32);
    const old = localKeyProtector(OLD);
    const tenant = await createTenant(db, TENANT_A);
    await addCertificate(db, old, tenant, { certificatePem: readCert('signer-123456.cert.pem'), privateKeyPem: readCert('signer-123456.key.pem') });
    const user = await createUser(db, { tenantId: tenant, name: 'Olive', email: 'olive@x.example', role: 'owner', password: 'correct horse battery' });
    const secret = await beginTwoFactorSetup(db, old, 'user', user.id);

    const ring = keyringProtector(NEW, [OLD]);
    assert.deepEqual(await rotateSecrets(db, ring, { dryRun: true }), { certificates: 1, twoFactorSecrets: 1, alreadyCurrent: 0 });
    assert.deepEqual(await rotateSecrets(db, ring), { certificates: 1, twoFactorSecrets: 1, alreadyCurrent: 0 });
    assert.deepEqual(await rotateSecrets(db, ring), { certificates: 0, twoFactorSecrets: 0, alreadyCurrent: 2 }, 'running it again changes nothing');

    // The new key alone now reads everything.
    const onlyNew = localKeyProtector(NEW);
    assert.equal((await loadTenantContext(db, onlyNew, tenant)).tenantId, tenant);
    const confirmed = await confirmTwoFactorSetup(db, onlyNew, 'user', user.id, totpCode(base32Decode(secret), Math.floor(Date.now() / 30_000)));
    assert.equal(confirmed.length, 10);
  } finally {
    await db.close();
  }
});
