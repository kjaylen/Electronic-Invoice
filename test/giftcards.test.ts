/**
 * Gift cards: sold or given in the app (not a BTS document: GST is charged
 * when a card is used), emailed with their code, taken as payment at the
 * counter (all or part of a receipt, which carries the full GST) and in the
 * online store, given back when a sale does not stand, an order is cancelled
 * or refunded. Cards sold for cash count in the drawer's shift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { reverseVoidedGiftCards } from '../src/commerce/giftcards.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC = 'https://app.example.test';

interface Ctx { f: PipelineFixture; app: FastifyInstance; mail: ReturnType<typeof memoryMailer>; slug: string; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>>; variant: string }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withBusiness(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC, mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const owner = await login('olive@biz.example');
  const opened = await app.inject({
    method: 'PUT', url: '/v1/store-settings', headers: owner,
    payload: { enabled: true, delivery: { enabled: false, zones: [] }, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank' }, cashOnDelivery: { enabled: false }, payAtPickup: { enabled: true } } },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  const product = await app.inject({ method: 'POST', url: '/v1/products', headers: owner, payload: { title: 'Island T-shirt', status: 'active', variants: [{ price: '20.00', gstCategory: 'S', stock: 50 }] } });
  assert.equal(product.statusCode, 201, product.body);
  try {
    await fn({ f, app, mail, slug, owner, login, variant: product.json().variants[0].id });
  } finally {
    await app.close();
    await f.close();
  }
}

const line = (price: string) => ({ description: 'Goods', quantity: '1', unitCode: 'H87', unitPrice: price, gstCategory: 'S' });
const sell = (c: Ctx, headers: Record<string, string>, body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: '/v1/gift-cards', headers, payload: body });
const balanceOf = async (c: Ctx, id: string) => (await c.app.inject({ method: 'GET', url: `/v1/gift-cards/${id}`, headers: c.owner })).json().card.balance as string;
const docCount = async (c: Ctx) => (await c.f.db.query("select 1 from documents where tenant_id = $1 and etd_type = '02'", [c.f.tenantA])).rows.length;

test('gift cards at the counter: sold (not a BTS document) and emailed, taken as all or part of a receipt with its full GST, counted in the shift; adjusted, turned off', () =>
  withBusiness(async (c) => {
    const shift = await c.app.inject({ method: 'POST', url: '/v1/shifts', headers: c.owner, payload: { openingFloat: '100.00' } });
    assert.equal(shift.statusCode, 201, shift.body);

    assert.equal((await sell(c, c.owner, { amount: '50.00', source: 'sold' })).json().error.code, 'gift_card_invalid', 'how it was paid');
    const sold = await sell(c, c.owner, { amount: '50.00', source: 'sold', paidBy: 'cash', recipientName: 'Maria', recipientEmail: 'Maria@Example.com', message: 'Happy birthday!', send: true });
    assert.equal(sold.statusCode, 201, sold.body);
    const { card, code, emailed } = sold.json();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    assert.equal(card.last4, code.slice(-4));
    assert.deepEqual([card.initial, card.balance, card.status, card.source, card.paidBy], ['50.00', '50.00', 'active', 'sold', 'cash']);
    assert.equal(emailed, 'maria@example.com');
    const email = c.mail.sent.at(-1)!;
    assert.match(email.subject, /Maria, a BZ\$50\.00 gift card from /);
    assert.ok(email.html!.includes(code), 'the code is in the email');
    assert.match(email.html!, /Happy birthday!/);
    assert.equal(await docCount(c), 0, 'selling a card issues no BTS document');

    // Found by its whole code (any case, with or without dashes) or its last four.
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/gift-cards?q=${code.replace(/-/g, '').toLowerCase()}`, headers: c.owner })).json().data.length, 1);
    const listed = (await c.app.inject({ method: 'GET', url: `/v1/gift-cards?q=${card.last4}`, headers: c.owner })).json();
    assert.equal(listed.data[0].id, card.id);
    assert.equal(listed.summary.outstanding, '50.00');
    assert.equal(listed.summary.active, 1);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/gift-cards/check', headers: c.owner, payload: { code: code.toLowerCase() } })).json().card.balance, '50.00');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/gift-cards/check', headers: c.owner, payload: { code: 'AAAA-BBBB-CCCC-DDDD' } })).statusCode, 404);

    // A sale of BZ$22.50 paid all by the card: a receipt with its GST, paid by "gift card".
    const all = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('20.00')], giftCard: { code, amount: '22.50' } } });
    assert.equal(all.statusCode, 201, all.body);
    const doc = (await c.f.db.query<{ payment_means: string; gst_cents: string; payable_cents: string }>('select payment_means, gst_cents::text, payable_cents::text from documents where id = $1', [all.json().id])).rows[0]!;
    assert.deepEqual([doc.payment_means, doc.gst_cents, doc.payable_cents], ['1', '250', '2250']);
    assert.equal(await balanceOf(c, card.id), '27.50');

    // BZ$45.00: the rest of the card and BZ$17.50 in cash.
    const part = await c.app.inject({
      method: 'POST', url: '/v1/documents', headers: c.owner,
      payload: { type: '02', lines: [line('40.00')], giftCard: { code, amount: '27.50' }, tenders: [{ meansCode: '1', amount: '27.50' }, { meansCode: '10', amount: '17.50' }] },
    });
    assert.equal(part.statusCode, 201, part.body);
    const detail = (await c.app.inject({ method: 'GET', url: `/v1/gift-cards/${card.id}`, headers: c.owner })).json();
    assert.deepEqual([detail.card.balance, detail.card.status], ['0.00', 'used_up']);
    // Used up: no longer counted as active, as it is no longer listed as active.
    const after = (await c.app.inject({ method: 'GET', url: '/v1/gift-cards?status=active', headers: c.owner })).json();
    assert.deepEqual([after.data.length, after.summary.active, after.summary.outstanding], [0, 0, '0.00']);
    assert.deepEqual(detail.activity.map((a: { kind: string; amount: string }) => [a.kind, a.amount]), [['issued', '50.00'], ['used', '-22.50'], ['used', '-27.50']]);
    assert.ok(detail.activity[1].document.id);

    // Nothing left: the sale is refused and nothing is issued. A part that does not match is refused too.
    const before = await docCount(c);
    const empty = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('4.00')], giftCard: { code, amount: '4.50' } } });
    assert.equal(empty.json().error.code, 'gift_card_empty');
    const wrong = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('40.00')], giftCard: { code, amount: '5.00' }, tenders: [{ meansCode: '1', amount: '10.00' }, { meansCode: '10', amount: '35.00' }] } });
    assert.equal(wrong.json().error.code, 'invalid_tenders');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: { type: '02', lines: [line('40.00')], tenders: [{ meansCode: '1', amount: '10.00' }, { meansCode: '10', amount: '35.00' }] } })).json().error.code, 'invalid_tenders');
    assert.equal(await docCount(c), before);

    // The shift: the card sold in cash is in the drawer; what the card paid is not new money.
    const report = (await c.app.inject({ method: 'GET', url: `/v1/shifts/${shift.json().shift.id}`, headers: c.owner })).json().report;
    assert.deepEqual(report.giftCards, { sold: { count: 1, total: '50.00' }, used: '50.00' });
    assert.equal(report.cash.expected, '167.50', 'float 100 + card sold 50 + cash 17.50');

    // A sale cancelled later gives its part back, once.
    await c.f.db.query("update documents set status = 'cancelled' where id = $1", [part.json().id]);
    assert.equal(await reverseVoidedGiftCards(c.f.db), 1);
    assert.equal(await reverseVoidedGiftCards(c.f.db), 0);
    assert.equal(await balanceOf(c, card.id), '27.50');

    // Managers adjust and turn cards off; a cashier sells but does not give cards away.
    const adjusted = await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/adjust`, headers: c.owner, payload: { amount: '-30.00', note: 'Too much' } });
    assert.equal(adjusted.json().error.code, 'gift_card_not_enough');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/adjust`, headers: c.owner, payload: { amount: '2.50', note: 'Goodwill' } })).json().card.balance, '30.00');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/disable`, headers: c.owner, payload: { note: 'Reported lost' } })).json().card.status, 'disabled');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/gift-cards/check', headers: c.owner, payload: { code } })).json().error.code, 'gift_card_disabled');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/enable`, headers: c.owner, payload: {} })).json().card.status, 'active');

    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cass@biz.example');
    assert.equal((await sell(c, cashier, { amount: '10.00', source: 'given' })).statusCode, 403);
    assert.equal((await sell(c, cashier, { amount: '10.00', source: 'sold', paidBy: 'card' })).statusCode, 201);
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/send`, headers: cashier, payload: { email: 'someone@else.example' } })).statusCode, 403, 'a new address is a manager’s call');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/send`, headers: cashier, payload: {} })).json().emailed, 'maria@example.com');
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/gift-cards/${card.id}/adjust`, headers: cashier, payload: { amount: '5.00', note: 'x' } })).statusCode, 403);
  }));

test('gift cards in the online store: pay part or all of an order (the receipt has the full GST); a cancelled or refunded order puts it back', () =>
  withBusiness(async (c) => {
    const { card, code } = (await sell(c, c.owner, { amount: '30.00', source: 'given', note: 'Prize' })).json();
    const quote = (giftCard?: string, quantity = 2) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/quote`, payload: { lines: [{ variantId: c.variant, quantity }], fulfillment: 'pickup', ...(giftCard && { giftCard }) } });
    const order = (body: Record<string, unknown>, quantity = 2) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/orders`, payload: { lines: [{ variantId: c.variant, quantity }], fulfillment: 'pickup', customer: { name: 'Ana', phone: '+501 610-0001', email: 'ana@example.com' }, ...body } });

    // Two shirts, BZ$45.00: the card pays 30, 15 is left to pay at pickup.
    const q = (await quote(code)).json();
    assert.deepEqual(q.giftCard, { last4: card.last4, balance: '30.00', applied: '30.00' });
    assert.equal(q.due, '15.00');
    assert.deepEqual(q.paymentMethods, ['bank_transfer', 'pay_at_pickup']);
    assert.equal((await quote('AAAA-BBBB-CCCC-DDDD')).json().error.code, 'gift_card_not_found');

    const partly = await order({ paymentMethod: 'pay_at_pickup', giftCard: code });
    assert.equal(partly.statusCode, 201, partly.body);
    assert.equal(await balanceOf(c, card.id), '0.00');
    const page = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/orders/${partly.json().number}?t=${partly.json().token}` })).json();
    assert.deepEqual([page.giftCard, page.amountDue, page.totals.total], [{ amount: '30.00' }, '15.00', '45.00']);
    assert.match(c.mail.sent.find((m) => m.to === 'ana@example.com')!.html!, /BZ\$30\.00 paid with a gift card[\s\S]*Pay BZ\$15\.00 when you pick up/);

    // Cancelled: the card gets its 30 back.
    const orderId = (await c.f.db.query<{ id: string }>('select id from orders where number = $1 and tenant_id = $2', [partly.json().number, c.f.tenantA])).rows[0]!.id;
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/cancel`, headers: c.owner, payload: { reason: 'Changed their mind' } })).statusCode, 200);
    assert.equal(await balanceOf(c, card.id), '30.00');

    // One shirt, BZ$22.50, all on the card: paid at once, the receipt issued with its GST.
    assert.deepEqual((await quote(code, 1)).json().paymentMethods, ['gift_card']);
    assert.equal((await order({ paymentMethod: 'gift_card', giftCard: code })).json().error.code, 'invalid_order', 'the card does not cover two');
    const full = await order({ paymentMethod: 'gift_card', giftCard: code }, 1);
    assert.equal(full.statusCode, 201, full.body);
    const paid = (await c.f.db.query<{ id: string; payment_status: string; gift_card_cents: string; payment_means: string; gst_cents: string; payable_cents: string }>(
      'select o.id, o.payment_status, o.gift_card_cents::text, d.payment_means, d.gst_cents::text, d.payable_cents::text from orders o join documents d on d.id = o.document_id where o.number = $1 and o.tenant_id = $2',
      [full.json().number, c.f.tenantA],
    )).rows[0]!;
    assert.deepEqual([paid.payment_status, paid.gift_card_cents, paid.payment_means, paid.gst_cents, paid.payable_cents], ['paid', '2250', '1', '250', '2250']);
    assert.equal(await balanceOf(c, card.id), '7.50');

    // Refunded: back on the card.
    const refund = await c.app.inject({ method: 'POST', url: `/v1/orders/${paid.id}/refund`, headers: c.owner, payload: { reason: 'Wrong size' } });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(refund.json().refund.toGiftCard, '22.50');
    assert.equal(await balanceOf(c, card.id), '30.00');

    // Its balance, from the link in its email.
    const balance = await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/gift-cards/balance`, payload: { code } });
    assert.deepEqual(balance.json(), { last4: card.last4, balance: '30.00', status: 'active', expiresOn: null });
    assert.equal((await c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/gift-cards/balance`, payload: { code: 'nope' } })).statusCode, 404);
  }));
