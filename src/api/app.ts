/**
 * The HTTP API (v1) and, when built, the web app.
 *
 *   /health                         liveness, database check and "ok" or "degraded", no auth
 *   /v1/openapi.json                the public API's OpenAPI 3.1 description, no auth
 *   /metrics                        Prometheus metrics (Authorization: Bearer METRICS_TOKEN); off without a token
 *   /v1/admin/...                   onboarding, Bearer <ADMIN_TOKEN>
 *   /v1/auth/...                    signing in to a business (web app)
 *   /v1/...                         everything else: Bearer <tenant API key>, or a session cookie
 *                                   (the business named by X-Business or ?b=<slug>)
 *   /v1/platform/...                the platform console, for our staff (own accounts and cookie)
 *   /v1/store/:slug/...             a business's online store, no auth
 *   /d/:token                       a shared document's printed copy, no auth (the token is the permission)
 *   /*                              the web app (static files), when webRoot is set
 *
 * The tenant always comes from the API key or the signed-in account (which
 * belongs to exactly one business), never from the URL or body, so one
 * business can never address another's data. What a person may do depends on
 * their role (see permissions.ts). Money and quantities are decimal strings in and out ("24.99").
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { authenticateApiKey } from '../db/apikeys.ts';
import { type Mailer, noMailer } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { registerAdminRoutes } from './admin.ts';
import { registerAuthRoutes, requireCsrfHeader, sessionFromRequest } from './auth.ts';
import { registerBusinessRoutes } from './business.ts';
import { registerCatalogRoutes } from './catalog.ts';
import type { ServerContext } from './context.ts';
import { registerDocumentRoutes, registerPublicDocumentRoutes } from './documents.ts';
import { ApiError, errorHandler } from './errors.ts';
import type { Role } from './permissions.ts';
import { registerOrderRoutes } from './orders.ts';
import { registerPlatformRoutes } from './platform.ts';
import { registerProductRoutes } from './products.ts';
import { registerReportRoutes } from './reports.ts';
import { registerStorefrontRoutes } from './storefront.ts';
import { registerUserRoutes } from './users.ts';
import { counters, metricsText, opsStatus } from '../ops/monitoring.ts';
import type { ObjectStore } from '../storage/objects.ts';
import { billingContextFactory, registerBillingRoutes } from './billing.ts';
import { registerWebhookRoutes } from './webhooks.ts';
import { countHit } from '../db/ratelimit.ts';
import { buildOpenApi, routeCollector } from './openapi.ts';
import { type GatewayExtras, gatewayOptions, registerPaymentAccountRoutes, registerPaymentCallbacks } from './payments.ts';
import { registerPayRoutes, registerReceivableRoutes } from './receivables.ts';
import { registerBillPayBankRoutes, registerBillPaySettingsRoutes } from './billpay.ts';
import { registerPublicQuoteRoutes, registerQuoteRoutes } from './quotes.ts';
import { registerRecurringRoutes } from './recurring.ts';
import { registerExpenseRoutes } from './expenses.ts';
import { registerAccountingRoutes } from './accounting.ts';
import { registerInventoryRoutes } from './inventory.ts';
import { registerPurchasingRoutes } from './purchasing.ts';
import { registerSupplierSummaryRoutes } from './supplier-summary.ts';
import { registerHeldSaleRoutes } from './held.ts';
import { registerTimeclockRoutes } from './timeclock.ts';
import { registerPriceListRoutes } from './price-list.ts';
import { registerShiftRoutes } from './shifts.ts';
import { registerPosAdminRoutes, registerPosDeviceRoutes, SESSION_TOKEN_PREFIX, tillMayUse, touchDevice } from './pos.ts';
import { lookupSession } from '../db/users.ts';
import { registerDiscountRoutes } from './discounts.ts';
import { registerPublicAssetRoutes, registerTemplateRoutes } from './templates.ts';
import { registerImportRoutes } from './imports.ts';
import { domainCache } from '../commerce/domains.ts';
import { registerIntegrationCallback, registerIntegrationRoutes } from './integrations.ts';
import type { QuickBooksConfig } from '../integrations/quickbooks.ts';
import { plansJson } from './billing.ts';
import { TRIAL_DAYS } from '../billing/plans.ts';
import { type HtmlPdfRenderer, setPdfRenderer } from '../render/browser-pdf.ts';

export type Principal = 'api' | Role;

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    /** "api" for an API key; the person's role for a session. */
    principal: Principal;
    userId: string;
    /** Signed in on a till: the till and its cash drawer. */
    posDevice: { id: string; registerId: string } | null;
  }
}

