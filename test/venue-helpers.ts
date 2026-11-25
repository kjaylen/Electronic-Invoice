/** What the hospitality tests share: a business with the module on, people with roles, and operations sent as one of them. */

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser, setPin } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import type { Check } from '../src/venue/check.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
type Headers = Record<string, string>;
export interface VenueCtx { f: PipelineFixture; app: FastifyInstance; owner: Headers; login: (email: string) => Promise<Headers>; person: (name: string, role: string, pin?: string) => Promise<{ id: string; headers: Headers }> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

export async function withVenue(fn: (c: VenueCtx) => Promise<void>, kinds: Record<string, unknown> | null = { restaurant: true, bar: true }) {
  const f = await setupPipeline();
  for (const t of ['01', '02', '04'] as const) f.bts.script(SUBMIT_PATHS[t], AUTHORIZED);
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const person = async (name: string, role: string, pin?: string) => {
    const email = `${name.toLowerCase()}@biz.example`;
    const u = await createUser(f.db, { tenantId: f.tenantA, name, email, role: role as 'server', password: PASSWORD });
    if (pin) await setPin(f.db, f.tenantA, u.id, pin);
    return { id: u.id, headers: await login(email) };
  };
  try {
    const owner = await login('olive@biz.example');
    if (kinds) assert.equal((await app.inject({ method: 'PUT', url: '/v1/venue/settings', headers: owner, payload: kinds })).statusCode, 200);
    await fn({ f, app, owner, login, person });
  } finally {
    await app.close();
    await f.close();
  }
}

export const call = (c: VenueCtx, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = c.owner) => c.app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
export async function menuItem(c: VenueCtx, name: string, price: string, category: string, extra: Record<string, unknown> = {}) {
  const r = await call(c, 'POST', '/v1/items', { name, unitCode: 'H87', unitPrice: price, gstCategory: 'S', category, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
/** Send operations as one person; returns each one's result. */
export async function ops(c: VenueCtx, headers: Headers, list: Array<{ checkId: string; type: string; payload?: Record<string, unknown>; id?: string; at?: string }>) {
  const r = await call(c, 'POST', '/v1/venue/ops', { ops: list.map((o) => ({ id: o.id ?? randomUUID(), checkId: o.checkId, type: o.type, at: o.at ?? new Date().toISOString(), payload: o.payload ?? {} })) }, headers);
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { results: Array<{ id: string; ok: boolean; reason?: string; code?: string; duplicate?: boolean; sent: string[] }>; seq: number };
}
export const check = async (c: VenueCtx, id: string) => (await call(c, 'GET', `/v1/venue/checks/${id}`)).json() as Check & { number: number };

