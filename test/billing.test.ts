/**
 * The platform's billing: trials, plan limits and features, monthly invoices
 * issued as e-invoices by the platform's own business, overdue and paused
 * issuing, paying, changing plan, and the console's billing view.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { runHousekeepingOnce } from '../src/api/housekeeping.ts';
import { billingContextFactory } from '../src/api/billing.ts';
import { getSubscription, runBilling } from '../src/billing/billing.ts';
import { PLANS } from '../src/billing/plans.ts';
import { createPlatformAdmin } from '../src/db/platform.ts';
import { base32Decode, stepAt, totpCode } from '../src/db/twofactor.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';

interface Ctx {
  f: PipelineFixture;
  app: FastifyInstance;
  mail: ReturnType<typeof memoryMailer>;
  owner: Record<string, string>;
  slug: string;
  billingSlug: string;
}

function cookieFrom(res: LightMyRequestResponse, name = 'etd_s_[a-z0-9-]+'): string {
  const m = new RegExp(`(${name})=([^;]+)`).exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

/** Tenant A subscribes; tenant B is the platform's own business, which issues the invoices. */
async function withBilling(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  f.bts.script(SUBMIT_PATHS['01'], AUTHORIZED);
  f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  f.bts.script(SUBMIT_PATHS['04'], AUTHORIZED);
  const mail = memoryMailer();
  const slugOf = async (id: string) => (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [id])).rows[0]!.slug;
  const slug = await slugOf(f.tenantA);
  const billingSlug = await slugOf(f.tenantB);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: 'https://app.example.test', mailer: mail, billing: { tenantSlug: billingSlug, paymentInstructions: 'Belize Bank 000-111, reference: your TIN' } });
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@shop.example', password: PASSWORD } });
  try {
    await fn({ f, app, mail, slug, billingSlug, owner: { ...CSRF, cookie: cookieFrom(login), 'x-business': slug } });
  } finally {
    await app.close();
    await f.close();
  }
}

const receipt = { type: '02', lines: [{ description: 'Soap', quantity: '1', unitCode: 'H87', unitPrice: '4', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Cash' } };
const billingContext = (c: Ctx) => billingContextFactory(c.f.deps, { mailer: c.mail, mailConfigured: true, publicUrl: 'https://app.example.test', cookieSecure: true, allowSignup: true, billing: { tenantSlug: c.billingSlug } });

test('a new business starts a 30-day trial of the Business plan, and sees its plan and the plans on offer', () =>
  withBilling(async (c) => {
    const b = (await c.app.inject({ method: 'GET', url: '/v1/billing', headers: c.owner })).json();
    assert.equal(b.plan, 'business');
    assert.equal(b.status, 'trialing');
    assert.ok(b.trialDaysLeft >= 29 && b.trialDaysLeft <= 30);
    assert.deepEqual(b.plans.map((p: { code: string }) => p.code), ['starter', 'business', 'pro']);
    assert.equal(b.paymentInstructions, 'Belize Bank 000-111, reference: your TIN');
    assert.deepEqual(b.usage, { documents: 0, documentsLimit: 1000, users: 1, usersLimit: 10 });
    const me = (await c.app.inject({ method: 'GET', url: '/v1/me', headers: c.owner })).json();
    assert.equal(me.billing.status, 'trialing');

    // The plan and its invoices are for those who manage the business; a cashier is told no (and still knows what the plan allows).
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@shop.example', role: 'cashier', password: PASSWORD });
    const login = await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: c.slug, login: 'cass@shop.example', password: PASSWORD } });
    const cashier = { ...CSRF, cookie: cookieFrom(login), 'x-business': c.slug };
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/billing', headers: cashier })).statusCode, 403);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/billing/invoices/00000000-0000-4000-8000-000000000000/pdf', headers: cashier })).statusCode, 403);
    assert.ok((await c.app.inject({ method: 'GET', url: '/v1/me', headers: cashier })).json().billing.features.length > 0);
  }));

