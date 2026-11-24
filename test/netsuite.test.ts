/**
 * NetSuite: a pretend NetSuite account answers the OAuth 2.0 token request
 * (checking the JWT against the certificate made here), SuiteQL and the REST
 * record API in their documented shapes. We check what gets issued to BTS and
 * written back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, verify, X509Certificate } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { processConnectorImports } from '../src/connectors/imports.ts';
import { contentHash, normalize, pollDueNetSuite } from '../src/connectors/netsuite.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const HOST = 'https://1234567-sb1.suitetalk.api.netsuite.com';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

// ---------- a pretend NetSuite account ----------

type Rec = Record<string, unknown>;
interface Txn { type: 'CustInvc' | 'CashSale' | 'CustCred'; record: 'invoice' | 'cashSale' | 'creditMemo'; rec: Rec; modified: string; voided?: boolean }

class PretendNetSuite {
  certificatePem = '';
  certificateId = 'cert-abc';
  clientId = 'client-123';
  refuseTokens = false;
  txns = new Map<string, Txn>();
  customers = new Map<string, Rec>();
  queries: string[] = [];
  patches: Array<{ path: string; body: Rec }> = [];
  tokensIssued = 0;
  #clock = 0;

  /** NetSuite's lastmodifieddate, a second later each time something changes. */
  tick() {
    this.#clock++;
    const d = new Date(Date.parse(`${today()}T08:00:00Z`) + this.#clock * 1000);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }

  put(id: string, type: Txn['type'], rec: Rec, extra: Partial<Txn> = {}) {
    const record = type === 'CustInvc' ? 'invoice' : type === 'CashSale' ? 'cashSale' : 'creditMemo';
    this.txns.set(id, { type, record, rec: { id, ...rec }, modified: this.tick(), ...extra });
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${HOST}/services/rest/auth/oauth2/v1/token`) {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      const [h, p, sig] = form.get('client_assertion')!.split('.');
      const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
      const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
      assert.equal(header.alg, 'PS256');
      assert.equal(payload.aud, url);
      assert.deepEqual(payload.scope, ['rest_webservices']);
      assert.ok(payload.exp - payload.iat <= 3600);
      if (this.refuseTokens || header.kid !== this.certificateId) return json(400, { error: 'invalid_grant' });
      if (payload.iss !== this.clientId) return json(401, { error: 'invalid_client' });
      // Signed with the key whose certificate was uploaded.
      const key = new X509Certificate(this.certificatePem).publicKey;
      const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(sig!, 'base64url'));
      if (!ok) return json(400, { error: 'invalid_grant' });
      this.tokensIssued++;
      return json(200, { access_token: `token-${this.tokensIssued}`, token_type: 'bearer', expires_in: 3600 });
    }
    const headers = new Headers(init?.headers);
    assert.match(headers.get('authorization') ?? '', /^Bearer token-\d+$/);
    if (this.refuseTokens) return json(401, { title: 'Unauthorized', status: 401, 'o:errorDetails': [{ detail: 'Invalid login attempt.', 'o:errorCode': 'INVALID_LOGIN' }] });
    const path = url.slice(HOST.length);
    if (path.startsWith('/services/rest/query/v1/suiteql')) {
      assert.equal(headers.get('prefer'), 'transient');
      const q = (JSON.parse(String(init?.body)) as { q: string }).q;
      this.queries.push(q);
      if (!q.includes('lastmodifieddate')) return json(200, { items: [], hasMore: false, count: 0, offset: 0 });
      const since = /lastmodifieddate >= TO_DATE\('([^']+)'/.exec(q)![1]!;
      const types = /t\.type IN \(([^)]+)\)/.exec(q)![1]!;
      const items = [...this.txns.entries()]
        .filter(([, t]) => t.modified >= since && types.includes(`'${t.type}'`))
        .sort(([, a], [, b]) => a.modified.localeCompare(b.modified))
        .map(([id, t]) => ({ id, type: t.type, voided: t.voided ? 'T' : 'F', modified: t.modified, links: [] }));
      return json(200, { items, hasMore: false, count: items.length, offset: 0, totalResults: items.length });
    }
    const m = /^\/services\/rest\/record\/v1\/(\w+)\/([^?]+)/.exec(path);
    if (m) {
      const [, type, id] = m;
      if (type === 'customer') return this.customers.has(id!) ? json(200, this.customers.get(id!)) : json(404, { title: 'Not Found' });
      const t = this.txns.get(id!);
      if (!t || t.record !== type) return json(404, { title: 'Not Found', status: 404 });
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Rec;
        const bad = Object.keys(body).find((k) => k !== 'custbody_bts_number' && k !== 'custbody_bts_status' && k !== 'custbody_bts_qr');
        if (bad) return json(400, { type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.1', title: 'Bad Request', status: 400, 'o:errorDetails': [{ detail: `Invalid field: ${bad}.`, 'o:errorCode': 'INVALID_FLD' }] });
        this.patches.push({ path, body });
        Object.assign(t.rec, body);
        t.modified = this.tick();
        return new Response(null, { status: 204 });
      }
      assert.match(path, /expandSubResources=true/);
      return json(200, t.rec);
    }
    return json(404, { title: 'Not Found' });
  }) as typeof fetch;
}

const line = (item: string, itemType: string, qty: number | null, rate: number | null, amount: number, taxCode = 'S-BZ', description = item) => ({
  item: { id: `item-${item}`, refName: item }, itemType: { id: itemType, refName: itemType }, description, quantity: qty, rate, amount, taxCode: { id: '5', refName: taxCode }, links: [],
});

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string>; ns: PretendNetSuite }
async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const ns = new PretendNetSuite();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', netsuite: { fetch: ns.fetch } });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  await app.inject({ method: 'GET', url: '/v1/me', headers: owner });
  await f.db.query("update subscriptions set plan = 'pro' where tenant_id = $1", [f.tenantA]);
  try {
    await fn({ f, app, owner, ns });
  } finally {
    await app.close();
    await f.close();
  }
}

/** Connect NetSuite: the certificate made here is "uploaded" to the pretend account, then the details are saved. */
async function connect({ app, owner, ns }: Ctx, extra: Record<string, string> = {}) {
  const created = await app.inject({ method: 'POST', url: '/v1/connectors', headers: owner, payload: { kind: 'netsuite', name: 'NetSuite' } });
  assert.equal(created.statusCode, 201, created.body);
  const { id, certificate } = created.json();
  ns.certificatePem = certificate;
  const saved = await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { netsuite: { accountId: '1234567_sb1', clientId: ns.clientId, certificateId: ns.certificateId, ...extra } } });
  assert.equal(saved.statusCode, 200, saved.body);
  return id as string;
}
const readNow = async ({ app, owner, f, ns }: Ctx, id: string) => {
  assert.equal((await app.inject({ method: 'POST', url: `/v1/connectors/${id}/sync`, headers: owner })).statusCode, 200);
  return pollDueNetSuite(f.deps, { fetch: ns.fetch });
};
const imports = async ({ app, owner }: Ctx, status = 'all') => (await app.inject({ method: 'GET', url: `/v1/connectors/imports?status=${status}`, headers: owner })).json().data as Array<{ id: string; status: string; problem: string | null; writeback: string; writebackError: string | null; source: { type: string; ref: string }; document: { id: string } | null }>;

function account(ns: PretendNetSuite) {
  ns.customers.set('501', { id: '501', companyName: 'Belize Builders Ltd.', isPerson: false, email: 'accounts@builders.example', vatRegNumber: '445566' });
  ns.customers.set('502', { id: '502', isPerson: true, firstName: 'Walk-in', lastName: 'Customer' });
  // An invoice: a line, a discount item under it, a 10% header discount and shipping.
  ns.put('101', 'CustInvc', {
    tranId: 'INV1001', tranDate: today(), dueDate: '2099-01-31', terms: { id: '2', refName: 'Net 30' }, memo: 'Coffee order',
    entity: { id: '501', refName: 'Belize Builders' }, currency: { id: '1', refName: 'Belize Dollar' }, exchangeRate: 1,
    billingAddress: { addressee: 'Belize Builders Ltd.', addr1: '12 Market Square', city: 'Belmopan', country: { id: 'BZ', refName: 'Belize' } },
    item: { items: [line('Coffee beans 20lb', 'InvtPart', 10, 40, 400), line('Contractor discount', 'Discount', null, null, -20)] },
    subtotal: 380, discountItem: { id: '9', refName: '10% off' }, discountTotal: -38, shippingCost: 25, shippingTaxCode: { id: '5', refName: 'S-BZ' }, shipMethod: { id: '3', refName: 'Truck' },
    taxTotal: 45.88, total: 412.88,
  });
  // A cash sale paid by card.
  ns.put('102', 'CashSale', {
    tranId: 'CS2001', tranDate: today(), entity: { id: '502', refName: 'Walk-in Customer' }, paymentOption: { id: '4', refName: 'Visa' },
    item: { items: [line('Espresso', 'Service', 2, 5, 10)] }, subtotal: 10, taxTotal: 1.25, total: 11.25, exchangeRate: 1,
  });
}

test('NetSuite: connect with a certificate made here; invoices and cash sales are issued, the BTS number written back, a credit memo issued against its invoice', () =>
  withBusiness(async (c) => {
    const { app, owner, f, ns } = c;
    // The certificate: RSA 3072, valid just under two years (NetSuite's limit).
    const created = await app.inject({ method: 'POST', url: '/v1/connectors', headers: owner, payload: { kind: 'netsuite', name: 'NetSuite' } });
    const { id, certificate } = created.json();
    const cert = new X509Certificate(certificate);
    assert.equal(cert.publicKey.asymmetricKeyDetails?.modulusLength, 3072);
    const days = (Date.parse(cert.validTo) - Date.now()) / 86_400_000;
    assert.ok(days > 700 && days < 730, `valid ${days} days`);
    assert.match((await app.inject({ method: 'GET', url: `/v1/connectors/${id}/certificate`, headers: owner })).body, /^-----BEGIN CERTIFICATE-----/);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/connectors/${id}/qwc`, headers: owner })).statusCode, 409);
    let link = (await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0];
    assert.equal(link.netsuite.configured, false);
    assert.equal(link.username, null);

    // Not uploaded yet (or a wrong certificate ID): saving says what to check.
    ns.certificatePem = certificate;
    const wrong = await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { netsuite: { accountId: '1234567_sb1', clientId: ns.clientId, certificateId: 'nope' } } });
    assert.equal(wrong.statusCode, 422);
    assert.match(wrong.json().error.message, /check the Certificate ID/);
    const badField = await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { netsuite: { accountId: '1234567_sb1', clientId: ns.clientId, certificateId: ns.certificateId, numberField: 'memo' } } });
    assert.match(badField.json().error.message, /start with custbody/);
    const ok = await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { netsuite: { accountId: '1234567_sb1', clientId: ns.clientId, certificateId: ns.certificateId } } });
    assert.equal(ok.statusCode, 200, ok.body);
    link = (await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0];
    assert.equal(link.netsuite.accountId, '1234567_SB1');
    assert.equal(link.netsuite.numberField, 'custbody_bts_number');
    assert.equal(link.lastError, null);

    // First read: both picked up; NetSuite's tax code is not mapped yet, so both wait.
    account(ns);
    const first = await pollDueNetSuite(f.deps, { fetch: ns.fetch });
    assert.deepEqual({ links: first.links, picked: first.picked, errors: first.errors }, { links: 1, picked: 2, errors: 0 });
    assert.match(ns.queries.at(-1)!, new RegExp(`t\\.type IN \\('CustInvc', 'CashSale', 'CustCred'\\) AND t\\.trandate >= TO_DATE\\('${today()}', 'YYYY-MM-DD'\\)`));
    assert.match(ns.queries.at(-1)!, new RegExp(`lastmodifieddate >= TO_DATE\\('${today()} 00:00:00', 'YYYY-MM-DD HH24:MI:SS'\\)`));
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 0, held: 2, rejected: 0 });
    assert.match((await imports(c, 'attention'))[0]!.problem!, /Map these NetSuite tax codes to GST first: S-BZ/);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0].taxCodesSeen, ['S-BZ']);

    // Mapped: both issued.
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { taxCodes: { 'S-BZ': 'S' } } });
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 2, held: 0, rejected: 0 });
    const list = await imports(c);
    const inv = list.find((x) => x.source.type === 'invoice')!;
    const doc = (await app.inject({ method: 'GET', url: `/v1/documents/${inv.document!.id}`, headers: owner })).json();
    assert.equal(doc.type, '01');
    assert.equal(doc.customer.name, 'Belize Builders Ltd.');
    assert.equal(doc.customer.tin, '445566', 'the customer\'s tax registration number');
    assert.equal(doc.customer.address.districtCode, '2', 'Belmopan is in Cayo');
    assert.equal(doc.totals.lineExtension, '367.00', '400 less the 20 discount item, less the 38 header discount, plus 25 shipping');
    assert.equal(doc.totals.gst, '45.88');
    assert.ok(doc.lines.some((l: { description: string; unitCode: string }) => l.description === 'Shipping (Truck)' && l.unitCode === 'E48'));
    assert.match((await app.inject({ method: 'GET', url: `/v1/documents/${inv.document!.id}/xml`, headers: owner })).body, /NetSuite invoice INV1001 of/);
    const cs = list.find((x) => x.source.type === 'sales_receipt')!;
    const receipt = (await app.inject({ method: 'GET', url: `/v1/documents/${cs.document!.id}`, headers: owner })).json();
    assert.equal(receipt.type, '02');
    assert.equal(receipt.lines[0].unitCode, 'E48', 'a service item');

    // Next read: the BTS numbers go back into the custom field.
    const second = await readNow(c, id);
    assert.equal(second.written, 2);
    const invPatch = ns.patches.find((p) => p.path === '/services/rest/record/v1/invoice/101')!;
    assert.match(String(invPatch.body.custbody_bts_number), /^\d{3}-\d{9}$/);
    assert.ok(!('custbody_bts_qr' in invPatch.body), 'no QR field was named, so none is written');
    assert.equal(Object.keys(invPatch.body).length, 1, 'no status field set up, so only the number');
    assert.ok((await imports(c)).every((x) => x.writeback === 'done'));

    // Our write-back changed NetSuite's modified time: read again, found unchanged.
    const third = await readNow(c, id);
    assert.deepEqual({ picked: third.picked, written: third.written }, { picked: 0, written: 0 });
    assert.ok((await imports(c)).every((x) => !x.problem));

    // A credit memo made from the invoice: a credit note against the BTS invoice.
    ns.put('103', 'CustCred', {
      tranId: 'CM301', tranDate: today(), memo: 'One damaged bag', entity: { id: '501', refName: 'Belize Builders' }, createdFrom: { id: '101', refName: 'Invoice #INV1001' },
      item: { items: [line('Coffee beans 20lb', 'InvtPart', 1, 40, 40)] }, subtotal: 40, taxTotal: 5, total: 45, exchangeRate: 1,
    });
    assert.equal((await readNow(c, id)).picked, 1);
    assert.equal((await processConnectorImports(f.deps)).issued, 1);
    const cm = (await imports(c)).find((x) => x.source.type === 'credit_memo')!;
    const note = (await app.inject({ method: 'GET', url: `/v1/documents/${cm.document!.id}`, headers: owner })).json();
    assert.equal(note.type, '04');
    assert.equal(note.referencedEtdui, doc.etdui);

    // Edited in NetSuite after it was authorized: flagged, not re-issued. Voided: flagged too.
    (ns.txns.get('101')!.rec.item as { items: Rec[] }).items[0]!.quantity = 12;
    ns.txns.get('101')!.modified = ns.tick();
    ns.txns.get('102')!.voided = true;
    ns.txns.get('102')!.modified = ns.tick();
    await readNow(c, id);
    const after = await imports(c, 'issued');
    assert.match(after.find((x) => x.source.type === 'invoice')!.problem!, /Changed in NetSuite after it was sent to BTS/);
    assert.match(after.find((x) => x.source.type === 'sales_receipt')!.problem!, /Voided in NetSuite after it was sent to BTS/);
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 0, held: 0, rejected: 0 });
    assert.equal(ns.tokensIssued, 1, 'one token, reused for every read within its hour');
  }));

