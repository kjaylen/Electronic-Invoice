/**
 * Connectors, for businesses that keep their own QuickBooks (Desktop or Point
 * of Sale) and use this service to send its documents to BTS.
 *
 *   GET    /v1/connectors                       the business's connections, what each picked up, tax codes seen
 *   POST   /v1/connectors                       { kind: qbd|qbpos, name, syncFrom } → the connection and its password (shown once)
 *   GET    /v1/connectors/:id/qwc               the .qwc file to open in the Web Connector
 *   POST   /v1/connectors/:id/password          a new password (the old one stops working)
 *   PUT    /v1/connectors/:id                   { name?, paused?, taxCodes?, exemptions?, pull?, issueOnTaxMismatch? }
 *   DELETE /v1/connectors/:id                   disconnect (what was issued stays)
 *   GET    /v1/connectors/todo                  { attention }: picked-up documents held or rejected (for the dashboard)
 *   GET    /v1/connectors/imports               ?linkId&status&before: what was picked up, newest first
 *   POST   /v1/connectors/imports/:id/retry     { force? }: send it again (after fixing the cause; force accepts a tax difference)
 *   POST   /v1/connectors/imports/:id/skip      not to be sent
 *
 *   POST   /v1/qbwc                             the Web Connector's SOAP service (src/connectors/qbwc.ts)
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { hashPassword } from '../db/users.ts';
import { assertFeature } from '../billing/billing.ts';
import { connectorTodo } from '../connectors/imports.ts';
import { handleQbwc, LINK_SELECT, qwcFile } from '../connectors/qbwc.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, type ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { date as dateSchema, uuid } from './schemas.ts';

const KIND_NAMES = { qbd: 'QuickBooks Desktop', qbpos: 'QuickBooks Point of Sale' } as const;

interface LinkRow {
  id: string;
  kind: 'qbd' | 'qbpos';
  name: string;
  username: string;
  owner_id: string;
  file_id: string;
  status: 'active' | 'paused';
  settings: { taxCodes?: Record<string, string>; exemptions?: Record<string, string>; pull?: { invoices?: boolean; salesReceipts?: boolean }; issueOnTaxMismatch?: boolean };
  sync_from: string;
  company_name: string | null;
  last_seen_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

/** A connection's user name: the business and the kind, and a few random letters. */
const makeUsername = (slug: string, kind: string) => `${slug}-${kind}-${randomBytes(3).toString('hex')}`.toLowerCase();
const makePassword = () => randomBytes(15).toString('base64url');

async function loadLink(db: Queryable, tenantId: string, id: string): Promise<LinkRow> {
  const r = (await db.query<LinkRow>(`${LINK_SELECT} where id = $1 and tenant_id = $2 and removed_at is null`, [id, tenantId])).rows[0];
  if (!r) throw notFound('Connection');
  return r;
}

