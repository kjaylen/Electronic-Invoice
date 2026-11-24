/**
 * Who may call the public store API (/v1/store/:slug/...) from where.
 *
 *   - No Origin header (a server, curl) or a page of this app itself (the
 *     hosted store): as always, no key needed.
 *   - A page on another site: it must send a publishable key of this store
 *     (Authorization: Bearer pk_…, X-Floreo-Key, or ?key= on a GET), and the
 *     site must be on that key's list. Test keys also accept any site on the
 *     developer's own computer.
 *
 * Cross-origin answers never allow credentials, so no cookie of this app is
 * ever sent or readable from another site; buyer accounts (a cookie) stay on
 * the hosted pages. The Origin is echoed on refusals too, so the page's own
 * code can read why it was refused instead of a bare "CORS error" in the
 * console: a refusal carries nothing but its reason.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkKey, looksPublishable, originAllowed, type PublishableKey, returnUrlAllowed } from '../commerce/connect.ts';
import { loadStore, type StoreRef } from '../commerce/store.ts';
import { countHit } from '../db/ratelimit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';

export interface StoreCaller {
  /** The publishable key sent, checked. */
  key: PublishableKey | null;
  /** The other site the page is on, when the call comes from one. */
  origin: string | null;
  store: StoreRef;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on store API requests that sent a publishable key or came from another site. */
    storeCaller: StoreCaller | null;
  }
}

export const STORE_CORS_METHODS = 'GET, POST, PUT, DELETE';
export const STORE_CORS_HEADERS = 'Authorization, Content-Type, Idempotency-Key, X-Floreo-Key';
const EXPOSED = 'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After, Idempotent-Replayed, Content-Disposition';
const WHERE = 'Settings → Developers';

/** The answer to a browser asking, before a cross-origin request, whether it may send it. Says yes to the asking: the request itself is what gets checked. */
export function answerStorePreflight(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const origin = request.headers.origin;
  if (request.method !== 'OPTIONS' || !origin || !request.headers['access-control-request-method'] || !request.url.startsWith('/v1/store/')) return undefined;
  return reply
    .header('Access-Control-Allow-Origin', origin)
    .header('Vary', 'Origin')
    .header('Access-Control-Allow-Methods', STORE_CORS_METHODS)
    .header('Access-Control-Allow-Headers', STORE_CORS_HEADERS)
    .header('Access-Control-Max-Age', '3600')
    .code(204)
    .send();
}

