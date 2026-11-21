/** Account, customers and items. All queries are scoped to request.tenantId. */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { addCertificate } from '../db/tenants.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { BELIZE_DISTRICTS, type Customer, type DistrictCode } from '../engine/ubl.ts';
import { certificateSummary } from './admin.ts';
import { ApiError, notFound } from './errors.ts';
import { certificateSchema, customerSchema, itemSchema, listQuery, uuid } from './schemas.ts';

// ---------- pagination ----------

export interface Page {
  limit: number;
  after?: { createdAt: string; id: string };
}

export function parsePage(query: { limit?: string; cursor?: string }): Page {
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
  if (!query.cursor) return { limit };
  try {
    const [createdAt, id] = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) throw new Error();
    return { limit, after: { createdAt, id } };
  } catch {
    throw new ApiError(400, 'invalid_request', 'Invalid cursor');
  }
}

export function nextCursor<T extends { created_at: string | Date; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

// ---------- customers ----------

interface CustomerRow {
  id: string;
  name: string;
  tin: string | null;
  other_id_scheme: string | null;
  other_id_value: string | null;
  street: string | null;
  city: string | null;
  district_code: DistrictCode | null;
  telephone: string | null;
  email: string | null;
  created_at: string | Date;
}

export interface CustomerBody {
  name: string;
  tin?: string;
  otherId?: { scheme: string; value: string };
  address?: { street: string; additionalStreet?: string; city: string; districtCode: DistrictCode };
  contact?: { telephone?: string; email?: string };
}

const customerJson = (r: CustomerRow) => ({
  id: r.id,
  name: r.name,
  tin: r.tin,
  otherId: r.other_id_scheme && r.other_id_value ? { scheme: r.other_id_scheme, value: r.other_id_value } : null,
  address: r.street && r.city && r.district_code ? { street: r.street, city: r.city, districtCode: r.district_code } : null,
  contact: { telephone: r.telephone, email: r.email },
  createdAt: new Date(r.created_at).toISOString(),
});

/** A stored customer as the engine's Customer (what goes on the document). */
export function customerFromRow(r: CustomerRow): Customer {
  return {
    name: r.name,
    ...(r.tin && { tin: r.tin }),
    ...(r.other_id_scheme && r.other_id_value && { otherId: { scheme: r.other_id_scheme, value: r.other_id_value } }),
    ...(r.street && r.city && r.district_code && {
      address: { street: r.street, city: r.city, districtName: BELIZE_DISTRICTS[r.district_code], districtCode: r.district_code },
    }),
    ...((r.telephone || r.email) && { contact: { ...(r.telephone && { telephone: r.telephone }), ...(r.email && { email: r.email }) } }),
  };
}

export async function loadCustomer(deps: PipelineDeps, tenantId: string, id: string): Promise<CustomerRow> {
  const row = (await deps.db.query<CustomerRow>('select * from customers where id = $1 and tenant_id = $2', [id, tenantId])).rows[0];
  if (!row) throw notFound('Customer');
  return row;
}

// ---------- items ----------

interface ItemRow {
  id: string;
  name: string;
  description: string;
  seller_code: string | null;
  unit_code: string;
  unit_price: string;
  gst_category: 'S' | 'Z' | 'E';
  exemption_reason_code: string | null;
  created_at: string | Date;
}

/** numeric(24,6) comes back as "24.990000"; trim to at least two decimals. */
const trimDecimal = (v: string) => String(v).replace(/(\.\d{2}\d*?)0+$/, '$1');

const itemJson = (r: ItemRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  sellerCode: r.seller_code,
  unitCode: r.unit_code,
  unitPrice: trimDecimal(r.unit_price),
  gstCategory: r.gst_category,
  exemptionReasonCode: r.exemption_reason_code,
  createdAt: new Date(r.created_at).toISOString(),
});

export async function loadItems(deps: PipelineDeps, tenantId: string, ids: string[]): Promise<Map<string, ReturnType<typeof itemJson>>> {
  if (ids.length === 0) return new Map();
  const rows = (await deps.db.query<ItemRow>('select * from items where tenant_id = $1 and id = any($2::uuid[])', [tenantId, ids])).rows;
  return new Map(rows.map((r) => [r.id, itemJson(r)]));
}

// ---------- routes ----------

