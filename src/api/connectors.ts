/**
 * Connectors, for businesses that keep their own QuickBooks (Desktop or Point
 * of Sale) or NetSuite and use this service to send its documents to BTS.
 *
 *   GET    /v1/connectors                       the business's connections, what each picked up, tax codes seen
 *   POST   /v1/connectors                       { kind: qbd|qbpos|netsuite, name, syncFrom } → the connection and its password (QuickBooks, shown once) or certificate (NetSuite)
 *   GET    /v1/connectors/:id/qwc               the .qwc file to open in the Web Connector (QuickBooks)
 *   POST   /v1/connectors/:id/password          a new password (the old one stops working) (QuickBooks)
 *   GET    /v1/connectors/:id/certificate       the certificate to upload to NetSuite
 *   POST   /v1/connectors/:id/sync              read NetSuite now
 *   PUT    /v1/connectors/:id                   { name?, paused?, taxCodes?, exemptions?, pull?, issueOnTaxMismatch?, netsuite? } (NetSuite details are tested when saved)
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
import { ACCOUNT_ID, DEFAULT_NUMBER_FIELD, FIELD_ID, makeKeyAndCertificate, type NetSuiteConfig, newNotifyToken, notifyScript, notifyTokenMatches, secretContext, testNetSuite } from '../connectors/netsuite.ts';
import { overLimit } from '../db/ratelimit.ts';
import { type ConnectorLink, handleQbwc, LINK_SELECT, qwcFile } from '../connectors/qbwc.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, type ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { date as dateSchema, uuid } from './schemas.ts';

const KIND_NAMES = { qbd: 'QuickBooks Desktop', qbpos: 'QuickBooks Point of Sale', netsuite: 'NetSuite' } as const;

interface LinkRow extends ConnectorLink {
  owner_id: string | null;
  file_id: string | null;
  company_name: string | null;
  last_seen_at: Date | null;
  last_error: string | null;
  next_poll_at: Date | null;
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

export function registerConnectorRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, options: { netsuiteFetch?: typeof fetch } = {}) {
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
        settings: { taxCodes: l.settings.taxCodes ?? {}, exemptions: l.settings.exemptions ?? {}, pull: { invoices: l.settings.pull?.invoices !== false, salesReceipts: l.settings.pull?.salesReceipts !== false, creditMemos: l.settings.pull?.creditMemos !== false }, issueOnTaxMismatch: Boolean(l.settings.issueOnTaxMismatch) },
        netsuite: l.kind === 'netsuite'
          ? { accountId: l.config.accountId ?? null, clientId: l.config.clientId ?? null, certificateId: l.config.certificateId ?? null, numberField: l.config.numberField || DEFAULT_NUMBER_FIELD, statusField: l.config.statusField ?? null, qrField: l.config.qrField ?? null, instant: Boolean(l.config.notifyTokenHash), configured: Boolean(l.config.certificateId), certificateExpiresAt: iso(l.certificate_expires_at), nextCheckAt: iso(l.next_poll_at) }
          : null,
        taxCodesSeen: codes.filter((c) => c.link_id === l.id && c.code).map((c) => c.code).sort(),
        counts: Object.fromEntries(counts.filter((c) => c.link_id === l.id).map((c) => [c.status, c.n])),
        createdAt: iso(l.created_at),
      })),
    };
  });

  app.post<{ Body: { kind: 'qbd' | 'qbpos' | 'netsuite'; name?: string; syncFrom?: string } }>(
    '/connectors',
    { schema: { body: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['qbd', 'qbpos', 'netsuite'] }, name: { type: 'string', minLength: 1, maxLength: 100 }, syncFrom: dateSchema } } } },
    async (request, reply) => {
      requirePermission(request, 'business.manage');
      await assertFeature(db, request.tenantId, 'integrations');
      const b = request.body;
      const slug = (await db.query<{ slug: string }>('select slug from tenants where id = $1', [request.tenantId])).rows[0]!.slug;
      const id = randomUUID();
      const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
      if (b.kind === 'netsuite') {
        // A key of its own, and the certificate the business uploads to NetSuite.
        const made = makeKeyAndCertificate(`Floreo ${slug}`);
        const secret = await deps.keys.encrypt(Buffer.from(made.privateKeyPem), secretContext({ tenant_id: request.tenantId, id }));
        await db.query(
          `insert into connector_links (id, tenant_id, kind, name, sync_from, created_by, secret_encrypted, certificate_pem, certificate_expires_at, settings)
           values ($1, $2, 'netsuite', $3, $4, $5, $6, $7, $8, $9)`,
          [id, request.tenantId, (b.name ?? KIND_NAMES.netsuite).trim(), b.syncFrom ?? today, request.userId || null, secret, made.certificatePem, made.expiresAt.toISOString(), JSON.stringify({ issueOnTaxMismatch: false })],
        );
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.added', target: KIND_NAMES.netsuite, ip: request.ip });
        return reply.code(201).send({ id, kind: 'netsuite', name: (b.name ?? KIND_NAMES.netsuite).trim(), certificate: made.certificatePem, syncFrom: b.syncFrom ?? today });
      }
      const password = makePassword();
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
    if (link.kind === 'netsuite' || !link.username || !link.owner_id || !link.file_id) throw new ApiError(409, 'not_web_connector', 'NetSuite is read from here: it has no .qwc file');
    const biz = (await db.query<{ name: string }>('select coalesce(trade_name, legal_name) as name from tenants where id = $1', [request.tenantId])).rows[0]!.name;
    if (!ctx.publicUrl) throw new ApiError(503, 'not_configured', 'This server has no public address for the Web Connector to reach');
    const file = qwcFile({ name: link.name, username: link.username, owner_id: link.owner_id, file_id: link.file_id, kind: link.kind }, publicLink(ctx, '/v1/qbwc'), biz);
    return reply.type('application/xml').header('Content-Disposition', `attachment; filename="floreo-${link.kind}.qwc"`).send(file);
  });

  app.post<{ Params: { id: string } }>('/connectors/:id/password', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    if (link.kind === 'netsuite') throw new ApiError(409, 'not_web_connector', 'NetSuite signs in with its certificate, not a password');
    const password = makePassword();
    await db.query('update connector_links set password_hash = $2 where id = $1', [link.id, await hashPassword(password)]);
    await db.query('delete from connector_sessions where link_id = $1', [link.id]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.password_reset', target: link.name, ip: request.ip });
    return { username: link.username, password };
  });

  app.get<{ Params: { id: string } }>('/connectors/:id/certificate', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    if (link.kind !== 'netsuite' || !link.certificate_pem) throw new ApiError(409, 'no_certificate', 'Only NetSuite connections have a certificate');
    return reply.type('application/x-pem-file').header('Content-Disposition', 'attachment; filename="floreo-netsuite.pem"').send(link.certificate_pem);
  });

  // The script NetSuite runs when a sale is saved (see notifyScript). Each download makes a new token: the last script stops working.
  app.post<{ Params: { id: string } }>('/connectors/:id/notify-script', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    if (link.kind !== 'netsuite') throw new ApiError(409, 'not_netsuite', 'Only NetSuite connections have a script');
    const url = publicLink(ctx, `/v1/netsuite/notify/${link.id}`);
    if (!url.startsWith('https://')) throw new ApiError(503, 'not_configured', 'NetSuite only calls addresses that start with https://. Set PUBLIC_URL to this server\'s public https address.');
    const { token, hash } = newNotifyToken();
    await db.query(`update connector_links set config = config || jsonb_build_object('notifyTokenHash', $2::text) where id = $1`, [link.id, hash]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.notify_script', target: link.name, ip: request.ip });
    return { filename: 'floreo_notify.js', url, script: notifyScript(url, token) };
  });

  app.post<{ Params: { id: string } }>('/connectors/:id/sync', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const link = await loadLink(db, request.tenantId, request.params.id);
    if (link.kind !== 'netsuite') throw new ApiError(409, 'not_netsuite', 'QuickBooks sends its documents when the Web Connector runs');
    if (!link.config.certificateId) throw new ApiError(409, 'not_configured', 'Enter the NetSuite details first');
    await db.query('update connector_links set next_poll_at = now() where id = $1', [link.id]);
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; paused?: boolean; taxCodes?: Record<string, 'S' | 'Z' | 'E'>; exemptions?: Record<string, string>; pull?: { invoices?: boolean; salesReceipts?: boolean; creditMemos?: boolean }; issueOnTaxMismatch?: boolean; netsuite?: NetSuiteConfig } }>(
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
            pull: { type: 'object', additionalProperties: false, properties: { invoices: { type: 'boolean' }, salesReceipts: { type: 'boolean' }, creditMemos: { type: 'boolean' } } },
            issueOnTaxMismatch: { type: 'boolean' },
            netsuite: {
              type: 'object', additionalProperties: false,
              properties: {
                accountId: { type: 'string', maxLength: 40 },
                clientId: { type: 'string', maxLength: 100 },
                certificateId: { type: 'string', maxLength: 100 },
                numberField: { type: 'string', maxLength: 60 },
                statusField: { type: 'string', maxLength: 60 },
                qrField: { type: 'string', maxLength: 60 },
              },
            },
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
      let config = link.config;
      if (b.netsuite) {
        if (link.kind !== 'netsuite') throw new ApiError(409, 'not_netsuite', 'Only NetSuite connections take NetSuite details');
        const n = b.netsuite;
        const clean = (v: string | undefined) => (v === undefined ? undefined : v.trim());
        config = {
          ...link.config,
          ...(n.accountId !== undefined && { accountId: clean(n.accountId)!.toUpperCase() }),
          ...(n.clientId !== undefined && { clientId: clean(n.clientId) }),
          ...(n.certificateId !== undefined && { certificateId: clean(n.certificateId) }),
          ...(n.numberField !== undefined && { numberField: clean(n.numberField)!.toLowerCase() || DEFAULT_NUMBER_FIELD }),
          ...(n.statusField !== undefined && { statusField: clean(n.statusField)!.toLowerCase() || undefined }),
          ...(n.qrField !== undefined && { qrField: clean(n.qrField)!.toLowerCase() || undefined }),
        };
        if (config.accountId && !ACCOUNT_ID.test(config.accountId)) throw new ApiError(422, 'invalid_account', 'The Account ID looks like 1234567 or 1234567_SB1 (Setup > Company > Company Information)');
        for (const f of [config.numberField, config.statusField, config.qrField]) {
          if (f && !FIELD_ID.test(f)) throw new ApiError(422, 'invalid_field', `"${f}" is not a transaction body field ID: those start with custbody, e.g. custbody_bts_number`);
        }
        if (!config.accountId || !config.clientId || !config.certificateId) throw new ApiError(422, 'incomplete', 'Enter the Account ID, Client ID and Certificate ID');
      }
      await db.query('update connector_links set name = $2, status = $3, settings = $4, config = $5 where id = $1', [
        link.id, b.name?.trim() ?? link.name, b.paused === undefined ? link.status : b.paused ? 'paused' : 'active', JSON.stringify(settings), JSON.stringify(config),
      ]);
      if (b.netsuite) {
        // Tried at once: sign in and read one row, so a mistake shows now, not at the first read.
        const problem = await testNetSuite(deps, { ...link, config }, options.netsuiteFetch);
        await db.query('update connector_links set last_error = $2, next_poll_at = case when $2::text is null then now() else next_poll_at end where id = $1', [link.id, problem]);
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'connector.updated', target: link.name, ip: request.ip });
        if (problem) throw new ApiError(422, 'netsuite_refused', problem);
        return { ok: true };
      }
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

/**
 * Where NetSuite's script says "a sale was saved" (public; it carries the connection's own token).
 * Nothing about the sale is taken from the call: it only brings the next read forward to now.
 */
