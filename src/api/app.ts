/**
 * The HTTP API (v1).
 *
 *   /health                         liveness and database check, no auth
 *   /v1/admin/...                   onboarding, Bearer <ADMIN_TOKEN>
 *   /v1/...                         everything else, Bearer <tenant API key>
 *
 * The tenant always comes from the API key, never from the URL or body, so
 * one business can never address another's data. Money and quantities are
 * decimal strings in and out ("24.99"), never JSON numbers.
 */

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { authenticateApiKey } from '../db/apikeys.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { registerAdminRoutes } from './admin.ts';
import { registerCatalogRoutes } from './catalog.ts';
import { registerDocumentRoutes } from './documents.ts';
import { ApiError, errorHandler } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export interface AppOptions {
  pipeline: PipelineDeps;
  /** Enables /v1/admin routes. At least 32 characters. Leave unset to disable them. */
  adminToken?: string;
  logger?: boolean;
  /** Largest accepted request body. Default 1 MB. */
  bodyLimit?: number;
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

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  if (options.adminToken !== undefined && options.adminToken.length < 32) {
    throw new Error('ADMIN_TOKEN must be at least 32 characters');
  }
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });
  app.decorateRequest('tenantId', '');
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }));

  const db = options.pipeline.db;

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
    registerAdminRoutes(admin, options.pipeline);
  }, { prefix: '/v1/admin' });

  // Tenant routes.
  await app.register(async (tenant) => {
    tenant.addHook('onRequest', async (request) => {
      if (request.url.startsWith('/v1/admin')) return;
      const key = bearer(request);
      const principal = key ? await authenticateApiKey(db, key) : null;
      if (!principal) throw new ApiError(401, 'unauthorized', 'Missing or invalid API key');
      request.tenantId = principal.tenantId;
    });
    registerCatalogRoutes(tenant, options.pipeline);
    registerDocumentRoutes(tenant, options.pipeline);
  }, { prefix: '/v1' });

  return app;
}
