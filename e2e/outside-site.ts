/**
 * For the tests of sites built outside Floreo (embed.spec.ts, examples.spec.ts):
 * a business of their own in the BTS test environment with three products, an
 * open store that takes test card payments and a publishable key; and a
 * server on another origin to be the outside site.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect } from '@playwright/test';

export const SLUG = 'reef-goods';
export const OWNER = { name: 'Maya Reef', email: 'maya@reefgoods.test', password: 'reef goods test only 1' };
const cert = (name: string) => readFileSync(new URL(`../test/certs/${name}`, import.meta.url), 'utf8');

const PRODUCTS = [
  { title: 'Hot sauce trio', description: 'Three habanero sauces.\n\nMade in Belize.', status: 'active', variants: [{ price: '18.00', gstCategory: 'S', sellerCode: 'HOT-3' }] },
  { title: 'Island T-shirt', description: 'Soft cotton, printed in San Pedro.', status: 'active', option1Name: 'Size', variants: [{ option1: 'S', price: '40.00', gstCategory: 'S', stock: 50 }, { option1: 'M', price: '40.00', gstCategory: 'S', stock: 3 }, { option1: 'L', price: '40.00', gstCategory: 'S', stock: 0 }] },
  { title: 'Reef-safe sunscreen', description: 'Mineral sunscreen, SPF 30.', status: 'active', variants: [{ price: '24.00', compareAtPrice: '32.00', gstCategory: 'S' }] },
];

export interface Store {
  /** Calls as the business's owner. */
  api: APIRequestContext;
  /** A publishable test key made for this run. */
  key: string;
  order: (number: string) => Promise<{ number: number; paymentStatus: string; paymentMethod: string; documentId: string | null }>;
}

/** The business and its store, made once (a later run signs in to the one an earlier run made). */
export async function setUpStore(playwright: { request: { newContext: (options: object) => Promise<APIRequestContext> } }, floreo: string): Promise<Store> {
  const api = await playwright.request.newContext({ baseURL: floreo, extraHTTPHeaders: { 'X-Requested-With': 'etd-web', 'X-Business': SLUG } });
  const signup = await api.post('/v1/auth/signup', {
    data: {
      business: { legalName: 'Reef Goods Ltd', tradeName: 'Reef Goods', tin: '654321', address: { street: '12 Front Street', city: 'San Pedro', districtCode: '1' }, contact: { telephone: '501-226-0000', email: 'hello@reefgoods.test' } },
      owner: OWNER, sells: 'products',
    },
  });
  if (!signup.ok()) expect((await api.post('/v1/auth/login', { data: { business: SLUG, login: OWNER.email, password: OWNER.password } })).ok()).toBeTruthy();
  expect((await api.put('/v1/certificate', { data: { certificatePem: cert('signer-654321.cert.pem'), privateKeyPem: cert('signer-654321.key.pem') } })).ok()).toBeTruthy();
  const have = new Set(((await (await api.get('/v1/products')).json()).data as Array<{ handle: string }>).map((x) => x.handle));
  for (const product of PRODUCTS) {
    if (!have.has(product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'))) expect((await api.post('/v1/products', { data: product })).status()).toBe(201);
  }
  // A collection, for pages that show one (its products are named by their handles).
  const collections = (await (await api.get('/v1/collections')).json()).data as Array<{ handle: string }>;
  if (!collections.some((c) => c.handle === 'for-the-beach')) {
    expect((await api.post('/v1/collections', { data: { title: 'For the beach', products: ['island-t-shirt', 'reef-safe-sunscreen'], published: true } })).status()).toBe(201);
  }
  const settings = await api.put('/v1/store-settings', {
    data: {
      enabled: true, delivery: { enabled: true, zones: [{ name: 'San Pedro', fee: '8.00' }] }, pickup: { enabled: true, instructions: 'Ask at the counter' },
      payments: { bankTransfer: { enabled: true, instructions: 'Belize Bank 000-111, Reef Goods Ltd' }, cashOnDelivery: { enabled: true }, payAtPickup: { enabled: true }, online: { enabled: true, provider: 'test' } },
    },
  });
  expect(settings.ok(), await settings.text()).toBeTruthy();
  // Keys of earlier runs are revoked, so a store never fills up with them.
  for (const old of ((await (await api.get('/v1/publishable-keys')).json()).data as Array<{ id: string; name: string; revokedAt: string | null }>)) {
    if (!old.revokedAt && old.name.startsWith('Browser test')) await api.delete(`/v1/publishable-keys/${old.id}`);
  }
  const made = await api.post('/v1/publishable-keys', { data: { name: `Browser test ${Date.now()}` } });
  expect(made.status(), await made.text()).toBe(201);
  const key = (await made.json()).key as string;
  expect(key).toMatch(/^pk_test_/);
  return {
    api, key,
    order: async (number) => ((await (await api.get(`/v1/orders?view=all&q=${number}`)).json()).data as Array<{ number: number; paymentStatus: string; paymentMethod: string; documentId: string | null }>).find((o) => String(o.number) === number)!,
  };
}

export interface OutsideSite {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

/** The outside site: its own server, so its own origin. `respond` answers a path with a body and its type, or nothing for 404. */
export async function serveSite(respond: (path: string) => { body: string | Buffer; type: string } | undefined): Promise<OutsideSite> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/favicon.ico') return void res.writeHead(204).end();
    const answer = respond(path);
    if (!answer) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': answer.type, 'cache-control': 'no-store' }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
