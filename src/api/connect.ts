/**
 * Connecting a site built somewhere else (Settings → Developers).
 *
 *   GET    /v1/publishable-keys          the store's publishable keys, and what a site needs to use them
 *   POST   /v1/publishable-keys          { name, origins? } → a new key (pk_test_… or pk_live_…)
 *   PATCH  /v1/publishable-keys/:id      { name?, origins? }
 *   DELETE /v1/publishable-keys/:id      revoke it: sites using it stop working at once
 *
 * For owners and admins, signed in (never with an API key, like secret keys).
 * A publishable key is not a secret, so it is shown every time.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertFeature } from '../billing/billing.ts';
import { ConnectError, createPublishableKey, listPublishableKeys, type PublishableKey, revokePublishableKey, updatePublishableKey } from '../commerce/connect.ts';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { requirePersonWith } from './permissions.ts';
import { uuid } from './schemas.ts';

const keyJson = (k: PublishableKey) => ({ id: k.id, key: k.key, name: k.name, mode: k.key.startsWith('pk_live_') ? 'live' : 'test', origins: k.origins, createdAt: k.createdAt, revokedAt: k.revokedAt });

function fail(e: unknown): never {
  if (e instanceof ConnectError) throw new ApiError(e.code === 'not_found' ? 404 : e.code === 'too_many_keys' ? 409 : 422, e.code === 'not_found' ? 'not_found' : e.code, e.message);
  throw e;
}

/** Where this server is reached from outside: PUBLIC_URL when set, else the address of this request. */
export function publicBase(ctx: Pick<ServerContext, 'publicUrl'>, request: FastifyRequest): string {
  return (ctx.publicUrl ?? `${request.protocol}://${request.host}`).replace(/\/$/, '');
}

export function registerConnectRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const originsSchema = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } } as const;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const who = (request: FastifyRequest) => ({ tenantId: request.tenantId, userId: request.userId || null, ip: request.ip });

  app.get('/publishable-keys', async (request) => {
    requirePersonWith(request, 'apikeys.manage');
    const { keys, mode } = await listPublishableKeys(db, request.tenantId);
    const t = (await db.query<{ slug: string; enabled: boolean }>(`select slug, coalesce(store_settings ->> 'enabled', 'false') = 'true' as enabled from tenants where id = $1`, [request.tenantId])).rows[0]!;
    const base = publicBase(ctx, request);
    return {
      data: keys.map(keyJson).sort((a, b) => Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt)) || b.createdAt.localeCompare(a.createdAt)),
      // What a site needs beside a key: which store, where the API and the script are, and whether this is test or live.
      mode,
      store: t.slug,
      storeOpen: t.enabled,
      apiUrl: `${base}/v1/store/${t.slug}`,
      embedUrl: `${base}/embed.js`,
    };
  });

  app.post<{ Body: { name: string; origins?: string[] } }>(
    '/publishable-keys',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, origins: originsSchema } } } },
    async (request, reply) => {
      requirePersonWith(request, 'apikeys.manage');
      await assertFeature(db, request.tenantId, 'store');
      const key = await createPublishableKey(db, request.tenantId, request.body).catch(fail);
      await audit(db, { ...who(request), action: 'publishable_key.created', target: key.name, details: { origins: key.origins } });
      return reply.code(201).send(keyJson(key));
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; origins?: string[] } }>(
    '/publishable-keys/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, origins: originsSchema } } } },
    async (request) => {
      requirePersonWith(request, 'apikeys.manage');
      const key = await updatePublishableKey(db, request.tenantId, request.params.id, request.body).catch(fail);
      await audit(db, { ...who(request), action: 'publishable_key.updated', target: key.name, details: { origins: key.origins } });
      return keyJson(key);
    },
  );

  app.delete<{ Params: { id: string } }>('/publishable-keys/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePersonWith(request, 'apikeys.manage');
    const key = await revokePublishableKey(db, request.tenantId, request.params.id).catch(fail);
    await audit(db, { ...who(request), action: 'publishable_key.revoked', target: key.name });
    return reply.code(204).send();
  });
}
