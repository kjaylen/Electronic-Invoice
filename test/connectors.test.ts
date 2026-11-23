/**
 * Connectors: QuickBooks Desktop and QuickBooks Point of Sale through the Web
 * Connector. The Web Connector is played here: it signs in, runs what we ask
 * against a pretend QuickBooks (canned qbXML answers in its format), and we
 * check what gets issued to BTS and written back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { processConnectorImports } from '../src/connectors/imports.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { AUTHORIZED, rejectedWith, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const today = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

interface Ctx { f: PipelineFixture; app: FastifyInstance; owner: Record<string, string> }
async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test' });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  // The subscription exists once the business is used: then on the Pro plan, which includes integrations.
  await app.inject({ method: 'GET', url: '/v1/me', headers: owner });
  await f.db.query("update subscriptions set plan = 'pro' where tenant_id = $1", [f.tenantA]);
  try {
    await fn({ f, app, owner });
  } finally {
    await app.close();
    await f.close();
  }
}

// ---------- playing the Web Connector ----------

const soap = (method: string, args: Record<string, string>) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://developer.intuit.com/">${Object.entries(args).map(([k, v]) => `<${k}>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${k}>`).join('')}</${method}></soap:Body></soap:Envelope>`;
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const resultOf = (xml: string, method: string) => {
  const m = new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`).exec(xml);
  return m ? m[1]! : '';
};

async function call(app: FastifyInstance, method: string, args: Record<string, string> = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/qbwc', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"http://developer.intuit.com/${method}"` }, payload: soap(method, args) });
  assert.equal(res.statusCode, 200, res.body);
  return resultOf(res.body, method);
}

/** A whole Web Connector run: sign in, then answer each request from `quickbooks` until we are told it is done. */
async function runSession(app: FastifyInstance, username: string, password: string, quickbooks: (request: string) => string): Promise<{ requests: string[]; closed: string; auth: string[] }> {
  const auth = [...(await call(app, 'authenticate', { strUserName: username, strPassword: password })).matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
  if (!auth[0] || auth[1] === 'nvu' || auth[1] === 'none') return { requests: [], closed: '', auth };
  const ticket = auth[0];
  const requests: string[] = [];
  for (let i = 0; i < 30; i++) {
    const request = unescape(await call(app, 'sendRequestXML', { ticket, strHCPResponse: i === 0 ? '<QBXML><QBXMLMsgsRs><CompanyQueryRs statusCode="0"><CompanyRet><CompanyName>Cayo Hardware Ltd</CompanyName></CompanyRet></CompanyQueryRs></QBXMLMsgsRs></QBXML>' : '', strCompanyFileName: '', qbXMLCountry: 'US', qbXMLMajorVers: '13', qbXMLMinorVers: '0' }));
    if (!request) break;
    requests.push(request);
    const pct = Number(await call(app, 'receiveResponseXML', { ticket, response: quickbooks(request), hresult: '', message: '' }));
    assert.ok(pct >= 0, `receiveResponseXML failed: ${await call(app, 'getLastError', { ticket })}`);
    if (pct >= 100) break;
  }
  return { requests, closed: await call(app, 'closeConnection', { ticket }), auth };
}

// A pretend QuickBooks Desktop: one invoice (with a discount and a non-taxable line) and one sales receipt.
const INVOICE = (editSequence: string, memo = 'Hardware order') => `
<InvoiceRet>
  <TxnID>1A2B-INV</TxnID><TimeModified>${today()}T09:30:00-06:00</TimeModified><EditSequence>${editSequence}</EditSequence>
  <TxnDate>${today()}</TxnDate><RefNumber>1045</RefNumber>
  <CustomerRef><ListID>80000001-CUST</ListID><FullName>Belize Builders</FullName></CustomerRef>
  <BillAddress><Addr1>Belize Builders</Addr1><Addr2>12 Market Square</Addr2><City>Belmopan</City></BillAddress>
  <IsPending>false</IsPending><DueDate>2099-01-31</DueDate><TermsRef><FullName>Net 30</FullName></TermsRef>
  <Subtotal>390.00</Subtotal><SalesTaxPercentage>12.5</SalesTaxPercentage><SalesTaxTotal>42.50</SalesTaxTotal><Memo>${memo}</Memo>
  <InvoiceLineRet><ItemRef><ListID>I-CEMENT</ListID><FullName>Cement 94lb</FullName></ItemRef><Desc>Cement 94lb bag</Desc><Quantity>10</Quantity><Rate>36.00</Rate><Amount>360.00</Amount><SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef></InvoiceLineRet>
  <InvoiceLineRet><ItemRef><ListID>I-DISC</ListID><FullName>Contractor discount</FullName></ItemRef><Desc>5% off</Desc><Amount>-20.00</Amount><SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef></InvoiceLineRet>
  <InvoiceLineRet><ItemRef><ListID>I-DELIV</ListID><FullName>Delivery</FullName></ItemRef><Desc>Delivery to site</Desc><Quantity>1</Quantity><Rate>50.00</Rate><Amount>50.00</Amount><SalesTaxCodeRef><FullName>Non</FullName></SalesTaxCodeRef></InvoiceLineRet>
</InvoiceRet>`;
const RECEIPT = `
<SalesReceiptRet>
  <TxnID>3C4D-SR</TxnID><TimeModified>${today()}T10:00:00-06:00</TimeModified><EditSequence>100</EditSequence>
  <TxnDate>${today()}</TxnDate><RefNumber>R-77</RefNumber><PaymentMethodRef><FullName>Visa</FullName></PaymentMethodRef>
  <Subtotal>8.00</Subtotal><SalesTaxTotal>1.00</SalesTaxTotal>
  <SalesReceiptLineRet><ItemRef><ListID>I-NAILS</ListID><FullName>Nails 1lb</FullName></ItemRef><Desc>Nails 1lb</Desc><Quantity>2</Quantity><Rate>4.00</Rate><Amount>8.00</Amount><SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef></SalesReceiptLineRet>
</SalesReceiptRet>`;

function pretendQuickBooks(state: { invoiceEdit: string; receipts: boolean; mods: string[] }) {
  return (request: string): string => {
    const rs = (body: string) => `<?xml version="1.0"?><QBXML><QBXMLMsgsRs>${body}</QBXMLMsgsRs></QBXML>`;
    if (request.includes('<InvoiceQueryRq')) return rs(`<InvoiceQueryRs requestID="Invoice" statusCode="0" statusSeverity="Info" statusMessage="Status OK" iteratorRemainingCount="0" iteratorID="it1">${INVOICE(state.invoiceEdit)}</InvoiceQueryRs>`);
    if (request.includes('<SalesReceiptQueryRq')) return rs(`<SalesReceiptQueryRs requestID="SalesReceipt" statusCode="0" statusMessage="Status OK" iteratorRemainingCount="0">${state.receipts ? RECEIPT : ''}</SalesReceiptQueryRs>`);
    if (request.includes('<ItemQueryRq')) {
      return rs(`<ItemQueryRs requestID="Item" statusCode="0" statusMessage="Status OK">
        <ItemInventoryRet><ListID>I-CEMENT</ListID><FullName>Cement 94lb</FullName></ItemInventoryRet>
        <ItemDiscountRet><ListID>I-DISC</ListID><FullName>Contractor discount</FullName></ItemDiscountRet>
        <ItemServiceRet><ListID>I-DELIV</ListID><FullName>Delivery</FullName></ItemServiceRet>
        <ItemInventoryRet><ListID>I-NAILS</ListID><FullName>Nails 1lb</FullName></ItemInventoryRet>
      </ItemQueryRs>`);
    }
    if (request.includes('<CustomerQueryRq')) {
      return rs(`<CustomerQueryRs requestID="Customer" statusCode="0" statusMessage="Status OK"><CustomerRet><ListID>80000001-CUST</ListID><FullName>Belize Builders</FullName><CompanyName>Belize Builders Ltd.</CompanyName>
        <BillAddress><Addr1>Belize Builders Ltd.</Addr1><Addr2>12 Market Square</Addr2><City>Belmopan</City></BillAddress><Email>accounts@builders.example</Email>
        <DataExtRet><OwnerID>0</OwnerID><DataExtName>TIN</DataExtName><DataExtType>STR255TYPE</DataExtType><DataExtValue>445566</DataExtValue></DataExtRet></CustomerRet></CustomerQueryRs>`);
    }
    if (request.includes('ModRq')) {
      state.mods.push(request);
      const ids = [...request.matchAll(/<(Invoice|SalesReceipt)ModRq requestID="([^"]+)">/g)];
      return rs(ids.map(([, kind, id]) => `<${kind}ModRs requestID="${id}" statusCode="0" statusMessage="Status OK"><${kind}Ret><EditSequence>${kind === 'Invoice' ? 'ours-1' : 'ours-2'}</EditSequence></${kind}Ret></${kind}ModRs>`).join(''));
    }
    return rs('');
  };
}

test('QuickBooks Desktop: invoices and sales receipts picked up through the Web Connector, issued to BTS, and the BTS number written back', () =>
  withBusiness(async ({ f, app, owner }) => {
    const created = await app.inject({ method: 'POST', url: '/v1/connectors', headers: owner, payload: { kind: 'qbd', name: 'Front office' } });
    assert.equal(created.statusCode, 201, created.body);
    const { id, username, password } = created.json();
    assert.ok(password.length >= 16);
    const qwc = await app.inject({ method: 'GET', url: `/v1/connectors/${id}/qwc`, headers: owner });
    assert.match(qwc.body, /<AppURL>https:\/\/app\.example\.test\/v1\/qbwc<\/AppURL>/);
    assert.match(qwc.body, new RegExp(`<UserName>${username}</UserName>`));
    assert.match(qwc.body, /<QBType>QBFS<\/QBType>/);

    // Wrong password: refused.
    assert.equal((await runSession(app, username, 'nope', () => '')).auth[1], 'nvu');

    const qb = { invoiceEdit: '1', receipts: true, mods: [] as string[] };
    const run1 = await runSession(app, username, password, pretendQuickBooks(qb));
    assert.match(run1.requests[0]!, /<\?qbxml version="13.0"\?>[\s\S]*<InvoiceQueryRq requestID="Invoice" iterator="Start"><MaxReturned>50<\/MaxReturned><ModifiedDateRangeFilter><FromModifiedDate>/);
    assert.ok(run1.requests.some((r) => r.includes('<ItemQueryRq')) && run1.requests.some((r) => r.includes('<CustomerQueryRq')));
    assert.match(run1.closed, /2 document\(s\) picked up/);

    // The worker issues them.
    const issued = await processConnectorImports(f.deps);
    assert.deepEqual(issued, { issued: 2, held: 0, rejected: 0 });
    const list = (await app.inject({ method: 'GET', url: '/v1/connectors/imports', headers: owner })).json().data;
    const inv = list.find((x: { source: { type: string } }) => x.source.type === 'invoice');
    assert.equal(inv.status, 'issued');
    assert.equal(inv.writeback, 'pending');
    const doc = (await app.inject({ method: 'GET', url: `/v1/documents/${inv.document.id}`, headers: owner })).json();
    assert.equal(doc.type, '01');
    assert.equal(doc.customer.name, 'Belize Builders Ltd.');
    assert.equal(doc.customer.tin, '445566', 'the TIN from the customer\'s custom field');
    assert.equal(doc.totals.lineExtension, '390.00', '360 less the 20 discount, plus 50 delivery');
    assert.equal(doc.totals.gst, '42.50', 'GST on the cement only: delivery was non-taxable');
    assert.equal(doc.lines.find((l: { description: string }) => l.description === 'Delivery to site').unitCode, 'E48', 'a service item');
    const receipt = list.find((x: { source: { type: string } }) => x.source.type === 'sales_receipt');
    assert.equal((await app.inject({ method: 'GET', url: `/v1/documents/${receipt.document.id}`, headers: owner })).json().type, '02');

    // Next run: the BTS number goes back into QuickBooks; nothing new is picked up.
    const run2 = await runSession(app, username, password, pretendQuickBooks(qb));
    assert.match(run2.closed, /0 document\(s\) picked up for BTS, 2 updated in QuickBooks/);
    const invoiceMod = qb.mods.join('').match(/<InvoiceMod>[\s\S]*?<\/InvoiceMod>/)![0];
    assert.match(invoiceMod, /<TxnID>1A2B-INV<\/TxnID><EditSequence>1<\/EditSequence><Memo>Hardware order \[BTS \d{3}-\d{9} · authorized · ETDUI \d{44}\]<\/Memo><Other>\d{3}-\d{9}<\/Other>/);
    const after = (await app.inject({ method: 'GET', url: '/v1/connectors/imports', headers: owner })).json().data;
    assert.ok(after.every((x: { writeback: string }) => x.writeback === 'done'));

    // QuickBooks now reports the edit sequence our write-back left: not a change.
    qb.invoiceEdit = 'ours-1';
    qb.mods = [];
    const run3 = await runSession(app, username, password, pretendQuickBooks(qb));
    assert.match(run3.closed, /0 document\(s\) picked up/);
    assert.equal(qb.mods.length, 0);

    // Someone edits the invoice in QuickBooks after it was authorized: flagged, not re-issued.
    qb.invoiceEdit = '7';
    await runSession(app, username, password, pretendQuickBooks(qb));
    const flagged = (await app.inject({ method: 'GET', url: '/v1/connectors/imports?status=issued', headers: owner })).json().data.find((x: { source: { type: string } }) => x.source.type === 'invoice');
    assert.match(flagged.problem, /Changed in QuickBooks after it was sent to BTS/);
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 0, held: 0, rejected: 0 });

    const links = (await app.inject({ method: 'GET', url: '/v1/connectors', headers: owner })).json().data;
    assert.equal(links[0].company, 'Cayo Hardware Ltd');
    assert.ok(links[0].lastSeenAt);
    assert.deepEqual(links[0].taxCodesSeen, ['Non', 'Tax']);
  }));