test('limits: production documents per month (test documents are free), accounts, store and API keys by plan', () =>
  withBilling(async (c) => {
    const original = PLANS.starter.documentsPerMonth;
    PLANS.starter.documentsPerMonth = 1;
    try {
      await getSubscription(c.f.db, c.f.tenantA);
      await c.f.db.query("update subscriptions set plan = 'starter', status = 'active' where tenant_id = $1", [c.f.tenantA]);
      const issue = (body = receipt) => c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: body });
      // In the test environment, nothing is counted.
      for (let i = 0; i < 3; i++) assert.equal((await issue()).statusCode, 201);
      await c.f.db.query("update tenants set environment = 'production' where id = $1", [c.f.tenantA]);
      const first = await issue();
      assert.equal(first.statusCode, 201, first.body);
      const over = await issue();
      assert.equal(over.statusCode, 402);
      assert.equal(over.json().error.code, 'plan_limit');
      // A credit note is always allowed.
      const credit = await issue({ ...receipt, type: '04', reference: { documentId: first.json().id, reason: 'Returned' } } as typeof receipt);
      assert.equal(credit.statusCode, 201, credit.body);

      // Two accounts on Starter.
      const add = (n: number) => c.app.inject({ method: 'POST', url: '/v1/users', headers: c.owner, payload: { name: `U${n}`, email: `u${n}@shop.example`, role: 'cashier', password: PASSWORD } });
      assert.equal((await add(1)).statusCode, 201);
      const third = await add(2);
      assert.equal(third.statusCode, 402);
      assert.match(third.json().error.message, /2 accounts/);

      const store = await c.app.inject({ method: 'PUT', url: '/v1/store-settings', headers: c.owner, payload: { enabled: true } });
      assert.equal(store.statusCode, 402);
      assert.match(store.json().error.message, /Business plan/);
      assert.equal((await c.app.inject({ method: 'POST', url: '/v1/api-keys', headers: c.owner, payload: { name: 'pos' } })).statusCode, 402);

      // Upgrading lifts the limits at once.
      const up = await c.app.inject({ method: 'PUT', url: '/v1/billing/plan', headers: c.owner, payload: { plan: 'business' } });
      assert.equal(up.statusCode, 200, up.body);
      assert.equal(up.json().plan, 'business');
      assert.equal((await issue()).statusCode, 201);
      assert.equal((await c.app.inject({ method: 'POST', url: '/v1/api-keys', headers: c.owner, payload: { name: 'pos' } })).statusCode, 201);
      // From the free plan, the paid month starts now and is invoiced (an e-invoice from the platform business, emailed).
      const inv = up.json().invoices[0];
      assert.equal(inv.status, 'open');
      assert.equal(inv.total, '55.13', '49.00 + 12.5% GST');
      assert.ok(inv.documentId, 'issued as an e-invoice');
      assert.ok(c.mail.sent.some((m) => m.to === 'billing@caribfuel.example' && m.attachments?.some((a) => a.filename.endsWith('.pdf'))), 'emailed to the business with the PDF');
      const pdf = await c.app.inject({ method: 'GET', url: `/v1/billing/invoices/${inv.id}/pdf`, headers: c.owner });
      assert.equal(pdf.headers['content-type'], 'application/pdf');
    } finally {
      PLANS.starter.documentsPerMonth = original;
    }
  }));

