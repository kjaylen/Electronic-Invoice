/**
 * The business's own plan with the platform.
 *
 *   GET /v1/billing                     plan, trial, usage, invoices, how to pay, the plans on offer
 *   PUT /v1/billing/plan                { plan }: upgrade now, downgrade at the end of the period
 *   GET /v1/billing/invoices/:id/pdf    the platform's e-invoice for a period
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { type BillingContext, type BillingInvoiceRow, billingSummary, changePlan, invoiceJson } from '../billing/billing.ts';
import { isPlan, PLAN_ORDER, PLANS } from '../billing/plans.ts';
import { tenantBySlug } from '../db/tenants.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { simpleHtml } from '../mail/mailer.ts';
import { publicLink, type ServerContext } from './context.ts';
import { printedCopy, sendDocumentEmail } from './documents.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

/** The platform's own business (it issues the e-invoices), from PLATFORM_BILLING_TENANT; looked up once. */
export function billingTenantResolver(deps: PipelineDeps, ctx: ServerContext) {
  let cached: Promise<string | undefined> | undefined;
  return () => {
    if (!ctx.billing?.tenantSlug) return Promise.resolve(undefined);
    cached ??= tenantBySlug(deps.db, ctx.billing.tenantSlug).then((t) => t?.id);
    return cached;
  };
}

export function plansJson() {
  return PLAN_ORDER.map((code) => {
    const p = PLANS[code];
    return { code, name: p.name, price: p.price, documentsPerMonth: p.documentsPerMonth, users: p.users, features: p.features, blurb: p.blurb };
  });
}

export function registerBillingRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, billingContext: (tenant?: string) => Promise<BillingContext>) {
  const { db } = deps;
  const billingTenant = billingTenantResolver(deps, ctx);

  app.get('/billing', async (request) => ({
    ...(await billingSummary(db, request.tenantId)),
    plans: plansJson(),
    paymentInstructions: ctx.billing?.paymentInstructions ?? null,
  }));

  app.put<{ Body: { plan: string } }>(
    '/billing/plan',
    { schema: { body: { type: 'object', required: ['plan'], additionalProperties: false, properties: { plan: { type: 'string', enum: [...PLAN_ORDER] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      if (request.principal !== 'owner') throw new ApiError(403, 'forbidden', 'Only an owner can change the plan');
      const plan = request.body.plan;
      if (!isPlan(plan)) throw new ApiError(422, 'invalid_plan', 'Unknown plan');
      const before = (await billingSummary(db, request.tenantId)).plan;
      const after = await changePlan(await billingContext(), request.tenantId, plan);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'billing.plan_changed', details: { from: before, to: plan, effective: after.nextPlan ? 'end of period' : 'now' }, ip: request.ip });
      return { ...(await billingSummary(db, request.tenantId)), plans: plansJson(), paymentInstructions: ctx.billing?.paymentInstructions ?? null };
    },
  );

  app.get<{ Params: { id: string } }>('/billing/invoices/:id/pdf', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    const inv = (await db.query<{ document_id: string | null }>('select document_id from billing_invoices where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!inv) throw notFound('Invoice');
    const issuer = await billingTenant();
    if (!inv.document_id || !issuer) throw new ApiError(409, 'not_printable', 'This invoice has no e-invoice yet');
    const copy = await printedCopy(deps, issuer, inv.document_id);
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${copy.filename}.pdf"`).send(copy.pdf);
  });
}

/** Email a new platform invoice to the business (its billing email): the e-invoice when there is one. */
export async function emailServiceInvoice(deps: PipelineDeps, ctx: ServerContext, invoice: BillingInvoiceRow, documentId: string | null, issuerId: string | undefined): Promise<void> {
  if (!ctx.mailConfigured) return;
  const t = (await deps.db.query<{ email: string; name: string; slug: string }>('select email, slug, coalesce(trade_name, legal_name) as name from tenants where id = $1', [invoice.tenant_id])).rows[0];
  if (!t) return;
  const j = invoiceJson(invoice);
  const lines = [
    `Your eInvoicing ${j.planName} plan for ${new Date(j.periodStart).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'America/Belize' })}: BZ$${j.total} (GST included), due ${j.dueAt.slice(0, 10)}.`,
    ...(ctx.billing?.paymentInstructions ? [`How to pay: ${ctx.billing.paymentInstructions}`] : []),
  ];
  if (documentId && issuerId) {
    await sendDocumentEmail(deps, ctx, issuerId, documentId, { to: t.email, message: lines.join('\n\n') });
    return;
  }
  const url = ctx.publicUrl ? publicLink(ctx, `/${t.slug}/settings?tab=plan`) : undefined;
  await ctx.mailer.send({
    to: t.email,
    subject: `${t.name}: your eInvoicing invoice (BZ$${j.total})`,
    text: [...lines, ...(url ? [url] : [])].join('\n\n'),
    html: simpleHtml({ heading: 'Your eInvoicing invoice', paragraphs: lines, ...(url && { button: { label: 'See your plan', url } }) }),
  });
}

/** What the billing functions need, for routes and the daily run. */
export function billingContextFactory(deps: PipelineDeps, ctx: ServerContext) {
  const resolve = billingTenantResolver(deps, ctx);
  return async (): Promise<BillingContext> => {
    const issuer = await resolve();
    return {
      deps,
      ...(issuer && { billingTenantId: issuer }),
      onInvoice: (invoice, documentId) => emailServiceInvoice(deps, ctx, invoice, documentId, issuer),
    };
  };
}
