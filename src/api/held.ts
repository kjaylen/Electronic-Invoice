/**
 * Held sales, shared by every till of a business: a sale put on hold at one till (a table's tab,
 * a customer who went back for something) can be finished at any other.
 *
 *   GET    /v1/held-sales               newest first, with who held them
 *   POST   /v1/held-sales               { label?, total, count, sale }: the counter's sale as it was (kept as given)
 *   POST   /v1/held-sales/:id/recall    takes it off hold and returns it (once: two tills cannot both recall it)
 *   DELETE /v1/held-sales/:id
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { toBigInt } from '../db/database.ts';
import { formatCents, parseCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

const MAX_HELD = 100;
const MAX_SALE_BYTES = 64 * 1024;

interface HeldRow { id: string; label: string; total_cents: unknown; item_count: number; sale: unknown; created_at: Date | string; held_by_name: string | null }
const heldJson = (r: HeldRow) => ({
  id: r.id, label: r.label, total: formatCents(toBigInt(r.total_cents)), count: r.item_count, at: new Date(r.created_at).toISOString(), heldBy: r.held_by_name, sale: r.sale,
});

export function registerHeldSaleRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

  app.get('/held-sales', async (request) => {
    requirePermission(request, 'documents.issue');
    const rows = (await db.query<HeldRow>(
      `select h.id, h.label, h.total_cents, h.item_count, h.sale, h.created_at, u.name as held_by_name
       from held_sales h left join users u on u.id = h.held_by where h.tenant_id = $1 order by h.created_at desc limit ${MAX_HELD}`, [request.tenantId],
    )).rows;
    return { data: rows.map(heldJson) };
  });

  app.post<{ Body: { label?: string; total: string; count: number; sale: Record<string, unknown> } }>(
    '/held-sales',
    {
      bodyLimit: MAX_SALE_BYTES + 4096,
      schema: {
        body: {
          type: 'object', required: ['total', 'count', 'sale'], additionalProperties: false,
          properties: {
            label: { type: 'string', maxLength: 80 },
            total: { type: 'string', pattern: '^-?\\d{1,10}(\\.\\d{1,2})?$' },
            count: { type: 'integer', minimum: 1, maximum: 500 },
            sale: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'documents.issue');
      const b = request.body;
      const sale = JSON.stringify(b.sale);
      if (sale.length > MAX_SALE_BYTES) throw new ApiError(413, 'too_large', 'This sale is too large to hold');
      const n = (await db.query<{ n: number }>('select count(*)::int as n from held_sales where tenant_id = $1', [request.tenantId])).rows[0]!.n;
      if (n >= MAX_HELD) throw new ApiError(409, 'too_many_held', `There are already ${MAX_HELD} sales on hold; finish or delete some first`);
      const id = randomUUID();
      await db.query(
        'insert into held_sales (id, tenant_id, label, total_cents, item_count, sale, held_by, device_id) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, request.tenantId, b.label?.trim() ?? '', String(parseCents(b.total.replace(/^-/, ''))), b.count, sale, request.userId || null, request.posDevice?.id ?? null],
      );
      const row = (await db.query<HeldRow>(
        'select h.id, h.label, h.total_cents, h.item_count, h.sale, h.created_at, u.name as held_by_name from held_sales h left join users u on u.id = h.held_by where h.id = $1', [id],
      )).rows[0]!;
      return reply.code(201).send(heldJson(row));
    },
  );

  app.post<{ Params: { id: string } }>('/held-sales/:id/recall', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    // Deleted as it is read: whichever till asks first gets it.
    const row = (await db.query<HeldRow>(
      `with gone as (delete from held_sales where id = $1 and tenant_id = $2 returning *)
       select g.id, g.label, g.total_cents, g.item_count, g.sale, g.created_at, u.name as held_by_name from gone g left join users u on u.id = g.held_by`,
      [request.params.id, request.tenantId],
    )).rows[0];
    if (!row) throw new ApiError(404, 'not_found', 'This sale is no longer on hold (another till may have taken it)');
    return heldJson(row);
  });

  app.delete<{ Params: { id: string } }>('/held-sales/:id', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'documents.issue');
    const r = await db.query('delete from held_sales where id = $1 and tenant_id = $2 returning id', [request.params.id, request.tenantId]);
    if (!r.rows.length) throw notFound('Held sale');
    return reply.code(204).send();
  });
}
