/**
 * What a secret API key may do, when it may do less than everything.
 *
 *   access   'full' (the default) or 'read': a read key may GET, and may not
 *            change anything (the few POSTs that only work something out,
 *            such as a document's preview, count as reading)
 *   areas    the parts of the API it may use, or all of them (the default)
 *   expires  the moment it stops working, or never (the default)
 *
 * Checked in one place, as the key is recognized (app.ts), by the route's
 * address, so no route can be reached around it: a key with areas is refused
 * anything outside them, including routes added later. Every route a key can
 * reach belongs to an area or is for people only; the server refuses to start
 * with one that is in neither (assertRouteHasArea), so a new route cannot be
 * forgotten here.
 *
 * A key made before scopes existed, or made without choosing, has full access
 * to every area and never expires: nothing changes for it.
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

export const KEY_AREAS = ['documents', 'customers', 'catalog', 'orders', 'reports', 'expenses', 'webhooks', 'business'] as const;
export type KeyArea = (typeof KEY_AREAS)[number];
export type KeyAccess = 'full' | 'read';

/** What each area is, for messages and the reference. */
export const AREA_NAMES: Record<KeyArea, string> = {
  documents: 'Documents',
  customers: 'Customers',
  catalog: 'Catalogue',
  orders: 'Orders',
  reports: 'Reports',
  expenses: 'Expenses',
  webhooks: 'Webhooks',
  business: 'Business',
};
export const AREA_COVERS: Record<KeyArea, string> = {
  documents: 'Invoices, receipts, credit and debit notes, payments received, what customers owe, quotes, recurring invoices, jobs',
  customers: 'Saved customers and their loyalty points',
  catalog: 'Items, products, collections, discounts, stock, purchase orders, the store\'s settings and site',
  orders: 'Online orders, gift cards, unfinished checkouts, buyers',
  reports: 'Totals, GST, sales by customer and item, the register, the archive',
  expenses: 'Suppliers, expenses and bills, repeating expenses',
  webhooks: 'Webhook endpoints and their deliveries',
  business: 'The business\'s details and certificate, templates, payment accounts, registers, shifts, tills, the time clock, integrations',
};

/** The first part of a route's address after /v1/ → its area; 'people' for what is only ever done signed in. */
const AREA_OF: Record<string, KeyArea | 'people'> = {
  documents: 'documents', payments: 'documents', receivables: 'documents', 'receivable-settings': 'documents', quotes: 'documents', recurring: 'documents',
  work: 'documents', 'held-sales': 'documents', 'bill-payments': 'documents', layaways: 'documents',
  customers: 'customers', 'loyalty-settings': 'customers',
  items: 'catalog', products: 'catalog', collections: 'catalog', discounts: 'catalog', inventory: 'catalog', 'inventory.csv': 'catalog', 'purchase-orders': 'catalog',
  'store-settings': 'catalog', 'store-site': 'catalog', 'store-domains': 'catalog',
  orders: 'orders', 'gift-cards': 'orders', 'store-checkouts': 'orders', 'store-buyers': 'orders',
  reports: 'reports',
  expenses: 'expenses', 'expenses.csv': 'expenses', 'expense-categories': 'expenses', suppliers: 'expenses', 'recurring-expenses': 'expenses',
  webhooks: 'webhooks',
  me: 'business', business: 'business', certificate: 'business', templates: 'business', 'payment-accounts': 'business', 'counter-settings': 'business',
  registers: 'business', shifts: 'business', timeclock: 'business', pos: 'business', integrations: 'business', connectors: 'business', billing: 'business',
  // People, signed in: accounts, keys, the logs. A key is refused these whatever its scope.
  users: 'people', audit: 'people', 'api-keys': 'people', 'publishable-keys': 'people', developer: 'people', mail: 'people',
};

/** POSTs that only work something out and change nothing: a read key may use them. */
const READS_BY_POST = new Set(['/v1/documents/preview', '/v1/collections/preview', '/v1/templates/:key/preview', '/v1/gift-cards/check']);

/** May a read-only key use this? Looking, or one of the POSTs that only work something out. */
export const readOnlyMayUse = (method: string, route: string) => method === 'GET' || method === 'HEAD' || READS_BY_POST.has(route);

const segment = (route: string) => route.replace(/^\/v1\//, '').split('/')[0] ?? '';

/** The area a route belongs to ('people' for what keys never reach), or undefined when it has none. */
export function areaOfRoute(route: string): KeyArea | 'people' | undefined {
  return AREA_OF[segment(route)];
}

/** At start-up, for each route a key can reach: it must have an area, or the server does not start. */
export function assertRouteHasArea(route: string): void {
  if (areaOfRoute(route) === undefined) {
    throw new Error(`The route ${route} belongs to no API key area. Add "${segment(route)}" to AREA_OF in src/api/key-scope.ts (an area, or 'people' if keys must never reach it).`);
  }
}

export interface KeyScope {
  name: string;
  access: KeyAccess;
  areas: KeyArea[] | null;
  expiresAt: Date | null;
}

const WHERE = 'Settings → Developers';
const names = (areas: readonly KeyArea[]) => areas.map((a) => AREA_NAMES[a]).join(', ');

/** Refuse what this key may not do. Called once the key is known to be one of the business's. */
export function enforceKeyScope(request: FastifyRequest, key: KeyScope, now = new Date()): void {
  if (key.expiresAt && key.expiresAt <= now) {
    throw new ApiError(401, 'api_key_expired', `The key "${key.name}" expired on ${key.expiresAt.toISOString().slice(0, 10)}. Make a new one in ${WHERE}.`);
  }
  if (key.access === 'full' && !key.areas) return;
  const route = request.routeOptions.url ?? request.url.split('?')[0]!;
  const what = `${request.method} ${route}`;
  if (key.access === 'read' && !readOnlyMayUse(request.method, route)) {
    throw new ApiError(403, 'key_read_only', `The key "${key.name}" is read-only, so it cannot ${what}. Use a key that may make changes (${WHERE}).`);
  }
  if (!key.areas) return;
  // Asking who the key is and what it may do is always allowed.
  if (route === '/v1/me' && request.method === 'GET') return;
  const area = areaOfRoute(route);
  if (area === 'people' || area === undefined) return; // refused for every key by the route itself, or no such route
  if (!key.areas.includes(area)) {
    throw new ApiError(403, 'key_scope', `The key "${key.name}" may not use ${AREA_NAMES[area]} (${what}). It is limited to: ${names(key.areas)}. Make a key that includes ${AREA_NAMES[area]} in ${WHERE}.`, { needs: area, has: key.areas });
  }
}

/** The key as its owner sees it: what it may do. */
export const scopeJson = (key: { access: KeyAccess; areas: KeyArea[] | null; expiresAt: Date | null }, now = new Date()) => ({
  access: key.access,
  areas: key.areas,
  expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
  expired: Boolean(key.expiresAt && key.expiresAt <= now),
});

/** "2026-12-31" → the end of that day in Belize (UTC-6): the key works through the day it names. Throws with a reason. */
export function expiryFromDay(day: string, now = new Date()): Date {
  const end = new Date(`${day}T23:59:59.999-06:00`);
  if (Number.isNaN(end.getTime())) throw new ApiError(422, 'invalid_expiry', `${day} is not a date. Use the form 2026-12-31.`);
  if (end <= now) throw new ApiError(422, 'invalid_expiry', 'The last day a key works must be today or later');
  return end;
}
