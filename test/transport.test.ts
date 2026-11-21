import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSigningCredentials } from '../src/engine/certificate.ts';
import { deliver, DeliveryError } from '../src/engine/delivery.ts';
import { signDocument } from '../src/engine/sign.ts';
import { BtsClient, DOCUMENT_QUERY_PATH, SUBMIT_PATHS, SYSTEM_STATUS_PATH, TransportError } from '../src/engine/transport.ts';
import { buildUblDocument } from '../src/engine/ubl.ts';
import { applicationResponse, documentQueryReply, startFakeBts, TEST_ROOT_CA, type FakeBts } from './fake-bts.ts';
import { etduiFor, makeDocument } from './fixtures.ts';

const certs = new URL('./certs/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, certs), 'utf8');
const CREDS = loadSigningCredentials(read('signer-123456.key.pem'), read('signer-123456.cert.pem'));
const WHEN = new Date(CREDS.certificate.validFrom.getTime() + 86_400_000);

const INVOICE = makeDocument('01');
const SIGNED = signDocument(buildUblDocument(INVOICE).xml, CREDS, { signingTime: WHEN }).xml;
const ETDUI = INVOICE.etdui;
const PROTOCOL = '05000000100013326800126012820091024411146627';
const INVOICE_PATH = SUBMIT_PATHS['01'];

const noSleep = async () => {};
const authorized = (code: '001' | '002' = '001', conditions?: Array<{ code: string; description: string }>) => ({
  status: 201,
  body: applicationResponse({ responseCode: code, referencedEtdui: ETDUI, protocol: PROTOCOL, ...(conditions && { conditions }) }),
});
const rejected = (code: string, description: string) => ({
  status: 400,
  body: applicationResponse({ responseCode: '003', referencedEtdui: ETDUI, conditions: [{ code, description }] }),
});
const query = (code: '004' | '005' | '006' | '007') => ({ status: 200, contentType: 'application/json', body: documentQueryReply(ETDUI, code) });

async function withBts(fn: (bts: FakeBts, client: BtsClient) => Promise<void>, clientOptions: { timeoutMs?: number } = {}) {
  const bts = await startFakeBts();
  const client = new BtsClient({ environment: 'test', baseUrl: bts.baseUrl, credentials: CREDS, ca: TEST_ROOT_CA, timeoutMs: 2_000, ...clientOptions });
  try {
    await fn(bts, client);
  } finally {
    client.close();
    await bts.close();
  }
}

// ---------- client ----------

test('submits the signed XML over mutual TLS to the right endpoint', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, authorized());
    const res = await client.submit('01', SIGNED);
    assert.equal(res.outcome, 'authorized');
    assert.equal(res.protocolNumber, PROTOCOL);
    assert.equal(res.reply?.referencedEtdui, ETDUI);
    const req = bts.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/invoice/v1');
    assert.match(req.contentType, /^application\/xml/);
    assert.equal(req.body, SIGNED);
    assert.equal(req.clientCn, 'CaribFuel C=BZ TIN=123456'); // the taxpayer certificate authenticated the connection
  }));

test('each document type goes to its own endpoint', () =>
  withBts(async (bts, client) => {
    for (const path of Object.values(SUBMIT_PATHS)) bts.script(path, authorized());
    for (const type of ['01', '02', '03', '04', '05'] as const) await client.submit(type, SIGNED);
    assert.deepEqual(bts.requests.map((r) => r.path), ['/api/invoice/v1', '/api/taxreceipt/v1', '/api/debitnote/v1', '/api/creditnote/v1', '/api/event/v1']);
  }));

test('maps BTS replies to outcomes: alert, rejection, 401, 500, unexpected', () =>
  withBts(async (bts, client) => {
    bts.script(
      INVOICE_PATH,
      authorized('002', [{ code: '278', description: 'Warning: Invoice Type Code list ID' }]),
      rejected('283', 'Rejection: Accounting Customer Party is mandatory'),
      { status: 401, body: '' },
      { status: 500, body: 'Rejection: Server error' },
      { status: 200, body: 'hello' },
    );
    const alert = await client.submit('01', SIGNED);
    assert.equal(alert.outcome, 'authorized_with_alert');
    assert.deepEqual(alert.reply?.conditions.map((c) => c.code), ['278']);
    const rej = await client.submit('01', SIGNED);
    assert.equal(rej.outcome, 'rejected');
    assert.equal(rej.reply?.conditions[0]?.code, '283');
    assert.equal(rej.protocolNumber, undefined);
    assert.equal((await client.submit('01', SIGNED)).outcome, 'unauthorized');
    assert.equal((await client.submit('01', SIGNED)).outcome, 'server_error');
    assert.equal((await client.submit('01', SIGNED)).outcome, 'unexpected');
  }));