test('NetSuite: a write-back field that does not exist, other currencies, credit memos without an original, a refused token, and pausing', () =>
  withBusiness(async (c) => {
    const { app, owner, f, ns } = c;
    const id = await connect(c, { numberField: 'custbody_wrong' });
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { taxCodes: { 'S-BZ': 'S' } } });
    account(ns);
    ns.put('104', 'CustInvc', { tranId: 'INV-USD', tranDate: today(), entity: { id: '501', refName: 'Belize Builders' }, currency: { id: '2', refName: 'US Dollar' }, exchangeRate: 2, item: { items: [line('Beans', 'InvtPart', 1, 100, 100)] }, subtotal: 100, taxTotal: 12.5 });
    ns.put('105', 'CustCred', { tranId: 'CM-LOOSE', tranDate: today(), entity: { id: '501', refName: 'Belize Builders' }, item: { items: [line('Beans', 'InvtPart', 1, 10, 10)] }, subtotal: 10, taxTotal: 1.25, exchangeRate: 1 });
    ns.put('106', 'CustCred', { tranId: 'CM-OLD', tranDate: today(), entity: { id: '501', refName: 'Belize Builders' }, createdFrom: { id: '999', refName: 'Invoice #OLD1' }, item: { items: [line('Beans', 'InvtPart', 1, 10, 10)] }, subtotal: 10, taxTotal: 1.25, exchangeRate: 1 });
    await pollDueNetSuite(f.deps, { fetch: ns.fetch });
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 2, held: 3, rejected: 0 });
    const held = await imports(c, 'attention');
    assert.match(held.find((x) => x.source.ref === 'INV-USD')!.problem!, /In US Dollar: only documents in Belize dollars/);
    assert.match(held.find((x) => x.source.ref === 'CM-LOOSE')!.problem!, /not made from an invoice or cash sale/);
    assert.match(held.find((x) => x.source.ref === 'CM-OLD')!.problem!, /Made from Invoice #OLD1, which was not sent to BTS through here/);

    // The write-back field does not exist in their NetSuite: said once, with what to create.
    await readNow(c, id);
    const failed = (await imports(c, 'issued')).find((x) => x.source.type === 'invoice')!;
    assert.equal(failed.writeback, 'failed');
    assert.match(failed.writebackError!, /Invalid field: custbody_wrong[\s\S]*Create a Free-Form Text transaction body field with the ID custbody_wrong/);

    // Fixed to the field they have (and a status field): written at the next read.
    // (And a field for the QR code's address, so NetSuite's own printout can draw the code. It must be a body field too.)
    const badField = await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { netsuite: { qrField: 'bts_qr' } } });
    assert.deepEqual([badField.statusCode, badField.json().error.code], [422, 'invalid_field']);
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { netsuite: { numberField: 'custbody_bts_number', statusField: 'custbody_bts_status', qrField: ' Custbody_BTS_QR ' } } });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0].netsuite.qrField, 'custbody_bts_qr');
    await f.db.query("update connector_imports set writeback = 'pending', writeback_error = null where writeback = 'failed'");
    await readNow(c, id);
    const patch = ns.patches.find((p) => p.path.endsWith('/invoice/101'))!;
    assert.match(String(patch.body.custbody_bts_status), /^BTS \d{3}-\d{9} · authorized · ETDUI \d{44}$/);
    // What the QR code holds: BTS's page for this very document (the test portal, for a test document).
    const etdui = /ETDUI (\d{44})$/.exec(String(patch.body.custbody_bts_status))![1];
    assert.equal(patch.body.custbody_bts_qr, `https://portal.test.bz.efdrciat.org/QRCode?UUID=${etdui}`);

    // NetSuite stops accepting the token, then the certificate (revoked): the connection says what to check.
    ns.refuseTokens = true;
    await readNow(c, id);
    let link = (await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0];
    assert.match(link.lastError, /NetSuite refused the token/);
    await readNow(c, id);
    link = (await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0];
    assert.match(link.lastError, /NetSuite refused the sign-in: check the Certificate ID/);

    // Paused: not read.
    ns.refuseTokens = false;
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { paused: true } });
    await f.db.query('update connector_links set next_poll_at = now() where id = $1', [id]);
    assert.equal((await pollDueNetSuite(f.deps, { fetch: ns.fetch })).links, 0);
  }));