function presentedKey(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  if (bearer && (looksPublishable(bearer) || bearer.startsWith('etd_'))) return bearer;
  const header = request.headers['x-floreo-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = (request.query as Record<string, unknown> | undefined)?.key;
  return typeof q === 'string' && q.trim() ? q.trim() : undefined;
}

export interface StoreAccessOptions {
  /** Origins that are this app's own (the till apps). */
  ownOrigins?: ReadonlySet<string>;
  /** Requests a minute for one publishable key from one visitor. Default 300. */
  ratePerMinute?: number;
}

export function registerStoreAccess(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, options: StoreAccessOptions = {}) {
  const { db } = deps;
  const limit = options.ratePerMinute ?? 300;
  const ownHost = ctx.publicUrl ? new URL(ctx.publicUrl).host.toLowerCase() : null;

  /** A page of this app itself: the hosted store, the web app, a till. */
  const firstParty = (origin: string, request: FastifyRequest) => {
    if (options.ownOrigins?.has(origin)) return true;
    try {
      const host = new URL(origin).host.toLowerCase();
      return host === request.host.toLowerCase() || host === ownHost;
    } catch {
      return false;
    }
  };

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    const slug = (request.params as { slug?: string } | undefined)?.slug;
    if (!slug) return;
    // Photos are public and cached by address for a year: any page may use them, whoever asked first.
    if (route.endsWith('/images/:id')) {
      reply.header('Access-Control-Allow-Origin', '*');
      return;
    }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const crossSite = origin !== undefined && !firstParty(origin, request);
    if (crossSite) reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin').header('Access-Control-Expose-Headers', EXPOSED);
    const presented = presentedKey(request);
    if (!crossSite && (!presented || presented.startsWith('etd_'))) return;

    if (presented?.startsWith('etd_')) {
      throw new ApiError(403, 'secret_key_in_browser', `This is a secret API key, and it was sent from a web page (${origin}), where anyone can read it. Revoke it now in ${WHERE}, and use a publishable key (pk_…) in pages.`);
    }
    if (!presented) {
      throw new ApiError(401, 'publishable_key_required', `To use the store API from another site, send the store's publishable key: "Authorization: Bearer pk_…" or "?key=pk_…". Make one in ${WHERE}.`);
    }
    if (!looksPublishable(presented)) throw new ApiError(401, 'invalid_publishable_key', `"${presented.slice(0, 12)}…" is not a publishable key. They start with pk_test_ or pk_live_; copy yours from ${WHERE}.`);

    const store = await loadStore(db, slug, { requireOpen: false });
    const check = checkKey(store.settings.connect, store.environment, presented);
    if (!check.ok) {
      if (check.reason === 'revoked') throw new ApiError(401, 'publishable_key_revoked', `This publishable key was revoked. Make a new one in ${WHERE} and put it in the site.`);
      if (check.reason === 'test_key_on_live_store') throw new ApiError(403, 'test_key_on_live_store', `This is a test key, and the store "${slug}" is now live. Make a live key (pk_live_…) in ${WHERE} and put it in the site.`);
      if (check.reason === 'live_key_on_test_store') throw new ApiError(403, 'live_key_on_test_store', `This is a live key, and the store "${slug}" is in test mode. Use its test key (pk_test_…) from ${WHERE}.`);
      throw new ApiError(401, 'invalid_publishable_key', `This publishable key is not one of the store "${slug}". Check the store name and copy the key again from ${WHERE}.`);
    }
    const key = check.key;
    if (crossSite && !originAllowed(key, origin)) {
      throw new ApiError(403, 'origin_not_allowed', origin === 'null'
        ? `A page opened from a file can only use a test key. Serve the page from its site and add that site to the key in ${WHERE}.`
        : `${origin} is not on the list of sites of the key "${key.name}". Add it in ${WHERE} → Publishable keys.`);
    }
    // Buyer accounts sign in with a cookie of this app, which another site can neither send nor read.
    if (crossSite && /\/account(\/|$)/.test(route)) {
      throw new ApiError(403, 'hosted_only', `Buyer accounts work on the store's hosted pages only. Link buyers to ${(ctx.publicUrl ?? '').replace(/\/$/, '')}/${slug}/shop/account instead.`);
    }
    // Per visitor, so one busy page cannot use up the store's allowance for everyone. A server sending the key (no Origin) is not a visitor.
    if (crossSite) {
      const used = await countHit(db, `pk|${key.id}|${request.ip}`, 60_000);
      reply.header('X-RateLimit-Limit', String(limit));
      reply.header('X-RateLimit-Remaining', String(Math.max(0, limit - used)));
      if (used > limit) {
        reply.header('Retry-After', '60');
        throw new ApiError(429, 'rate_limited', `More than ${limit} requests in a minute from one visitor with this key; wait and retry after the Retry-After seconds`);
      }
    }
    request.storeCaller = { key, origin: crossSite ? origin : null, store };
  });

  // "?key=" is the publishable key, not part of any route's own query.
  app.addHook('preValidation', async (request) => {
    const q = request.query as Record<string, unknown> | undefined;
    if (q && 'key' in q) delete q.key;
  });
}

/**
 * Where to send the buyer back after paying, when the site asks for it
 * ("returnUrl"): only to a site on the list of the key that asked.
 */
export function checkedReturnUrl(request: FastifyRequest, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const key = request.storeCaller?.key;
  if (!key) throw new ApiError(422, 'invalid_return_url', 'returnUrl needs a publishable key: buyers are only sent back to a site on that key\'s list');
  if (!returnUrlAllowed(key, raw)) throw new ApiError(422, 'invalid_return_url', `returnUrl must be a page on one of the sites of the key "${key.name}" (${key.origins.join(', ') || 'none listed yet'}). Add the site in ${WHERE}.`);
  return raw;
}
