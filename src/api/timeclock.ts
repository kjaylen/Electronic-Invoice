/**
 * The time clock: staff clock in and out (at the counter or a till), and managers see the hours
 * each person worked, correct a forgotten clock-out, and download them for the payroll.
 *
 *   GET  /v1/timeclock/me              my open entry (or null) and my hours today and this week
 *   POST /v1/timeclock/in              { note? }
 *   POST /v1/timeclock/out             { note? }
 *   GET  /v1/timeclock?from&to&userId  entries and hours per person (owners, admins, managers); format=csv
 *   PUT  /v1/timeclock/:id             { clockIn, clockOut | null, note? }: a correction (audited)
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { csvCell } from './reports.ts';
import { date as dateSchema, uuid } from './schemas.ts';

/** An open entry older than this is a forgotten clock-out: it stops counting. */
const MAX_SHIFT_HOURS = 16;
const belizeDay = (d: Date) => new Date(d.getTime() - 6 * 3600_000).toISOString().slice(0, 10);
/** Midnight in Belize (UTC−6) of a Belize date, as a moment. */
const belizeMidnight = (day: string) => new Date(`${day}T06:00:00Z`);

interface EntryRow { id: string; user_id: string; user_name: string; clock_in: Date | string; clock_out: Date | string | null; note: string | null; edited: boolean }

