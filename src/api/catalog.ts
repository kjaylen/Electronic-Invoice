/** Account, customers and items. All queries are scoped to request.tenantId. */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApiKey, revokeApiKey } from '../db/apikeys.ts';
import { pfxToPem, PfxError } from '../db/pfx.ts';
import { addCertificate } from '../db/tenants.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { BELIZE_DISTRICTS, type Customer, type DistrictCode } from '../engine/ubl.ts';
import { certificateSummary } from './admin.ts';
import { audit } from '../db/audit.ts';
import { can, requirePermission, requirePersonWith } from './permissions.ts';
import { ApiError, notFound } from './errors.ts';
import { certificateSchema, customerSchema, itemSchema, listQuery, uuid } from './schemas.ts';
import { assertFeature, getSubscription } from '../billing/billing.ts';
import { PLANS } from '../billing/plans.ts';
import type { Queryable } from '../db/database.ts';

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
  archived_at?: string | Date | null;
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
  archived: Boolean(r.archived_at),
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
  barcode: string | null;
  favorite: boolean;
  stock_quantity?: string | null;
  archived_at: string | Date | null;
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
  barcode: r.barcode,
  favorite: r.favorite,
  /** In stock now; null when stock is not tracked. */
  stock: r.stock_quantity === null || r.stock_quantity === undefined ? null : Number(r.stock_quantity),
  archived: Boolean(r.archived_at),
  createdAt: new Date(r.created_at).toISOString(),
});

type ItemBody = { name: string; description?: string; sellerCode?: string; unitCode: string; unitPrice: string; gstCategory: 'S' | 'Z' | 'E'; exemptionReasonCode?: string; barcode?: string; favorite?: boolean };

