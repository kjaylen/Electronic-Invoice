/**
 * The business's own details (what goes on new documents) and its address.
 *
 *   GET /v1/business    everyone in the business
 *   PUT /v1/business    owners and admins; changing the address (slug) is owners only
 *   POST /v1/business/close { password, name }   an owner deletes the business: closed now, erased in 30 days
 *   POST /v1/business/reopen                     an owner undoes that, while it can be undone
 *
 * Issued documents keep the details they were signed with; changes apply to
 * new documents. The TIN cannot change: it is what BTS knows the business by.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { closeBusiness, ClosureError, reopenBusiness } from '../db/closure.ts';
import { passwordMatches } from '../db/users.ts';
import { simpleHtml } from '../mail/mailer.ts';
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
  sells: 'products' | 'services' | 'both';
  closed_at: Date | string | null;
  erase_after: Date | string | null;
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
  sells: r.sells,
  // Closed by an owner: when, and when it is erased unless reopened.
  closed: r.closed_at && r.erase_after ? { at: new Date(r.closed_at).toISOString(), eraseAfter: new Date(r.erase_after).toISOString() } : null,
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

  // ---------- deleting the business ----------
  // Closed at once, erased 30 days later unless an owner reopens it (src/db/closure.ts). Owners only, signed in
  // (never an API key), with their password and the business's name typed out, so it cannot happen by accident.
  const owner = (request: FastifyRequest) => {
    if (request.principal !== 'owner' || !request.userId) throw new ApiError(403, 'forbidden', 'Only an owner of this business can do this, signed in to the web app.');
    return request.userId;
  };

  app.post<{ Body: { password: string; name: string } }>(
    '/business/close',
    { schema: { body: { type: 'object', required: ['password', 'name'], additionalProperties: false, properties: { password: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request) => {
      const userId = owner(request);
      const b = await load(request.tenantId);
      const typed = request.body.name.trim().toLowerCase();
      if (typed !== b.legal_name.trim().toLowerCase() && typed !== (b.trade_name ?? '').trim().toLowerCase()) throw new ApiError(422, 'name_mismatch', 'That is not the name of this business. Type it exactly as shown.');
      if (!(await passwordMatches(db, userId, request.body.password))) {
        await audit(db, { tenantId: request.tenantId, userId, action: 'business.close_refused', ip: request.ip });
        throw new ApiError(403, 'wrong_password', 'Your current password is incorrect');
      }
      let closed;
      try {
        closed = await closeBusiness(db, request.tenantId, userId);
      } catch (e) {
        if (e instanceof ClosureError) throw new ApiError(409, e.code, e.message);
        throw e;
      }
      await audit(db, { tenantId: request.tenantId, userId, action: 'business.closed', details: { eraseAfter: closed.eraseAfter }, ip: request.ip });
      // Every owner is told, with how to undo it: a surprise here should reach them while it can still be undone.
      if (ctx.mailConfigured) {
        const owners = (await db.query<{ email: string }>(`select email from users where tenant_id = $1 and role = 'owner' and status = 'active' and email is not null`, [request.tenantId])).rows;
        const name = b.trade_name ?? b.legal_name;
        const on = new Date(closed.eraseAfter).toLocaleDateString('en-BZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Belize' });
        const link = ctx.publicUrl ? `${ctx.publicUrl.replace(/\/$/, '')}/${b.slug}/login` : null;
        const paragraphs = [
          `${name} was closed by one of its owners. Nobody else can sign in, and its tills, online store and API keys have stopped.`,
          `Everything it holds will be erased for good on ${on}. Until then an owner can sign in and reopen it, and nothing is lost.`,
          ...(link ? [`To reopen it or download its records, sign in: ${link}`] : []),
          'Documents already authorized by the Belize Tax Service stay registered with BTS.',
        ];
        for (const to of new Set([...owners.map((o) => o.email), b.email])) {
          await ctx.mailer.send({ type: 'business-closed', tenantId: request.tenantId, to, subject: `${name} was closed and will be erased on ${on}`, text: paragraphs.join('\n\n'), html: simpleHtml({ heading: `${name} was closed`, paragraphs }) })
            .catch((e: unknown) => request.log.warn({ err: e }, 'closing notice not sent'));
        }
      }
      return { closed: { at: closed.closedAt, eraseAfter: closed.eraseAfter } };
    },
  );

  app.post('/business/reopen', async (request) => {
    const userId = owner(request);
    try {
      await reopenBusiness(db, request.tenantId);
    } catch (e) {
      if (e instanceof ClosureError) throw new ApiError(409, e.code, e.message);
      throw e;
    }
    await audit(db, { tenantId: request.tenantId, userId, action: 'business.reopened', ip: request.ip });
    return { closed: null };
  });

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
  // What the business sells: products, services or both. The app leaves out what does not apply.
  app.put<{ Body: { sells: 'products' | 'services' | 'both' } }>(
    '/business/sells',
    { schema: { body: { type: 'object', required: ['sells'], additionalProperties: false, properties: { sells: { type: 'string', enum: ['products', 'services', 'both'] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      await db.query('update tenants set sells = $2 where id = $1', [request.tenantId, request.body.sells]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'business.sells_changed', target: request.body.sells, ip: request.ip });
      return businessJson(await load(request.tenantId));
    },
  );

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