/** Hours between two moments (an open entry counts up to now, at most MAX_SHIFT_HOURS). */
function hours(row: { clock_in: Date | string; clock_out: Date | string | null }, now = new Date()): number {
  const start = new Date(row.clock_in).getTime();
  const end = row.clock_out ? new Date(row.clock_out).getTime() : Math.min(now.getTime(), start + MAX_SHIFT_HOURS * 3600_000);
  return Math.max(0, end - start) / 3600_000;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const entryJson = (r: EntryRow) => ({
  id: r.id, userId: r.user_id, name: r.user_name, clockIn: new Date(r.clock_in).toISOString(), clockOut: r.clock_out ? new Date(r.clock_out).toISOString() : null,
  hours: round2(hours(r)), note: r.note, edited: r.edited, day: belizeDay(new Date(r.clock_in)),
});

export function registerTimeclockRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const person = (request: FastifyRequest) => {
    if (!request.userId) throw new ApiError(403, 'forbidden', 'Sign in as a person to use the time clock');
    return request.userId;
  };
  const noteBody = { type: ['object', 'null'], additionalProperties: false, properties: { note: { type: 'string', maxLength: 200 } } } as const;

  const mine = async (userId: string, tenantId: string) => {
    const now = new Date();
    const today = belizeDay(now);
    // The week starts on Monday.
    const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    const monday = new Date(Date.parse(`${today}T12:00:00Z`) - dow * 86_400_000).toISOString().slice(0, 10);
    const rows = (await db.query<EntryRow>(
      `select e.id, e.user_id, u.name as user_name, e.clock_in, e.clock_out, e.note, e.edited from time_entries e join users u on u.id = e.user_id
       where e.tenant_id = $1 and e.user_id = $2 and (e.clock_out is null or e.clock_in >= $3) order by e.clock_in desc limit 100`,
      [tenantId, userId, belizeMidnight(monday)],
    )).rows;
    const open = rows.find((r) => r.clock_out === null && hours(r, now) < MAX_SHIFT_HOURS) ?? null;
    const sum = (from: string) => round2(rows.filter((r) => belizeDay(new Date(r.clock_in)) >= from).reduce((a, r) => a + hours(r, now), 0));
    return { open: open ? entryJson(open) : null, today: sum(today), week: sum(monday) };
  };

  app.get('/timeclock/me', async (request) => mine(person(request), request.tenantId));

  app.post<{ Body: { note?: string } | null }>('/timeclock/in', { schema: { body: noteBody } }, async (request, reply) => {
    const userId = person(request);
    const state = await mine(userId, request.tenantId);
    if (state.open) throw new ApiError(409, 'already_in', 'You are already clocked in');
    // A forgotten clock-out older than a shift is closed where it stopped counting.
    await db.query(
      `update time_entries set clock_out = clock_in + interval '${MAX_SHIFT_HOURS} hours', edited = true where tenant_id = $1 and user_id = $2 and clock_out is null`,
      [request.tenantId, userId],
    );
    await db.query('insert into time_entries (id, tenant_id, user_id, clock_in, device_id, note) values ($1, $2, $3, now(), $4, $5)',
      [randomUUID(), request.tenantId, userId, request.posDevice?.id ?? null, request.body?.note?.trim() || null]);
    return reply.code(201).send(await mine(userId, request.tenantId));
  });

  app.post<{ Body: { note?: string } | null }>('/timeclock/out', { schema: { body: noteBody } }, async (request) => {
    const userId = person(request);
    const r = await db.query(
      `update time_entries set clock_out = now(), note = coalesce($3, note) where tenant_id = $1 and user_id = $2 and clock_out is null
         and clock_in > now() - interval '${MAX_SHIFT_HOURS} hours' returning id`,
      [request.tenantId, userId, request.body?.note?.trim() || null],
    );
    if (!r.rows.length) throw new ApiError(409, 'not_in', 'You are not clocked in');
    return mine(userId, request.tenantId);
  });

  const list = async (tenantId: string, q: { from: string; to: string; userId?: string }) => {
    const rows = (await db.query<EntryRow>(
      `select e.id, e.user_id, u.name as user_name, e.clock_in, e.clock_out, e.note, e.edited from time_entries e join users u on u.id = e.user_id
       where e.tenant_id = $1 and e.clock_in >= $2 and e.clock_in < $3 and ($4::uuid is null or e.user_id = $4) order by e.clock_in desc limit 5000`,
      [tenantId, belizeMidnight(q.from), new Date(belizeMidnight(q.to).getTime() + 86_400_000), q.userId ?? null],
    )).rows;
    const people = new Map<string, { userId: string; name: string; hours: number; days: Set<string>; open: boolean }>();
    for (const r of rows) {
      const p = people.get(r.user_id) ?? { userId: r.user_id, name: r.user_name, hours: 0, days: new Set<string>(), open: false };
      p.hours += hours(r);
      p.days.add(belizeDay(new Date(r.clock_in)));
      if (!r.clock_out && hours(r) < MAX_SHIFT_HOURS) p.open = true;
      people.set(r.user_id, p);
    }
    return {
      people: [...people.values()].sort((a, b) => b.hours - a.hours).map((p) => ({ userId: p.userId, name: p.name, hours: round2(p.hours), days: p.days.size, clockedIn: p.open })),
      entries: rows.map(entryJson),
    };
  };
  const manager = (request: FastifyRequest) => {
    if (!can(request.principal, 'documents.adjust')) requirePermission(request, 'business.manage');
  };

  app.get<{ Querystring: { from: string; to: string; userId?: string; format?: 'json' | 'csv' } }>(
    '/timeclock',
    { schema: { querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: dateSchema, to: dateSchema, userId: uuid, format: { type: 'string', enum: ['json', 'csv'] } } } } },
    async (request, reply: FastifyReply) => {
      manager(request);
      const q = request.query;
      if (q.from > q.to) throw new ApiError(400, 'invalid_request', '"from" must be on or before "to"');
      if (Date.parse(q.to) - Date.parse(q.from) > 400 * 86_400_000) throw new ApiError(400, 'invalid_request', 'Choose a period of at most a year');
      const r = await list(request.tenantId, q);
      if (q.format === 'csv') {
        const time = (iso: string | null) => (iso ? new Date(Date.parse(iso) - 6 * 3600_000).toISOString().slice(11, 16) : '');
        const lines = [['Person', 'Day', 'In', 'Out', 'Hours', 'Note'].join(','),
          ...r.entries.slice().reverse().map((e) => [csvCell(e.name), e.day, time(e.clockIn), time(e.clockOut), e.hours.toFixed(2), csvCell(e.note ?? '')].join(','))];
        return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="hours-${q.from}-to-${q.to}.csv"`).send(`﻿${lines.join('\r\n')}\r\n`);
      }
      return r;
    },
  );

  app.put<{ Params: { id: string }; Body: { clockIn: string; clockOut: string | null; note?: string | null } }>(
    '/timeclock/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: {
          type: 'object', required: ['clockIn', 'clockOut'], additionalProperties: false,
          properties: { clockIn: { type: 'string', format: 'date-time' }, clockOut: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] }, note: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] } },
        },
      },
    },
    async (request) => {
      manager(request);
      const b = request.body;
      const start = new Date(b.clockIn);
      const end = b.clockOut ? new Date(b.clockOut) : null;
      if (end && end <= start) throw new ApiError(422, 'invalid_entry', 'Clocking out must come after clocking in');
      if (end && end.getTime() - start.getTime() > 24 * 3600_000) throw new ApiError(422, 'invalid_entry', 'An entry is at most 24 hours');
      if (start.getTime() > Date.now() + 60_000) throw new ApiError(422, 'invalid_entry', 'Not in the future');
      const before = (await db.query<{ clock_in: Date; clock_out: Date | null; user_name: string }>(
        'select e.clock_in, e.clock_out, u.name as user_name from time_entries e join users u on u.id = e.user_id where e.id = $1 and e.tenant_id = $2', [request.params.id, request.tenantId],
      )).rows[0];
      if (!before) throw notFound('Time entry');
      // A note left out stays as it was.
      await db.query('update time_entries set clock_in = $3, clock_out = $4, note = case when $6::boolean then $5 else note end, edited = true where id = $1 and tenant_id = $2',
        [request.params.id, request.tenantId, start, end, b.note?.trim() || null, b.note !== undefined]);
      await audit(db, {
        tenantId: request.tenantId, userId: request.userId || null, action: 'timeclock.corrected', target: before.user_name,
        details: { from: { in: new Date(before.clock_in).toISOString(), out: before.clock_out ? new Date(before.clock_out).toISOString() : null }, to: { in: start.toISOString(), out: end?.toISOString() ?? null } }, ip: request.ip,
      });
      const row = (await db.query<EntryRow>(
        'select e.id, e.user_id, u.name as user_name, e.clock_in, e.clock_out, e.note, e.edited from time_entries e join users u on u.id = e.user_id where e.id = $1', [request.params.id],
      )).rows[0]!;
      return entryJson(row);
    },
  );
}
