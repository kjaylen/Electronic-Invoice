/**
 * The business's own details (what goes on new documents) and its address.
 *
 *   GET /v1/business    everyone in the business
 *   PUT /v1/business    owners and admins; changing the address (slug) is owners only
 *
 * Issued documents keep the details they were signed with; changes apply to
 * new documents. The TIN cannot change: it is what BTS knows the business by.
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { slugProblem, slugTaken } from '../db/tenants.ts';
import type { DistrictCode } from '../engine/ubl.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { readCookie, sessionCookieName } from './auth.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { addressSchema, contactSchema } from './schemas.ts';
import { twoFactorStatus } from '../db/twofactor.ts';

interface BusinessRow {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string | null;
  tin: string;
  street: string;
  additional_street: string | null;
  city: string;
  district_code: DistrictCode;
  telephone: string;
  email: string;
  environment: string;
  require_two_factor: boolean;
  daily_summary: boolean;
}

const businessJson = (r: BusinessRow) => ({
  id: r.id,
  slug: r.slug,
  legalName: r.legal_name,
  tradeName: r.trade_name,
  tin: r.tin,
  address: { street: r.street, ...(r.additional_street && { additionalStreet: r.additional_street }), city: r.city, districtCode: r.district_code },
  contact: { telephone: r.telephone, email: r.email },
  environment: r.environment,
  requireTwoFactor: r.require_two_factor,
  dailySummary: r.daily_summary,
});

type BusinessBody = {
  legalName: string;
  tradeName?: string | null;
  address: { street: string; additionalStreet?: string; city: string; districtCode: DistrictCode };
  contact: { telephone: string; email: string };
};

export function registerBusinessRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const load = async (id: string) => (await db.query<BusinessRow>('select * from tenants where id = $1', [id])).rows[0]!;

  app.get('/business', async (request) => businessJson(await load(request.tenantId)));

  app.put<{ Body: BusinessBody }>(
    '/business',
    {
      schema: {
        body: {
          type: 'object',
          required: ['legalName', 'address', 'contact'],
          additionalProperties: false,
          properties: {
            legalName: { type: 'string', minLength: 1, maxLength: 300 },
            tradeName: { type: ['string', 'null'], maxLength: 300 },
            address: addressSchema,
            contact: { ...contactSchema, required: ['telephone', 'email'] },
          },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'business.manage');
      const before = await load(request.tenantId);
      const b = request.body;
      await db.query(
        `update tenants set legal_name = $2, trade_name = $3, street = $4, additional_street = $5, city = $6, district_code = $7, telephone = $8, email = $9 where id = $1`,
        [request.tenantId, b.legalName, b.tradeName || null, b.address.street, b.address.additionalStreet ?? null, b.address.city, b.address.districtCode, b.contact.telephone, b.contact.email],
      );
      const after = await load(request.tenantId);
      const changed = Object.fromEntries((Object.keys(after) as Array<keyof BusinessRow>).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]));
      if (Object.keys(changed).length) await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'business.updated', details: changed, ip: request.ip });
      return businessJson(after);
    },
  );

  // The morning summary email to owners and admins (src/notify/daily.ts).
  app.put<{ Body: { dailySummary: boolean } }>(
    '/business/daily-summary',
    { schema: { body: { type: 'object', required: ['dailySummary'], additionalProperties: false, properties: { dailySummary: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      await db.query('update tenants set daily_summary = $2 where id = $1', [request.tenantId, request.body.dailySummary]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: request.body.dailySummary ? 'business.daily_summary_on' : 'business.daily_summary_off', ip: request.ip });
      return businessJson(await load(request.tenantId));
    },
  );

  app.put<{ Body: { requireTwoFactor: boolean } }>(
    '/business/security',
    { schema: { body: { type: 'object', required: ['requireTwoFactor'], additionalProperties: false, properties: { requireTwoFactor: { type: 'boolean' } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      if (request.principal !== 'owner') throw new ApiError(403, 'forbidden', 'Only an owner can change sign-in rules');
      const before = await load(request.tenantId);
      if (request.body.requireTwoFactor && !before.require_two_factor) {
        const own = await twoFactorStatus(db, 'user', request.userId);
        if (!own.enabled) throw new ApiError(409, 'two_factor_first', 'Turn on two-step sign-in for your own account first');
      }
      await db.query('update tenants set require_two_factor = $2 where id = $1', [request.tenantId, request.body.requireTwoFactor]);
      if (before.require_two_factor !== request.body.requireTwoFactor) {
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: request.body.requireTwoFactor ? 'business.two_factor_required' : 'business.two_factor_optional', ip: request.ip });
      }
      return businessJson(await load(request.tenantId));
    },
  );
}
