/**
 * Discount codes for the online store (owners, admins, managers).
 *
 *   GET    /v1/discounts           every code, with how often it was used
 *   POST   /v1/discounts           { code, kind: percent|amount|free_delivery, value?, minSubtotal?, startsAt?, endsAt?, maxUses? }
 *   PATCH  /v1/discounts/:id       { active?, endsAt?, maxUses? }
 */

import type { FastifyInstance } from 'fastify';
import { createDiscount, DiscountError, discountJson, type DiscountRow } from '../commerce/discounts.ts';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

const money = { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,2})?$' } as const;
const when = { type: ['string', 'null'], format: 'date-time' } as const;

export function registerDiscountRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.get('/discounts', async (request) => {
    requirePermission(request, 'catalog.manage');
    const rows = (await db.query<DiscountRow>('select * from discount_codes where tenant_id = $1 order by active desc, created_at desc', [request.tenantId])).rows;
    return { data: rows.map(discountJson) };
  });

  app.post<{ Body: { code: string; kind: 'percent' | 'amount' | 'free_delivery'; value?: string; minSubtotal?: string | null; startsAt?: string | null; endsAt?: string | null; maxUses?: number | null } }>(
    '/discounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'kind'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', minLength: 3, maxLength: 32 },
            kind: { type: 'string', enum: ['percent', 'amount', 'free_delivery'] },
            value: money,
            minSubtotal: { anyOf: [money, { type: 'null' }] },
            startsAt: when,
            endsAt: when,
            maxUses: { type: ['integer', 'null'], minimum: 1, maximum: 1_000_000 },
          },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'catalog.manage');
      try {
        const row = await createDiscount(db, request.tenantId, request.body);
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'discount.created', target: row.code, ip: request.ip });
        return reply.code(201).send(discountJson(row));
      } catch (e) {
        if (e instanceof DiscountError) throw new ApiError(422, 'invalid_discount', e.message);
        throw e;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { active?: boolean; endsAt?: string | null; maxUses?: number | null } }>(
    '/discounts/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { active: { type: 'boolean' }, endsAt: when, maxUses: { type: ['integer', 'null'], minimum: 1, maximum: 1_000_000 } } },
      },
    },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const before = (await db.query<DiscountRow>('select * from discount_codes where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
      if (!before) throw notFound('Discount code');
      const b = request.body;
      const row = (await db.query<DiscountRow>(
        'update discount_codes set active = $3, ends_at = $4, max_uses = $5 where id = $1 and tenant_id = $2 returning *',
        [before.id, request.tenantId, b.active ?? before.active, b.endsAt === undefined ? before.ends_at : b.endsAt, b.maxUses === undefined ? before.max_uses : b.maxUses],
      )).rows[0]!;
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: row.active ? 'discount.updated' : 'discount.deactivated', target: row.code, ip: request.ip });
      return discountJson(row);
    },
  );
}
