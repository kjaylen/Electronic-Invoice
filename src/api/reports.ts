/**
 * Reports for a period (issue dates, Belize time): totals and GST by rate,
 * sales by day, by customer and by item, and the document register.
 *
 * Only documents with legal value count: authorized (with or without notes)
 * and those issued in contingency. Credit notes subtract; debit notes add.
 * Every report is also available as CSV (?format=csv) for the accountant.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import { ETD_TYPE_NAMES, type IssuedEtdType } from '../engine/ubl.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { date } from './schemas.ts';

export const COUNTED_STATUSES = ['authorized', 'authorized_with_alert', 'contingency_pending'];
const signed = (col: string) => `sum(case when d.etd_type = '04' then -${col} else ${col} end)`;
const cents = (v: unknown) => formatCents(toBigInt(v ?? 0));

/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(value: unknown, text = true): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Array<Array<{ v: unknown; text?: boolean }>>): string {
  return `﻿${[header.map((h) => csvCell(h)).join(','), ...rows.map((r) => r.map((c) => csvCell(c.v, c.text ?? true)).join(','))].join('\r\n')}\r\n`;
}

function sendCsv(reply: FastifyReply, name: string, from: string, to: string, csv: string) {
  return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}-${from}-to-${to}.csv"`).send(csv);
}

const periodQuery = {
  type: 'object',
  required: ['from', 'to'],
  additionalProperties: false,
  properties: { from: date, to: date, format: { type: 'string', enum: ['json', 'csv'] } },
} as const;

type PeriodQuery = { Querystring: { from: string; to: string; format?: 'json' | 'csv' } };

function checkPeriod(q: { from: string; to: string }) {
  if (Number.isNaN(Date.parse(q.from)) || Number.isNaN(Date.parse(q.to))) throw new ApiError(400, 'invalid_request', 'Invalid date');
  if (q.from > q.to) throw new ApiError(400, 'invalid_request', '"from" must be on or before "to"');
  if (Date.parse(q.to) - Date.parse(q.from) > 3 * 366 * 86_400_000) throw new ApiError(400, 'invalid_request', 'Choose a period of at most three years');
}

const money = (v: unknown) => ({ v: cents(v), text: false });
const num = (v: unknown) => ({ v, text: false });
const txt = (v: unknown) => ({ v });

export function registerReportRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const base = `d.tenant_id = $1 and d.issue_date between $2::date and $3::date and d.status = any($4::text[])`;
  const args = (tenantId: string, q: { from: string; to: string }) => [tenantId, q.from, q.to, COUNTED_STATUSES];

  app.get<PeriodQuery>('/reports/summary', { schema: { querystring: periodQuery } }, async (request, reply) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    const p = args(request.tenantId, q);
    const byType = (await db.query<{ etd_type: IssuedEtdType; n: number; net: string; gst: string; tax: string; total: string }>(
      `select d.etd_type, count(*)::int as n, sum(d.line_extension_cents) as net, sum(d.gst_cents) as gst, sum(d.tax_cents) as tax, sum(d.tax_inclusive_cents) as total
       from documents d where ${base} group by d.etd_type order by d.etd_type`, p,
    )).rows;
    const byRate = (await db.query<{ gst_category: 'S' | 'Z' | 'E'; net: string; gst: string }>(
      `select l.gst_category, ${signed('l.net_cents')} as net, ${signed('l.gst_cents')} as gst
       from document_lines l join documents d on d.id = l.document_id where ${base} group by l.gst_category order by l.gst_category`, p,
    )).rows;
    const totals = (await db.query<{ n: number; net: string; gst: string; tax: string; total: string }>(
      `select count(*)::int as n, ${signed('d.line_extension_cents')} as net, ${signed('d.gst_cents')} as gst, ${signed('d.tax_cents')} as tax, ${signed('d.tax_inclusive_cents')} as total
       from documents d where ${base}`, p,
    )).rows[0]!;
    const byDay = (await db.query<{ day: string; n: number; total: string }>(
      `select d.issue_date::text as day, count(*)::int as n, ${signed('d.tax_inclusive_cents')} as total from documents d where ${base} group by d.issue_date order by d.issue_date`, p,
    )).rows;
    const rateName = { S: 'Standard rate (12.5%)', Z: 'Zero-rated', E: 'Exempt' } as const;

    if (q.format === 'csv') {
      const rows = [
        ...byRate.map((r) => [txt(rateName[r.gst_category]), money(r.net), money(r.gst)]),
        [txt('Total'), money(totals.net), money(totals.gst)],
      ];
      return sendCsv(reply, 'gst-summary', q.from, q.to, toCsv(['GST rate', 'Net sales (BZD)', 'GST (BZD)'], rows));
    }
    return {
      period: { from: q.from, to: q.to },
      totals: { documents: totals.n, net: cents(totals.net), gst: cents(totals.gst), tax: cents(totals.tax), total: cents(totals.total) },
      byType: byType.map((r) => ({ type: r.etd_type, typeName: ETD_TYPE_NAMES[r.etd_type], documents: r.n, net: cents(r.net), gst: cents(r.gst), tax: cents(r.tax), total: cents(r.total) })),
      byRate: byRate.map((r) => ({ category: r.gst_category, name: rateName[r.gst_category], net: cents(r.net), gst: cents(r.gst) })),
      byDay: byDay.map((r) => ({ date: r.day, documents: r.n, total: cents(r.total) })),
    };
  });

  app.get<PeriodQuery>('/reports/customers', { schema: { querystring: periodQuery } }, async (request, reply) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    const rows = (await db.query<{ name: string; tin: string | null; n: number; net: string; gst: string; total: string }>(
      `select coalesce(nullif(d.customer_snapshot->>'name', ''), 'Walk-in customers') as name, d.customer_snapshot->>'tin' as tin, count(*)::int as n,
         ${signed('d.line_extension_cents')} as net, ${signed('d.gst_cents')} as gst, ${signed('d.tax_inclusive_cents')} as total
       from documents d where ${base} group by 1, 2 order by total desc nulls last limit 1000`, args(request.tenantId, q),
    )).rows;
    if (q.format === 'csv') {
      return sendCsv(reply, 'sales-by-customer', q.from, q.to, toCsv(['Customer', 'TIN', 'Documents', 'Net (BZD)', 'GST (BZD)', 'Total (BZD)'],
        rows.map((r) => [txt(r.name), txt(r.tin), num(r.n), money(r.net), money(r.gst), money(r.total)])));
    }
    return { data: rows.map((r) => ({ name: r.name, tin: r.tin, documents: r.n, net: cents(r.net), gst: cents(r.gst), total: cents(r.total) })) };
  });

  app.get<PeriodQuery>('/reports/items', { schema: { querystring: periodQuery } }, async (request, reply) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    const rows = (await db.query<{ description: string; unit_code: string; quantity: string; net: string; gst: string; total: string }>(
      `select l.description, l.unit_code, ${signed('l.quantity')}::text as quantity,
         ${signed('l.net_cents')} as net, ${signed('l.gst_cents')} as gst, ${signed('l.line_total_cents')} as total
       from document_lines l join documents d on d.id = l.document_id where ${base}
       group by l.description, l.unit_code order by total desc nulls last limit 1000`, args(request.tenantId, q),
    )).rows;
    const qty = (v: string) => String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    if (q.format === 'csv') {
      return sendCsv(reply, 'sales-by-item', q.from, q.to, toCsv(['Item', 'Unit', 'Quantity', 'Net (BZD)', 'GST (BZD)', 'Total (BZD)'],
        rows.map((r) => [txt(r.description), txt(r.unit_code), num(qty(r.quantity)), money(r.net), money(r.gst), money(r.total)])));
    }
    return { data: rows.map((r) => ({ description: r.description, unitCode: r.unit_code, quantity: qty(r.quantity), net: cents(r.net), gst: cents(r.gst), total: cents(r.total) })) };
  });

  // Every document in the period, whatever its status, for bookkeeping.
  app.get<PeriodQuery>('/reports/documents', { schema: { querystring: periodQuery } }, async (request, reply) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    const rows = (await db.query<{ issue_date: string; issue_time: string; etd_type: IssuedEtdType; series_number: number; serial: string; etdui: string; name: string | null; tin: string | null; net: string; gst: string; tax: string; total: string; status: string; protocol_number: string | null; referenced_etdui: string | null }>(
      `select d.issue_date::text as issue_date, d.issue_time::text as issue_time, d.etd_type, d.series_number, d.serial::text as serial, d.etdui,
         d.customer_snapshot->>'name' as name, d.customer_snapshot->>'tin' as tin, d.line_extension_cents as net, d.gst_cents as gst, d.tax_cents as tax,
         d.tax_inclusive_cents as total, d.status, d.protocol_number, d.referenced_etdui
       from documents d where d.tenant_id = $1 and d.issue_date between $2::date and $3::date
       order by d.issue_date, d.issue_time, d.etd_type, d.serial limit 100000`, [request.tenantId, q.from, q.to],
    )).rows;
    const header = ['Date', 'Time', 'Type', 'Number', 'ETDUI', 'Customer', 'Customer TIN', 'Net (BZD)', 'GST (BZD)', 'All taxes (BZD)', 'Total (BZD)', 'Status', 'BTS authorization', 'References'];
    return sendCsv(reply, 'documents', q.from, q.to, toCsv(header, rows.map((r) => [
      txt(r.issue_date), txt(r.issue_time.slice(0, 8)), txt(ETD_TYPE_NAMES[r.etd_type]),
      txt(`${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}`), txt(r.etdui), txt(r.name), txt(r.tin),
      money(r.net), money(r.gst), money(r.tax), money(r.total), txt(r.status), txt(r.protocol_number), txt(r.referenced_etdui),
    ])));
  });
}
