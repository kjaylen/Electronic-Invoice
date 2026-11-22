/**
 * The HTTP API (v1) and, when built, the web app.
 *
 *   /health                         liveness, database check and "ok" or "degraded", no auth
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

import { existsSync } from 'node:fs';
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

export type Principal = 'api' | Role;

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    /** "api" for an API key; the person's role for a session. */
    principal: Principal;
    userId: string;
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
}

function bearer(request: FastifyRequest): string | undefined {
  const h = request.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
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
  app.decorateRequest('tenantId', '');
  app.decorateRequest('principal', 'api');
  app.decorateRequest('userId', '');
  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
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
  };
  const billingContext = billingContextFactory(deps, ctx);

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
  await app.register(async (tenant) => {
    tenant.addHook('onRequest', async (request) => {
      if (request.url.startsWith('/v1/admin') || request.url.startsWith('/v1/auth')) return;
      const key = bearer(request);
      if (key) {
        const principal = await authenticateApiKey(db, key);
        if (!principal) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key');
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
    registerProductRoutes(tenant, deps, ctx);
    registerOrderRoutes(tenant, deps, ctx);
    registerReportRoutes(tenant, deps);
    registerBillingRoutes(tenant, deps, ctx, billingContext);
  }, { prefix: '/v1' });

  registerPublicDocumentRoutes(app, deps);

  // The platform console, for our own staff.
  await app.register(async (platform) => registerPlatformRoutes(platform, deps, ctx, billingContext), { prefix: '/v1/platform' });

  // The public storefront: no sign-in, scoped by the business's address.
  await app.register(async (store) => registerStorefrontRoutes(store, deps, ctx), { prefix: '/v1/store' });

  // The web app: static files, and index.html for any other GET so client-side routes work.
  const webRoot = options.webRoot;
  const hasWeb = Boolean(webRoot && existsSync(join(webRoot, 'index.html')));
  if (hasWeb) await app.register(fastifyStatic, { root: webRoot!, prefix: '/', wildcard: true, index: ['index.html'] });
  app.setNotFoundHandler((request, reply) => {
    const isPage = request.method === 'GET' && !request.url.startsWith('/v1') && !request.url.startsWith('/health') && !request.url.startsWith('/d/');
    if (hasWeb && isPage) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  return app;
}