export function registerCatalogRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.get('/me', async (request) => {
    const t = (await db.query<{ id: string; legal_name: string; trade_name: string | null; tin: string; environment: string }>(
      'select id, legal_name, trade_name, tin, environment from tenants where id = $1', [request.tenantId],
    )).rows[0]!;
    const period = (await db.query<{ started_at: string | Date; reason: string }>(
      'select started_at, reason from contingency_periods where tenant_id = $1 and ended_at is null', [request.tenantId],
    )).rows[0];
    const queued = (await db.query<{ n: number }>(
      `select count(*)::int as n from documents where tenant_id = $1 and status = 'contingency_pending'`, [request.tenantId],
    )).rows[0]!.n;
    return {
      id: t.id,
      legalName: t.legal_name,
      tradeName: t.trade_name,
      tin: t.tin,
      environment: t.environment,
      certificate: await certificateSummary(deps, request.tenantId),
      contingency: { active: Boolean(period), since: period ? new Date(period.started_at).toISOString() : null, reason: period?.reason ?? null, queued },
    };
  });

  // A business can renew its own certificate.
  app.put<{ Body: { certificatePem: string; privateKeyPem: string; passphrase?: string } }>('/certificate', { schema: { body: certificateSchema } }, async (request) => {
    const id = await addCertificate(db, deps.keys, request.tenantId, request.body);
    return certificateSummary(deps, request.tenantId, id);
  });

  app.post<{ Body: CustomerBody }>('/customers', { schema: { body: { ...customerSchema, required: ['name'] } } }, async (request, reply) => {
    const b = request.body;
    const id = randomUUID();
    await db.query(
      `insert into customers (id, tenant_id, name, tin, other_id_scheme, other_id_value, street, city, district_code, telephone, email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, request.tenantId, b.name, b.tin ?? null, b.otherId?.scheme ?? null, b.otherId?.value ?? null, b.address?.street ?? null,
        b.address?.city ?? null, b.address?.districtCode ?? null, b.contact?.telephone ?? null, b.contact?.email ?? null],
    );
    return reply.code(201).send(customerJson(await loadCustomer(deps, request.tenantId, id)));
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>(
    '/customers',
    { schema: { querystring: listQuery({ q: { type: 'string', maxLength: 100 } }) } },
    async (request) => {
      const page = parsePage(request.query);
      const params: unknown[] = [request.tenantId];
      let where = 'tenant_id = $1';
      if (request.query.q) {
        params.push(`%${request.query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where += ` and (name ilike $${params.length} or tin like $${params.length})`;
      }
      if (page.after) {
        params.push(page.after.createdAt, page.after.id);
        where += ` and (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(page.limit + 1);
      const rows = (await db.query<CustomerRow>(`select * from customers where ${where} order by created_at desc, id desc limit $${params.length}`, params)).rows;
      const { items, nextCursor: next } = nextCursor(rows, page.limit);
      return { data: items.map(customerJson), nextCursor: next };
    },
  );

  app.get<{ Params: { id: string } }>('/customers/:id', { schema: { params: { type: 'object', properties: { id: uuid } } } }, async (request) =>
    customerJson(await loadCustomer(deps, request.tenantId, request.params.id)),
  );

  app.post<{ Body: { name: string; description?: string; sellerCode?: string; unitCode: string; unitPrice: string; gstCategory: 'S' | 'Z' | 'E'; exemptionReasonCode?: string } }>(
    '/items',
    { schema: { body: itemSchema } },
    async (request, reply) => {
      const b = request.body;
      if (b.gstCategory === 'E' && !b.exemptionReasonCode) throw new ApiError(422, 'invalid_document', 'An exempt item needs an exemptionReasonCode');
      const id = randomUUID();
      await db.query(
        `insert into items (id, tenant_id, name, description, seller_code, unit_code, unit_price, gst_category, exemption_reason_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, request.tenantId, b.name, b.description ?? b.name, b.sellerCode ?? null, b.unitCode, b.unitPrice, b.gstCategory, b.exemptionReasonCode ?? null],
      );
      return reply.code(201).send((await loadItems(deps, request.tenantId, [id])).get(id));
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/items', { schema: { querystring: listQuery() } }, async (request) => {
    const page = parsePage(request.query);
    const params: unknown[] = [request.tenantId];
    let where = 'tenant_id = $1';
    if (page.after) {
      params.push(page.after.createdAt, page.after.id);
      where += ` and (created_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    params.push(page.limit + 1);
    const rows = (await db.query<ItemRow>(`select * from items where ${where} order by created_at desc, id desc limit $${params.length}`, params)).rows;
    const { items, nextCursor: next } = nextCursor(rows, page.limit);
    return { data: items.map(itemJson), nextCursor: next };
  });

  app.get<{ Params: { id: string } }>('/items/:id', { schema: { params: { type: 'object', properties: { id: uuid } } } }, async (request) => {
    const item = (await loadItems(deps, request.tenantId, [request.params.id])).get(request.params.id);
    if (!item) throw notFound('Item');
    return item;
  });
}
