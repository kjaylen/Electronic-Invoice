/**
 * Importing items and customers from a spreadsheet: the CSV reader, a dry run that writes nothing,
 * matching existing records, stock through the ledger, and rows refused with the reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { amount, columns, parseCsv } from '../src/imports/csv.ts';
import { setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('the CSV reader: quotes, commas and line breaks inside fields, a BOM, semicolons, blank lines', () => {
  assert.deepEqual(parseCsv('﻿Name,Price\r\n"Rice, 5 lb","12.50"\r\n\r\n"Say ""hi""",3\n"Two\nlines",1'), [
    ['Name', 'Price'], ['Rice, 5 lb', '12.50'], ['Say "hi"', '3'], ['Two\nlines', '1'],
  ]);
  assert.deepEqual(parseCsv('Name;Price\nBeans;4,50'), [['Name', 'Price'], ['Beans', '4,50']]);
  assert.deepEqual(columns(['Item Name', 'Price (incl. GST)', 'SKU'], { name: ['itemname'], priceWithGst: ['priceinclgst'], code: ['sku'] }), { name: 0, priceWithGst: 1, code: 2 });
  assert.equal(amount('BZ$1,234.50'), '1234.50');
  assert.equal(amount('abc'), null);
});

test('importing items and customers: dry run first, then the good rows; matches by code, barcode, TIN', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
    const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };

    // An item already in the catalog, matched by its code.
    const rice = await app.inject({ method: 'POST', url: '/v1/items', headers: owner, payload: { name: 'Rice', sellerCode: 'RICE5', unitCode: 'H87', unitPrice: '10.00', gstCategory: 'Z' } });
    assert.equal(rice.statusCode, 201, rice.body);

    const csv = [
      'Name,SKU,Barcode,Price,GST,Unit,Stock,Low stock,Quick button',
      'Rice 5 lb,RICE5,,11.00,zero,each,40,10,yes',
      '"Coffee, dark roast",CDR,7500000000028,22.00,S,lb,12,,',
      'Mystery,,,abc,S,,,,',
      'Bread,,,3.00,maybe,,,,',
      'Medicine,MED,,8.00,E,,,,',
      'Cola,COLA,,,S,,,,',
    ].join('\n');
    const dry = await app.inject({ method: 'POST', url: '/v1/items/import', headers: owner, payload: { csv, dryRun: true } });
    assert.equal(dry.statusCode, 200, dry.body);
    const d = dry.json();
    assert.deepEqual([d.dryRun, d.rows, d.created, d.updated, d.errors], [true, 6, 1, 1, 4]);
    assert.deepEqual(d.results.map((r: { action: string }) => r.action), ['update', 'create', 'error', 'error', 'error', 'error']);
    assert.match(d.results[3].message, /GST "maybe"/);
    assert.match(d.results[4].message, /exemption reason/);
    assert.equal((await f.db.query("select count(*)::int as n from items where seller_code = 'CDR'")).rows[0]!.n, 0, 'a dry run writes nothing');

    const done = (await app.inject({ method: 'POST', url: '/v1/items/import', headers: owner, payload: { csv } })).json();
    assert.deepEqual([done.created, done.updated, done.errors], [1, 1, 4]);
    const items = (await app.inject({ method: 'GET', url: '/v1/items?limit=50', headers: owner })).json().data as Array<{ name: string; sellerCode: string; unitPrice: string; unitCode: string; gstCategory: string; barcode: string | null; favorite: boolean; stock: number | null }>;
    const r = items.find((i) => i.sellerCode === 'RICE5')!;
    assert.deepEqual([r.name, r.unitPrice, r.gstCategory, r.unitCode, r.favorite, r.stock], ['Rice 5 lb', '11.00', 'Z', 'EA', true, 40]);
    const c = items.find((i) => i.sellerCode === 'CDR')!;
    assert.deepEqual([c.name, c.barcode, c.unitCode, c.stock], ['Coffee, dark roast', '7500000000028', 'LBR', 12]);
    // The stock came in through the ledger, as a count.
    assert.equal((await f.db.query("select count(*)::int as n from stock_movements where reason in ('initial', 'count') and note = 'Imported'")).rows[0]!.n, 2);

    // Prices with GST: the price before GST is worked out.
    const withGst = (await app.inject({ method: 'POST', url: '/v1/items/import', headers: owner, payload: { csv: 'Name,Price incl. GST\nCappuccino,"BZ$7.31"' } })).json();
    assert.equal(withGst.created, 1);
    const cap = ((await app.inject({ method: 'GET', url: '/v1/items?q=Cappuccino', headers: owner })).json().data as Array<{ unitPrice: string }>)[0]!;
    assert.equal(Number(cap.unitPrice).toFixed(2), '6.50');

    assert.equal((await app.inject({ method: 'POST', url: '/v1/items/import', headers: owner, payload: { csv: 'Title only\nx' } })).json().error.code, 'invalid_csv');

    // Customers: matched by TIN, then email; addresses need street, town and district.
    await app.inject({ method: 'POST', url: '/v1/customers', headers: owner, payload: { name: 'Hotel SI', tin: '777888' } });
    const people = [
      'Customer,TIN,Email,Phone,Address,Town,District',
      'Hotel San Ignacio Ltd.,777888,,824-0000,18 Buena Vista,San Ignacio,Cayo',
      'Maria Chan,,maria@example.com,,,Belize City,',
      'Bad TIN Co,12345,,,,,',
    ].join('\n');
    const cust = (await app.inject({ method: 'POST', url: '/v1/customers/import', headers: owner, payload: { csv: people } })).json();
    assert.deepEqual([cust.created, cust.updated, cust.errors], [1, 1, 1]);
    assert.match(cust.results[1].detail, /address left out/);
    const list = (await app.inject({ method: 'GET', url: '/v1/customers?limit=50', headers: owner })).json().data as Array<{ name: string; tin: string | null; address: { districtCode: string } | null; contact: { email: string | null; telephone: string | null } }>;
    const hotel = list.find((x) => x.tin === '777888')!;
    assert.deepEqual([hotel.name, hotel.address?.districtCode, hotel.contact.telephone], ['Hotel San Ignacio Ltd.', '2', '824-0000']);
    assert.equal(list.find((x) => x.name === 'Maria Chan')?.contact.email, 'maria@example.com');

    // Cashiers cannot import.
    await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const cl = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'cass@biz.example', password: PASSWORD } });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/items/import', headers: { ...CSRF, cookie: cookieFrom(cl), 'x-business': slug }, payload: { csv } })).statusCode, 403);
  } finally {
    await app.close();
    await f.close();
  }
});
