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
import { spelledCategory } from '../inventory/categories.ts';
import { openReceivables } from '../receivables/receivables.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import { toBigInt } from '../db/database.ts';
import { loyaltySettings } from './loyalty.ts';

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
  price_list?: 'retail' | 'wholesale';
  credit_limit_cents?: string | number | bigint | null;
  archived_at?: string | Date | null;
  created_at: string | Date;
}

export interface CustomerBody {
  name: string;
  tin?: string;
  otherId?: { scheme: string; value: string };
  address?: { street: string; additionalStreet?: string; city: string; districtCode: DistrictCode };
  contact?: { telephone?: string; email?: string };
  priceList?: 'retail' | 'wholesale';
  /** How much they may owe on account (BZ$); null for no limit. */
  creditLimit?: string | null;
}

const customerJson = (r: CustomerRow) => ({
  id: r.id,
  name: r.name,
  tin: r.tin,
  otherId: r.other_id_scheme && r.other_id_value ? { scheme: r.other_id_scheme, value: r.other_id_value } : null,
  address: r.street && r.city && r.district_code ? { street: r.street, city: r.city, districtCode: r.district_code } : null,
  contact: { telephone: r.telephone, email: r.email },
  priceList: r.price_list ?? 'retail',
  creditLimit: r.credit_limit_cents === null || r.credit_limit_cents === undefined ? null : formatCents(BigInt(r.credit_limit_cents)),
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
  wholesale_price?: string | null;
  category?: string | null;
  is_bundle?: boolean;
  price_breaks?: Array<{ minQuantity: string; unitPrice: string }> | null;
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
  /** The price before GST for wholesale customers; null: the usual price. */
  wholesalePrice: r.wholesale_price === null || r.wholesale_price === undefined ? null : trimDecimal(r.wholesale_price),
  category: r.category ?? null,
  /** Made of other items (in lists). */
  ...(r.is_bundle !== undefined && { bundle: r.is_bundle }),
  /** Lower prices for larger quantities, smallest quantity first (in lists and single items). */
  ...(r.price_breaks !== undefined && { priceBreaks: (r.price_breaks ?? []).map((b) => ({ minQuantity: String(Number(b.minQuantity)), unitPrice: trimDecimal(b.unitPrice) })) }),
  /** In stock now; null when stock is not tracked. */
  stock: r.stock_quantity === null || r.stock_quantity === undefined ? null : Number(r.stock_quantity),
  archived: Boolean(r.archived_at),
  createdAt: new Date(r.created_at).toISOString(),
});

type ItemBody = { name: string; description?: string; sellerCode?: string; unitCode: string; unitPrice: string; gstCategory: 'S' | 'Z' | 'E'; exemptionReasonCode?: string; barcode?: string; favorite?: boolean; wholesalePrice?: string | null; category?: string | null; priceBreaks?: Array<{ minQuantity: string; unitPrice: string }> };

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

/** Each item's quantity prices as JSON, for item queries (`items` as the table's name). */
export const PRICE_BREAKS_SQL = `(select coalesce(json_agg(json_build_object('minQuantity', b.min_quantity::text, 'unitPrice', b.unit_price::text) order by b.min_quantity), '[]'::json)
  from item_price_breaks b where b.item_id = items.id) as price_breaks`;

/** The quantity prices of an item, replaced (inside the caller's transaction or not). */
async function savePriceBreaks(db: Queryable, itemId: string, breaks: Array<{ minQuantity: string; unitPrice: string }>) {
  if (new Set(breaks.map((b) => Number(b.minQuantity))).size !== breaks.length) throw new ApiError(422, 'invalid_item', 'Each quantity once in the quantity prices');
  if (breaks.some((b) => Number(b.minQuantity) <= 1)) throw new ApiError(422, 'invalid_item', 'Quantity prices start above 1');
  await db.query('delete from item_price_breaks where item_id = $1', [itemId]);
  for (const b of breaks) await db.query('insert into item_price_breaks (item_id, min_quantity, unit_price) values ($1, $2, $3)', [itemId, b.minQuantity, b.unitPrice]);
}

/** The price of one unit when buying this many: the best quantity price reached, else the usual price. */
export function priceForQuantity(item: { unitPrice: string; priceBreaks?: Array<{ minQuantity: string; unitPrice: string }> }, quantity: string): string {
  const q = Number(quantity);
  let best = item.unitPrice;
  for (const b of item.priceBreaks ?? []) if (q >= Number(b.minQuantity)) best = b.unitPrice;
  return best;
}

