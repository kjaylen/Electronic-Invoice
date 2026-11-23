/**
 * Which business this page belongs to. Every business has its own address:
 * app.example.bz/<slug>/... The slug is read once from the URL when the app
 * loads; the router then runs under it (basename), so pages link to "/documents"
 * and land on "/<slug>/documents". Moving to another business is a full page load.
 */

import { store } from './storage';

/** First path segments that are the app's own pages, not businesses. */
const APP_PAGES = new Set(['signup', 'admin', 'docs', 'pricing', 'terms', 'privacy', 'pay', 'd', 'q', 'a']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function fromLocation(): string | null {
  const first = window.location.pathname.split('/')[1]?.toLowerCase() ?? '';
  return SLUG.test(first) && !APP_PAGES.has(first) ? first : null;
}

/** On a store's own domain (shop.example.bz), the server names the store in the page. */
const storeMeta = typeof document !== 'undefined' ? document.querySelector('meta[name="einvoicing-store"]')?.getAttribute('content') ?? null : null;
export const STORE_DOMAIN = Boolean(storeMeta && SLUG.test(storeMeta));

export const BUSINESS: string | null = STORE_DOMAIN ? storeMeta : fromLocation();

export interface RecentBusiness {
  slug: string;
  name: string;
}

const RECENT = 'etd.recent';

/** Businesses this device has signed in to, newest first (for the "find your business" page). */
export function recentBusinesses(): RecentBusiness[] {
  return store.get<RecentBusiness[]>(RECENT) ?? [];
}

export function rememberBusiness(b: RecentBusiness) {
  store.set(RECENT, [b, ...recentBusinesses().filter((x) => x.slug !== b.slug)].slice(0, 8));
}

export function forgetBusiness(slug: string) {
  store.set(RECENT, recentBusinesses().filter((x) => x.slug !== slug));
}

/** Full page load into a business (or to the start page with null). */
export function goToBusiness(slug: string | null, path = '') {
  window.location.assign(slug ? `/${slug}${path}` : `/${path.replace(/^\//, '')}`);
}
