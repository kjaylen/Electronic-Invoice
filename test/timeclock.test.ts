/**
 * The time clock: clock in and out once at a time, hours per person for managers (JSON and CSV),
 * corrections kept in the activity log, forgotten clock-outs closed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { setupPipeline } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

test('time clock: in, out, hours, corrections', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
    await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
    const cass = await createUser(f.db, { tenantId: f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const login = async (email: string) => ({ ...CSRF, cookie: cookieFrom(await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } })), 'x-business': slug });
    const owner = await login('olive@biz.example');
    const cashier = await login('cass@biz.example');
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, headers: typeof owner, payload?: object) => app.inject({ method, url, headers, ...(payload && { payload }) });

    assert.equal((await call('GET', '/v1/timeclock/me', cashier)).json().open, null);
    const inn = await call('POST', '/v1/timeclock/in', cashier, {});
    assert.equal(inn.statusCode, 201, inn.body);
    assert.ok(inn.json().open);
    assert.equal((await call('POST', '/v1/timeclock/in', cashier, {})).statusCode, 409);
    const out = await call('POST', '/v1/timeclock/out', cashier, { note: 'Lunch' });
    assert.equal(out.statusCode, 200);
    assert.equal(out.json().open, null);
    assert.equal((await call('POST', '/v1/timeclock/out', cashier, {})).statusCode, 409);

    // Yesterday's 8-hour day, and a clock-in forgotten 20 hours ago.
    const userId = cass.id;
    await f.db.query(`insert into time_entries (id, tenant_id, user_id, clock_in, clock_out) values (gen_random_uuid(), $1, $2, now() - interval '30 hours', now() - interval '22 hours')`, [f.tenantA, userId]);
    await f.db.query(`insert into time_entries (id, tenant_id, user_id, clock_in) values (gen_random_uuid(), $1, $2, now() - interval '20 hours')`, [f.tenantA, userId]);
    // The forgotten one does not count as open; clocking in closes it at 16 hours.
    assert.equal((await call('GET', '/v1/timeclock/me', cashier)).json().open, null);
    assert.equal((await call('POST', '/v1/timeclock/in', cashier, {})).statusCode, 201);
    const closed = (await f.db.query<{ h: string; edited: boolean }>(`select extract(epoch from clock_out - clock_in) / 3600 as h, edited from time_entries where user_id = $1 and clock_in between now() - interval '21 hours' and now() - interval '19 hours'`, [userId])).rows[0]!;
    assert.deepEqual([Number(closed.h), closed.edited], [16, true]);

    // Managers see everyone's hours; cashiers do not.
    const from = new Date(Date.now() - 3 * 86_400_000 - 6 * 3600_000).toISOString().slice(0, 10);
    const period = `from=${from}&to=${belizeToday()}`;
    assert.equal((await call('GET', `/v1/timeclock?${period}`, cashier)).statusCode, 403);
    const report = (await call('GET', `/v1/timeclock?${period}`, owner)).json();
    assert.equal(report.people.length, 1);
    assert.equal(report.people[0].name, 'Cass');
    assert.equal(report.people[0].clockedIn, true);
    assert.ok(report.people[0].hours >= 24 && report.people[0].hours < 24.1, String(report.people[0].hours)); // 8 + 16 + a moment
    const csv = await call('GET', `/v1/timeclock?${period}&format=csv`, owner);
    assert.match(csv.body.split('\r\n')[0]!, /Person,Day,In,Out,Hours,Note/);
    assert.match(csv.body, /Cass,\d{4}-\d{2}-\d{2},\d{2}:\d{2},\d{2}:\d{2},8\.00,/);

    // A correction: the 8-hour day was really 7.5, kept in the activity log.
    const day = report.entries.find((e: { hours: number }) => e.hours === 8);
    const start = new Date(day.clockIn);
    const fixed = await call('PUT', `/v1/timeclock/${day.id}`, owner, { clockIn: start.toISOString(), clockOut: new Date(start.getTime() + 7.5 * 3600_000).toISOString(), note: 'Left early' });
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.deepEqual([fixed.json().hours, fixed.json().edited, fixed.json().note], [7.5, true, 'Left early']);
    assert.equal((await call('PUT', `/v1/timeclock/${day.id}`, owner, { clockIn: start.toISOString(), clockOut: start.toISOString() })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/timeclock/${day.id}`, cashier, { clockIn: start.toISOString(), clockOut: null })).statusCode, 403);
    const logged = (await f.db.query<{ n: number }>(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'timeclock.corrected'`, [f.tenantA])).rows[0]!.n;
    assert.equal(logged, 1);
  } finally {
    await app.close();
    await f.close();
  }
});