test('NetSuite: reading a record keeps only what the e-invoice uses; the fingerprint ignores our own fields and the memo', () => {
  const rec = {
    id: '7', tranId: 'INV7', tranDate: '2026-11-20', memo: 'a', custbody_bts_number: '001-000000001', entity: { id: '1', refName: 'Shop' },
    item: { items: [line('Rice', 'InvtPart', 2, 3, 6, 'Z-BZ')] }, subtotal: 6, taxTotal: 0, exchangeRate: 1,
  };
  const t = normalize('invoice', rec, { companyName: 'Shop Ltd', custentity_tin: '000123' });
  assert.equal(t.customer.tin, '000123', 'a custom TIN field on the customer');
  assert.deepEqual(t.lines.map((l) => l.taxCode), ['Z-BZ']);
  assert.equal(t.netTotal, '6.00');
  const again = normalize('invoice', { ...rec, memo: 'changed', custbody_bts_number: '001-000000002' }, { companyName: 'Shop Ltd', custentity_tin: '000123' });
  assert.equal(contentHash(again), contentHash(t));
  const edited = normalize('invoice', { ...rec, subtotal: 7 }, { companyName: 'Shop Ltd', custentity_tin: '000123' });
  assert.notEqual(contentHash(edited), contentHash(t));
});

