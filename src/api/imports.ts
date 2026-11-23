/**
 * Importing a spreadsheet (CSV) of items or customers (owners, admins and managers).
 *
 *   POST /v1/items/import      { csv, dryRun? }: items, matched by code then barcode (stock sets the level)
 *   POST /v1/customers/import  { csv, dryRun? }: customers, matched by TIN then email
 *
 * A dry run says what each row would do; the import writes the good rows and lists the others.
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { CsvError } from '../imports/csv.ts';
import { importCustomers, importItems, type ImportResult } from '../imports/importers.ts';
import { ApiError } from './errors.ts';
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