export interface AppOptions {
  pipeline: PipelineDeps;
  /** Enables /v1/admin routes. At least 32 characters. Leave unset to disable them. */
  adminToken?: string;
  logger?: boolean;
  /** Largest accepted request body. Default 1 MB. */
  bodyLimit?: number;
  /** Folder with the built web app (web/dist). Unset: API only. */
  webRoot?: string;
  /** Secure flag on the session cookie. Default true; false only for local HTTP development. */
  cookieSecure?: boolean;
  /** Allow self-service sign-up. Default true. */
  allowSignup?: boolean;
  /** Sends password resets, invitations and documents. Unset: those answer 503 (invitations still return a link). */
  mailer?: Mailer;
  /** Public base URL of the web app, for links in emails and share links. Never taken from the Host header. */
  publicUrl?: string;
  /** Enables /metrics for a scraper sending this bearer token. At least 32 characters. */
  metricsToken?: string;
  /** S3-compatible storage for product photos. Unset: photos are kept in the database. */
  objectStore?: ObjectStore;
  /** The platform's billing: its own business's address (it issues the invoices) and payment instructions. */
  billing?: { tenantSlug?: string; paymentInstructions?: string };
  /** Requests per minute per API key. Default 600. */
  apiRateLimitPerMinute?: number;
  /** Let webhooks reach private addresses and plain http (development and tests only). */
  webhooksAllowPrivate?: boolean;
  /** For tests: the fetch used to talk to payment providers. */
  paymentsFetch?: typeof fetch;
  /** E-Kyash's API addresses (given by Belize Bank, the same for every merchant). */
  ekyash?: { sandboxUrl?: string; liveUrl?: string };
  /** Where businesses point their store domains (CNAME), e.g. stores.example.bz. */
  storeDomainTarget?: string;
  /** For tests: DNS TXT lookups for domain verification. */
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Shown on the public pages (pricing, terms, privacy): who runs the service and how to reach them. */
  site?: { legalName?: string; contactEmail?: string };
  /** The platform's Intuit app, for the QuickBooks Online integration. */
  quickbooks?: { clientId: string; clientSecret: string; environment: 'sandbox' | 'production'; fetch?: typeof fetch };
  /** Extra origins the till apps call the API from (the built-in ones cover the iOS, Android and desktop apps). */
  tillOrigins?: string[];
  /** Prints documents from the businesses' templates (a headless Chromium). Unset: the built-in layouts. Closed with the app. */
  pdfRenderer?: HtmlPdfRenderer;
}

/** Where the till apps run: Capacitor on iOS and Android, the Electron desktop app. They send bearer tokens, never cookies. */
export const TILL_APP_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'https://localhost', 'http://localhost', 'app://pos'];