export function registerNetSuiteNotifyRoutes(app: FastifyInstance, deps: PipelineDeps, options: { onNotify?: () => void } = {}) {
  const { db } = deps;
  app.post<{ Params: { id: string } }>('/notify/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    const token = /^Bearer (\S{20,200})$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? '';
    const link = (await db.query<{ id: string; config: NetSuiteConfig; status: string }>(`select id, config, status from connector_links where id = $1 and kind = 'netsuite' and removed_at is null`, [request.params.id])).rows[0];
    // The same answer whether the connection or the token is wrong.
    if (!link || !notifyTokenMatches(token, link.config.notifyTokenHash)) throw new ApiError(401, 'unauthorized', 'Unknown connection or token: download the script again from Floreo');
    // A burst of saves (an import in NetSuite) is one read, not hundreds.
    if (await overLimit(db, `netsuite-notify|${link.id}`, 120, 60_000)) return reply.code(202).send({ ok: true, queued: true });
    if (link.status === 'active') {
      await db.query('update connector_links set next_poll_at = now() where id = $1', [link.id]);
      options.onNotify?.();
    }
    return reply.code(202).send({ ok: true });
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
  app.get('/', async (_request, reply) => reply.type('text/plain').send('Floreo: QuickBooks Web Connector service. Add it to the Web Connector with the .qwc file from Settings → Integrations.'));
}
