/**
 * The HTTP API (v1) and, when built, the web app.
 *
 *   /health                         liveness and database check, no auth
 *   /v1/admin/...                   onboarding, Bearer <ADMIN_TOKEN>
 *   /v1/auth/...                    accounts and sessions for people (web app)
 *   /v1/...                         everything else: Bearer <tenant API key>, or a session cookie
 *   /*                              the web app (static files), when webRoot is set
 *
 * The tenant always comes from the API key or the session's current business,
 * never from the URL or body, so one business can never address another's
 * data. Money and quantities are decimal strings in and out ("24.99").
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { authenticateApiKey } from '../db/apikeys.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { registerAdminRoutes } from './admin.ts';
import { registerAuthRoutes, requireCsrfHeader, sessionFromRequest } from './auth.ts';
import { registerCatalogRoutes } from './catalog.ts';
import { registerDocumentRoutes } from './documents.ts';
import { ApiError, errorHandler } from './errors.ts';

export type Principal = 'api' | 'owner' | 'member';

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

/** Owner-only actions: certificates, API keys. API keys count as owner-level (they are created by owners). */
export function requireOwner(request: FastifyRequest) {
  if (request.principal === 'member') throw new ApiError(403, 'forbidden', 'Only an owner of this business can do this');
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
  const auth = { cookieSecure: options.cookieSecure ?? true, allowSignup: options.allowSignup ?? true };

  app.get('/health', async () => {
    await db.query('select 1');
    return { status: 'ok' };
  });

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
  await app.register(async (a) => registerAuthRoutes(a, deps, auth), { prefix: '/v1/auth' });

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
      if (!session.currentTenantId || !session.role) throw new ApiError(409, 'no_business', 'Create or choose a business first');
      request.tenantId = session.currentTenantId;
      request.principal = session.role;
      request.userId = session.user.id;
    });
    registerCatalogRoutes(tenant, deps);
    registerDocumentRoutes(tenant, deps);
  }, { prefix: '/v1' });

  // The web app: static files, and index.html for any other GET so client-side routes work.
  const webRoot = options.webRoot;
  const hasWeb = Boolean(webRoot && existsSync(join(webRoot, 'index.html')));
  if (hasWeb) await app.register(fastifyStatic, { root: webRoot!, prefix: '/', wildcard: true, index: ['index.html'] });
  app.setNotFoundHandler((request, reply) => {
    const isPage = request.method === 'GET' && !request.url.startsWith('/v1') && !request.url.startsWith('/health');
    if (hasWeb && isPage) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  return app;
}