function bearer(request: FastifyRequest): string | undefined {
  const h = request.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The content security policy; product photos may come from a CDN origin. */
const csp = (imageOrigins: string[]) => [
  "default-src 'self'",
  `img-src 'self' data: blob:${imageOrigins.map((o) => ` ${o}`).join('')}`,
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  if (options.adminToken !== undefined && options.adminToken.length < 32) {
    throw new Error('ADMIN_TOKEN must be at least 32 characters');
  }
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });
  if (options.pdfRenderer) {
    const renderer = options.pdfRenderer;
    setPdfRenderer(renderer);
    app.addHook('onClose', async () => {
      setPdfRenderer(null);
      await renderer.close();
    });
  }
  app.decorateRequest('tenantId', '');
  app.decorateRequest('principal', 'api');
  app.decorateRequest('userId', '');
  app.decorateRequest('posDevice', null);
  app.setErrorHandler(errorHandler);

  // The till apps call the API from their own origin with a bearer token. No cookies are allowed
  // cross-origin (no Allow-Credentials), so this opens nothing to web pages elsewhere.
  const tillOrigins = new Set([...TILL_APP_ORIGINS, ...(options.tillOrigins ?? [])]);
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !tillOrigins.has(origin) || !request.url.startsWith('/v1/')) return;
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Expose-Headers', 'Content-Disposition, Idempotent-Replayed, Retry-After');
    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Requested-With');
      reply.header('Access-Control-Max-Age', '600');
      return reply.code(204).send();
    }
  });
  const photoOrigin = (() => {
    const u = options.objectStore?.publicUrl('probe');
    try {
      return u ? [new URL(u).origin] : [];
    } catch {
      return [];
    }
  })();
  const CSP = csp(photoOrigin);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
    // A route with a policy of its own (uploaded images) keeps it.
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Behind TLS (secure cookies), browsers should never use plain HTTP again.
    if (options.cookieSecure !== false) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  const deps = options.pipeline;
  const db = deps.db;
  const ctx: ServerContext = {
    mailer: options.mailer ?? noMailer,
    mailConfigured: Boolean(options.mailer),
    ...(options.publicUrl && { publicUrl: options.publicUrl }),
    cookieSecure: options.cookieSecure ?? true,
    allowSignup: options.allowSignup ?? true,
    ...(options.objectStore && { objects: options.objectStore }),
    ...(options.billing && { billing: options.billing }),
    ...(options.storeDomainTarget && { storeDomainTarget: options.storeDomainTarget }),
    ...(options.resolveTxt && { resolveTxt: options.resolveTxt }),
  };
  const storeDomains = domainCache(db);
  const quickbooks: QuickBooksConfig | undefined = options.quickbooks && options.publicUrl
    ? { ...options.quickbooks, redirectUri: `${options.publicUrl.replace(/\/$/, '')}/v1/integrations/quickbooks/callback` }
    : undefined;
  const billingContext = billingContextFactory(deps, ctx);
  // How every part of the app talks to payment providers.
  const paymentExtras: GatewayExtras = {
    ...(options.paymentsFetch && { fetch: options.paymentsFetch }),
    ...(options.publicUrl && { publicUrl: options.publicUrl }),
    ...(options.ekyash && { ekyash: options.ekyash }),
  };

  app.addHook('onResponse', async (_request, reply) => {
    counters.requests++;
    if (reply.statusCode >= 500) counters.serverErrors++;
  });

  // For load balancers: 200 while the database answers ("degraded" says something needs a look), 503 when it does not.
  app.get('/health', async (_request, reply) => {
    try {
      const s = await opsStatus(db);
      return { status: s.status, worker: s.worker.stale ? 'stale' : 'ok' };
    } catch {
      return reply.code(503).send({ status: 'down' });
    }
  });

  if (options.metricsToken !== undefined && options.metricsToken.length < 32) throw new Error('metricsToken must be at least 32 characters');
  if (options.metricsToken) {
    const token = options.metricsToken;
    app.get('/metrics', async (request, reply) => {
      const given = bearer(request);
      if (!given || !constantTimeEquals(given, token)) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Bearer token required' } });
      const s = await opsStatus(db);
      return reply.type('text/plain; version=0.0.4').send(`${metricsText(s)}${s.problems.map((p) => `# problem ${p.key}: ${p.message}`).join('\n')}\n`);
    });
  }

  // Admin routes: onboarding businesses, certificates and API keys.
  await app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      const token = bearer(request);
      if (!options.adminToken || !token || !constantTimeEquals(token, options.adminToken)) {
        throw new ApiError(401, 'unauthorized', 'Missing or invalid admin token');
      }
    });
    registerAdminRoutes(admin, deps);
  }, { prefix: '/v1/admin' });

  // Accounts for people.
  await app.register(async (a) => registerAuthRoutes(a, deps, ctx), { prefix: '/v1/auth' });

  // Tenant routes: API key or session.
  const collected = routeCollector();
  await app.register(async (tenant) => {
    tenant.addHook('onRoute', collected.onRoute);
    tenant.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/v1/admin') || request.url.startsWith('/v1/auth')) return;
      const key = bearer(request);
      // A cashier signed in on a till: their role, limited to what a till does.
      if (key?.startsWith(SESSION_TOKEN_PREFIX)) {
        const session = await lookupSession(db, key.slice(SESSION_TOKEN_PREFIX.length));
        if (!session?.device) throw new ApiError(401, 'signed_out', 'Signed out on this till; sign in again with your PIN');
        if (!tillMayUse(request)) throw new ApiError(403, 'not_on_till', 'This is done in the web app, not on a till');
        request.tenantId = session.business.id;
        request.principal = session.user.role;
        request.userId = session.user.id;
        request.posDevice = session.device;
        touchDevice(db, session.device.id);
        return;
      }
      if (key) {
        const principal = await authenticateApiKey(db, key);
        if (!principal) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key');
        // Per key, per minute, shared by every server process.
        const limit = options.apiRateLimitPerMinute ?? 600;
        const used = await countHit(db, `apikey|${principal.keyId}`, 60_000);
        reply.header('X-RateLimit-Limit', String(limit));
        reply.header('X-RateLimit-Remaining', String(Math.max(0, limit - used)));
        if (used > limit) {
          reply.header('Retry-After', '60');
          throw new ApiError(429, 'rate_limited', `More than ${limit} requests in a minute with this API key; slow down and retry after the Retry-After seconds`);
        }
        request.tenantId = principal.tenantId;
        request.principal = 'api';
        return;
      }
      const session = await sessionFromRequest(deps, request);
      if (!session) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key or session');
      requireCsrfHeader(request);
      // A temporary password set by an administrator must be replaced before anything else.
      if (session.user.mustChangePassword) throw new ApiError(403, 'password_change_required', 'Choose a new password first');
      // The business requires two-step sign-in for owners and admins: set it up before anything else.
      if (session.twoFactor.required && !session.twoFactor.enabled) throw new ApiError(403, 'two_factor_setup_required', 'Set up two-step sign-in first');
      request.tenantId = session.business.id;
      request.principal = session.user.role;
      request.userId = session.user.id;
    });
    // "?b=<slug>" names the business on plain links (PDFs, downloads); it is not part of any route's own query.
    tenant.addHook('preValidation', async (request) => {
      const q = request.query as Record<string, unknown> | undefined;
      if (q && 'b' in q) delete q.b;
    });
    registerCatalogRoutes(tenant, deps);
    registerDocumentRoutes(tenant, deps, ctx);
    registerUserRoutes(tenant, deps, ctx);
    registerBusinessRoutes(tenant, deps, ctx);
    registerProductRoutes(tenant, deps, ctx, storeDomains);
    registerOrderRoutes(tenant, deps, ctx);
    registerReportRoutes(tenant, deps);
    registerBillingRoutes(tenant, deps, ctx, billingContext);
    registerWebhookRoutes(tenant, deps, { ...(options.webhooksAllowPrivate && { allowPrivate: true }) });
    registerPaymentAccountRoutes(tenant, deps, paymentExtras);
    registerDiscountRoutes(tenant, deps);
    registerIntegrationRoutes(tenant, deps, quickbooks);
    registerReceivableRoutes(tenant, deps, ctx, { ...(options.ekyash && { ekyash: options.ekyash }) });
    registerBillPaySettingsRoutes(tenant, deps, ctx);
    registerQuoteRoutes(tenant, deps, ctx, { ...(options.ekyash && { ekyash: options.ekyash }) });
    registerRecurringRoutes(tenant, deps, ctx, { ...(options.ekyash && { ekyash: options.ekyash }) });
    registerExpenseRoutes(tenant, deps, ctx);
    registerAccountingRoutes(tenant, deps);
    registerInventoryRoutes(tenant, deps);
    registerPurchasingRoutes(tenant, deps, ctx);
    registerSupplierSummaryRoutes(tenant, deps);
    registerHeldSaleRoutes(tenant, deps);
    registerTimeclockRoutes(tenant, deps);
    registerPriceListRoutes(tenant, deps);
    registerShiftRoutes(tenant, deps);
    registerPosAdminRoutes(tenant, deps);
    registerTemplateRoutes(tenant, deps);
    registerImportRoutes(tenant, deps);
  }, { prefix: '/v1' });

  // The till apps before anyone signs in: pairing, who can sign in, PIN sign-in (the till's own token).
  await app.register(async (pos) => registerPosDeviceRoutes(pos, deps), { prefix: '/v1/pos' });

  registerPublicDocumentRoutes(app, deps);
  registerPublicAssetRoutes(app, deps);
  registerIntegrationCallback(app, deps, ctx, quickbooks);

  // What the public pages need: who runs the service, and the plans.
  app.get('/v1/site', async (_request, reply) => reply.header('Cache-Control', 'public, max-age=300').send({
    productName: 'eInvoicing',
    legalName: options.site?.legalName ?? null,
    contactEmail: options.site?.contactEmail ?? null,
    plans: plansJson(),
    trialDays: TRIAL_DAYS,
  }));

  // The public API's description (OpenAPI 3.1), from the routes' own schemas.
  let openapi: unknown;
  app.get('/v1/openapi.json', async (_request, reply) => {
    openapi ??= buildOpenApi(collected.routes, { ...(options.publicUrl && { serverUrl: options.publicUrl }) });
    return reply.header('Cache-Control', 'public, max-age=300').send(openapi);
  });

  // The platform console, for our own staff.
  await app.register(async (platform) => registerPlatformRoutes(platform, deps, ctx, billingContext), { prefix: '/v1/platform' });

  // Paying an invoice from its link: no sign-in, the link's token is the permission.
  const slugOfTenant = async (tenantId: string) => (await db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]!.slug;
  await app.register(async (pay) => registerPayRoutes(pay, deps, ctx, {
    gatewayOptions: gatewayOptions(deps, slugOfTenant, paymentExtras),
    ...(options.ekyash && { ekyash: options.ekyash }),
  }), { prefix: '/v1/pay' });
  // A customer looking at a quote, accepting or declining it (the link's token is the permission).
  await app.register(async (q) => registerPublicQuoteRoutes(q, deps, ctx), { prefix: '/v1/quote' });
  // Belize Bank asking about and posting bill payments (bearer token per business).
  await app.register(async (bank) => registerBillPayBankRoutes(bank, deps), { prefix: '/v1/billpay' });
  // What payment providers tell us (only ever a prompt to ask them).
  await app.register(async (cb) => registerPaymentCallbacks(cb, deps, ctx, gatewayOptions(deps, slugOfTenant, paymentExtras)), { prefix: '/v1/payment-callbacks' });

  // The public storefront: no sign-in, scoped by the business's address.
  await app.register(async (store) => registerStorefrontRoutes(store, deps, ctx, paymentExtras), { prefix: '/v1/store' });

  // The web app: static files, and index.html for any other GET so client-side routes work.
  const webRoot = options.webRoot;
  const hasWeb = Boolean(webRoot && existsSync(join(webRoot, 'index.html')));
  // For a proxy with on-demand TLS: may it get a certificate for this domain?
  app.get<{ Querystring: { domain?: string } }>('/v1/domains/check', async (request, reply) => {
    const slug = request.query.domain ? await storeDomains.slugFor(request.query.domain) : undefined;
    return slug ? { ok: true } : reply.code(404).send({ error: { code: 'not_found', message: 'Unknown domain' } });
  });

  // A store's own domain: its pages are the store, with the store named in the page (the app has no business in the path).
  let indexHtml: string | null = null;
  if (hasWeb) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/v1') || request.url.startsWith('/health') || request.url.startsWith('/assets/') || /\.[a-z0-9]{2,5}(\?|$)/i.test(request.url)) return;
      const slug = await storeDomains.slugFor(request.hostname);
      if (!slug) return;
      if (!request.url.startsWith('/shop')) return reply.redirect('/shop', 302);
      indexHtml ??= readFileSync(join(webRoot!, 'index.html'), 'utf8');
      return reply.type('text/html').header('Cache-Control', 'no-cache')
        .send(indexHtml.replace('</head>', `<meta name="einvoicing-store" content="${slug.replace(/[^a-z0-9-]/g, '')}"></head>`));
    });
    await app.register(fastifyStatic, { root: webRoot!, prefix: '/', wildcard: true, index: ['index.html'] });
  }
  const hasTill = Boolean(webRoot && existsSync(join(webRoot, 'pos.html')));
  app.setNotFoundHandler((request, reply) => {
    const isPage = request.method === 'GET' && !request.url.startsWith('/v1') && !request.url.startsWith('/health') && !request.url.startsWith('/d/');
    // The till in a browser (the same app the iOS, Android and desktop tills run).
    if (hasTill && isPage && /^\/pos(\/|\?|$)/.test(request.url)) return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('pos.html');
    if (hasWeb && isPage) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  return app;
}