test('the trial ends into a monthly invoice; unpaid it goes past due, then issuing pauses; paying resumes it', () =>
  withBilling(async (c) => {
    await getSubscription(c.f.db, c.f.tenantA);
    await c.f.db.query("update subscriptions set trial_ends_at = now() - interval '1 hour' where tenant_id = $1", [c.f.tenantA]);
    const run = await runBilling(await billingContext(c)());
    assert.equal(run.trialsEnded, 1);
    assert.equal(run.invoices, 1);
    let b = (await c.app.inject({ method: 'GET', url: '/v1/billing', headers: c.owner })).json();
    assert.equal(b.status, 'active');
    assert.equal(b.amountDue, '55.13');
    const invoiceId = b.invoices[0].id;
    // The e-invoice was issued by the platform's business, to this business.
    const doc = (await c.f.db.query<{ tenant_id: string; customer_snapshot: { tin: string } }>('select d.tenant_id, d.customer_snapshot from documents d join billing_invoices i on i.document_id = d.id where i.id = $1', [invoiceId])).rows[0]!;
    assert.equal(doc.tenant_id, c.f.tenantB);
    assert.equal(doc.customer_snapshot.tin, '123456');
    assert.equal((await runBilling(await billingContext(c)())).invoices, 0, 'never invoiced twice');

    await c.f.db.query("update billing_invoices set due_at = now() - interval '1 day' where id = $1", [invoiceId]);
    await runBilling(await billingContext(c)());
    assert.equal((await getSubscription(c.f.db, c.f.tenantA)).status, 'past_due');
    await c.f.db.query("update tenants set environment = 'production' where id = $1", [c.f.tenantA]);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: receipt })).statusCode, 201, 'past due still issues');

    await c.f.db.query("update billing_invoices set due_at = now() - interval '15 days' where id = $1", [invoiceId]);
    await runHousekeepingOnce(c.f.db, { billing: billingContext(c), mailer: c.mail, publicUrl: 'https://app.example.test' });
    assert.equal((await getSubscription(c.f.db, c.f.tenantA)).status, 'suspended');
    const paused = await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: receipt });
    assert.equal(paused.statusCode, 402);
    assert.equal(paused.json().error.code, 'billing_suspended');
    assert.ok(c.mail.sent.some((m) => /invoice is overdue/.test(m.subject)), 'an overdue reminder');
    assert.ok(c.mail.sent.some((m) => /Issuing is paused/.test(m.subject)), 'and a notice that issuing paused');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/documents', headers: c.owner })).statusCode, 200, 'documents stay readable');

    // Staff record the payment in the console (two-step sign-in, as always).
    await createPlatformAdmin(c.f.db, { email: 'ops@platform.example', name: 'Ops', password: 'platform staff password' });
    const first = (await c.app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: CSRF, payload: { email: 'ops@platform.example', password: 'platform staff password' } })).json();
    const verified = await c.app.inject({ method: 'POST', url: '/v1/platform/auth/login/verify', headers: CSRF, payload: { challenge: first.challenge, code: totpCode(base32Decode(first.secret), stepAt(Date.now())) } });
    const staff = { ...CSRF, cookie: cookieFrom(verified, 'etd_admin') };
    const overview = (await c.app.inject({ method: 'GET', url: '/v1/platform/billing', headers: staff })).json();
    assert.equal(overview.summary.suspended, 1);
    assert.equal(overview.summary.overdueAmount, '55.13');
    assert.equal(overview.invoices[0].tenant.id, c.f.tenantA);
    const paid = await c.app.inject({ method: 'POST', url: `/v1/platform/invoices/${invoiceId}/paid`, headers: staff, payload: { reference: 'Belize Bank transfer 8812' } });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal((await getSubscription(c.f.db, c.f.tenantA)).status, 'active');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/documents', headers: c.owner, payload: receipt })).statusCode, 201, 'issuing resumes at once');

    // A downgrade waits for the end of the period; then the next month is on the new plan.
    b = (await c.app.inject({ method: 'PUT', url: '/v1/billing/plan', headers: c.owner, payload: { plan: 'starter' } })).json();
    assert.equal(b.plan, 'business');
    assert.equal(b.nextPlan, 'starter');
    await c.f.db.query("update subscriptions set current_period_end = now() - interval '1 minute' where tenant_id = $1", [c.f.tenantA]);
    const renewed = await runBilling(await billingContext(c)());
    assert.equal(renewed.renewed, 1);
    assert.equal(renewed.invoices, 0, 'the free plan is not invoiced');
    assert.equal((await getSubscription(c.f.db, c.f.tenantA)).plan, 'starter');

    // Staff can extend a trial.
    const extend = await c.app.inject({ method: 'PUT', url: `/v1/platform/tenants/${c.f.tenantA}/subscription`, headers: staff, payload: { plan: 'pro', trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString() } });
    assert.equal(extend.statusCode, 200, extend.body);
    assert.equal(extend.json().status, 'trialing');
    assert.equal(extend.json().plan, 'pro');
  }));
