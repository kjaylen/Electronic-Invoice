/**
 * The public API: webhooks (outbox, signed deliveries, retries, switching off
 * a failing endpoint, refusing private addresses), per-key rate limits, and
 * the OpenAPI description.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/api/app.ts';
import { getSubscription } from '../src/billing/billing.ts';
import { createApiKey } from '../src/db/apikeys.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { checkEndpointUrl, dispatchWebhooks, isPrivateAddress, verifySignature } from '../src/webhooks/webhooks.ts';
import { AUTHORIZED, rejectedWith, setupPipeline } from './pipeline-setup.ts';

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

/** A local endpoint that records what it gets and answers with `status()`. */
async function receiver() {
  const got: Received[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status).end('thanks');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    got,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    answer: (s: number) => (status = s),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const receipt = { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } };

test('webhook URLs: https only, never private or internal addresses', () => {
  assert.throws(() => checkEndpointUrl('http://example.com/hook'), /https/);
  for (const bad of ['https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://192.168.0.10/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://db.internal/x', 'https://[::1]/x', 'https://user:pw@example.com/x']) {
    assert.throws(() => checkEndpointUrl(bad), Error, bad);
  }
  assert.equal(checkEndpointUrl('https://hooks.example.com/einvoicing?k=1').hostname, 'hooks.example.com');
  for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.255', '100.64.0.1', '0.0.0.0', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '200.32.1.1', '2001:4860:4860::8888']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('webhooks: Pro plan; signed deliveries when documents are authorized or rejected; retries; a failing endpoint is switched off', async () => {
  const f = await setupPipeline();
  const hook = await receiver();
  const app = await buildApp({ pipeline: f.deps, webhooksAllowPrivate: true });
  try {
    const key = (await createApiKey(f.db, f.tenantA, 'erp')).key;
    const h = { authorization: `Bearer ${key}` };
    const create = () => app.inject({ method: 'POST', url: '/v1/webhooks', headers: h, payload: { url: hook.url, events: ['document.authorized', 'document.rejected'], description: 'Our ERP' } });
    assert.equal((await create()).statusCode, 402, 'webhooks come with the Pro plan');
    await getSubscription(f.db, f.tenantA);
    await f.db.query("update subscriptions set plan = 'pro' where tenant_id = $1", [f.tenantA]);
    const made = await create();
    assert.equal(made.statusCode, 201, made.body);
    const { id: endpointId, secret } = made.json();
    assert.match(secret, /^whsec_/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/webhooks', headers: h })).json().data[0].secret, undefined, 'the secret is shown only once');

    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const doc = (await app.inject({ method: 'POST', url: '/v1/documents', headers: h, payload: receipt })).json();
    const sent = await dispatchWebhooks(f.db, { keys: f.deps.keys, allowPrivate: true });
    assert.deepEqual(sent, { created: 1, attempted: 1 });
    const first = hook.got[0]!;
    assert.equal(first.headers['x-einvoicing-event'], 'document.authorized');
    assert.ok(verifySignature(secret, String(first.headers['x-einvoicing-signature']), first.body), 'signed with the endpoint secret');
    assert.equal(verifySignature('whsec_wrong', String(first.headers['x-einvoicing-signature']), first.body), false);
    const event = JSON.parse(first.body);
    assert.equal(event.type, 'document.authorized');
    assert.equal(event.data.document.id, doc.id);
    assert.equal(event.data.document.number, '001-000000001');
    assert.equal(event.data.document.totals.taxInclusive, '4.50');

    // A rejected document; the endpoint is down: retried later, not lost.
    hook.answer(500);
    f.bts.script(SUBMIT_PATHS['02'], rejectedWith('271', 'Bad hash'));
    await app.inject({ method: 'POST', url: '/v1/documents', headers: h, payload: receipt });
    await dispatchWebhooks(f.db, { keys: f.deps.keys, allowPrivate: true });
    let deliveries = (await app.inject({ method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries`, headers: h })).json().data;
    assert.equal(deliveries[0].type, 'document.rejected');
    assert.equal(deliveries[0].status, 'pending');
    assert.equal(deliveries[0].responseStatus, 500);
    assert.ok(new Date(deliveries[0].nextAttemptAt).getTime() > Date.now() + 50_000, 'next try in about a minute');
    hook.answer(200);
    await f.db.query("update webhook_deliveries set next_attempt_at = now() where status = 'pending'");
    await dispatchWebhooks(f.db, { keys: f.deps.keys, allowPrivate: true });
    deliveries = (await app.inject({ method: 'GET', url: `/v1/webhooks/${endpointId}/deliveries`, headers: h })).json().data;
    assert.equal(deliveries[0].status, 'delivered');
    assert.equal(deliveries[0].attempts, 2);

    // The test button.
    const ping = await app.inject({ method: 'POST', url: `/v1/webhooks/${endpointId}/test`, headers: h });
    assert.deepEqual(ping.json(), { ok: true, status: 200, error: null });
    assert.equal(hook.got.at(-1)!.headers['x-einvoicing-event'], 'ping');

    // Twenty failures in a row switch the endpoint off.
    hook.answer(503);
    await f.db.query('update webhook_endpoints set consecutive_failures = 19 where id = $1', [endpointId]);
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    await app.inject({ method: 'POST', url: '/v1/documents', headers: h, payload: receipt });
    await dispatchWebhooks(f.db, { keys: f.deps.keys, allowPrivate: true });
    const ep = (await app.inject({ method: 'GET', url: '/v1/webhooks', headers: h })).json().data[0];
    assert.equal(ep.enabled, false);
    assert.match(ep.disabledReason, /20 failed/);
    const back = await app.inject({ method: 'PATCH', url: `/v1/webhooks/${endpointId}`, headers: h, payload: { enabled: true } });
    assert.equal(back.json().consecutiveFailures, 0);

    // Rotating the secret.
    const rotated = (await app.inject({ method: 'POST', url: `/v1/webhooks/${endpointId}/rotate-secret`, headers: h })).json();
    assert.notEqual(rotated.secret, secret);
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/webhooks/${endpointId}`, headers: h })).statusCode, 204);
  } finally {
    await app.close();
    await hook.close();
    await f.close();
  }
});

