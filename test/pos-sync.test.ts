/**
 * Offline-first tills, the server's side: the snapshot a till sells from, and
 * the upload of what it did offline. A sale reaches the server exactly once,
 * keeps the number, time and ETDUI it was printed with, and is never refused
 * for what changed since (a price, a deleted product, stock).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { calculateDocument, type LineInput } from '../src/engine/calc.ts';
import { buildEtdui, generateSecurityCode } from '../src/engine/etdui.ts';
import { receiptPrintView } from '../src/engine/receipt-view.ts';
import { toBelizeDateTime } from '../src/engine/time.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { readEtdForPrint } from '../src/render/view.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

interface Snapshot {
  business: { tin: string; environment: string };
  device: { id: string; register: { id: string } };
  users: Array<{ id: string; name: string; hasPin: boolean; permissions: string[] }>;
  receipt: { issuer: Parameters<typeof receiptPrintView>[0]['issuer']; qrBase: string; logo: string | null };
  offline: { series: number; nextSerial: number; receptionEnv: string; environment: string };
  items: Array<{ id: string; name: string; unitPrice: string; stock: number | null }>;
  customers: Array<{ id: string; name: string }>;
  me: { tin: string };
  serverTime: string;
}

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  owner: Record<string, string>;
  ownerId: string;
  /** Add and pair a till; its device token headers. */
  till: (name: string) => Promise<Record<string, string>>;
}

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const ownerId = (await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD })).id;
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  const till = async (name: string) => {
    const added = await app.inject({ method: 'POST', url: '/v1/pos/devices', headers: owner, payload: { name } });
    assert.equal(added.statusCode, 201, added.body);
    const paired = await app.inject({ method: 'POST', url: '/v1/pos/pair', payload: { code: added.json().pairing.code, platform: 'windows', appVersion: '1.0.0' } });
    assert.equal(paired.statusCode, 200, paired.body);
    return { authorization: `Bearer ${paired.json().token}` };
  };
  try {
    await fn({ f, app, owner, ownerId, till });
  } finally {
    await app.close();
    await f.close();
  }
}

const COFFEE: LineInput = { description: 'Coffee', quantity: '1', unitCode: 'H87', unitPrice: '10.00', gstCategory: 'S' };

/** What a till does when it sells offline: numbers the receipt in its series and builds its ETDUI. */
function sale(snap: Snapshot, serial: number, opts: { lines?: LineInput[]; itemIds?: Array<string | null>; userId?: string; shiftId?: string; customerId?: string; at?: Date } = {}) {
  const at = opts.at ?? new Date();
  const local = toBelizeDateTime(at);
  const securityCode = generateSecurityCode();
  const etdui = buildEtdui({
    etdType: '02', tin: snap.business.tin, serial, series: snap.offline.series, issueDate: local.date, issueTime: local.time,
    operMode: 3, receptionEnv: snap.offline.receptionEnv as '01' | '02', securityCode,
  });
  const lines = opts.lines ?? [COFFEE];
  return {
    id: randomUUID(), kind: 'sale', at: at.toISOString(), userId: opts.userId ?? null, shiftId: opts.shiftId ?? null,
    environment: snap.offline.environment, series: snap.offline.series, serial, issueDate: local.date, issueTime: local.time, securityCode, etdui,
    request: { lines, payment: { meansCode: '10', terms: 'Paid' }, ...(opts.itemIds && { lineItemIds: opts.itemIds }), ...(opts.customerId && { customerId: opts.customerId }) },
  };
}

const snapshot = async (c: Ctx, headers: Record<string, string>, install: string) => {
  const res = await c.app.inject({ method: 'GET', url: `/v1/pos/snapshot?install=${install}`, headers });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Snapshot;
};

