/**
 * Gift cards, for staff.
 *
 *   GET  /v1/gift-cards?q=&status=     the cards (q: a whole code, the last four, or who it is for), and what is outstanding
 *   POST /v1/gift-cards                sell one (documents.issue) or give one (documents.adjust) → the card and its code, once
 *   POST /v1/gift-cards/check { code } a card's balance, to take it as payment
 *   GET  /v1/gift-cards/:id            the card and everything that changed its balance
 *   POST /v1/gift-cards/:id/send       email it again (to someone else: documents.adjust)
 *   POST /v1/gift-cards/:id/adjust     add to or take from the balance { amount, note } (documents.adjust)
 *   POST /v1/gift-cards/:id/disable    stop it being used (lost or stolen); .../enable (documents.adjust)
 *
 * A card sold is not a BTS document (GST is charged when it is used); paid in
 * cash at a till or counter, it counts in that drawer's shift.
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { toBigInt } from '../db/database.ts';
import { adjustCard, cardActivity, cardById, cardCode, cardJson, type GiftCardRow, issueGiftCard, listCards, payingCard, setCardStatus } from '../commerce/giftcards.ts';
import { formatCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { emailLanguage } from '../templates/lang.ts';
import { renderEmail } from '../templates/render.ts';
import type { ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { date, money, uuid } from './schemas.ts';

const cents = (amount: string) => {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = amount.replace('-', '').split('.');
  const v = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -v : v;
};
const email = { type: 'string', maxLength: 254, pattern: '^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

/** Email a card to whoever it is for (or `to`). */
export async function sendGiftCardEmail(deps: PipelineDeps, ctx: ServerContext, card: GiftCardRow, to: string): Promise<void> {
  const { db } = deps;
  const t = (await db.query<{ name: string; email: string; city: string; telephone: string; slug: string; store_settings: { enabled?: boolean } | null }>(
    'select coalesce(trade_name, legal_name) as name, email, city, telephone, slug, store_settings from tenants where id = $1', [card.tenant_id],
  )).rows[0]!;
  const base = ctx.publicUrl?.replace(/\/$/, '') ?? '';
  const online = Boolean(t.store_settings?.enabled) && Boolean(base);
  const mail = await renderEmail(db, card.tenant_id, 'email.gift-card', {
    store: { name: t.name, city: t.city, telephone: t.telephone, online, url: online ? `${base}/${t.slug}/shop` : null },
    recipient: { name: card.recipient_name ?? '' },
    message: card.message ?? '',
    card: { amount: formatCents(toBigInt(card.initial_cents)), balance: formatCents(toBigInt(card.balance_cents)), code: await cardCode(deps.keys, card), expires_on: card.expires_on },
    balance_url: online ? `${base}/${t.slug}/shop/gift-card` : null,
  }, { publicUrl: ctx.publicUrl, lang: await emailLanguage(db, card.tenant_id) });
  await ctx.mailer.send({ to, replyTo: t.email, subject: mail.subject, text: mail.text, html: mail.html });
}