test('API keys are rate limited per minute, with headers telling how many are left', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, apiRateLimitPerMinute: 3 });
  try {
    const h = { authorization: `Bearer ${(await createApiKey(f.db, f.tenantA, 'pos')).key}` };
    const r1 = await app.inject({ method: 'GET', url: '/v1/me', headers: h });
    assert.equal(r1.headers['x-ratelimit-limit'], '3');
    assert.equal(r1.headers['x-ratelimit-remaining'], '2');
    await app.inject({ method: 'GET', url: '/v1/me', headers: h });
    await app.inject({ method: 'GET', url: '/v1/me', headers: h });
    const over = await app.inject({ method: 'GET', url: '/v1/me', headers: h });
    assert.equal(over.statusCode, 429);
    assert.equal(over.headers['retry-after'], '60');
    assert.equal(over.json().error.code, 'rate_limited');
    const other = { authorization: `Bearer ${(await createApiKey(f.db, f.tenantA, 'erp')).key}` };
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: other })).statusCode, 200, 'each key has its own budget');
  } finally {
    await app.close();
    await f.close();
  }
});

test('the OpenAPI description covers the API-key routes, from their own schemas', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, publicUrl: 'https://app.example.test' });
  try {
    const spec = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.servers[0].url, 'https://app.example.test');
    const issue = spec.paths['/v1/documents'].post;
    assert.equal(issue.tags[0], 'Documents');
    assert.ok(issue.requestBody.content['application/json'].schema.properties.lines, 'the body schema is the route\'s own');
    assert.ok(issue.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key'));
    assert.deepEqual(spec.paths['/v1/documents/{id}'].get.parameters.map((p: { name: string; in: string }) => [p.name, p.in]), [['id', 'path']]);
    assert.ok(spec.paths['/v1/webhooks'].post);
    for (const hidden of ['/v1/users', '/v1/billing', '/v1/api-keys', '/v1/audit']) assert.equal(spec.paths[hidden], undefined, hidden);
    assert.match(spec.info.description, /X-EInvoicing-Signature/);
  } finally {
    await app.close();
    await f.close();
  }
});