export function registerConnectorRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

  app.get('/connectors', async (request) => {
    requirePermission(request, 'business.manage');
    const links = (await db.query<LinkRow>(`${LINK_SELECT} where tenant_id = $1 and removed_at is null order by created_at`, [request.tenantId])).rows;
    const counts = (await db.query<{ link_id: string; status: string; n: number }>(
      'select link_id, status, count(*)::int as n from connector_imports where tenant_id = $1 group by link_id, status', [request.tenantId],
    )).rows;
    // Tax codes seen on picked-up documents, to map to GST.
    const codes = (await db.query<{ link_id: string; code: string }>(
      `select distinct i.link_id, coalesce(l->>'taxCode', '') as code from connector_imports i, jsonb_array_elements(i.payload->'lines') l
       where i.tenant_id = $1 and l ? 'taxCode' and l->>'taxCode' is not null`, [request.tenantId],
    )).rows;
    return {
      data: links.map((l) => ({
        id: l.id,
        kind: l.kind,
        kindName: KIND_NAMES[l.kind],
        name: l.name,
        username: l.username,
        paused: l.status === 'paused',
        syncFrom: l.sync_from,
        company: l.company_name,
        lastSeenAt: iso(l.last_seen_at),
        lastError: l.last_error,
        settings: { taxCodes: l.settings.taxCodes ?? {}, exemptions: l.settings.exemptions ?? {}, pull: { invoices: l.settings.pull?.invoices !== false, salesReceipts: l.settings.pull?.salesReceipts !== false }, issueOnTaxMismatch: Boolean(l.settings.issueOnTaxMismatch) },
        taxCodesSeen: codes.filter((c) => c.link_id === l.id && c.code).map((c) => c.code).sort(),
        counts: Object.fromEntries(counts.filter((c) => c.link_id === l.id).map((c) => [c.status, c.n])),
        createdAt: iso(l.created_at),
      })),
    };
  });

  app.post<{ Body: { kind: 'qbd' | 'qbpos'; name?: string; syncFrom?: string } }>(
    '/connectors',
    { schema: { body: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['qbd', 'qbpos'] }, name: { type: 'string', minLength: 1, maxLength: 100 }, syncFrom: dateSchema } } } },
    async (request, reply) => {
      requirePermission(request, 'business.manage');
      await assertFeature(db, request.tenantId, 'integrations');
      const b = request.body;
      const slug = (await db.query<{ slug: string }>('select slug from tenants where id = $1', [request.tenantId])).rows[0]!.slug;
      const password = makePassword();
      const id = randomUUID();
      const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
      await db.query(
        `insert into connector_links (id, tenant_id, kind, name, username, password_hash, owner_id, file_id, sync_from, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, request.tenantId, b.kind, (b.name ?? KIND_NAMES[b.kind]).trim(), makeUsername(slug.slice(0, 30), b.kind), await hashPassword(password), randomUUID(), randomUUID(), b.syncFrom ?? today, request.userId || null],
      );
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.added', target: KIND_NAMES[b.kind], ip: request.ip });
      const link = await loadLink(db, request.tenantId, id);
      return reply.code(201).send({ id, kind: link.kind, name: link.name, username: link.username, password, syncFrom: link.sync_from });
    },
  );

  app.get<{ Params: { id: string } }>('/connectors/:id/qwc', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    const biz = (await db.query<{ name: string }>('select coalesce(trade_name, legal_name) as name from tenants where id = $1', [request.tenantId])).rows[0]!.name;
    if (!ctx.publicUrl) throw new ApiError(503, 'not_configured', 'This server has no public address for the Web Connector to reach');
    const file = qwcFile(link, publicLink(ctx, '/v1/qbwc'), biz);
    return reply.type('application/xml').header('Content-Disposition', `attachment; filename="einvoicing-${link.kind}.qwc"`).send(file);
  });

  app.post<{ Params: { id: string } }>('/connectors/:id/password', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    const password = makePassword();
    await db.query('update connector_links set password_hash = $2 where id = $1', [link.id, await hashPassword(password)]);
    await db.query('delete from connector_sessions where link_id = $1', [link.id]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.password_reset', target: link.name, ip: request.ip });
    return { username: link.username, password };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; paused?: boolean; taxCodes?: Record<string, 'S' | 'Z' | 'E'>; exemptions?: Record<string, string>; pull?: { invoices?: boolean; salesReceipts?: boolean }; issueOnTaxMismatch?: boolean } }>(
    '/connectors/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            paused: { type: 'boolean' },
            taxCodes: { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', enum: ['S', 'Z', 'E'] } },
            exemptions: { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', maxLength: 10 } },
            pull: { type: 'object', additionalProperties: false, properties: { invoices: { type: 'boolean' }, salesReceipts: { type: 'boolean' } } },
            issueOnTaxMismatch: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const link = await loadLink(db, request.tenantId, request.params.id);
      const b = request.body;
      const settings = {
        ...link.settings,
        ...(b.taxCodes && { taxCodes: b.taxCodes }),
        ...(b.exemptions && { exemptions: b.exemptions }),
        ...(b.pull && { pull: { ...link.settings.pull, ...b.pull } }),
        ...(b.issueOnTaxMismatch !== undefined && { issueOnTaxMismatch: b.issueOnTaxMismatch }),
      };
      await db.query('update connector_links set name = $2, status = $3, settings = $4 where id = $1', [
        link.id, b.name?.trim() ?? link.name, b.paused === undefined ? link.status : b.paused ? 'paused' : 'active', JSON.stringify(settings),
      ]);
      // Held only for an unmapped tax code: a new mapping lets them through.
      if (b.taxCodes) {
        await db.query("update connector_imports set status = 'new', problem = null, updated_at = now() where link_id = $1 and status = 'attention' and problem like 'Map these %'", [link.id]);
      }
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.updated', target: link.name, ip: request.ip });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/connectors/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    await db.query('update connector_links set removed_at = now() where id = $1', [link.id]);
    await db.query('delete from connector_sessions where link_id = $1', [link.id]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.removed', target: link.name, ip: request.ip });
    return reply.code(204).send();
  });

  app.get('/connectors/todo', async (request) => {
    requirePermission(request, 'business.manage');
    return { attention: await connectorTodo(db, request.tenantId) };
  });

  app.get<{ Querystring: { linkId?: string; status?: string; before?: string } }>(
    '/connectors/imports',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { linkId: uuid, status: { type: 'string', enum: ['attention', 'issued', 'rejected', 'skipped', 'waiting', 'all'] }, before: { type: 'string', maxLength: 40 } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const q = request.query;
      const params: unknown[] = [request.tenantId];
      let where = 'i.tenant_id = $1';
      if (q.linkId) {
        params.push(q.linkId);
        where += ` and i.link_id = $${params.length}`;
      }
      const status = q.status ?? 'all';
      if (status === 'waiting') where += " and i.status in ('staged', 'new', 'issuing')";
      else if (status !== 'all') {
        params.push(status);
        where += ` and i.status = $${params.length}`;
      }
      if (q.before) {
        params.push(q.before);
        where += ` and i.created_at < $${params.length}::timestamptz`;
      }
      const rows = (await db.query<{ id: string; link_id: string; source_type: string; source_ref: string | null; source_date: string | null; customer_name: string | null; total_cents: string | number | null; status: string; problem: string | null; writeback: string; writeback_error: string | null; document_id: string | null; created_at: Date; series_number: number | null; serial: string | null; doc_status: string | null; kind: string }>(
        `select i.id, i.link_id, i.source_type, i.source_ref, i.source_date::text as source_date, i.customer_name, i.total_cents, i.status, i.problem, i.writeback, i.writeback_error,
           i.document_id, i.created_at, d.series_number, d.serial::text as serial, d.status as doc_status, l.kind
         from connector_imports i join connector_links l on l.id = i.link_id left join documents d on d.id = i.document_id
         where ${where} order by i.created_at desc limit 51`,
        params,
      )).rows;
      return {
        data: rows.slice(0, 50).map((r) => ({
          id: r.id,
          linkId: r.link_id,
          source: { type: r.source_type, ref: r.source_ref, date: r.source_date, customer: r.customer_name, total: r.total_cents === null ? null : (Number(r.total_cents) / 100).toFixed(2) },
          status: r.status === 'staged' || r.status === 'issuing' ? 'new' : r.status,
          problem: r.problem,
          writeback: r.writeback,
          writebackError: r.writeback_error,
          document: r.document_id ? { id: r.document_id, number: r.serial !== null ? `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}` : null, status: r.doc_status } : null,
          createdAt: iso(r.created_at),
        })),
        nextBefore: rows.length > 50 ? iso(rows[49]!.created_at) : null,
      };
    },
  );

  const importOf = async (tenantId: string, id: string) => {
    const r = (await db.query<{ id: string; status: string }>('select id, status from connector_imports where id = $1 and tenant_id = $2', [id, tenantId])).rows[0];
    if (!r) throw notFound('Document');
    return r;
  };

  app.post<{ Params: { id: string }; Body: { force?: boolean } }>(
    '/connectors/imports/:id/retry',
    { schema: { params: idParams, body: { type: ['object', 'null'], additionalProperties: false, properties: { force: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const imp = await importOf(request.tenantId, request.params.id);
      if (!['attention', 'rejected', 'skipped'].includes(imp.status)) throw new ApiError(409, 'not_held', 'Only held, rejected or skipped documents are sent again');
      await db.query("update connector_imports set status = 'new', problem = null, force = $2, document_id = null, writeback = 'none', attempts = 0, updated_at = now() where id = $1", [imp.id, Boolean(request.body?.force)]);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/connectors/imports/:id/skip', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const imp = await importOf(request.tenantId, request.params.id);
    if (!['attention', 'rejected', 'new'].includes(imp.status)) throw new ApiError(409, 'not_held', 'Only documents not yet sent can be skipped');
    await db.query("update connector_imports set status = 'skipped', updated_at = now() where id = $1", [imp.id]);
    return { ok: true };
  });
}

/** The Web Connector's SOAP endpoint: public (it signs in with the connection's password), XML in and out. */
export function registerQbwcRoutes(app: FastifyInstance, deps: PipelineDeps) {
  app.addContentTypeParser(['text/xml', 'application/xml', 'application/soap+xml'], { parseAs: 'string', bodyLimit: 20 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  app.post('/', async (request, reply) => {
    const xml = typeof request.body === 'string' ? request.body : '';
    return reply.type('text/xml; charset=utf-8').send(await handleQbwc(deps.db, xml));
  });
  // A browser opening the address sees what it is.
  app.get('/', async (_request, reply) => reply.type('text/plain').send('eInvoicing: QuickBooks Web Connector service. Add it to the Web Connector with the .qwc file from Settings → Integrations.'));
}