export async function loadItems(deps: PipelineDeps, tenantId: string, ids: string[]): Promise<Map<string, ReturnType<typeof itemJson>>> {
  if (ids.length === 0) return new Map();
  const rows = (await deps.db.query<ItemRow>(`select *, ${PRICE_BREAKS_SQL} from items where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, ids])).rows;
  return new Map(rows.map((r) => [r.id, itemJson(r)]));
}

// ---------- routes ----------

export function registerCatalogRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.get('/me', async (request) => {
    const t = (await db.query<{ id: string; legal_name: string; trade_name: string | null; tin: string; environment: string; cashier_discount_limit: string | null }>(
      'select id, legal_name, trade_name, tin, environment, cashier_discount_limit::text from tenants where id = $1', [request.tenantId],
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
      // Notices from the platform (maintenance, a BTS outage, news), newest first.
      notices: (await db.query<{ id: string; message: string; message_es: string | null; level: 'info' | 'warning' }>(
        `select id, message, message_es, level from platform_notices where starts_at <= now() and (ends_at is null or ends_at > now()) order by created_at desc limit 3`,
      )).rows.map((n) => ({ id: n.id, message: n.message, messageEs: n.message_es, level: n.level })),
      counter: {
        cashierDiscountLimit: t.cashier_discount_limit === null ? null : String(Number(t.cashier_discount_limit)),
        loyalty: await loyaltySettings(db, request.tenantId).then((l) => (l.enabled ? { pointValue: l.pointValue, minRedeem: l.minRedeem } : null)),
      },
    };
  });

  // How the counter and the tills work for this business (owners and admins).
  app.put<{ Body: { cashierDiscountLimit: string | null } }>(
    '/counter-settings',
    { schema: { body: { type: 'object', required: ['cashierDiscountLimit'], additionalProperties: false, properties: { cashierDiscountLimit: { anyOf: [{ type: 'string', pattern: '^(100(\\.0{1,2})?|\\d{1,2}(\\.\\d{1,2})?)$' }, { type: 'null' }] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      await db.query('update tenants set cashier_discount_limit = $2 where id = $1', [request.tenantId, request.body.cashierDiscountLimit]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'counter.settings', details: { cashierDiscountLimit: request.body.cashierDiscountLimit }, ip: request.ip });
      return { cashierDiscountLimit: request.body.cashierDiscountLimit === null ? null : String(Number(request.body.cashierDiscountLimit)) };
    },
  );

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
      `insert into customers (id, tenant_id, name, tin, other_id_scheme, other_id_value, street, city, district_code, telephone, email, price_list, credit_limit_cents)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, request.tenantId, b.name, b.tin ?? null, b.otherId?.scheme ?? null, b.otherId?.value ?? null, b.address?.street ?? null,
        b.address?.city ?? null, b.address?.districtCode ?? null, b.contact?.telephone ?? null, b.contact?.email ?? null, b.priceList ?? 'retail',
        // Only those who manage the catalog set a credit limit (cashiers save customers at the counter).
        b.creditLimit && can(request.principal, 'catalog.manage') ? String(parseCents(b.creditLimit)) : null],
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

  // A customer at a glance: what they bought (all time, this year), what they owe, their recent documents and favourite items.
  app.get<{ Params: { id: string } }>('/customers/:id/summary', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const customer = customerJson(await loadCustomer(deps, request.tenantId, request.params.id));
    const env = `(select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
    const counted = "('authorized', 'authorized_with_alert', 'contingency_pending', 'pending')";
    const sales = (await db.query<{ lifetime: unknown; this_year: unknown; n: number; last: string | null; first: string | null }>(
      `select coalesce(sum(case when etd_type = '04' then -tax_inclusive_cents else tax_inclusive_cents end), 0) as lifetime,
         coalesce(sum(case when etd_type = '04' then -tax_inclusive_cents else tax_inclusive_cents end) filter (where extract(year from issue_date) = extract(year from (now() - interval '6 hours'))), 0) as this_year,
         count(*)::int as n, max(issue_date)::text as last, min(issue_date)::text as first
       from documents where tenant_id = $1 and customer_id = $2 and status in ${counted} and reception_env = ${env}`,
      [request.tenantId, request.params.id],
    )).rows[0]!;
    const recent = (await db.query<{ id: string; etd_type: string; series_number: number; serial: string; issue_date: string; total: unknown; status: string }>(
      `select id, etd_type, series_number, serial::text as serial, issue_date::text as issue_date, tax_inclusive_cents as total, status
       from documents where tenant_id = $1 and customer_id = $2 and reception_env = ${env} order by issue_date desc, created_at desc limit 10`,
      [request.tenantId, request.params.id],
    )).rows;
    const items = (await db.query<{ name: string; quantity: string; total: unknown }>(
      `select l.description as name, sum(l.quantity)::text as quantity, sum(l.line_total_cents) as total
       from document_lines l join documents d on d.id = l.document_id and d.tenant_id = l.tenant_id
       where d.tenant_id = $1 and d.customer_id = $2 and d.etd_type in ('01', '02') and d.status in ${counted} and d.reception_env = ${env}
       group by l.description order by sum(l.line_total_cents) desc limit 5`,
      [request.tenantId, request.params.id],
    )).rows;
    const open = (await openReceivables(db, request.tenantId, { customerKey: `c:${request.params.id}` })).filter((r) => r.balanceCents > 0n);
    const overdue = open.filter((r) => r.daysOverdue > 0);
    const c = (v: unknown) => formatCents(toBigInt(v ?? 0));
    return {
      customer,
      key: `c:${request.params.id}`,
      sales: { lifetime: c(sales.lifetime), thisYear: c(sales.this_year), documents: sales.n, lastSale: sales.last, firstSale: sales.first },
      owed: {
        total: formatCents(open.reduce((a, r) => a + r.balanceCents, 0n)),
        overdue: formatCents(overdue.reduce((a, r) => a + r.balanceCents, 0n)),
        invoices: open.map((r) => ({ id: r.documentId, number: r.number, dueDate: r.dueDate, balance: r.balance, daysOverdue: r.daysOverdue })),
      },
      recent: recent.map((d) => ({ id: d.id, type: d.etd_type, number: `${String(d.series_number).padStart(3, '0')}-${d.serial.padStart(9, '0')}`, issueDate: d.issue_date, total: c(d.total), status: d.status })),
      topItems: items.map((i) => ({ name: i.name, quantity: String(Number(i.quantity)), total: c(i.total) })),
    };
  });

  // Edit: replaces all fields. Documents already issued keep the details they were issued with.
  app.put<{ Params: { id: string }; Body: CustomerBody }>(
    '/customers/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { ...customerSchema, required: ['name'] } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      const r = await db.query(
        `update customers set name = $3, tin = $4, other_id_scheme = $5, other_id_value = $6, street = $7, city = $8, district_code = $9, telephone = $10, email = $11,
           price_list = coalesce($12, price_list),
           credit_limit_cents = case when $13::boolean then $14::bigint else credit_limit_cents end
         where id = $1 and tenant_id = $2 returning id`,
        [request.params.id, request.tenantId, b.name, b.tin ?? null, b.otherId?.scheme ?? null, b.otherId?.value ?? null, b.address?.street ?? null,
          b.address?.city ?? null, b.address?.districtCode ?? null, b.contact?.telephone ?? null, b.contact?.email ?? null, b.priceList ?? null,
          // Left out: the limit stays; null removes it.
          b.creditLimit !== undefined, b.creditLimit ? String(parseCents(b.creditLimit)) : null],
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
      const category = await spelledCategory(db, request.tenantId, b.category);
      await withBarcodeCheck(() => db.query(
        `insert into items (id, tenant_id, name, description, seller_code, unit_code, unit_price, gst_category, exemption_reason_code, barcode, favorite, wholesale_price, category)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, request.tenantId, b.name, b.description ?? b.name, b.sellerCode ?? null, b.unitCode, b.unitPrice, b.gstCategory, b.exemptionReasonCode ?? null, b.barcode ?? null, b.favorite ?? false, b.wholesalePrice ?? null, category],
      ));
      if (b.priceBreaks?.length) await savePriceBreaks(db, id, b.priceBreaks);
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
      const category = await spelledCategory(db, request.tenantId, b.category, request.params.id);
      const r = await withBarcodeCheck(() => db.query(
        `update items set name = $3, description = $4, seller_code = $5, unit_code = $6, unit_price = $7, gst_category = $8, exemption_reason_code = $9, barcode = $10, favorite = $11,
           wholesale_price = case when $12::boolean then $13::numeric else wholesale_price end,
           category = case when $14::boolean then $15::text else category end
         where id = $1 and tenant_id = $2 returning id`,
        [request.params.id, request.tenantId, b.name, b.description ?? b.name, b.sellerCode ?? null, b.unitCode, b.unitPrice, b.gstCategory,
          b.gstCategory === 'E' ? (b.exemptionReasonCode ?? null) : null, b.barcode ?? null, b.favorite ?? false,
          // Left out: the wholesale price stays as it was; null clears it.
          b.wholesalePrice !== undefined, b.wholesalePrice ?? null,
          b.category !== undefined, category],
      ));
      if (!r.rows.length) throw notFound('Item');
      if (b.priceBreaks) await savePriceBreaks(db, request.params.id, b.priceBreaks);
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

  // A bundle's components (empty for an ordinary item).
  app.get<{ Params: { id: string } }>('/items/:id/components', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const item = (await db.query<{ id: string }>('select id from items where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!item) throw notFound('Item');
    const rows = (await db.query<{ component_id: string; name: string; quantity: string; unit_code: string; average_cost: string | null; stock: string | null }>(
      `select c.component_id, i.name, c.quantity::text as quantity, i.unit_code, i.average_cost::text as average_cost, i.stock_quantity::text as stock
       from item_components c join items i on i.id = c.component_id where c.item_id = $1 order by i.name`, [item.id],
    )).rows;
    const costs = rows.map((r) => (r.average_cost === null ? null : Number(r.quantity) * Number(r.average_cost)));
    return {
      data: rows.map((r) => ({ itemId: r.component_id, name: r.name, quantity: String(Number(r.quantity)), unitCode: r.unit_code, stock: r.stock === null ? null : Number(r.stock) })),
      // What the bundle costs, when every component has a cost.
      cost: rows.length && costs.every((c) => c !== null) ? costs.reduce((a, c) => a + c!, 0).toFixed(2) : null,
    };
  });

  app.put<{ Params: { id: string }; Body: { components: Array<{ itemId: string; quantity: string }> } }>(
    '/items/:id/components',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: {
          type: 'object', required: ['components'], additionalProperties: false,
          properties: { components: { type: 'array', maxItems: 30, items: { type: 'object', required: ['itemId', 'quantity'], additionalProperties: false, properties: { itemId: uuid, quantity: { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,3})?$' } } } } },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const id = request.params.id;
      const list = request.body.components;
      const item = (await db.query<{ id: string }>('select id from items where id = $1 and tenant_id = $2 and archived_at is null', [id, request.tenantId])).rows[0];
      if (!item) throw notFound('Item');
      if (new Set(list.map((c) => c.itemId)).size !== list.length) throw new ApiError(422, 'invalid_bundle', 'Each component once');
      if (list.some((c) => c.itemId === id)) throw new ApiError(422, 'invalid_bundle', 'A bundle cannot contain itself');
      if (list.some((c) => Number(c.quantity) <= 0)) throw new ApiError(422, 'invalid_bundle', 'Quantities must be more than zero');
      if (list.length) {
        const found = (await db.query<{ id: string; is_bundle: boolean }>(
          `select i.id, exists (select 1 from item_components c where c.item_id = i.id) as is_bundle from items i
           where i.tenant_id = $1 and i.id = any($2::uuid[]) and i.archived_at is null`, [request.tenantId, list.map((c) => c.itemId)],
        )).rows;
        if (found.length !== list.length) throw new ApiError(422, 'invalid_bundle', 'A component is not in your catalog');
        if (found.some((f) => f.is_bundle)) throw new ApiError(422, 'invalid_bundle', 'A bundle cannot contain another bundle');
        // Nor can an item that is itself in a bundle become one.
        const used = (await db.query('select 1 from item_components where component_id = $1 limit 1', [id])).rows.length;
        if (used) throw new ApiError(422, 'invalid_bundle', 'This item is part of another bundle, so it cannot be a bundle itself');
      }
      await db.transaction(async (tx) => {
        await tx.query('delete from item_components where item_id = $1', [id]);
        for (const c of list) await tx.query('insert into item_components (item_id, component_id, quantity) values ($1, $2, $3)', [id, c.itemId, c.quantity]);
      });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'item.bundle_changed', target: id, details: { components: list.length }, ip: request.ip });
      return { components: list.length };
    },
  );

  // The categories in use, with how many items each has.
  app.get('/items/categories', async (request) => {
    const rows = (await db.query<{ name: string; n: number }>(
      `select min(category) as name, count(*)::int as n from items where tenant_id = $1 and archived_at is null and category is not null
       group by lower(category) order by lower(category)`, [request.tenantId],
    )).rows;
    return { data: rows.map((r) => ({ name: r.name, items: r.n })) };
  });

  // Change many prices at once: by a percentage, by an amount, or to a price; for a category (or every item); rounded up to 5 cents, 25 cents or a dollar.
  app.post<{ Body: { category?: string | null; mode: 'percent' | 'amount' | 'set'; value: string; price?: 'retail' | 'wholesale'; roundTo?: '0.05' | '0.25' | '1.00'; dryRun?: boolean } }>(
    '/items/reprice',
    {
      schema: {
        body: {
          type: 'object', required: ['mode', 'value'], additionalProperties: false,
          properties: {
            category: { anyOf: [{ type: 'string', minLength: 1, maxLength: 80 }, { type: 'null' }] },
            mode: { type: 'string', enum: ['percent', 'amount', 'set'] },
            value: { type: 'string', pattern: '^-?\\d{1,9}(\\.\\d{1,6})?$' },
            price: { type: 'string', enum: ['retail', 'wholesale'] },
            roundTo: { type: 'string', enum: ['0.05', '0.25', '1.00'] },
            dryRun: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      const column = b.price === 'wholesale' ? 'wholesale_price' : 'unit_price';
      const params: unknown[] = [request.tenantId];
      let where = 'tenant_id = $1 and archived_at is null';
      if (b.category === null) where += ' and category is null';
      else if (b.category) {
        params.push(b.category);
        where += ` and lower(category) = lower($${params.length})`;
      }
      if (column === 'wholesale_price' && b.mode !== 'set') where += ' and wholesale_price is not null';
      const items = (await db.query<{ id: string; name: string; price: string | null }>(`select id, name, ${column}::text as price from items where ${where} order by name limit 5000`, params)).rows;
      const value = Number(b.value);
      const step = b.roundTo ? Number(b.roundTo) : 0.01;
      const changes = items.map((it) => {
        const from = it.price === null ? null : Number(it.price);
        let to = b.mode === 'set' ? value : b.mode === 'percent' ? (from ?? 0) * (1 + value / 100) : (from ?? 0) + value;
        // Rounded up to the step (prices end in .x5 or whole dollars), never below zero.
        to = Math.max(0, Math.ceil(Math.round(to * 1e6) / 1e6 / step - 1e-9) * step);
        return { id: it.id, name: it.name, from: from === null ? null : from.toFixed(2), to: to.toFixed(2) };
      }).filter((c) => c.from !== c.to);
      if (!b.dryRun && changes.length) {
        await db.transaction(async (tx) => {
          for (const c of changes) await tx.query(`update items set ${column} = $3 where id = $1 and tenant_id = $2`, [c.id, request.tenantId, c.to]);
        });
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'items.repriced', target: b.category ?? 'all items', details: { mode: b.mode, value: b.value, price: b.price ?? 'retail', items: changes.length }, ip: request.ip });
      }
      return { dryRun: Boolean(b.dryRun), matched: items.length, changed: changes.length, changes: changes.slice(0, 500) };
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string; favorite?: 'true'; code?: string; category?: string } }>(
    '/items',
    { schema: { querystring: listQuery({ q: { type: 'string', maxLength: 100 }, favorite: { type: 'string', enum: ['true'] }, code: { type: 'string', maxLength: 100 }, category: { type: 'string', maxLength: 80 } }) } },
    async (request) => {
    const page = parsePage(request.query);
    const params: unknown[] = [request.tenantId];
    let where = 'tenant_id = $1 and archived_at is null';
    if (request.query.q) {
      params.push(likePattern(request.query.q));
      where += ` and (name ilike $${params.length} or description ilike $${params.length} or seller_code ilike $${params.length} or barcode like $${params.length})`;
    }
    if (request.query.favorite) where += ' and favorite';
    // ?category=Coffee, or ?category= (empty) for items without one.
    if (request.query.category !== undefined) {
      if (request.query.category === '') where += ' and category is null';
      else {
        params.push(request.query.category);
        where += ` and lower(category) = lower($${params.length})`;
      }
    }
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
    const rows = (await db.query<ItemRow>(`select *, exists (select 1 from item_components c where c.item_id = items.id) as is_bundle, ${PRICE_BREAKS_SQL} from items where ${where} order by created_at desc, id desc limit $${params.length}`, params)).rows;
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