/** A LIKE pattern matching q anywhere, with LIKE's special characters escaped. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Unique-violation on the barcode index becomes a friendly 409. */
async function withBarcodeCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === '23505' || /items_barcode/.test(String((e as Error).message))) {
      throw new ApiError(409, 'conflict', 'Another item already has this barcode');
    }
    throw e;
  }
}

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
      billing: await billingBanner(db, request.tenantId),
      contingency: { active: Boolean(period), since: period ? new Date(period.started_at).toISOString() : null, reason: period?.reason ?? null, queued },
    };
  });

  // A business can install or renew its own certificate (owners only).
  app.put<{ Body: { certificatePem: string; privateKeyPem: string; passphrase?: string } }>('/certificate', { schema: { body: certificateSchema } }, async (request) => {
    requirePermission(request, 'business.manage');
    const id = await addCertificate(db, deps.keys, request.tenantId, request.body);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'certificate.installed', ip: request.ip });
    return certificateSummary(deps, request.tenantId, id);
  });

  // The same from a .pfx / .p12 file, the format certificate portals usually hand out.
  app.post<{ Body: { pfxBase64: string; password: string } }>(
    '/certificate/pfx',
    { schema: { body: { type: 'object', required: ['pfxBase64', 'password'], additionalProperties: false, properties: { pfxBase64: { type: 'string', minLength: 100, maxLength: 200_000 }, password: { type: 'string', maxLength: 500 } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      let pem;
      try {
        pem = pfxToPem(Buffer.from(request.body.pfxBase64, 'base64'), request.body.password);
      } catch (e) {
        if (e instanceof PfxError) throw new ApiError(422, 'certificate_problem', e.message);
        throw e;
      }
      const id = await addCertificate(db, deps.keys, request.tenantId, pem);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'certificate.installed', ip: request.ip });
      return certificateSummary(deps, request.tenantId, id);
    },
  );

  // API keys for the business's own software (POS, accounting connectors). Owners and admins, signed in.
  const requireOwnerSession = (request: import('fastify').FastifyRequest) => requirePersonWith(request, 'apikeys.manage');
  app.get('/api-keys', async (request) => {
    requireOwnerSession(request);
    const rows = (await db.query<{ id: string; name: string; prefix: string; created_at: string | Date; last_used_at: string | Date | null; revoked_at: string | Date | null }>(
      'select id, name, prefix, created_at, last_used_at, revoked_at from api_keys where tenant_id = $1 order by created_at desc', [request.tenantId],
    )).rows;
    const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
    return { data: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at) })) };
  });
  app.post<{ Body: { name: string } }>(
    '/api-keys',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } } },
    async (request, reply) => {
      requireOwnerSession(request);
      await assertFeature(db, request.tenantId, 'api');
      const key = await createApiKey(db, request.tenantId, request.body.name);
      await audit(db, { tenantId: request.tenantId, userId: request.userId, action: 'apikey.created', target: request.body.name, ip: request.ip });
      return reply.code(201).send({ id: key.id, name: request.body.name, prefix: key.prefix, key: key.key });
    },
  );
  app.delete<{ Params: { id: string } }>('/api-keys/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requireOwnerSession(request);
    if (!(await revokeApiKey(db, request.tenantId, request.params.id))) throw notFound('API key');
    await audit(db, { tenantId: request.tenantId, userId: request.userId, action: 'apikey.revoked', target: request.params.id, ip: request.ip });
    return reply.code(204).send();
  });

  // Saving a new customer is part of issuing (cashiers do it at the counter); editing and archiving are catalog management.
  app.post<{ Body: CustomerBody }>('/customers', { schema: { body: { ...customerSchema, required: ['name'] } } }, async (request, reply) => {
    if (!can(request.principal, 'catalog.manage')) requirePermission(request, 'documents.issue');
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
      let where = 'tenant_id = $1 and archived_at is null';
      if (request.query.q) {
        params.push(likePattern(request.query.q));
        where += ` and (name ilike $${params.length} or tin like $${params.length} or email ilike $${params.length} or telephone ilike $${params.length})`;
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

  // Edit: replaces all fields. Documents already issued keep the details they were issued with.
  app.put<{ Params: { id: string }; Body: CustomerBody }>(
    '/customers/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { ...customerSchema, required: ['name'] } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      const r = await db.query(
        `update customers set name = $3, tin = $4, other_id_scheme = $5, other_id_value = $6, street = $7, city = $8, district_code = $9, telephone = $10, email = $11
         where id = $1 and tenant_id = $2 returning id`,
        [request.params.id, request.tenantId, b.name, b.tin ?? null, b.otherId?.scheme ?? null, b.otherId?.value ?? null, b.address?.street ?? null,
          b.address?.city ?? null, b.address?.districtCode ?? null, b.contact?.telephone ?? null, b.contact?.email ?? null],
      );
      if (!r.rows.length) throw notFound('Customer');
      return customerJson(await loadCustomer(deps, request.tenantId, request.params.id));
    },
  );

  // Archive (hide from lists and search). Issued documents still reference the customer.
  app.delete<{ Params: { id: string } }>('/customers/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const r = await db.query('update customers set archived_at = coalesce(archived_at, now()) where id = $1 and tenant_id = $2 returning id', [request.params.id, request.tenantId]);
    if (!r.rows.length) throw notFound('Customer');
    return reply.code(204).send();
  });

  app.post<{ Body: ItemBody }>(
    '/items',
    { schema: { body: itemSchema } },
    async (request, reply) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      if (b.gstCategory === 'E' && !b.exemptionReasonCode) throw new ApiError(422, 'invalid_document', 'An exempt item needs an exemptionReasonCode');
      const id = randomUUID();
      await withBarcodeCheck(() => db.query(
        `insert into items (id, tenant_id, name, description, seller_code, unit_code, unit_price, gst_category, exemption_reason_code, barcode, favorite)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, request.tenantId, b.name, b.description ?? b.name, b.sellerCode ?? null, b.unitCode, b.unitPrice, b.gstCategory, b.exemptionReasonCode ?? null, b.barcode ?? null, b.favorite ?? false],
      ));
      return reply.code(201).send((await loadItems(deps, request.tenantId, [id])).get(id));
    },
  );

  // Edit: replaces all fields. Documents already issued keep their own lines.
  app.put<{ Params: { id: string }; Body: ItemBody }>(
    '/items/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: itemSchema } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      if (b.gstCategory === 'E' && !b.exemptionReasonCode) throw new ApiError(422, 'invalid_document', 'An exempt item needs an exemptionReasonCode');
      const r = await withBarcodeCheck(() => db.query(
        `update items set name = $3, description = $4, seller_code = $5, unit_code = $6, unit_price = $7, gst_category = $8, exemption_reason_code = $9, barcode = $10, favorite = $11
         where id = $1 and tenant_id = $2 returning id`,
        [request.params.id, request.tenantId, b.name, b.description ?? b.name, b.sellerCode ?? null, b.unitCode, b.unitPrice, b.gstCategory,
          b.gstCategory === 'E' ? (b.exemptionReasonCode ?? null) : null, b.barcode ?? null, b.favorite ?? false],
      ));
      if (!r.rows.length) throw notFound('Item');
      return (await loadItems(deps, request.tenantId, [request.params.id])).get(request.params.id);
    },
  );

  // Archive. Frees the barcode for another item.
  app.delete<{ Params: { id: string } }>('/items/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const r = await db.query('update items set archived_at = coalesce(archived_at, now()), barcode = null where id = $1 and tenant_id = $2 returning id', [request.params.id, request.tenantId]);
    if (!r.rows.length) throw notFound('Item');
    return reply.code(204).send();
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string; favorite?: 'true'; code?: string } }>(
    '/items',
    { schema: { querystring: listQuery({ q: { type: 'string', maxLength: 100 }, favorite: { type: 'string', enum: ['true'] }, code: { type: 'string', maxLength: 100 } }) } },
    async (request) => {
    const page = parsePage(request.query);
    const params: unknown[] = [request.tenantId];
    let where = 'tenant_id = $1 and archived_at is null';
    if (request.query.q) {
      params.push(likePattern(request.query.q));
      where += ` and (name ilike $${params.length} or description ilike $${params.length} or seller_code ilike $${params.length} or barcode like $${params.length})`;
    }
    if (request.query.favorite) where += ' and favorite';
    // Exact match on barcode or your own code: what a scanner or a quick code entry sends.
    if (request.query.code) {
      params.push(request.query.code);
      where += ` and (barcode = $${params.length} or lower(seller_code) = lower($${params.length}))`;
    }
    if (page.after) {
      params.push(page.after.createdAt, page.after.id);
      where += ` and (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
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

/** Just enough of the plan for the app's banners and menus. */
async function billingBanner(db: Queryable, tenantId: string) {
  const sub = await getSubscription(db, tenantId);
  const due = (await db.query<{ n: number }>("select count(*)::int as n from billing_invoices where tenant_id = $1 and status = 'open' and due_at < now()", [tenantId])).rows[0]!.n;
  return {
    plan: sub.plan,
    planName: PLANS[sub.plan].name,
    status: sub.status,
    trialDaysLeft: sub.status === 'trialing' && sub.trialEndsAt ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - Date.now()) / 86_400_000)) : null,
    overdueInvoices: due,
    features: PLANS[sub.plan].features,
  };
}
