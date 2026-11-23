/**
 * Webhook endpoints, for owners and admins (or an integration's API key).
 * Needs a plan with webhooks.
 *
 *   GET    /v1/webhooks                         endpoints and the event types on offer
 *   POST   /v1/webhooks                         { url, events, description? } → the signing secret, shown once
 *   PATCH  /v1/webhooks/:id                     { url?, events?, description?, enabled? }
 *   DELETE /v1/webhooks/:id
 *   POST   /v1/webhooks/:id/rotate-secret       a new secret, shown once
 *   POST   /v1/webhooks/:id/test                send a "ping" now and report the answer
 *   GET    /v1/webhooks/:id/deliveries          the last 50 deliveries
 *   POST   /v1/webhooks/deliveries/:id/retry    send a failed delivery again
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertFeature } from '../billing/billing.ts';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { checkEndpointUrl, deliverDue, newSecret, WEBHOOK_EVENTS, WebhookError } from '../webhooks/webhooks.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

export const MAX_ENDPOINTS = 10;

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: Date | string;
  last_delivery_at: Date | string | null;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const endpointJson = (r: EndpointRow) => ({
  id: r.id, url: r.url, description: r.description, events: r.events, enabled: r.enabled,
  consecutiveFailures: r.consecutive_failures, disabledReason: r.disabled_reason, createdAt: iso(r.created_at), lastDeliveryAt: iso(r.last_delivery_at),
});

const eventsSchema = { type: 'array', minItems: 1, maxItems: WEBHOOK_EVENTS.length + 1, uniqueItems: true, items: { type: 'string', enum: ['*', ...WEBHOOK_EVENTS] } } as const;

export function registerWebhookRoutes(app: FastifyInstance, deps: PipelineDeps, options: { allowPrivate?: boolean } = {}) {
  const { db } = deps;
  const guard = async (request: FastifyRequest) => {
    requirePermission(request, 'business.manage');
    await assertFeature(db, request.tenantId, 'webhooks');
  };
  const checkUrl = (url: string) => {
    try {
      return checkEndpointUrl(url, options).toString();
    } catch (e) {
      throw new ApiError(422, 'invalid_url', (e as WebhookError).message);
    }
  };
  const load = async (tenantId: string, id: string) => {
    const r = (await db.query<EndpointRow>('select * from webhook_endpoints where id = $1 and tenant_id = $2', [id, tenantId])).rows[0];
    if (!r) throw notFound('Webhook');
    return r;
  };
  const who = (request: FastifyRequest) => ({ tenantId: request.tenantId, userId: request.userId || null, ip: request.ip });
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

  app.get('/webhooks', async (request) => {
    requirePermission(request, 'business.manage');
    const rows = (await db.query<EndpointRow>('select * from webhook_endpoints where tenant_id = $1 order by created_at', [request.tenantId])).rows;
    return { data: rows.map(endpointJson), events: WEBHOOK_EVENTS };
  });

  app.post<{ Body: { url: string; events: string[]; description?: string } }>(
    '/webhooks',
    { schema: { body: { type: 'object', required: ['url', 'events'], additionalProperties: false, properties: { url: { type: 'string', maxLength: 2000 }, events: eventsSchema, description: { type: 'string', maxLength: 200 } } } } },
    async (request, reply) => {
      await guard(request);
      const count = (await db.query<{ n: number }>('select count(*)::int as n from webhook_endpoints where tenant_id = $1', [request.tenantId])).rows[0]!.n;
      if (count >= MAX_ENDPOINTS) throw new ApiError(409, 'too_many_webhooks', `A business can have up to ${MAX_ENDPOINTS} webhook endpoints`);
      const id = randomUUID();
      const secret = newSecret();
      const url = checkUrl(request.body.url);
      await db.query(
        'insert into webhook_endpoints (id, tenant_id, url, description, events, secret_encrypted) values ($1, $2, $3, $4, $5, $6)',
        [id, request.tenantId, url, request.body.description?.trim() || null, request.body.events, await deps.keys.encrypt(Buffer.from(secret), `webhook:${id}`)],
      );
      await audit(db, { ...who(request), action: 'webhook.created', target: url });
      return reply.code(201).send({ ...endpointJson(await load(request.tenantId, id)), secret });
    },
  );

  app.patch<{ Params: { id: string }; Body: { url?: string; events?: string[]; description?: string | null; enabled?: boolean } }>(
    '/webhooks/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { url: { type: 'string', maxLength: 2000 }, events: eventsSchema, description: { type: ['string', 'null'], maxLength: 200 }, enabled: { type: 'boolean' } } } } },
    async (request) => {
      await guard(request);
      const before = await load(request.tenantId, request.params.id);
      const b = request.body;
      const url = b.url !== undefined ? checkUrl(b.url) : before.url;
      const enabling = b.enabled === true && !before.enabled;
      await db.query(
        `update webhook_endpoints set url = $3, events = $4, description = $5, enabled = $6,
           consecutive_failures = case when $7 then 0 else consecutive_failures end, disabled_reason = case when $6 then null else disabled_reason end
         where id = $1 and tenant_id = $2`,
        [before.id, request.tenantId, url, b.events ?? before.events, b.description === undefined ? before.description : b.description?.trim() || null, b.enabled ?? before.enabled, enabling],
      );
      await audit(db, { ...who(request), action: 'webhook.updated', target: url });
      return endpointJson(await load(request.tenantId, before.id));
    },
  );

  app.delete<{ Params: { id: string } }>('/webhooks/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const before = await load(request.tenantId, request.params.id);
    await db.query('delete from webhook_endpoints where id = $1', [before.id]);
    await audit(db, { ...who(request), action: 'webhook.deleted', target: before.url });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/webhooks/:id/rotate-secret', { schema: { params: idParams } }, async (request) => {
    await guard(request);
    const before = await load(request.tenantId, request.params.id);
    const secret = newSecret();
    await db.query('update webhook_endpoints set secret_encrypted = $2 where id = $1', [before.id, await deps.keys.encrypt(Buffer.from(secret), `webhook:${before.id}`)]);
    await audit(db, { ...who(request), action: 'webhook.secret_rotated', target: before.url });
    return { ...endpointJson(before), secret };
  });

  app.post<{ Params: { id: string } }>('/webhooks/:id/test', { schema: { params: idParams } }, async (request) => {
    await guard(request);
    const ep = await load(request.tenantId, request.params.id);
    if (!ep.enabled) throw new ApiError(409, 'disabled', 'Switch the endpoint on first');
    const id = randomUUID();
    await db.query(
      `insert into webhook_deliveries (id, endpoint_id, tenant_id, type, payload, status, next_attempt_at) values ($1, $2, $3, 'ping', $4, 'pending', now() + interval '1 hour')`,
      [id, ep.id, request.tenantId, JSON.stringify({ createdAt: new Date().toISOString(), data: { message: 'A test from Floreo. Your endpoint works.' } })],
    );
    // Send just this one, now.
    await db.query('update webhook_deliveries set next_attempt_at = now() where id = $1', [id]);
    await deliverDue(db, { keys: deps.keys, ...(options.allowPrivate && { allowPrivate: true }) }, 1, id);
    const d = (await db.query<{ status: string; response_status: number | null; error: string | null }>('select status, response_status, error from webhook_deliveries where id = $1', [id])).rows[0]!;
    // A test that failed is not retried later.
    if (d.status === 'pending') await db.query("update webhook_deliveries set status = 'failed' where id = $1", [id]);
    return { ok: d.status === 'delivered', status: d.response_status, error: d.error };
  });

  app.get<{ Params: { id: string } }>('/webhooks/:id/deliveries', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const ep = await load(request.tenantId, request.params.id);
    const rows = (await db.query<{ id: string; type: string; status: string; attempts: number; response_status: number | null; error: string | null; created_at: Date; delivered_at: Date | null; next_attempt_at: Date }>(
      'select id, type, status, attempts, response_status, error, created_at, delivered_at, next_attempt_at from webhook_deliveries where endpoint_id = $1 order by created_at desc limit 50', [ep.id],
    )).rows;
    return {
      data: rows.map((r) => ({
        id: r.id, type: r.type, status: r.status, attempts: r.attempts, responseStatus: r.response_status, error: r.error,
        createdAt: iso(r.created_at), deliveredAt: iso(r.delivered_at), nextAttemptAt: r.status === 'pending' ? iso(r.next_attempt_at) : null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/webhooks/deliveries/:id/retry', { schema: { params: idParams } }, async (request) => {
    await guard(request);
    const r = await db.query("update webhook_deliveries set status = 'pending', next_attempt_at = now() where id = $1 and tenant_id = $2 and status = 'failed' and type <> 'ping' returning id", [request.params.id, request.tenantId]);
    if (!r.rows.length) throw new ApiError(409, 'conflict', 'Only a failed delivery can be sent again');
    return { ok: true };
  });
}