test('keeps the raw reply exactly as received', () =>
  withBts(async (bts, client) => {
    const body = authorized().body;
    bts.script(INVOICE_PATH, { status: 201, body });
    assert.equal((await client.submit('01', SIGNED)).rawBody, body);
  }));

test('Document Query posts JSON with the ETDUI', () =>
  withBts(async (bts, client) => {
    bts.script(DOCUMENT_QUERY_PATH, { status: 200, contentType: 'application/json', body: documentQueryReply(ETDUI, '005', SIGNED) });
    const q = await client.queryDocument(ETDUI);
    assert.equal(q.status, 'authorized');
    assert.equal(q.etdXml, SIGNED);
    assert.deepEqual(JSON.parse(bts.requests[0]!.body), { ETDUI });
    assert.match(bts.requests[0]!.contentType, /application\/json/);
  }));

test('System Status reports whether reception is operating', () =>
  withBts(async (bts, client) => {
    bts.script(
      SYSTEM_STATUS_PATH,
      { status: 200, contentType: 'application/json', body: JSON.stringify({ GetStatus: { ResponseCode: '008', StatusResponseTime: 350 } }) },
      { status: 200, contentType: 'application/json', body: JSON.stringify({ GetStatus: { ResponseCode: '009' } }) },
    );
    const up = await client.systemStatus();
    assert.equal(up.operational, true);
    assert.equal(up.averageResponseMs, 350);
    assert.equal((await client.systemStatus()).operational, false);
  }));

test('a slow server produces a timeout error', () =>
  withBts(
    async (bts, client) => {
      bts.script(INVOICE_PATH, { status: 201, body: authorized().body, delayMs: 1_000 });
      await assert.rejects(client.submit('01', SIGNED), (e: unknown) => e instanceof TransportError && e.kind === 'timeout');
    },
    { timeoutMs: 200 },
  ));

test('a dropped connection produces a network error', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, { status: 0, hangUp: true });
    await assert.rejects(client.submit('01', SIGNED), (e: unknown) => e instanceof TransportError && (e.kind === 'network' || e.kind === 'connect'));
  }));

test('a server that does not trust the client certificate refuses the connection', async () => {
  const bts = await startFakeBts({ trustedCa: read('untrusted-root-ca.cert.pem') });
  const client = new BtsClient({ environment: 'test', baseUrl: bts.baseUrl, credentials: CREDS, ca: TEST_ROOT_CA, timeoutMs: 2_000 });
  try {
    bts.script(INVOICE_PATH, authorized());
    await assert.rejects(client.submit('01', SIGNED), TransportError);
    assert.equal(bts.requests.length, 0);
  } finally {
    client.close();
    await bts.close();
  }
});

test('the client refuses a server certificate it does not trust', async () => {
  const bts = await startFakeBts();
  const client = new BtsClient({ environment: 'test', baseUrl: bts.baseUrl, credentials: CREDS, timeoutMs: 2_000 }); // no test CA
  try {
    await assert.rejects(client.submit('01', SIGNED), (e: unknown) => e instanceof TransportError && e.kind === 'connect');
    assert.equal(bts.requests.length, 0);
  } finally {
    client.close();
    await bts.close();
  }
});

test('refuses plain http base URLs', () => {
  assert.throws(() => new BtsClient({ environment: 'test', baseUrl: 'http://localhost', credentials: CREDS }), /https/);
});

// ---------- delivery ----------

test('deliver: authorized on the first attempt', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, authorized());
    const out = await deliver(client, SIGNED, { sleep: noSleep });
    assert.equal(out.status, 'authorized');
    assert.ok(out.status === 'authorized' && out.protocolNumber === PROTOCOL && out.recoveredBy === undefined);
    assert.equal(bts.requests.length, 1);
  }));

test('deliver: a rejection is final and carries the rule codes', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, rejected('283', 'Rejection: Accounting Customer Party is mandatory'));
    const out = await deliver(client, SIGNED, { sleep: noSleep });
    assert.equal(out.status, 'rejected');
    assert.ok(out.status === 'rejected' && out.conditions[0]?.code === '283');
    assert.equal(bts.requests.length, 1);
  }));

