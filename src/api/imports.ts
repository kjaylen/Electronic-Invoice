/**
 * Importing a spreadsheet (CSV) of items or customers (owners, admins and managers).
 *
 *   POST /v1/items/import      { csv, dryRun? }: items, matched by code then barcode (stock sets the level)
 *   POST /v1/customers/import  { csv, dryRun? }: customers, matched by TIN then email
 *   GET  /v1/items/export.csv      every item, in the columns the import reads
 *   GET  /v1/customers/export.csv  every customer, likewise
 *
 * A dry run says what each row would do; the import writes the good rows and lists the others.
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { CsvError } from '../imports/csv.ts';
import { importCustomers, importItems, type ImportResult } from '../imports/importers.ts';
import { ApiError } from './errors.ts';
import { toCsv } from './reports.ts';
import { requirePermission } from './permissions.ts';

const body = {
  type: 'object',
  required: ['csv'],
  additionalProperties: false,
  properties: { csv: { type: 'string', minLength: 1, maxLength: 4_000_000 }, dryRun: { type: 'boolean' } },
} as const;

export function registerImportRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const run = async (fn: () => Promise<ImportResult>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CsvError) throw new ApiError(422, 'invalid_csv', e.message);
      throw e;
    }
  };

  // Exports in the import's own columns: edit in a spreadsheet, import again.
  const text = (v: unknown) => ({ v });
  const number = (v: unknown) => ({ v, text: false });
  const trim = (v: string | null) => (v === null ? '' : String(Number(v)));
  /** 22 -> "22.00", 6.666667 -> "6.666667". */
  const price = (v: string | null) => (v === null ? '' : Number.isInteger(Math.round(Number(v) * 1e6) / 1e4) ? Number(v).toFixed(2) : String(Number(v)));
  const DISTRICT_NAMES: Record<string, string> = { '1': 'Belize', '2': 'Cayo', '3': 'Corozal', '4': 'Orange Walk', '5': 'Stann Creek', '6': 'Toledo' };

  app.get('/items/export.csv', async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const rows = (await db.query<{ name: string; description: string; seller_code: string | null; barcode: string | null; unit_price: string; wholesale_price: string | null; gst_category: string; exemption_reason_code: string | null; unit_code: string; stock_quantity: string | null; low_stock: string | null; favorite: boolean; category: string | null }>(
      `select name, description, seller_code, barcode, unit_price::text, wholesale_price::text, gst_category, exemption_reason_code, unit_code, stock_quantity::text, low_stock::text, favorite, category
       from items where tenant_id = $1 and archived_at is null order by name limit 20000`, [request.tenantId],
    )).rows;
    const csv = toCsv(['Name', 'Code', 'Barcode', 'Category', 'Price', 'Wholesale price', 'GST', 'Exemption reason', 'Unit', 'Stock', 'Low stock', 'Quick button', 'Description'],
      rows.map((r) => [text(r.name), text(r.seller_code), text(r.barcode), text(r.category), number(price(r.unit_price)),
        number(price(r.wholesale_price)), text(r.gst_category), text(r.exemption_reason_code), text(r.unit_code),
        number(trim(r.stock_quantity)), number(trim(r.low_stock)), text(r.favorite ? 'yes' : ''), text(r.description === r.name ? '' : r.description)]));
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="items.csv"').send(csv);
  });

  app.get('/customers/export.csv', async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const rows = (await db.query<{ name: string; tin: string | null; email: string | null; telephone: string | null; street: string | null; city: string | null; district_code: string | null; price_list: string }>(
      `select name, tin, email, telephone, street, city, district_code, price_list from customers where tenant_id = $1 and archived_at is null order by name limit 20000`, [request.tenantId],
    )).rows;
    const csv = toCsv(['Name', 'TIN', 'Email', 'Phone', 'Street', 'City', 'District', 'Price list'],
      rows.map((r) => [text(r.name), text(r.tin), text(r.email), text(r.telephone), text(r.street), text(r.city), text(r.district_code ? DISTRICT_NAMES[r.district_code] : ''), text(r.price_list)]));
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="customers.csv"').send(csv);
  });

  app.post<{ Body: { csv: string; dryRun?: boolean } }>('/items/import', { bodyLimit: 5 * 1024 * 1024, schema: { body } }, async (request) => {
    requirePermission(request, 'catalog.manage');
    const dryRun = request.body.dryRun ?? false;
    const result = await run(() => (dryRun
      ? importItems(db, request.tenantId, request.body.csv, { dryRun, userId: request.userId || null })
      : db.transaction((tx) => importItems(tx, request.tenantId, request.body.csv, { dryRun, userId: request.userId || null }))));
    if (!dryRun) await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'items.imported', details: { created: result.created, updated: result.updated, errors: result.errors }, ip: request.ip });
    return { dryRun, ...result };
  });

  app.post<{ Body: { csv: string; dryRun?: boolean } }>('/customers/import', { bodyLimit: 5 * 1024 * 1024, schema: { body } }, async (request) => {
    requirePermission(request, 'catalog.manage');
    const dryRun = request.body.dryRun ?? false;
    const result = await run(() => (dryRun
      ? importCustomers(db, request.tenantId, request.body.csv, { dryRun })
      : db.transaction((tx) => importCustomers(tx, request.tenantId, request.body.csv, { dryRun }))));
    if (!dryRun) await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'customers.imported', details: { created: result.created, updated: result.updated, errors: result.errors }, ip: request.ip });
    return { dryRun, ...result };
  });
}