test('NetSuite, as fast as it goes: the answer is written back right after issuing, and NetSuite\'s own script brings the next read forward to now', () =>
  withBusiness(async (c) => {
    const { app, owner, f, ns } = c;
    const id = await connect(c, { qrField: 'custbody_bts_qr' });
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { taxCodes: { 'S-BZ': 'S' } } });
    const nextRead = async () => new Date((await f.db.query<{ next_poll_at: Date }>('select next_poll_at from connector_links where id = $1', [id])).rows[0]!.next_poll_at).getTime();
    account(ns);

    // Read by itself, a minute apart (not five).
    await f.db.query('update connector_links set next_poll_at = now() where id = $1', [id]);
    assert.equal((await pollDueNetSuite(f.deps, { fetch: ns.fetch })).picked, 2);
    const wait = (await nextRead()) - Date.now();
    assert.ok(wait > 30_000 && wait < 90_000, `the next read is about a minute away (${wait} ms)`);
    assert.equal((await pollDueNetSuite(f.deps, { fetch: ns.fetch })).links, 0, 'not due yet');

    // Issued: the answer does not wait for that minute. The next tick writes it, QR address included, with nobody asking.
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 2, held: 0, rejected: 0 });
    assert.ok((await nextRead()) <= Date.now() + 1000, 'the read is brought forward to now');
    assert.equal((await pollDueNetSuite(f.deps, { fetch: ns.fetch })).written, 2);
    const patch = ns.patches.find((p) => p.path === '/services/rest/record/v1/invoice/101')!;
    assert.match(String(patch.body.custbody_bts_number), /^\d{3}-\d{9}$/);
    assert.match(String(patch.body.custbody_bts_qr), /^https:\/\/portal\.test\.bz\.efdrciat\.org\/QRCode\?UUID=\d{44}$/);
    // Nothing left to write: it goes back to once a minute, not round and round.
    await processConnectorImports(f.deps);
    assert.ok((await nextRead()) > Date.now() + 30_000);

    // The script for NetSuite: this connection's address and a token of its own, shown once.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0].netsuite.instant, false);
    const made = await app.inject({ method: 'POST', url: `/v1/connectors/${id}/notify-script`, headers: owner, payload: {} });
    assert.equal(made.statusCode, 200, made.body);
    const { script, url, filename } = made.json() as { script: string; url: string; filename: string };
    assert.equal(url, `https://app.example.test/v1/netsuite/notify/${id}`);
    assert.equal(filename, 'floreo_notify.js');
    assert.ok(script.includes('@NScriptType UserEventScript') && script.includes(JSON.stringify(url)) && script.includes('REST_WEBSERVICES'));
    const token = /const TOKEN = "([A-Za-z0-9_-]{40,})";/.exec(script)![1]!;
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data[0].netsuite.instant, true);
    const stored = (await f.db.query<{ config: Record<string, string> }>('select config from connector_links where id = $1', [id])).rows[0]!.config;
    assert.ok(stored.notifyTokenHash && !JSON.stringify(stored).includes(token), 'only its hash is kept');

    // NetSuite saves a sale and says so: no sign-in, only the token; the read is now.
    const notify = (auth: string | null, link = id) => app.inject({ method: 'POST', url: `/v1/netsuite/notify/${link}`, headers: { 'content-type': 'application/json', ...(auth && { authorization: auth }) }, payload: {} });
    assert.equal((await notify(null)).statusCode, 401);
    assert.equal((await notify('Bearer not-the-token-not-the-token-not-the-token')).statusCode, 401);
    assert.equal((await notify(`Bearer ${token}`, '00000000-0000-4000-8000-000000000000')).statusCode, 401);
    assert.ok((await nextRead()) > Date.now() + 30_000, 'a wrong token changes nothing');
    const told = await notify(`Bearer ${token}`);
    assert.equal(told.statusCode, 202, told.body);
    assert.ok((await nextRead()) <= Date.now() + 1000);
    assert.equal((await pollDueNetSuite(f.deps, { fetch: ns.fetch })).links, 1);

    // Paused: told, but not read. A new script replaces the old one's token.
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { paused: true } });
    assert.equal((await notify(`Bearer ${token}`)).statusCode, 202);
    assert.ok((await nextRead()) > Date.now() + 30_000);
    await app.inject({ method: 'POST', url: `/v1/connectors/${id}/notify-script`, headers: owner, payload: {} });
    assert.equal((await notify(`Bearer ${token}`)).statusCode, 401);
  }));