type Result = { id: string; status: string; retry?: boolean; error?: { code: string; message: string }; document?: { id: string; etdui: string; status: string }; warnings?: string[] };
const sync = async (c: Ctx, headers: Record<string, string>, events: unknown[]) => {
  const res = await c.app.inject({ method: 'POST', url: '/v1/pos/sync', headers, payload: { events } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { results: Result[] }).results;
};

const count = async (c: Ctx, sql: string, params: unknown[] = []) => Number((await c.f.db.query<{ n: string }>(sql, params)).rows[0]!.n);

test('the snapshot: everything a till sells from, and a series of its own for each install', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/pos/snapshot?install=${randomUUID()}` })).statusCode, 401, 'a till token is needed');
    const item = await c.app.inject({ method: 'POST', url: '/v1/items', headers: c.owner, payload: { name: 'Coffee', unitCode: 'H87', unitPrice: '10', gstCategory: 'S' } });
    assert.equal(item.statusCode, 201, item.body);
    await c.app.inject({ method: 'POST', url: '/v1/customers', headers: c.owner, payload: { name: 'Mia' } });

    const install = randomUUID();
    const snap = await snapshot(c, front, install);
    assert.deepEqual([snap.offline.series, snap.offline.nextSerial, snap.offline.environment], [101, 1, 'test']);
    assert.equal(snap.offline.receptionEnv, '02');
    assert.equal(snap.business.tin, '123456');
    assert.deepEqual(snap.items.map((i) => [i.name, i.unitPrice]), [['Coffee', '10.00']]);
    assert.deepEqual(snap.users.map((u) => u.name), ['Olive']);
    assert.ok(snap.customers.some((x) => x.name === 'Mia'));
    assert.equal(snap.receipt.issuer.tin, '123456');
    assert.match(snap.receipt.qrBase, /^https:\/\//);
    assert.ok(Math.abs(Date.parse(snap.serverTime) - Date.now()) < 60_000);

    // The same install keeps its series; a new install (a reinstall) gets a new one; so does another till.
    assert.equal((await snapshot(c, front, install)).offline.series, 101);
    assert.equal((await snapshot(c, front, randomUUID())).offline.series, 102);
    const back = await c.till('Back');
    assert.equal((await snapshot(c, back, randomUUID())).offline.series, 103);
    // A series the business uses itself is never given to a till.
    await c.f.db.query("insert into series (id, tenant_id, environment, etd_type, series_number, purpose) values ($1, $2, 'test', '01', 104, 'normal')", [randomUUID(), c.f.tenantA]);
    assert.equal((await snapshot(c, back, randomUUID())).offline.series, 105);
  }));

test('sales made offline reach the server exactly once, as printed', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    const snap = await snapshot(c, front, randomUUID());
    const shiftId = randomUUID();
    const opened = new Date(Date.now() - 3 * 3600_000);
    const events = [
      { id: randomUUID(), kind: 'shift_open', at: opened.toISOString(), userId: c.ownerId, shiftId, openingFloat: '50.00' },
      sale(snap, 1, { userId: c.ownerId, shiftId, at: new Date(opened.getTime() + 60_000) }),
      sale(snap, 2, { userId: c.ownerId, shiftId, at: new Date(opened.getTime() + 120_000), lines: [{ ...COFFEE, quantity: '2' }] }),
      { id: randomUUID(), kind: 'cash', at: new Date(opened.getTime() + 180_000).toISOString(), userId: c.ownerId, shiftId, type: 'pay_out', amount: '5.00', reason: 'Ice' },
      { id: randomUUID(), kind: 'shift_close', at: new Date(opened.getTime() + 240_000).toISOString(), userId: c.ownerId, shiftId, countedCash: '78.75' },
    ];
    const first = await sync(c, front, events);
    assert.deepEqual(first.map((r) => r.status), ['applied', 'applied', 'applied', 'applied', 'applied'], JSON.stringify(first));

    // The documents carry the till's ids, numbers and ETDUIs, operMode 3 (subsequent authorization), sent to BTS.
    const docs = (await c.f.db.query<{ id: string; etdui: string; serial: string; series_number: number; oper_mode: number; status: string; shift_id: string; device_id: string; issued_by: string; issue_time: string }>(
      'select id, etdui, serial::text, series_number, oper_mode, status, shift_id, device_id, issued_by, issue_time::text from documents where tenant_id = $1 order by serial', [c.f.tenantA],
    )).rows;
    assert.equal(docs.length, 2);
    for (const [i, d] of docs.entries()) {
      const ev = events[i + 1] as ReturnType<typeof sale>;
      assert.deepEqual([d.id, d.etdui, Number(d.serial), d.series_number, d.oper_mode], [ev.id, ev.etdui, i + 1, 101, 3]);
      assert.equal(d.issue_time.slice(0, 8), ev.issueTime);
      assert.deepEqual([d.shift_id, d.device_id, d.issued_by], [shiftId, snap.device.id, c.ownerId]);
      assert.equal(d.status, 'authorized');
      assert.equal(first[i + 1]!.document!.etdui, ev.etdui);
    }

    // The shift: opened and closed at the till's times, the count against what the drawer should hold.
    const shift = (await c.f.db.query<{ expected_cash_cents: string; counted_cash_cents: string; opened_at: Date }>('select expected_cash_cents::text, counted_cash_cents::text, opened_at from register_shifts where id = $1', [shiftId])).rows[0]!;
    assert.deepEqual([shift.expected_cash_cents, shift.counted_cash_cents], ['7875', '7875']);
    assert.equal(new Date(shift.opened_at).getTime(), opened.getTime());

    // Sent again (the reply was lost): nothing changes, and each event answers with its first result.
    const again = await sync(c, front, events);
    assert.deepEqual(again.map((r) => r.status), ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    assert.equal(again[1]!.document!.id, docs[0]!.id);
    assert.equal(await count(c, 'select count(*) as n from documents where tenant_id = $1', [c.f.tenantA]), 2);
    assert.equal(await count(c, 'select count(*) as n from cash_movements where shift_id = $1', [shiftId]), 1);
    assert.equal(await count(c, 'select count(*) as n from register_shifts where tenant_id = $1', [c.f.tenantA]), 1);

    // Two uploads of the same new sale at the same moment: one document.
    const racing = sale(snap, 3, { userId: c.ownerId });
    const [a, b] = await Promise.all([sync(c, front, [racing]), sync(c, front, [racing])]);
    assert.deepEqual([a[0]!.status, b[0]!.status].sort(), ['applied', 'duplicate']);
    assert.equal(await count(c, 'select count(*) as n from documents where id = $1', [racing.id]), 1);

    // The series' next number follows the till's, never going back for a late sale.
    assert.equal(await count(c, "select next_serial as n from series where tenant_id = $1 and series_number = 101", [c.f.tenantA]), 4);
    assert.equal((await snapshot(c, front, randomUUID())).offline.series, 102);
  }));

test('the printed copy a till makes equals the server\'s reading of the signed receipt', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    const snap = await snapshot(c, front, randomUUID());
    const lines: LineInput[] = [
      { ...COFFEE, sellerItemCode: 'COF-1' },
      { description: 'Muffin', quantity: '3', unitCode: 'H87', unitPrice: '4.50', gstCategory: 'S', allowanceCharges: [{ isCharge: false, amount: '1.50', reason: 'Day old' }] },
      { description: 'Water', quantity: '1', unitCode: 'H87', unitPrice: '2', gstCategory: 'Z' },
    ];
    const ev = sale(snap, 1, { lines });
    const [r] = await sync(c, front, [ev]);
    assert.equal(r!.status, 'applied', JSON.stringify(r));
    const xml = (await c.f.db.query<{ signed_xml: string }>('select signed_xml from documents where id = $1', [ev.id])).rows[0]!.signed_xml;
    const server = readEtdForPrint(xml);
    const till = receiptPrintView({
      etdui: ev.etdui, series: ev.series, serial: ev.serial, issueDate: ev.issueDate, issueTime: ev.issueTime, operMode: 3, receptionEnv: snap.offline.receptionEnv,
      issuer: snap.receipt.issuer, totals: calculateDocument({ lines }, c.f.deps.tax), payment: { terms: 'Paid' },
    });
    assert.deepEqual(till, server);
    assert.ok(server.regulatory.includes('Pending of BTS authorization'));
  }));

test('what changed while the till was offline never refuses a sale', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    const back = await c.till('Back');
    const item = (await c.app.inject({ method: 'POST', url: '/v1/items', headers: c.owner, payload: { name: 'Mug', unitCode: 'H87', unitPrice: '20', gstCategory: 'S' } })).json();
    const tracked = await c.app.inject({ method: 'PUT', url: `/v1/inventory/${item.id}/settings`, headers: c.owner, payload: { track: true, quantity: '1' } });
    assert.equal(tracked.statusCode, 200, tracked.body);
    const s1 = await snapshot(c, front, randomUUID());
    const s2 = await snapshot(c, back, randomUUID());
    assert.notEqual(s1.offline.series, s2.offline.series);

    // Both tills sell the last mug offline, at the old price; the owner raised the price meanwhile.
    await c.app.inject({ method: 'PATCH', url: `/v1/items/${item.id}`, headers: c.owner, payload: { unitPrice: '25' } });
    const mug = { description: 'Mug', quantity: '1', unitCode: 'H87', unitPrice: '20', gstCategory: 'S' } as LineInput;
    const r1 = await sync(c, front, [sale(s1, 1, { lines: [mug], itemIds: [item.id] })]);
    const r2 = await sync(c, back, [sale(s2, 1, { lines: [mug], itemIds: [item.id] })]);
    assert.deepEqual([r1[0]!.status, r2[0]!.status], ['applied', 'applied']);
    assert.equal(r1[0]!.warnings, undefined);
    assert.match(r2[0]!.warnings!.join(' '), /Mug is now at -1 in stock/);
    assert.equal(await count(c, 'select stock_quantity as n from items where id = $1', [item.id]), -1);
    assert.equal(await count(c, "select count(*) as n from audit_events where tenant_id = $1 and action = 'stock.negative'", [c.f.tenantA]), 1);
    // The receipts kept the price they were sold at.
    assert.equal(await count(c, "select payable_cents as n from documents where tenant_id = $1 order by created_at limit 1", [c.f.tenantA]), 2250);

    // A product and a customer deleted since: the sale is kept, without the links, and says so.
    const gone = (await c.app.inject({ method: 'POST', url: '/v1/items', headers: c.owner, payload: { name: 'Gone', unitCode: 'H87', unitPrice: '1', gstCategory: 'S' } })).json();
    await c.f.db.query('delete from items where id = $1', [gone.id]);
    const ev = sale(s1, 2, { lines: [{ ...mug, description: 'Gone', unitPrice: '1' }], itemIds: [gone.id], customerId: randomUUID(), userId: randomUUID(), shiftId: randomUUID() });
    const [kept] = await sync(c, front, [ev]);
    assert.equal(kept!.status, 'applied', JSON.stringify(kept));
    assert.equal(kept!.warnings!.length, 4, kept!.warnings!.join(' | '));
  }));

test('order and failures: a bad event is reported and skipped; a retryable one holds the rest back', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    const snap = await snapshot(c, front, randomUUID());

    // A receipt whose ETDUI does not match its parts can never pass: reported, and the next sale goes on.
    const bad = { ...sale(snap, 1), etdui: sale(snap, 9).etdui };
    const good = sale(snap, 2);
    const r = await sync(c, front, [bad, good]);
    assert.deepEqual(r.map((x) => [x.status, x.retry ?? null]), [['failed', false], ['applied', null]]);
    assert.match(r[0]!.error!.message, /does not match/);
    // A series another till owns is refused too.
    const back = await c.till('Back');
    const [stolen] = await sync(c, back, [sale(snap, 3)]);
    assert.deepEqual([stolen!.status, stolen!.error!.code], ['failed', 'unknown_series']);

    // Without a certificate (expired, being replaced) nothing can be signed: the first sale fails for now, the rest wait.
    await c.f.db.query("update certificates set status = 'revoked' where tenant_id = $1", [c.f.tenantA]);
    const later = [sale(snap, 3), sale(snap, 4)];
    const held = await sync(c, front, later);
    assert.deepEqual(held.map((x) => [x.status, x.retry]), [['failed', true], ['not_processed', true]]);
    assert.equal(await count(c, 'select count(*) as n from documents where id = any($1::uuid[])', [later.map((e) => e.id)]), 0);
    await c.f.db.query("update certificates set status = 'active' where tenant_id = $1", [c.f.tenantA]);
    const passed = await sync(c, front, later);
    assert.deepEqual(passed.map((x) => x.status), ['applied', 'applied']);

    // BTS down: the sale is stored and queued for BTS (contingency_pending), not failed.
    c.f.bts.script(SUBMIT_PATHS['02'], { status: 503, body: 'down' });
    const [queued] = await sync(c, front, [sale(snap, 5)]);
    assert.equal(queued!.status, 'applied');
    assert.equal(queued!.document!.status, 'contingency_pending');
  }));

test('a shift a till opened offline closes one still open on its drawer', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    const snap = await snapshot(c, front, randomUUID());
    // A shift opened online on this till's drawer and never closed.
    const pinned = await c.app.inject({ method: 'PUT', url: '/v1/me/pin', headers: c.owner, payload: { pin: '90210' } });
    assert.equal(pinned.statusCode, 200, pinned.body);
    const session = (await c.app.inject({ method: 'POST', url: '/v1/pos/sign-in', headers: front, payload: { userId: c.ownerId, pin: '90210' } })).json().token;
    const open = await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: { authorization: `Bearer ${session}` }, payload: { openingFloat: '10.00' } });
    assert.equal(open.statusCode, 201, open.body);

    const shiftId = randomUUID();
    const [r] = await sync(c, front, [{ id: randomUUID(), kind: 'shift_open', at: new Date().toISOString(), userId: c.ownerId, shiftId, openingFloat: '40.00' }]);
    assert.equal(r!.status, 'applied', JSON.stringify(r));
    assert.match(r!.warnings!.join(' '), /was still open and has been closed/);
    assert.equal(await count(c, 'select count(*) as n from register_shifts where tenant_id = $1 and closed_at is null', [c.f.tenantA]), 1);
    const old = (await c.f.db.query<{ closed_at: Date | null; close_note: string }>('select closed_at, close_note from register_shifts where id = $1', [open.json().shift.id])).rows[0]!;
    assert.ok(old.closed_at);
    assert.match(old.close_note, /Closed automatically/);
  }));

test('a long time offline: many sales in one upload, in order', () =>
  withBusiness(async (c) => {
    const front = await c.till('Front');
    const snap = await snapshot(c, front, randomUUID());
    const start = Date.now() - 6 * 24 * 3600_000;
    const events = Array.from({ length: 150 }, (_, i) => sale(snap, i + 1, { at: new Date(start + i * 3600_000) }));
    // Sent in batches of 50, as a till does.
    for (let i = 0; i < events.length; i += 50) {
      const r = await sync(c, front, events.slice(i, i + 50));
      assert.ok(r.every((x) => x.status === 'applied'), JSON.stringify(r.filter((x) => x.status !== 'applied')));
    }
    assert.equal(await count(c, 'select count(*) as n from documents where tenant_id = $1', [c.f.tenantA]), 150);
    assert.equal(await count(c, 'select count(distinct etdui) as n from documents where tenant_id = $1', [c.f.tenantA]), 150);
  }));
