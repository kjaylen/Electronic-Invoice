/**
 * The platform console API, for our own staff (not businesses).
 *
 *   POST /v1/platform/auth/login | logout,  GET /v1/platform/auth/session
 *   POST /v1/platform/auth/login/verify    { challenge, code }: two-step sign-in, always required for staff
 *   GET  /v1/platform/overview                     the front page: growth, documents, stores, revenue, health, who needs a person
 *   GET  /v1/platform/tenants                      every business: q, environment
 *   GET  /v1/platform/tenants/:id                  details, people, certificate, documents, readiness for production
 *   POST /v1/platform/tenants/:id/go-live          move to the BTS production environment (BTS approval reference required)
 *   POST /v1/platform/tenants/:id/back-to-test     undo, only while nothing was issued in production
 *   GET  /v1/platform/audit                        what staff did
 *   GET  /v1/platform/billing                      subscriptions and invoices: monthly revenue, open and overdue invoices
 *   POST /v1/platform/invoices/:id/paid | void | issue   record a payment, cancel an invoice, (re)issue its e-invoice
 *   PUT  /v1/platform/tenants/:id/subscription     staff: set a business's plan or extend its trial
 *
 * Staff sign in with their own accounts (npm run platform-admin), in a cookie
 * of their own ("etd_admin"), with the same CSRF header rule as the web app.
 * Two-step sign-in is mandatory: the first sign-in sets up the authenticator
 * app (the password returns its secret), every sign-in then needs a code.
 *
 * Going live needs: an active certificate for the business's TIN, and nothing
 * still on its way to BTS test (no pending or contingency documents, no
 * pending cancellations, no open outage). Production numbering then starts at
 * serial 1 with a fresh hash chain; test documents keep theirs.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import {
  checkPlatformCredentials,
  createPlatformSession,
  deletePlatformSession,
  getPlatformAdmin,
  lookupPlatformSession,
  type PlatformAdmin,
  PLATFORM_SESSION_MAX_MS,
  platformAudit,
} from '../db/platform.ts';
import { simpleHtml } from '../mail/mailer.ts';
import type { Database, Queryable } from '../db/database.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { certificateSummary } from './admin.ts';
import { readCookie, requireCsrfHeader } from './auth.ts';
import { publicLink, type ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { uuid } from './schemas.ts';
import { atLimit, countHit } from '../db/ratelimit.ts';
import { beginTwoFactorSetup, confirmTwoFactorSetup, createLoginChallenge, endLoginChallenge, otpauthQr, otpauthUrl, TOTP_ISSUER, twoFactorStatus, useLoginChallenge, verifySecondFactor } from '../db/twofactor.ts';
import { type BillingContext, type BillingInvoiceRow, billingSummary, getSubscription, invoiceJson, issueInvoiceDocument, markInvoicePaid, refreshStatus } from '../billing/billing.ts';
import { type PlanCode, PLANS } from '../billing/plans.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import { platformOverview } from './platform-overview.ts';

export const PLATFORM_COOKIE = 'etd_admin';

declare module 'fastify' {
  interface FastifyRequest {
    platformAdmin: PlatformAdmin | null;
  }
}


interface TenantRow {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string | null;
  tin: string;
  environment: 'test' | 'production';
  email: string;
  telephone: string;
  city: string;
  created_at: string | Date;
  production_since: string | Date | null;
  bts_approval_reference: string | null;
}

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

// Failed staff sign-ins, shared by every server process.
const STAFF_WINDOW_MS = 15 * 60 * 1000;

export function registerPlatformRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, billingContext: () => Promise<BillingContext>) {
  const { db } = deps;
  app.decorateRequest('platformAdmin', null);
  const setCookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.header('set-cookie', `${PLATFORM_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ctx.cookieSecure ? '; Secure' : ''}`);

  app.addHook('onRequest', async (request) => {
    requireCsrfHeader(request);
    if (request.url.startsWith('/v1/platform/auth/login')) return;
    const token = readCookie(request, PLATFORM_COOKIE);
    request.platformAdmin = token ? await lookupPlatformSession(db, token) : null;
    if (!request.platformAdmin && !request.url.startsWith('/v1/platform/auth/')) throw new ApiError(401, 'unauthorized', 'Sign in to the platform console');
  });
  const admin = (request: FastifyRequest) => request.platformAdmin!;

  // ---------- sign-in ----------

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { schema: { body: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3, maxLength: 254 }, password: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      const key = `staff|${request.ip}|${request.body.email.trim().toLowerCase()}`;
      const ipKey = `staff|${request.ip}`;
      if (await atLimit(db, key, 5) || await atLimit(db, ipKey, 5)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
      const a = await checkPlatformCredentials(db, request.body.email, request.body.password);
      if (!a) {
        await countHit(db, key, STAFF_WINDOW_MS);
        await countHit(db, ipKey, STAFF_WINDOW_MS);
        await platformAudit(db, { adminId: null, action: 'login.failed', details: { email: request.body.email.trim().toLowerCase() }, ip: request.ip });
        throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
      }
      // The password alone never gives a session: the code is always needed.
      const challenge = await createLoginChallenge(db, 'staff', a.id);
      if ((await twoFactorStatus(db, 'staff', a.id)).enabled) return { twoFactorRequired: true, challenge };
      const secret = await beginTwoFactorSetup(db, deps.keys, 'staff', a.id);
      const url = otpauthUrl(`${TOTP_ISSUER} console`, a.email, secret);
      return { twoFactorRequired: true, setup: true, challenge, secret, otpauthUrl: url, qr: await otpauthQr(url) };
    },
  );

  app.post<{ Body: { challenge: string; code: string } }>(
    '/auth/login/verify',
    { schema: { body: { type: 'object', required: ['challenge', 'code'], additionalProperties: false, properties: { challenge: { type: 'string', maxLength: 100 }, code: { type: 'string', minLength: 6, maxLength: 20 } } } } },
    async (request, reply) => {
      const ipKey = `staff-2fa|${request.ip}`;
      if (await atLimit(db, ipKey, 10)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts; try again in 15 minutes');
      const adminId = await useLoginChallenge(db, 'staff', request.body.challenge);
      const a = adminId ? await getPlatformAdmin(db, adminId) : null;
      if (!a) throw new ApiError(401, 'challenge_expired', 'This sign-in has expired. Enter your password again.');
      let recoveryCodes: string[] | undefined;
      if ((await twoFactorStatus(db, 'staff', a.id)).enabled) {
        const method = await verifySecondFactor(db, deps.keys, 'staff', a.id, request.body.code);
        if (!method) {
          await countHit(db, ipKey, STAFF_WINDOW_MS);
          await platformAudit(db, { adminId: a.id, action: 'login.code_failed', ip: request.ip });
          throw new ApiError(401, 'invalid_code', 'That code is not right. Try the newest code from your app.');
        }
      } else {
        try {
          recoveryCodes = await confirmTwoFactorSetup(db, deps.keys, 'staff', a.id, request.body.code);
        } catch (e) {
          await countHit(db, ipKey, STAFF_WINDOW_MS);
          throw e;
        }
        await platformAudit(db, { adminId: a.id, action: 'two_factor.enabled', ip: request.ip });
      }
      await endLoginChallenge(db, request.body.challenge);
      setCookie(reply, await createPlatformSession(db, a.id), PLATFORM_SESSION_MAX_MS / 1000);
      await platformAudit(db, { adminId: a.id, action: 'login', ip: request.ip });
      return { admin: a, ...(recoveryCodes && { recoveryCodes }) };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const token = readCookie(request, PLATFORM_COOKIE);
    if (token) await deletePlatformSession(db, token);
    setCookie(reply, '', 0);
    return reply.code(204).send();
  });

  app.get('/auth/session', async (request) => {
    if (!request.platformAdmin) throw new ApiError(401, 'unauthorized', 'Sign in to the platform console');
    return { admin: request.platformAdmin };
  });

  // ---------- overview ----------

  app.get('/overview', async () => platformOverview(db));

  // ---------- billing ----------

  app.get('/billing', async () => {
    const subs = (await db.query<{ plan: PlanCode; status: string; n: number }>('select plan, status, count(*)::int as n from subscriptions group by plan, status')).rows;
    const count = (status: string) => subs.filter((x) => x.status === status).reduce((a, x) => a + x.n, 0);
    // Monthly recurring revenue: paying plans that are active or behind on payment (before GST).
    const mrr = subs.filter((x) => x.status !== 'trialing' && x.status !== 'suspended').reduce((a, x) => a + parseCents(PLANS[x.plan].price) * BigInt(x.n), 0n);
    const invoices = (await db.query<BillingInvoiceRow & { tenant_name: string; tenant_slug: string }>(
      `select i.*, coalesce(t.trade_name, t.legal_name) as tenant_name, t.slug as tenant_slug from billing_invoices i join tenants t on t.id = i.tenant_id
       order by (i.status = 'open') desc, i.due_at asc, i.created_at desc limit 300`,
    )).rows;
    const now = new Date();
    const open = invoices.filter((i) => i.status === 'open');
    return {
      summary: {
        mrr: formatCents(mrr),
        trialing: count('trialing'), active: count('active'), pastDue: count('past_due'), suspended: count('suspended'),
        byPlan: Object.fromEntries((Object.keys(PLANS) as PlanCode[]).map((p) => [p, subs.filter((x) => x.plan === p && x.status !== 'trialing').reduce((a, x) => a + x.n, 0)])),
        openAmount: formatCents(open.reduce((a, i) => a + toBigInt(i.total_cents), 0n)),
        overdueAmount: formatCents(open.filter((i) => new Date(i.due_at) < now).reduce((a, i) => a + toBigInt(i.total_cents), 0n)),
      },
      invoices: invoices.map((i) => ({ ...invoiceJson(i, now), tenant: { id: i.tenant_id, name: i.tenant_name, slug: i.tenant_slug } })),
      billingBusinessConfigured: Boolean(ctx.billing?.tenantSlug),
    };
  });

  const invoiceParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  app.post<{ Params: { id: string }; Body: { reference: string } }>(
    '/invoices/:id/paid',
    { schema: { params: invoiceParams, body: { type: 'object', required: ['reference'], additionalProperties: false, properties: { reference: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request) => {
      const row = await markInvoicePaid(db, request.params.id, request.body.reference.trim());
      if (!row) throw new ApiError(409, 'conflict', 'Only an open invoice can be marked paid');
      await platformAudit(db, { adminId: admin(request).id, tenantId: row.tenant_id, action: 'invoice.paid', details: { invoice: row.id, reference: request.body.reference.trim(), total: formatCents(toBigInt(row.total_cents)) }, ip: request.ip });
      return invoiceJson(row);
    },
  );
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/invoices/:id/void',
    { schema: { params: invoiceParams, body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } } } } },
    async (request) => {
      const row = (await db.query<BillingInvoiceRow>("update billing_invoices set status = 'void' where id = $1 and status = 'open' returning *", [request.params.id])).rows[0];
      if (!row) throw new ApiError(409, 'conflict', 'Only an open invoice can be voided');
      await refreshStatus(db, row.tenant_id);
      await platformAudit(db, { adminId: admin(request).id, tenantId: row.tenant_id, action: 'invoice.voided', details: { invoice: row.id, reason: request.body.reason }, ip: request.ip });
      return invoiceJson(row);
    },
  );
  app.post<{ Params: { id: string } }>('/invoices/:id/issue', { schema: { params: invoiceParams } }, async (request) => {
    const bc = await billingContext();
    if (!bc.billingTenantId) throw new ApiError(409, 'not_configured', 'Set PLATFORM_BILLING_TENANT to the platform business that issues invoices');
    const row = await issueInvoiceDocument(bc, request.params.id);
    await platformAudit(db, { adminId: admin(request).id, tenantId: row.tenant_id, action: 'invoice.issued', details: { invoice: row.id, document: row.document_id }, ip: request.ip });
    return invoiceJson(row);
  });

  app.put<{ Params: { id: string }; Body: { plan?: PlanCode; trialEndsAt?: string } }>(
    '/tenants/:id/subscription',
    {
      schema: {
        params: invoiceParams,
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { plan: { type: 'string', enum: Object.keys(PLANS) }, trialEndsAt: { type: 'string', format: 'date-time' } } },
      },
    },
    async (request) => {
      const t = (await db.query<{ id: string }>('select id from tenants where id = $1', [request.params.id])).rows[0];
      if (!t) throw notFound('Business');
      const before = await getSubscription(db, t.id);
      if (request.body.trialEndsAt) {
        const end = new Date(request.body.trialEndsAt);
        if (Number.isNaN(end.getTime()) || end < new Date()) throw new ApiError(422, 'invalid_request', 'The trial must end in the future');
        await db.query("update subscriptions set status = 'trialing', trial_ends_at = $2, current_period_start = null, current_period_end = null, updated_at = now() where tenant_id = $1", [t.id, end.toISOString()]);
      }
      if (request.body.plan) await db.query('update subscriptions set plan = $2, next_plan = null, updated_at = now() where tenant_id = $1', [t.id, request.body.plan]);
      await platformAudit(db, { adminId: admin(request).id, tenantId: t.id, action: 'subscription.changed', details: { from: { plan: before.plan, status: before.status }, ...request.body }, ip: request.ip });
      return billingSummary(db, t.id);
    },
  );

  // ---------- businesses ----------

  app.get<{ Querystring: { q?: string; environment?: 'test' | 'production' } }>(
    '/tenants',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 }, environment: { type: 'string', enum: ['test', 'production'] } } } } },
    async (request) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (request.query.environment) {
        params.push(request.query.environment);
        where.push(`t.environment = $${params.length}`);
      }
      if (request.query.q?.trim()) {
        params.push(`%${request.query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(t.legal_name ilike $${params.length} or t.trade_name ilike $${params.length} or t.slug ilike $${params.length} or t.tin like $${params.length})`);
      }
      const rows = (await db.query<TenantRow & { users: number; test_authorized: number; production_documents: number; cert_valid_to: string | Date | null }>(
        `select t.*,
           (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active') as users,
           (select count(*)::int from documents d where d.tenant_id = t.id and d.reception_env = '02' and d.status in ('authorized', 'authorized_with_alert')) as test_authorized,
           (select count(*)::int from documents d where d.tenant_id = t.id and d.reception_env = '01') as production_documents,
           (select c.valid_to from certificates c where c.tenant_id = t.id and c.status = 'active') as cert_valid_to
         from tenants t ${where.length ? `where ${where.join(' and ')}` : ''} order by t.created_at desc limit 500`,
        params,
      )).rows;
      return {
        data: rows.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.trade_name ?? t.legal_name,
          legalName: t.legal_name,
          tin: t.tin,
          environment: t.environment,
          users: t.users,
          testAuthorized: t.test_authorized,
          productionDocuments: t.production_documents,
          certificateValidTo: iso(t.cert_valid_to),
          createdAt: iso(t.created_at),
          productionSince: iso(t.production_since),
        })),
      };
    },
  );

  /** What going live needs, read through `q` (the transaction, when called inside one). */
  async function readiness(q: Queryable, tenantId: string) {
    const cert = await certificateSummary({ ...deps, db: q as Database }, tenantId);
    const counts = (await q.query<{ in_flight: number; events_pending: number; outage: number; test_authorized: number; test_rejected: number; production_documents: number }>(
      `select
         (select count(*)::int from documents where tenant_id = $1 and status in ('pending', 'contingency_pending')) as in_flight,
         (select count(*)::int from events where tenant_id = $1 and status = 'pending') as events_pending,
         (select count(*)::int from contingency_periods where tenant_id = $1 and ended_at is null) as outage,
         (select count(*)::int from documents where tenant_id = $1 and reception_env = '02' and status in ('authorized', 'authorized_with_alert')) as test_authorized,
         (select count(*)::int from documents where tenant_id = $1 and reception_env = '02' and status = 'rejected') as test_rejected,
         (select count(*)::int from documents where tenant_id = $1 and reception_env = '01') as production_documents`,
      [tenantId],
    )).rows[0]!;
    const checks = [
      { key: 'certificate', ok: Boolean(cert && cert.daysLeft >= 0), required: true, detail: cert ? `TIN ${cert.tin}, valid until ${cert.validTo.slice(0, 10)}` : 'No certificate installed' },
      { key: 'nothing_in_flight', ok: counts.in_flight === 0 && counts.events_pending === 0 && counts.outage === 0, required: true, detail: `${counts.in_flight} documents and ${counts.events_pending} cancellations waiting for BTS${counts.outage ? ', an outage is open' : ''}` },
      { key: 'tested', ok: counts.test_authorized > 0, required: false, detail: `${counts.test_authorized} authorized and ${counts.test_rejected} rejected in the test environment` },
    ];
    return { checks, ready: checks.every((c) => c.ok || !c.required), counts, certificate: cert };
  }

  const loadTenant = async (id: string) => {
    const t = (await db.query<TenantRow>('select * from tenants where id = $1', [id])).rows[0];
    if (!t) throw notFound('Business');
    return t;
  };

  app.get<{ Params: { id: string } }>('/tenants/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const t = await loadTenant(request.params.id);
    const owners = (await db.query<{ name: string; email: string | null; username: string | null; role: string; last_login_at: string | Date | null }>(
      `select name, email, username, role, last_login_at from users where tenant_id = $1 and status = 'active' and role in ('owner', 'admin') order by role desc, created_at`, [t.id],
    )).rows;
    const users = (await db.query<{ n: number }>(`select count(*)::int as n from users where tenant_id = $1 and status = 'active'`, [t.id])).rows[0]!.n;
    const history = (await db.query<{ action: string; details: Record<string, unknown> | null; at: string | Date; admin: string | null }>(
      `select p.action, p.details, p.at, a.name as admin from platform_audit p left join platform_admins a on a.id = p.admin_id where p.tenant_id = $1 order by p.id desc limit 50`, [t.id],
    )).rows;
    const r = await readiness(db, t.id);
    return {
      id: t.id,
      slug: t.slug,
      name: t.trade_name ?? t.legal_name,
      legalName: t.legal_name,
      tin: t.tin,
      environment: t.environment,
      contact: { email: t.email, telephone: t.telephone, city: t.city },
      createdAt: iso(t.created_at),
      productionSince: iso(t.production_since),
      approvalReference: t.bts_approval_reference,
      users,
      admins: owners.map((o) => ({ name: o.name, login: o.email ?? o.username, role: o.role, lastLoginAt: iso(o.last_login_at) })),
      certificate: r.certificate,
      readiness: { ready: r.ready, checks: r.checks },
      billing: await billingSummary(db, t.id),
      documents: { testAuthorized: r.counts.test_authorized, testRejected: r.counts.test_rejected, production: r.counts.production_documents },
      history: history.map((h) => ({ action: h.action, details: h.details, at: iso(h.at), admin: h.admin })),
    };
  });

  const confirmSchema = (extra: Record<string, unknown>, required: string[]) => ({
    params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['confirmTin', ...required], additionalProperties: false, properties: { confirmTin: { type: 'string', pattern: '^\\d{6}$' }, ...extra } },
  });

  app.post<{ Params: { id: string }; Body: { confirmTin: string; approvalReference: string; retireCertificate?: boolean } }>(
    '/tenants/:id/go-live',
    { schema: confirmSchema({ approvalReference: { type: 'string', minLength: 3, maxLength: 200 }, retireCertificate: { type: 'boolean' } }, ['approvalReference']) },
    async (request) => {
      const a = admin(request);
      const result = await db.transaction(async (tx) => {
        // Lock the business so a concurrent change cannot slip in between the checks and the switch.
        const t = (await tx.query<TenantRow>('select * from tenants where id = $1 for update', [request.params.id])).rows[0];
        if (!t) throw notFound('Business');
        if (request.body.confirmTin !== t.tin) throw new ApiError(422, 'confirmation_mismatch', 'Type the business’s TIN to confirm');
        if (t.environment === 'production') throw new ApiError(409, 'already_live', 'This business is already in production');
        const r = await readiness(tx, t.id);
        const missing = r.checks.filter((c) => c.required && !c.ok);
        if (missing.length) throw new ApiError(409, 'not_ready', `Not ready for production: ${missing.map((c) => c.detail).join('; ')}`, { checks: r.checks });
        const clash = await tx.query(`select 1 from tenants where tin = $1 and environment = 'production' and id <> $2`, [t.tin, t.id]);
        if (clash.rows.length) throw new ApiError(409, 'conflict', 'Another business with this TIN is already in production');
        await tx.query(`update tenants set environment = 'production', production_since = now(), bts_approval_reference = $2 where id = $1`, [t.id, request.body.approvalReference.trim()]);
        if (request.body.retireCertificate) await tx.query(`update certificates set status = 'retired' where tenant_id = $1 and status = 'active'`, [t.id]);
        const details = { approvalReference: request.body.approvalReference.trim(), retiredCertificate: Boolean(request.body.retireCertificate) };
        await platformAudit(tx, { adminId: a.id, tenantId: t.id, action: 'tenant.went_live', details, ip: request.ip });
        await audit(tx, { tenantId: t.id, action: 'business.went_live', details, ip: request.ip });
        return t;
      });
      void notifyOwners(result, request.body.retireCertificate ?? false).catch((e) => request.log.error({ err: e }, 'go-live email failed'));
      return { ok: true, environment: 'production' };
    },
  );

  app.post<{ Params: { id: string }; Body: { confirmTin: string; reason: string } }>(
    '/tenants/:id/back-to-test',
    { schema: confirmSchema({ reason: { type: 'string', minLength: 3, maxLength: 500 } }, ['reason']) },
    async (request) => {
      const a = admin(request);
      await db.transaction(async (tx) => {
        const t = (await tx.query<TenantRow>('select * from tenants where id = $1 for update', [request.params.id])).rows[0];
        if (!t) throw notFound('Business');
        if (request.body.confirmTin !== t.tin) throw new ApiError(422, 'confirmation_mismatch', 'Type the business’s TIN to confirm');
        if (t.environment === 'test') throw new ApiError(409, 'already_test', 'This business is already in the test environment');
        const issued = (await tx.query<{ n: number }>(`select count(*)::int as n from documents where tenant_id = $1 and reception_env = '01'`, [t.id])).rows[0]!.n;
        const events = (await tx.query<{ n: number }>(`select count(*)::int as n from events where tenant_id = $1 and substring(etdui from 33 for 2) = '01'`, [t.id])).rows[0]!.n;
        if (issued + events > 0) throw new ApiError(409, 'has_production_documents', 'This business has issued documents in production; it cannot go back to test');
        const clash = await tx.query(`select 1 from tenants where tin = $1 and environment = 'test' and id <> $2`, [t.tin, t.id]);
        if (clash.rows.length) throw new ApiError(409, 'conflict', 'Another business with this TIN is in the test environment');
        await tx.query(`update tenants set environment = 'test', production_since = null where id = $1`, [t.id]);
        await platformAudit(tx, { adminId: a.id, tenantId: t.id, action: 'tenant.back_to_test', details: { reason: request.body.reason }, ip: request.ip });
        await audit(tx, { tenantId: t.id, action: 'business.back_to_test', details: { reason: request.body.reason }, ip: request.ip });
      });
      return { ok: true, environment: 'test' };
    },
  );

  app.get<{ Querystring: { before?: string } }>(
    '/audit',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'string', pattern: '^\\d{1,18}$' } } } } },
    async (request) => {
      const params: unknown[] = [];
      let where = '';
      if (request.query.before) {
        params.push(Number(request.query.before));
        where = 'where p.id < $1';
      }
      const rows = (await db.query<{ id: string | number; action: string; details: Record<string, unknown> | null; ip: string | null; at: string | Date; admin: string | null; tenant: string | null; tenant_id: string | null }>(
        `select p.id, p.action, p.details, p.ip, p.at, a.name as admin, coalesce(t.trade_name, t.legal_name) as tenant, p.tenant_id
         from platform_audit p left join platform_admins a on a.id = p.admin_id left join tenants t on t.id = p.tenant_id ${where} order by p.id desc limit 101`,
        params,
      )).rows;
      return {
        data: rows.slice(0, 100).map((r) => ({ id: Number(r.id), action: r.action, details: r.details, ip: r.ip, at: iso(r.at), admin: r.admin, tenant: r.tenant ? { id: r.tenant_id, name: r.tenant } : null })),
        nextBefore: rows.length > 100 ? Number(rows[99]!.id) : null,
      };
    },
  );

  /** Tell the business's owners they are live (best effort). */
  async function notifyOwners(t: TenantRow, retired: boolean) {
    if (!ctx.mailConfigured || !ctx.publicUrl) return;
    const owners = (await db.query<{ email: string; name: string }>(`select email, name from users where tenant_id = $1 and role = 'owner' and status = 'active' and email is not null`, [t.id])).rows;
    const name = t.trade_name ?? t.legal_name;
    const link = publicLink(ctx, `/${t.slug}`);
    const lines = [
      `${name} is now connected to the Belize Tax Service production environment. Documents you issue from now on are real tax documents.`,
      'Numbering starts again at 000000001. Your test documents stay in your records, marked as test.',
      ...(retired ? ['Install your production certificate in Settings → Business before issuing.'] : []),
    ];
    for (const o of owners) {
      await ctx.mailer.send({
        to: o.email,
        subject: `${name} is live with BTS`,
        text: [`Hello ${o.name},`, ...lines, link].join('\n\n'),
        html: simpleHtml({ heading: `${name} is live`, paragraphs: [`Hello ${o.name},`, ...lines], button: { label: 'Open eInvoicing', url: link } }),
      });
    }
  }
}
