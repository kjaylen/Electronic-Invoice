/**
 * The QuickBooks Online integration, against a stand-in for Intuit's API:
 * connecting (OAuth, state checked), sending documents as invoices, sales
 * receipts and credit memos (with or without mapped tax codes), refreshing
 * tokens, voiding cancelled documents, reconnecting, disconnecting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { getSubscription } from '../src/billing/billing.ts';
import { runQuickBooksSync } from '../src/integrations/quickbooks.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

/** Intuit's OAuth and QuickBooks API, in memory. */
function fakeIntuit() {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const grants: string[] = [];
  let refreshFails = false;
  let ids = 100;
  const customers = new Map<string, string>();
  const items = new Map<string, string>();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.href.startsWith('https://oauth.platform.intuit.com')) {
      const form = new URLSearchParams(String(init?.body));
      grants.push(form.get('grant_type')!);
      if (form.get('grant_type') === 'refresh_token' && refreshFails) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: `access-${grants.length}`, refresh_token: `refresh-${grants.length}`, expires_in: 3600 });
    }
    if (url.href.startsWith('https://developer.api.intuit.com')) return json(200, {});
    const path = url.pathname.replace(/^\/v3\/company\/[^/]+/, '');
    if (init?.method === 'GET' && path.startsWith('/companyinfo/')) return json(200, { CompanyInfo: { CompanyName: 'Corner Store Books' } });
    if (path === '/query') {
      const q = url.searchParams.get('query')!;
      if (q.includes('from Customer')) {
        const name = /DisplayName = '(.+)'/.exec(q)![1]!;
        return json(200, { QueryResponse: customers.has(name) ? { Customer: [{ Id: customers.get(name) }] } : {} });
      }
      if (q.includes('from Item')) return json(200, { QueryResponse: items.has('eInvoicing sales') ? { Item: [{ Id: items.get('eInvoicing sales') }] } : {} });
      if (q.includes('from Account')) return json(200, { QueryResponse: { Account: [{ Id: '79' }] } });
      if (q.includes('from TaxCode')) return json(200, { QueryResponse: { TaxCode: [{ Id: '5', Name: 'GST 12.5%', Active: true }, { Id: '6', Name: 'Zero', Active: true }] } });
    }
    if (init?.method === 'GET') {
      const m = /^\/(invoice|salesreceipt|creditmemo)\/(\d+)$/.exec(path);
      if (m) return json(200, { [{ invoice: 'Invoice', salesreceipt: 'SalesReceipt', creditmemo: 'CreditMemo' }[m[1]!]!]: { Id: m[2], SyncToken: '0' } });
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push({ path: `${path}${url.search.includes('operation') ? `?${url.searchParams.get('operation')}` : ''}`, body });
      const id = String(++ids);
      if (path === '/item') items.set(body.Name, id);
      if (path === '/customer') customers.set(body.DisplayName, id);
      const entity = { '/item': 'Item', '/customer': 'Customer', '/invoice': 'Invoice', '/salesreceipt': 'SalesReceipt', '/creditmemo': 'CreditMemo' }[path];
      return json(200, entity ? { [entity]: { Id: id, SyncToken: '0' } } : {});
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetcher, posts, grants, failRefresh: () => (refreshFails = true) };
}