export function registerGiftCardRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;
  const load = async (tenantId: string, id: string) => {
    const card = await cardById(db, tenantId, id);
    if (!card) throw notFound('Gift card');
    return card;
  };

  app.get<{ Querystring: { q?: string; status?: 'active' | 'used_up' | 'disabled' | 'all' } }>(
    '/gift-cards',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: ['active', 'used_up', 'disabled', 'all'] } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      return listCards(db, request.tenantId, request.query);
    },
  );

  app.post<{ Body: { amount: string; source: 'sold' | 'given'; paidBy?: 'cash' | 'card' | 'bank_transfer'; recipientName?: string; recipientEmail?: string; message?: string; note?: string; expiresOn?: string; send?: boolean } }>(
    '/gift-cards',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount', 'source'],
          additionalProperties: false,
          properties: {
            amount: money,
            source: { type: 'string', enum: ['sold', 'given'] },
            paidBy: { type: 'string', enum: ['cash', 'card', 'bank_transfer'] },
            recipientName: { type: 'string', maxLength: 200 },
            recipientEmail: { anyOf: [{ type: 'string', maxLength: 0 }, email] },
            message: { type: 'string', maxLength: 500 },
            note: { type: 'string', maxLength: 500 },
            expiresOn: date,
            send: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      // Selling takes money like a sale; giving one away is the business's money.
      requirePermission(request, b.source === 'given' ? 'documents.adjust' : 'documents.issue');
      if (b.send && !b.recipientEmail) throw new ApiError(422, 'invalid_request', 'Give the email to send the card to');
      if (b.send && !ctx.mailConfigured) throw new ApiError(503, 'email_unavailable', 'Email is not set up on this server');
      const { card, code } = await issueGiftCard(db, deps.keys, request.tenantId, {
        amountCents: cents(b.amount), source: b.source, ...(b.paidBy && { paidBy: b.paidBy }),
        ...(b.recipientName && { recipientName: b.recipientName }), ...(b.recipientEmail && { recipientEmail: b.recipientEmail }),
        ...(b.message && { message: b.message }), ...(b.note && { note: b.note }), ...(b.expiresOn && { expiresOn: b.expiresOn }),
        userId: request.userId || null, deviceId: request.posDevice?.id ?? null,
      });
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: b.source === 'given' ? 'gift_card.given' : 'gift_card.sold', target: `••••${card.last4}`, details: { amount: formatCents(toBigInt(card.initial_cents)), ...(b.paidBy && { paidBy: b.paidBy }) }, ip: request.ip });
      let emailed: string | null = null;
      if (b.send && card.recipient_email) {
        try {
          await sendGiftCardEmail(deps, ctx, card, card.recipient_email);
          emailed = card.recipient_email;
        } catch (e) {
          request.log.error({ err: e }, 'gift card email failed');
        }
      }
      return reply.code(201).send({ card: cardJson(card), code: code.match(/.{4}/g)!.join('-'), emailed });
    },
  );

  // The counter and the tills: is this card good, and for how much?
  app.post<{ Body: { code: string } }>(
    '/gift-cards/check',
    { schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 1, maxLength: 40 } } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      const card = await payingCard(db, request.tenantId, request.body.code);
      return { card: cardJson(card) };
    },
  );

  app.get<{ Params: { id: string } }>('/gift-cards/:id', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'documents.issue');
    const card = await load(request.tenantId, request.params.id);
    return { card: cardJson(card), activity: await cardActivity(db, request.tenantId, card.id) };
  });

  app.post<{ Params: { id: string }; Body: { email?: string } }>(
    '/gift-cards/:id/send',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { email } } } },
    async (request) => {
      requirePermission(request, 'documents.issue');
      if (!ctx.mailConfigured) throw new ApiError(503, 'email_unavailable', 'Email is not set up on this server');
      const card = await load(request.tenantId, request.params.id);
      const to = request.body?.email?.trim().toLowerCase() || card.recipient_email;
      if (!to) throw new ApiError(422, 'invalid_request', 'Give the email to send the card to');
      // Sending the code somewhere new is handing over the card: managers only.
      if (to !== card.recipient_email && !can(request.principal, 'documents.adjust')) throw new ApiError(403, 'forbidden', 'Only an owner, admin or manager can send a card to a new address');
      if (to !== card.recipient_email) await db.query('update gift_cards set recipient_email = $3 where tenant_id = $1 and id = $2', [request.tenantId, card.id, to]);
      await sendGiftCardEmail(deps, ctx, { ...card, recipient_email: to }, to);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'gift_card.sent', target: `••••${card.last4}`, details: { to }, ip: request.ip });
      return { emailed: to };
    },
  );

  app.post<{ Params: { id: string }; Body: { amount: string; note: string } }>(
    '/gift-cards/:id/adjust',
    { schema: { params: idParams, body: { type: 'object', required: ['amount', 'note'], additionalProperties: false, properties: { amount: money, note: { type: 'string', minLength: 1, maxLength: 500 } } } } },
    async (request) => {
      requirePermission(request, 'documents.adjust');
      const card = await adjustCard(db, request.tenantId, (await load(request.tenantId, request.params.id)).id, cents(request.body.amount), request.userId || null, request.body.note.trim());
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'gift_card.adjusted', target: `••••${card.last4}`, details: { amount: request.body.amount, note: request.body.note }, ip: request.ip });
      return { card: cardJson(card), activity: await cardActivity(db, request.tenantId, card.id) };
    },
  );

  for (const [path, status] of [['disable', 'disabled'], ['enable', 'active']] as const) {
    app.post<{ Params: { id: string }; Body: { note?: string } }>(
      `/gift-cards/:id/${path}`,
      { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 500 } } } } },
      async (request) => {
        requirePermission(request, 'documents.adjust');
        const card = await setCardStatus(db, request.tenantId, (await load(request.tenantId, request.params.id)).id, status, request.userId || null, request.body?.note?.trim() || undefined);
        await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `gift_card.${status === 'active' ? 'enabled' : 'disabled'}`, target: `••••${card.last4}`, ip: request.ip });
        return { card: cardJson(card), activity: await cardActivity(db, request.tenantId, card.id) };
      },
    );
  }
}
