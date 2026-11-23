/**
 * Buyer accounts at a store: no password, a code sent to the buyer's email.
 *
 *   GET    /v1/store/:slug/account                    who is signed in here: { buyer, addresses } (buyer null when no one is)
 *   POST   /v1/store/:slug/account/code { email }     email a sign-in code → { challenge, minutes }
 *   POST   /v1/store/:slug/account/verify { challenge, code }   sign in (the first time makes the account)
 *   POST   /v1/store/:slug/account/sign-out
 *   PUT    /v1/store/:slug/account { name, phone, business }    the details checkout fills in
 *   POST   /v1/store/:slug/account/addresses           keep an address; PUT|DELETE .../addresses/:id
 *   GET    /v1/store/:slug/account/orders              the buyer's orders at this store, newest first
 *   DELETE /v1/store/:slug/account                     close the account (the store keeps its order records)
 *
 * The session is an httpOnly, SameSite=Lax cookie per store ("etd_b_<slug>"):
 * an account at one store never signs anyone in at another. Requests that
 * change anything must send X-Requested-With: etd-web, like the rest of the app.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/database.ts';
import { atLimit, overLimit } from '../db/ratelimit.ts';
import {
  addAddress, type AddressInput, type Buyer, BUYER_SESSION_DAYS, buyerFromToken, buyerOrders, CODE_MINUTES, deleteBuyer, endBuyerSession, finishSignIn,
  listAddresses, normalEmail, removeAddress, startSignIn, updateAddress, updateBuyer, withdrawCode, wrongCodeKey, WRONG_CODES_PER_DAY,
} from '../commerce/buyers.ts';
import type { StoreRef } from '../commerce/store.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderEmail } from '../templates/render.ts';
import { readCookie, requireCsrfHeader } from './auth.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { uuid } from './schemas.ts';
import { emailLanguage } from '../templates/lang.ts';

const HOUR_MS = 60 * 60 * 1000;
export const buyerCookieName = (slug: string) => `etd_b_${slug}`;

/** Accounts are offered when the store has them on and this server can send the codes. */
export const accountsOffered = (s: StoreRef, ctx: Pick<ServerContext, 'mailConfigured'>) => s.settings.accounts.enabled && ctx.mailConfigured;

/** The buyer signed in at this store, if any (none while the store has accounts turned off). */
export async function buyerFromRequest(db: Queryable, request: FastifyRequest, s: StoreRef): Promise<Buyer | null> {
  if (!s.settings.accounts.enabled) return null;
  const token = readCookie(request, buyerCookieName(s.slug));
  return token ? buyerFromToken(db, s.tenantId, token) : null;
}

const buyerJson = (b: Buyer) => ({ email: b.email, name: b.name, phone: b.phone, business: b.business, createdAt: b.createdAt });