test('deliver: after a timeout, Document Query finds it authorized, so it is not sent twice', () =>
  withBts(
    async (bts, client) => {
      bts.script(INVOICE_PATH, { status: 201, body: authorized().body, delayMs: 600 });
      bts.script(DOCUMENT_QUERY_PATH, query('005'));
      const out = await deliver(client, SIGNED, { sleep: noSleep });
      assert.equal(out.status, 'authorized');
      assert.ok(out.status === 'authorized' && out.recoveredBy === 'query');
      assert.deepEqual(bts.requests.map((r) => r.path), [INVOICE_PATH, DOCUMENT_QUERY_PATH]);
    },
    { timeoutMs: 200 },
  ));

test('deliver: 500, query says not found, retry succeeds', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, { status: 500, body: 'Rejection: Server error' }, authorized());
    bts.script(DOCUMENT_QUERY_PATH, query('004'));
    const waits: number[] = [];
    const out = await deliver(client, SIGNED, { sleep: async (ms) => void waits.push(ms), backoffMs: [100, 400] });
    assert.equal(out.status, 'authorized');
    assert.deepEqual(waits, [100]);
    assert.deepEqual(bts.requests.map((r) => r.path), [INVOICE_PATH, DOCUMENT_QUERY_PATH, INVOICE_PATH]);
  }));

test('deliver: a resend rejected with 255 (already authorized) is resolved by Document Query', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, rejected('255', 'Rejection: The ETDUI used in the XML file is the same of one that has already been authorized by EFDR'));
    bts.script(DOCUMENT_QUERY_PATH, query('005'));
    const out = await deliver(client, SIGNED, { sleep: noSleep });
    assert.equal(out.status, 'authorized');
    assert.ok(out.status === 'authorized' && out.recoveredBy === 'duplicate');
  }));

test('deliver: queryFirst settles from Document Query without sending', () =>
  withBts(async (bts, client) => {
    bts.script(DOCUMENT_QUERY_PATH, query('005'));
    bts.script(INVOICE_PATH, authorized());
    const out = await deliver(client, SIGNED, { sleep: noSleep, queryFirst: true });
    assert.equal(out.status, 'authorized');
    assert.deepEqual(bts.requests.map((r) => r.path), [DOCUMENT_QUERY_PATH]);
  }));

test('deliver: 401 stops at once (certificate or issuer problem)', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, { status: 401, body: '' });
    const out = await deliver(client, SIGNED, { sleep: noSleep });
    assert.equal(out.status, 'certificate_problem');
    assert.equal(bts.requests.length, 1);
  }));

test('deliver: still failing after the last attempt is "undetermined", for the caller to switch to contingency', () =>
  withBts(async (bts, client) => {
    bts.script(INVOICE_PATH, { status: 500, body: 'Rejection: Server error' });
    bts.script(DOCUMENT_QUERY_PATH, query('004'));
    const out = await deliver(client, SIGNED, { sleep: noSleep, maxAttempts: 3 });
    assert.equal(out.status, 'undetermined');
    const submits = bts.requests.filter((r) => r.path === INVOICE_PATH).length;
    const queries = bts.requests.filter((r) => r.path === DOCUMENT_QUERY_PATH).length;
    assert.equal(submits, 3);
    assert.equal(queries, 3); // before attempts 2 and 3, and once more before giving up
    assert.equal(out.attempts.length, 6);
  }));

test('deliver: refuses to send to the wrong environment (BTS code 284)', () =>
  withBts(async (bts) => {
    const production = new BtsClient({ environment: 'production', baseUrl: bts.baseUrl, credentials: CREDS, ca: TEST_ROOT_CA });
    try {
      await assert.rejects(deliver(production, SIGNED), (e: unknown) => e instanceof DeliveryError && e.btsCode === 284);
      assert.equal(bts.requests.length, 0);
    } finally {
      production.close();
    }
  }));

test('deliver: refuses to send a document whose signature does not verify', () =>
  withBts(async (bts, client) => {
    const tampered = SIGNED.replace('Island Logistics Ltd.', 'Island Logistics Inc.');
    await assert.rejects(deliver(client, tampered), (e: unknown) => e instanceof DeliveryError && e.btsCode === 241);
    assert.equal(bts.requests.length, 0);
  }));

test('deliver: works for other document types too (credit note)', () =>
  withBts(async (bts, client) => {
    const note = makeDocument('04', { etdui: etduiFor('04', 9) });
    const signed = signDocument(buildUblDocument(note).xml, CREDS, { signingTime: WHEN }).xml;
    bts.script(SUBMIT_PATHS['04'], { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: note.etdui }) });
    const out = await deliver(client, signed, { sleep: noSleep });
    assert.equal(out.status, 'authorized');
    assert.equal(bts.requests[0]!.path, '/api/creditnote/v1');
  }));