test('QuickBooks Desktop: an unmapped tax code or a tax difference holds the document until it is fixed; a BTS rejection is written back', () =>
  withBusiness(async ({ f, app, owner }) => {
    const { id, username, password } = (await app.inject({ method: 'POST', url: '/v1/connectors', headers: owner, payload: { kind: 'qbd' } })).json();
    const qb = { invoiceEdit: '1', receipts: true, mods: [] as string[] };
    const quickbooks = pretendQuickBooks(qb);
    // QuickBooks with a code we do not know on the receipt, and a 10% tax on the invoice.
    const odd = (request: string) => quickbooks(request).replace('<SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef></SalesReceiptLineRet>', '<SalesTaxCodeRef><FullName>Exe</FullName></SalesTaxCodeRef></SalesReceiptLineRet>').replace('<SalesTaxTotal>42.50</SalesTaxTotal>', '<SalesTaxTotal>34.00</SalesTaxTotal>').replace('<SalesTaxTotal>1.00</SalesTaxTotal>', '<SalesTaxTotal>0.00</SalesTaxTotal>');
    await runSession(app, username, password, odd);
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 0, held: 2, rejected: 0 });
    const held = (await app.inject({ method: 'GET', url: '/v1/connectors/imports?status=attention', headers: owner })).json().data;
    assert.match(held.find((x: { source: { type: string } }) => x.source.type === 'sales_receipt').problem, /Map these QuickBooks sales tax codes to GST first: Exe/);
    const taxHeld = held.find((x: { source: { type: string } }) => x.source.type === 'invoice');
    assert.match(taxHeld.problem, /QuickBooks charged BZ\$34\.00 sales tax; the e-invoice would carry BZ\$42\.50 GST/);

    // Mapping the code releases the receipt; "issue anyway" sends the invoice.
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { taxCodes: { Exe: 'Z' } } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/connectors/imports/${taxHeld.id}/retry`, headers: owner, payload: { force: true } })).statusCode, 200);
    f.bts.script(SUBMIT_PATHS['01'], rejectedWith('B12', 'Customer TIN is not registered'));
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 1, held: 0, rejected: 1 });
    const rejected = (await app.inject({ method: 'GET', url: '/v1/connectors/imports?status=rejected', headers: owner })).json().data[0];
    assert.match(rejected.problem, /BTS rejected it: B12 Customer TIN is not registered/);

    // The rejection is written into QuickBooks for the bookkeeper to see.
    await runSession(app, username, password, quickbooks);
    assert.match(qb.mods.join(''), /\[BTS not authorized: BTS rejected it: B12 Customer TIN is not registered\. Fix it and save; it is sent again\.\]/);
    // Fixed and saved in QuickBooks (a new edit sequence): picked up again and issued.
    f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
    qb.invoiceEdit = '9';
    const again = await runSession(app, username, password, quickbooks);
    assert.match(again.closed, /1 document\(s\) picked up/);
    assert.equal((await processConnectorImports(f.deps)).issued, 1);
  }));

test('QuickBooks Point of Sale: receipts rung up become BTS receipts; returns are held; the plan and permissions apply', () =>
  withBusiness(async ({ f, app, owner }) => {
    const { id, username, password } = (await app.inject({ method: 'POST', url: '/v1/connectors', headers: owner, payload: { kind: 'qbpos', name: 'Shop till' } })).json();
    assert.match((await app.inject({ method: 'GET', url: `/v1/connectors/${id}/qwc`, headers: owner })).body, /<QBType>QBPOS<\/QBType>/);
    const pos = (request: string) => {
      assert.match(request, /<\?qbposxml version="3.0"\?>[\s\S]*<SalesReceiptQueryRq requestID="PosReceipt" iterator="Start">/);
      return `<?xml version="1.0"?><QBPOSXML><QBPOSXMLMsgsRs><SalesReceiptQueryRs requestID="PosReceipt" statusCode="0" statusMessage="Status OK" iteratorRemainingCount="0">
        <SalesReceiptRet><TxnID>P-1</TxnID><TimeModified>${today()}T11:00:00</TimeModified><TxnDate>${today()}</TxnDate><SalesReceiptNumber>5001</SalesReceiptNumber><SalesReceiptType>Sales</SalesReceiptType>
          <Discount>2.00</Discount><Subtotal>20.00</Subtotal><TaxAmount>2.25</TaxAmount><Total>20.25</Total><TenderType>Cash</TenderType>
          <SalesReceiptItemRet><Desc1>Coffee beans</Desc1><Qty>2</Qty><Price>10.00</Price><TaxCode>Tax</TaxCode><TaxAmount>2.25</TaxAmount></SalesReceiptItemRet></SalesReceiptRet>
        <SalesReceiptRet><TxnID>P-2</TxnID><TimeModified>${today()}T11:05:00</TimeModified><TxnDate>${today()}</TxnDate><SalesReceiptNumber>5002</SalesReceiptNumber><SalesReceiptType>Return</SalesReceiptType>
          <Total>-10.00</Total><SalesReceiptItemRet><Desc1>Coffee beans</Desc1><Qty>-1</Qty><Price>10.00</Price><TaxCode>Tax</TaxCode></SalesReceiptItemRet></SalesReceiptRet>
      </SalesReceiptQueryRs></QBPOSXMLMsgsRs></QBPOSXML>`;
    };
    const run = await runSession(app, username, password, pos);
    assert.match(run.closed, /2 document\(s\) picked up/);
    assert.deepEqual(await processConnectorImports(f.deps), { issued: 1, held: 1, rejected: 0 });
    const list = (await app.inject({ method: 'GET', url: '/v1/connectors/imports', headers: owner })).json().data;
    const sale = list.find((x: { source: { ref: string } }) => x.source.ref === '5001');
    const doc = (await app.inject({ method: 'GET', url: `/v1/documents/${sale.document.id}`, headers: owner })).json();
    assert.equal(doc.type, '02');
    assert.equal(doc.totals.lineExtension, '18.00', 'the receipt discount shared over its lines');
    assert.equal(doc.totals.payable, '20.25');
    assert.equal(sale.writeback, 'none', 'Point of Sale receipts are not written back');
    assert.match(list.find((x: { source: { ref: string } }) => x.source.ref === '5002').problem, /A return: issue a credit note/);

    // Paused: the Web Connector is told there is nothing to do.
    await app.inject({ method: 'PUT', url: `/v1/connectors/${id}`, headers: owner, payload: { paused: true } });
    assert.equal((await runSession(app, username, password, pos)).auth[1], 'none');

    // Integrations need the Pro plan; only owners and admins manage them.
    await f.db.query("update subscriptions set plan = 'business' where tenant_id = $1", [f.tenantA]);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/connectors', headers: owner, payload: { kind: 'qbd' } })).statusCode, 402);
  }));
