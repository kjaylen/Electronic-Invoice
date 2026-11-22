/**
 * Accounting integrations (Pro plan). QuickBooks Online first.
 *
 *   GET    /v1/integrations                           what is available, connected, and the recent syncs
 *   POST   /v1/integrations/quickbooks/connect        → the Intuit sign-in URL to send the person to
 *   GET    /v1/integrations/quickbooks/callback       Intuit sends the person back here (public; checked by state)
 *   PUT    /v1/integrations/quickbooks                { syncFrom?, taxCodes? }
 *   GET    /v1/integrations/quickbooks/tax-codes      the company's tax codes, to map to GST rates
 *   POST   /v1/integrations/quickbooks/retry          send failed documents again
 *   DELETE /v1/integrations/quickbooks                disconnect
 */

import type { FastifyInstance } from 'fastify';
import { assertFeature } from '../billing/billing.ts';
import { audit } from '../db/audit.ts';
import { beginConnect, disconnect, finishConnect, IntegrationError, type QuickBooksConfig, taxCodes } from '../integrations/quickbooks.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, type ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { date } from './schemas.ts';

export function registerIntegrationRoutes(app: FastifyInstance, deps: PipelineDeps, config: QuickBooksConfig | undefined) {
  const { db } = deps;
  const ctx = () => {
    if (!config) throw new ApiError(503, 'not_configured', 'QuickBooks is not set up on this server yet');
    return { db, keys: deps.keys, config };
  };

  app.get('/integrations', async (request) => {
    requirePermission(request, 'business.manage');
    const c = (await db.query<{ status: string; account_name: string | null; sync_from: string; settings: { taxCodes?: Record<string, string> }; created_at: Date }>(
      "select status, account_name, sync_from::text as sync_from, settings, created_at from integration_connections where tenant_id = $1 and provider = 'quickbooks'", [request.tenantId],
    )).rows[0];
    const counts = (await db.query<{ status: string; n: number }>("select status, count(*)::int as n from integration_syncs where tenant_id = $1 and provider = 'quickbooks' group by status", [request.tenantId])).rows;
    const recent = (await db.query<{ document_id: string; status: string; remote_type: string | null; remote_id: string | null; error: string | null; synced_at: Date | null; voided_at: Date | null; etd_type: string; series_number: number; serial: string; attempts: number }>(
      `select s.document_id, s.status, s.remote_type, s.remote_id, s.error, s.synced_at, s.voided_at, s.attempts, d.etd_type, d.series_number, d.serial::text as serial
       from integration_syncs s join documents d on d.id = s.document_id
       where s.tenant_id = $1 and s.provider = 'quickbooks' order by s.created_at desc limit 25`, [request.tenantId],
    )).rows;
    return {
      quickbooks: {
        available: Boolean(config),
        environment: config?.environment ?? null,
        connected: Boolean(c),
        status: c?.status ?? null,
        company: c?.account_name ?? null,
        syncFrom: c?.sync_from ?? null,
        taxCodes: c?.settings.taxCodes ?? {},
        counts: Object.fromEntries(counts.map((x) => [x.status, x.n])),
        recent: recent.map((r) => ({
          documentId: r.document_id,
          number: `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}`,
          type: r.etd_type,
          status: r.status,
          remote: r.remote_type ? `${r.remote_type} ${r.remote_id}` : null,
          error: r.error,
          attempts: r.attempts,
          syncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : null,
          voided: Boolean(r.voided_at),
        })),
      },
    };
  });

  app.post('/integrations/quickbooks/connect', async (request) => {
    requirePermission(request, 'business.manage');
    if (request.principal === 'api') throw new ApiError(403, 'forbidden', 'Connect QuickBooks from the web app');
    await assertFeature(db, request.tenantId, 'integrations');
    return { url: await beginConnect(db, ctx().config, request.tenantId, request.userId || null) };
  });

  app.put<{ Body: { syncFrom?: string; taxCodes?: { S?: string | null; Z?: string | null; E?: string | null } } }>(
    '/integrations/quickbooks',
    {
      schema: {
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            syncFrom: date,
            taxCodes: { type: 'object', additionalProperties: false, properties: { S: { type: ['string', 'null'], maxLength: 50 }, Z: { type: ['string', 'null'], maxLength: 50 }, E: { type: ['string', 'null'], maxLength: 50 } } },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const c = (await db.query<{ settings: Record<string, unknown> }>("select settings from integration_connections where tenant_id = $1 and provider = 'quickbooks'", [request.tenantId])).rows[0];
      if (!c) throw new ApiError(409, 'not_connected', 'Connect QuickBooks first');
      const codes = request.body.taxCodes ? Object.fromEntries(Object.entries(request.body.taxCodes).filter(([, v]) => v)) : undefined;
      await db.query(
        "update integration_connections set settings = $2, sync_from = coalesce($3::date, sync_from), updated_at = now() where tenant_id = $1 and provider = 'quickbooks'",
        [request.tenantId, JSON.stringify({ ...c.settings, ...(codes && { taxCodes: codes }) }), request.body.syncFrom ?? null],
      );
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'integration.updated', target: 'QuickBooks', details: request.body, ip: request.ip });
      return { ok: true };
    },
  );

  app.get('/integrations/quickbooks/tax-codes', async (request) => {
    requirePermission(request, 'business.manage');
    try {
      return { data: await taxCodes(ctx(), request.tenantId) };
    } catch (e) {
      if (e instanceof IntegrationError) throw new ApiError(409, 'integration', e.message);
      throw e;
    }
  });

  app.post('/integrations/quickbooks/retry', async (request) => {
    requirePermission(request, 'business.manage');
    const r = await db.query("update integration_syncs set status = 'pending', attempts = 0, next_attempt_at = now() where tenant_id = $1 and provider = 'quickbooks' and status = 'failed' returning document_id", [request.tenantId]);
    return { retrying: r.rows.length };
  });

  app.delete('/integrations/quickbooks', async (request, reply) => {
    requirePermission(request, 'business.manage');
    if (config) await disconnect(db, deps.keys, config, request.tenantId);
    else await db.query("delete from integration_connections where tenant_id = $1 and provider = 'quickbooks'", [request.tenantId]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'integration.disconnected', target: 'QuickBooks', ip: request.ip });
    return reply.code(204).send();
  });
}

/** Intuit sends the person back here after they allow the connection. */
export function registerIntegrationCallback(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, config: QuickBooksConfig | undefined) {
  app.get<{ Querystring: { code?: string; state?: string; realmId?: string; error?: string } }>('/v1/integrations/quickbooks/callback', async (request, reply) => {
    const q = request.query;
    const back = async (tenantId: string | null, result: string) => {
      const slug = tenantId ? (await deps.db.query<{ slug: string }>('select slug from tenants where id = $1', [tenantId])).rows[0]?.slug : null;
      const path = slug ? `/${slug}/settings?tab=integrations&quickbooks=${result}` : `/?quickbooks=${result}`;
      return reply.redirect(ctx.publicUrl ? publicLink(ctx, path) : path, 302);
    };
    if (!config || !q.code || !q.state || !q.realmId) return back(null, q.error === 'access_denied' ? 'cancelled' : 'failed');
    try {
      const { tenantId } = await finishConnect(deps.db, deps.keys, config, { code: q.code, state: q.state, realmId: q.realmId });
      await audit(deps.db, { tenantId, action: 'integration.connected', target: 'QuickBooks', ip: request.ip });
      return back(tenantId, 'connected');
    } catch (e) {
      request.log.warn({ err: e }, 'QuickBooks connection failed');
      return back(null, 'failed');
    }
  });
}
