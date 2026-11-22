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
});

type BusinessBody = {
  legalName: string;
  tradeName?: string | null;
  slug?: string;
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
            slug: { type: 'string', minLength: 3, maxLength: 40 },
            address: addressSchema,
            contact: { ...contactSchema, required: ['telephone', 'email'] },
          },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'business.manage');
      const before = await load(request.tenantId);
      const b = request.body;
      const slug = b.slug?.toLowerCase() ?? before.slug;
      if (slug !== before.slug) {
        if (request.principal !== 'owner') throw new ApiError(403, 'forbidden', "Only an owner can change the business's address");
        const problem = slugProblem(slug);
        if (problem) throw new ApiError(422, 'invalid_business', `Address: ${problem}`);
        if (await slugTaken(db, slug, request.tenantId)) throw new ApiError(409, 'conflict', 'Another business already uses this address');
      }
      await db.query(
        `update tenants set legal_name = $2, trade_name = $3, slug = $4, street = $5, additional_street = $6, city = $7, district_code = $8, telephone = $9, email = $10 where id = $1`,
        [request.tenantId, b.legalName, b.tradeName || null, slug, b.address.street, b.address.additionalStreet ?? null, b.address.city, b.address.districtCode, b.contact.telephone, b.contact.email],
      );
      const after = await load(request.tenantId);
      const changed = Object.fromEntries((Object.keys(after) as Array<keyof BusinessRow>).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]));
      if (Object.keys(changed).length) await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'business.updated', details: changed, ip: request.ip });
      // The session cookie is named after the address: carry the caller's session over to the new name.
      if (slug !== before.slug) {
        const token = readCookie(request, sessionCookieName(before.slug));
        if (token) {
          const flags = `Path=/; HttpOnly; SameSite=Lax${ctx.cookieSecure ? '; Secure' : ''}`;
          reply.header('set-cookie', [`${sessionCookieName(slug)}=${token}; Max-Age=${30 * 24 * 3600}; ${flags}`, `${sessionCookieName(before.slug)}=; Max-Age=0; ${flags}`]);
        }
      }
      return businessJson(after);
    },
  );
}