test('QuickBooks: connect, documents become invoices and sales receipts, tax codes, token refresh, voids, reconnect, disconnect', async () => {
  const f = await setupPipeline();
  const intuit = fakeIntuit();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', quickbooks: { clientId: 'qb-client', clientSecret: 'qb-secret', environment: 'sandbox', fetch: intuit.fetcher } });
  const config = { clientId: 'qb-client', clientSecret: 'qb-secret', environment: 'sandbox' as const, redirectUri: 'https://app.example.test/v1/integrations/quickbooks/callback', fetch: intuit.fetcher };
  const sync = () => runQuickBooksSync({ db: f.db, keys: f.deps.keys, config });
  try {
    f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };

    assert.equal((await app.inject({ method: 'POST', url: '/v1/integrations/quickbooks/connect', headers: owner })).statusCode, 402, 'integrations come with Pro');
    await getSubscription(f.db, f.tenantA);
    await f.db.query("update subscriptions set plan = 'pro' where tenant_id = $1", [f.tenantA]);
    const start = await app.inject({ method: 'POST', url: '/v1/integrations/quickbooks/connect', headers: owner });
    const url = new URL(start.json().url);
    assert.equal(url.origin + url.pathname, 'https://appcenter.intuit.com/connect/oauth2');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.test/v1/integrations/quickbooks/callback');
    assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
    const state = url.searchParams.get('state')!;

    const forged = await app.inject({ method: 'GET', url: '/v1/integrations/quickbooks/callback?code=c&state=not-ours&realmId=123' });
    assert.match(String(forged.headers.location), /quickbooks=failed/, 'an unknown state is refused');
    const back = await app.inject({ method: 'GET', url: `/v1/integrations/quickbooks/callback?code=auth-code&state=${state}&realmId=4620816365` });
    assert.equal(back.headers.location, `https://app.example.test/${slug}/settings?tab=integrations&quickbooks=connected`);
    assert.match(String((await app.inject({ method: 'GET', url: `/v1/integrations/quickbooks/callback?code=auth-code&state=${state}&realmId=4620816365` })).headers.location), /failed/, 'a state works once');
    let status = (await app.inject({ method: 'GET', url: '/v1/integrations', headers: owner })).json().quickbooks;
    assert.equal(status.connected, true);
    assert.equal(status.company, 'Corner Store Books');

    // An invoice and a receipt: sent as Invoice and SalesReceipt, GST included (no tax codes mapped yet).
    const customer = { name: 'Reef Divers Ltd.', tin: '998877', address: { street: '1 A St', city: 'Belize City', districtCode: '1' } };
    const line = { description: 'Tank refill', quantity: '2', unitCode: 'H87', unitPrice: '20.00', gstCategory: 'S' };
    const issue = async (body: Record<string, unknown>) => {
      const r = await app.inject({ method: 'POST', url: '/v1/documents', headers: owner, payload: { payment: { meansCode: '10', terms: 'Cash' }, ...body } });
      assert.equal(r.statusCode, 201, r.body);
      return r.json();
    };
    const invoice = await issue({ type: '01', customer, lines: [line] });
    await issue({ type: '02', lines: [line] });
    let r = await sync();
    assert.equal(r.synced, 2, JSON.stringify(r));
    const inv = intuit.posts.find((p) => p.path === '/invoice')!;
    assert.equal(inv.body.DocNumber, '001-000000001');
    assert.equal(inv.body.GlobalTaxCalculation, 'NotApplicable');
    assert.equal((inv.body.Line as Array<{ Amount: number }>)[0]!.Amount, 45, '40 + GST, so totals agree with the e-invoice');
    assert.match(String(inv.body.PrivateNote), /BTS ETDUI \d{44}/);
    assert.ok(intuit.posts.some((p) => p.path === '/salesreceipt'));
    assert.equal(intuit.posts.filter((p) => p.path === '/item').length, 1, 'the sales item is created once');
    assert.ok(intuit.posts.some((p) => p.path === '/customer' && p.body.DisplayName === 'Reef Divers Ltd.' && p.body.Notes === 'TIN 998877'));
    assert.equal((await sync()).synced, 0, 'never sent twice');

    // With tax codes mapped: net amounts, the tax code on each line, QuickBooks books the GST.
    const codes = (await app.inject({ method: 'GET', url: '/v1/integrations/quickbooks/tax-codes', headers: owner })).json().data;
    assert.deepEqual(codes.map((c: { id: string }) => c.id), ['5', '6']);
    await app.inject({ method: 'PUT', url: '/v1/integrations/quickbooks', headers: owner, payload: { taxCodes: { S: '5', Z: '6' } } });
    await issue({ type: '01', customer, lines: [line] });
    await sync();
    const taxed = intuit.posts.filter((p) => p.path === '/invoice').at(-1)!;
    assert.equal(taxed.body.GlobalTaxCalculation, 'TaxExcluded');
    const taxedLine = (taxed.body.Line as Array<{ Amount: number; SalesItemLineDetail: { Qty: number; UnitPrice: number; TaxCodeRef: { value: string } } }>)[0]!;
    assert.deepEqual([taxedLine.Amount, taxedLine.SalesItemLineDetail.Qty, taxedLine.SalesItemLineDetail.UnitPrice, taxedLine.SalesItemLineDetail.TaxCodeRef.value], [40, 2, 20, '5']);
    assert.equal(intuit.posts.filter((p) => p.path === '/customer' && p.body.DisplayName === 'Reef Divers Ltd.').length, 1, 'the customer is matched, not created again');
    assert.ok(intuit.posts.some((p) => p.path === '/customer' && p.body.DisplayName === 'Walk-in customers'), 'receipts without a customer go to Walk-in customers');

    // An expired access token is refreshed.
    await f.db.query("update integration_connections set access_expires_at = now() - interval '1 minute'");
    await issue({ type: '02', lines: [line] });
    await sync();
    assert.ok(intuit.grants.includes('refresh_token'));

    // A document cancelled with BTS: its QuickBooks copy is voided.
    await f.db.query("update documents set status = 'cancelled' where id = $1", [invoice.id]);
    r = await sync();
    assert.equal(r.voided, 1);
    assert.ok(intuit.posts.some((p) => p.path === '/invoice?void'));

    // QuickBooks revokes the connection: documents wait, the business is asked to reconnect.
    await f.db.query("update integration_connections set access_expires_at = now() - interval '1 minute'");
    intuit.failRefresh();
    await issue({ type: '02', lines: [line] });
    await sync();
    status = (await app.inject({ method: 'GET', url: '/v1/integrations', headers: owner })).json().quickbooks;
    assert.equal(status.status, 'needs_reconnect');
    assert.equal(status.counts.pending, 1, 'the document waits; it is not failed');

    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/integrations/quickbooks', headers: owner })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/integrations', headers: owner })).json().quickbooks.connected, false);
  } finally {
    await app.close();
    await f.close();
  }
});