const slugParams = { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' } } as const;
const params = { type: 'object', required: ['slug'], properties: slugParams } as const;
const addressParams = { type: 'object', required: ['slug', 'id'], properties: { ...slugParams, id: uuid } } as const;
const addressBody = {
  type: 'object',
  required: ['street', 'city', 'districtCode'],
  additionalProperties: false,
  properties: {
    street: { type: 'string', minLength: 1, maxLength: 200 },
    city: { type: 'string', minLength: 1, maxLength: 100 },
    districtCode: { type: 'string', enum: ['1', '2', '3', '4', '5', '6'] },
    isDefault: { type: 'boolean' },
  },
} as const;

export function registerStoreAccountRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, store: (request: FastifyRequest<{ Params: { slug: string } }>) => Promise<StoreRef>) {
  const { db } = deps;

  const setCookie = (reply: FastifyReply, slug: string, token: string, maxAge: number) =>
    reply.header('set-cookie', `${buyerCookieName(slug)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ctx.cookieSecure ? '; Secure' : ''}`);

  /** The store, with accounts on. */
  const accountStore = async (request: FastifyRequest<{ Params: { slug: string } }>) => {
    const s = await store(request);
    if (!accountsOffered(s, ctx)) throw new ApiError(404, 'accounts_off', 'This store does not have buyer accounts');
    return s;
  };
  /** The store and the signed-in buyer; changes need the CSRF header. */
  const signedIn = async (request: FastifyRequest<{ Params: { slug: string } }>) => {
    if (!['GET', 'HEAD'].includes(request.method)) requireCsrfHeader(request);
    const s = await accountStore(request);
    const buyer = await buyerFromRequest(db, request, s);
    if (!buyer) throw new ApiError(401, 'signed_out', 'Sign in to your account first');
    return { s, buyer };
  };
  const account = async (buyer: Buyer) => ({ buyer: buyerJson(buyer), addresses: await listAddresses(db, buyer.id) });

  app.get<{ Params: { slug: string } }>('/:slug/account', { schema: { params } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const s = await store(request);
    const buyer = accountsOffered(s, ctx) ? await buyerFromRequest(db, request, s) : null;
    return buyer ? account(buyer) : { buyer: null, addresses: [] };
  });

  app.post<{ Params: { slug: string }; Body: { email: string } }>(
    '/:slug/account/code',
    { schema: { params, body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 254, pattern: '^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' } } } } },
    async (request) => {
      requireCsrfHeader(request);
      const s = await accountStore(request);
      const email = normalEmail(request.body.email);
      if (await overLimit(db, `buyer-code|${request.ip}`, 20, HOUR_MS) || await overLimit(db, `buyer-code|${s.tenantId}|${email}`, 5, HOUR_MS)) {
        throw new ApiError(429, 'too_many_requests', 'Too many codes asked for; wait a while and try again');
      }
      if (await atLimit(db, wrongCodeKey(s.tenantId, email), WRONG_CODES_PER_DAY)) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes for this email today; try again tomorrow');
      const { challenge, code } = await startSignIn(db, s.tenantId, email);
      try {
        const base = ctx.publicUrl?.replace(/\/$/, '') ?? '';
        const mail = await renderEmail(db, s.tenantId, 'email.sign-in-code', {
          store: { name: s.name, city: s.city, telephone: s.telephone, url: `${base}/${s.slug}/shop` }, code, minutes: CODE_MINUTES,
        }, { publicUrl: ctx.publicUrl, lang: await emailLanguage(db, s.tenantId) });
        await ctx.mailer.send({ to: email, replyTo: s.email, subject: mail.subject, text: mail.text, html: mail.html });
      } catch (e) {
        await withdrawCode(db, challenge);
        request.log.error({ err: e }, 'sign-in code not sent');
        throw new ApiError(503, 'email_failed', 'The code could not be sent. Try again in a moment.');
      }
      return { challenge, minutes: CODE_MINUTES };
    },
  );

  app.post<{ Params: { slug: string }; Body: { challenge: string; code: string } }>(
    '/:slug/account/verify',
    { schema: { params, body: { type: 'object', required: ['challenge', 'code'], additionalProperties: false, properties: { challenge: { type: 'string', minLength: 20, maxLength: 64 }, code: { type: 'string', minLength: 6, maxLength: 9, pattern: '^[0-9 ]+$' } } } } },
    async (request, reply) => {
      requireCsrfHeader(request);
      const s = await accountStore(request);
      if (await overLimit(db, `buyer-verify|${request.ip}`, 60, HOUR_MS)) throw new ApiError(429, 'too_many_attempts', 'Too many tries from here; wait a while and try again');
      const { buyer, token, created } = await finishSignIn(db, s.tenantId, request.body.challenge, request.body.code);
      setCookie(reply, s.slug, token, BUYER_SESSION_DAYS * 24 * 60 * 60);
      return { ...(await account(buyer)), created };
    },
  );

  app.post<{ Params: { slug: string } }>('/:slug/account/sign-out', { schema: { params } }, async (request, reply) => {
    requireCsrfHeader(request);
    const s = await store(request);
    const token = readCookie(request, buyerCookieName(s.slug));
    if (token) await endBuyerSession(db, token);
    setCookie(reply, s.slug, '', 0);
    return reply.code(204).send();
  });

  app.put<{ Params: { slug: string }; Body: { name: string; phone: string; business: { tin: string; name: string } | null } }>(
    '/:slug/account',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['name', 'phone', 'business'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 200 },
            phone: { type: 'string', maxLength: 30, pattern: '^$|^[0-9+()\\-\\s]{7,30}$' },
            business: {
              anyOf: [
                { type: 'null' },
                { type: 'object', required: ['tin', 'name'], additionalProperties: false, properties: { tin: { type: 'string', pattern: '^\\d{6}$' }, name: { type: 'string', minLength: 1, maxLength: 300 } } },
              ],
            },
          },
        },
      },
    },
    async (request) => {
      const { buyer } = await signedIn(request);
      return account(await updateBuyer(db, buyer, request.body));
    },
  );

  app.post<{ Params: { slug: string }; Body: AddressInput }>('/:slug/account/addresses', { schema: { params, body: addressBody } }, async (request, reply) => {
    const { buyer } = await signedIn(request);
    return reply.code(201).send(await addAddress(db, buyer, request.body));
  });

  app.put<{ Params: { slug: string; id: string }; Body: AddressInput }>('/:slug/account/addresses/:id', { schema: { params: addressParams, body: addressBody } }, async (request) => {
    const { buyer } = await signedIn(request);
    return updateAddress(db, buyer, request.params.id, request.body);
  });

  app.delete<{ Params: { slug: string; id: string } }>('/:slug/account/addresses/:id', { schema: { params: addressParams } }, async (request, reply) => {
    const { buyer } = await signedIn(request);
    await removeAddress(db, buyer, request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { slug: string } }>('/:slug/account/orders', { schema: { params } }, async (request, reply) => {
    const { buyer } = await signedIn(request);
    reply.header('Cache-Control', 'no-store');
    return { data: await buyerOrders(db, buyer) };
  });

  app.delete<{ Params: { slug: string } }>('/:slug/account', { schema: { params } }, async (request, reply) => {
    const { s, buyer } = await signedIn(request);
    await deleteBuyer(db, buyer);
    setCookie(reply, s.slug, '', 0);
    return reply.code(204).send();
  });
}
