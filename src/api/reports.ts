/**
 * Reports for a period (issue dates, Belize time): totals and GST by rate,
 * sales by day, by customer and by item, and the document register.
 *
 * Only documents with legal value count: authorized (with or without notes)
 * and those issued in contingency, in the business's current BTS environment
 * (after going live, test documents never mix into real figures). Credit notes subtract; debit notes add.
 * Every report is also available as CSV (?format=csv) for the accountant.
 *
 * GET /v1/reports/archive?from&to[&pdf=true] downloads everything for the
 * period as one ZIP: each document's signed XML exactly as sent to BTS, BTS's
 * reply, cancellation events, the register as CSV and (optionally) the PDFs.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../db/audit.ts';
import { toBigInt } from '../db/database.ts';
import { formatCents } from '../engine/decimal.ts';
import { ETD_TYPE_NAMES, type IssuedEtdType } from '../engine/ubl.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderSheet } from '../render/pdf.ts';
import { readEtdForPrint } from '../render/view.ts';
import { ZipWriter } from '../render/zip.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { date } from './schemas.ts';
import { logoForPdf } from '../templates/assets.ts';

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

/** In the archive: documents with legal value, and those cancelled afterwards (their record still matters). */
const ARCHIVED_STATUSES = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending', 'cancelled'];
const PDF_STATUSES = ['authorized', 'authorized_with_alert', 'contingency_pending'];
export const MAX_ARCHIVE_DOCUMENTS = 20_000;

function archiveReadme(biz: { tin: string; name: string; environment: string }, from: string, to: string, count: number, pdf: boolean): string {
  return [
    `${biz.name} (TIN ${biz.tin}): electronic tax documents issued ${from} to ${to}.`,
    biz.environment === 'production' ? '' : 'TEST ENVIRONMENT: these documents have no tax value.',
    '',
    `${count} document(s). Created ${new Date().toISOString()}.`,
    '',
    'register.csv    Every document of the period, any status (including rejected ones, which are not in the folders).',
    'signed-xml/     Each document exactly as signed and sent to the Belize Tax Service (the legal record).',
    'bts-replies/    BTS\'s answer to each document (authorization, alert or rejection).',
    'events/         Cancellation events registered with BTS.',
    pdf ? 'pdf/            The printed copy of each valid document.' : '',
    '',
    'Keep this archive for as long as the law requires you to keep tax records.',
    '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\r\n');
}
const num = (v: unknown) => ({ v, text: false });
const txt = (v: unknown) => ({ v });

export function registerReportRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const base = `d.tenant_id = $1 and d.issue_date between $2::date and $3::date and d.status = any($4::text[])
    and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
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

  // Who sold what: documents, sales and discounts given per person (API keys and automatic documents together).
  app.get<PeriodQuery>('/reports/staff', { schema: { querystring: periodQuery } }, async (request, reply) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    const rows = (await db.query<{ name: string | null; n: number; total: string; discounts: string; receipts: number; receipt_total: string }>(
      `select u.name, count(*)::int as n, ${signed('d.tax_inclusive_cents')} as total,
         coalesce(sum((select coalesce(sum(greatest(round(l.quantity * l.unit_price * 100)::bigint - l.net_cents, 0)), 0)
                       from document_lines l where l.document_id = d.id and l.tenant_id = d.tenant_id)) filter (where d.etd_type in ('01', '02')), 0) as discounts,
         (count(*) filter (where d.etd_type = '02'))::int as receipts,
         coalesce(sum(d.tax_inclusive_cents) filter (where d.etd_type = '02'), 0) as receipt_total
       from documents d left join users u on u.id = d.issued_by
       where ${base} group by u.id, u.name order by total desc nulls last limit 200`, args(request.tenantId, q),
    )).rows;
    const data = rows.map((r) => ({
      name: r.name, documents: r.n, total: cents(r.total), discounts: cents(r.discounts), receipts: r.receipts,
      averageReceipt: r.receipts ? formatCents(toBigInt(r.receipt_total) / BigInt(r.receipts)) : null,
    }));
    if (q.format === 'csv') {
      return sendCsv(reply, 'sales-by-staff', q.from, q.to, toCsv(['Person', 'Documents', 'Total (BZD)', 'Discounts given (BZD)', 'Receipts', 'Average receipt (BZD)'],
        rows.map((r) => [txt(r.name ?? 'API and automatic'), num(r.n), money(r.total), money(r.discounts), num(r.receipts), r.receipts ? money(toBigInt(r.receipt_total) / BigInt(r.receipts)) : txt('')])));
    }
    return { data };
  });

  // When customers buy: sales and documents by hour of the day (invoices and receipts, Belize time).
  app.get<PeriodQuery>('/reports/hours', { schema: { querystring: periodQuery } }, async (request) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    const rows = (await db.query<{ hour: number; n: number; total: string }>(
      `select extract(hour from d.issue_time)::int as hour, count(*)::int as n, coalesce(sum(d.tax_inclusive_cents), 0) as total
       from documents d where ${base} and d.etd_type in ('01', '02') group by 1 order by 1`, args(request.tenantId, q),
    )).rows;
    return { data: rows.map((r) => ({ hour: r.hour, documents: r.n, total: cents(r.total) })) };
  });

  /** The document register: every document of the period, any status (for the accountant, and in the archive). */
  const registerCsv = async (tenantId: string, q: { from: string; to: string }): Promise<string> => {
    const rows = (await db.query<{ issue_date: string; issue_time: string; etd_type: IssuedEtdType; series_number: number; serial: string; etdui: string; name: string | null; tin: string | null; net: string; gst: string; tax: string; total: string; status: string; protocol_number: string | null; referenced_etdui: string | null }>(
      `select d.issue_date::text as issue_date, d.issue_time::text as issue_time, d.etd_type, d.series_number, d.serial::text as serial, d.etdui,
         d.customer_snapshot->>'name' as name, d.customer_snapshot->>'tin' as tin, d.line_extension_cents as net, d.gst_cents as gst, d.tax_cents as tax,
         d.tax_inclusive_cents as total, d.status, d.protocol_number, d.referenced_etdui
       from documents d where d.tenant_id = $1 and d.issue_date between $2::date and $3::date
         and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)
       order by d.issue_date, d.issue_time, d.etd_type, d.serial limit 100000`, [tenantId, q.from, q.to],
    )).rows;
    const header = ['Date', 'Time', 'Type', 'Number', 'ETDUI', 'Customer', 'Customer TIN', 'Net (BZD)', 'GST (BZD)', 'All taxes (BZD)', 'Total (BZD)', 'Status', 'BTS authorization', 'References'];
    return toCsv(header, rows.map((r) => [
      txt(r.issue_date), txt(r.issue_time.slice(0, 8)), txt(ETD_TYPE_NAMES[r.etd_type]),
      txt(`${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}`), txt(r.etdui), txt(r.name), txt(r.tin),
      money(r.net), money(r.gst), money(r.tax), money(r.total), txt(r.status), txt(r.protocol_number), txt(r.referenced_etdui),
    ]));
  };

  app.get<PeriodQuery>('/reports/documents', { schema: { querystring: periodQuery } }, async (request, reply) => {
    const q = request.query;
    requirePermission(request, 'reports.view');
    checkPeriod(q);
    return sendCsv(reply, 'documents', q.from, q.to, await registerCsv(request.tenantId, q));
  });

  app.get<{ Querystring: { from: string; to: string; pdf?: 'true' | 'false' } }>(
    '/reports/archive',
    { schema: { querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: date, to: date, pdf: { type: 'string', enum: ['true', 'false'] } } } } },
    async (request, reply) => {
      const q = { ...request.query, pdf: request.query.pdf === 'true' };
      requirePermission(request, 'reports.view');
      checkPeriod(q);
      const tenantId = request.tenantId;
      const envOf = `(select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
      const where = `d.tenant_id = $1 and d.issue_date between $2::date and $3::date and d.reception_env = ${envOf} and d.status = any($4::text[])`;
      const args = [tenantId, q.from, q.to, ARCHIVED_STATUSES];
      const count = (await db.query<{ n: number }>(`select count(*)::int as n from documents d where ${where}`, args)).rows[0]!.n;
      if (count > MAX_ARCHIVE_DOCUMENTS) {
        throw new ApiError(422, 'too_many_documents', `This period has ${count} documents; download at most ${MAX_ARCHIVE_DOCUMENTS} at a time (choose a shorter period)`);
      }
      const biz = (await db.query<{ tin: string; name: string; environment: string }>('select tin, coalesce(trade_name, legal_name) as name, environment from tenants where id = $1', [tenantId])).rows[0]!;
      await audit(db, { tenantId, userId: request.userId || null, action: 'documents.exported', target: `${q.from} to ${q.to}`, details: { documents: count, pdf: Boolean(q.pdf) }, ip: request.ip });

      const zip = new ZipWriter();
      const produce = async () => {
        await zip.add('README.txt', archiveReadme(biz, q.from, q.to, count, Boolean(q.pdf)));
        await zip.add('register.csv', await registerCsv(tenantId, q));
        const BATCH = 100;
        for (let offset = 0; offset < count; offset += BATCH) {
          const docs = (await db.query<{ id: string; etd_type: IssuedEtdType; series_number: number; serial: string; issue_date: string; issue_time: string; signed_xml: string; status: string; protocol_number: string | null }>(
            `select d.id, d.etd_type, d.series_number, d.serial::text as serial, d.issue_date::text as issue_date, d.issue_time::text as issue_time, d.signed_xml, d.status, d.protocol_number
             from documents d where ${where} order by d.issue_date, d.issue_time, d.etd_type, d.serial limit ${BATCH} offset ${offset}`, args,
          )).rows;
          if (docs.length === 0) break;
          const ids = docs.map((d) => d.id);
          const replies = new Map((await db.query<{ document_id: string; raw_reply: string }>(
            `select distinct on (document_id) document_id, raw_reply from submissions
             where tenant_id = $1 and document_id = any($2::uuid[]) and raw_reply like '<%' order by document_id, attempt desc`, [tenantId, ids],
          )).rows.map((r) => [r.document_id, r.raw_reply]));
          const events = (await db.query<{ document_id: string; event_code: string; serial: string; signed_xml: string; created_at: Date }>(
            `select document_id, event_code, serial::text as serial, signed_xml, created_at from events
             where tenant_id = $1 and document_id = any($2::uuid[]) and status in ('registered', 'pending') order by serial`, [tenantId, ids],
          )).rows;
          let logo: Buffer | null | undefined;
          for (const d of docs) {
            const name = `${d.issue_date}_${ETD_TYPE_NAMES[d.etd_type].replace(/ /g, '-')}_${String(d.series_number).padStart(3, '0')}-${d.serial.padStart(9, '0')}`;
            // Belize wall-clock time, stored in the ZIP's time fields.
            const when = new Date(`${d.issue_date}T${d.issue_time.slice(0, 8)}Z`);
            await zip.add(`signed-xml/${name}.xml`, d.signed_xml, when);
            const answer = replies.get(d.id);
            if (answer) await zip.add(`bts-replies/${name}.xml`, answer, when);
            for (const e of events.filter((x) => x.document_id === d.id)) {
              await zip.add(`events/${name}_event-${e.event_code}-${e.serial.padStart(9, '0')}.xml`, e.signed_xml, new Date(e.created_at));
            }
            if (q.pdf && PDF_STATUSES.includes(d.status)) {
              logo ??= (await logoForPdf(db, request.tenantId)) ?? null;
              const pdf = await renderSheet(readEtdForPrint(d.signed_xml), { ...(d.protocol_number && { protocolNumber: d.protocol_number }), ...(logo && { logo }) });
              await zip.add(`pdf/${name}.pdf`, pdf, when);
            }
          }
        }
        await zip.finish();
      };
      void produce().catch((err: Error) => {
        request.log.error({ err }, 'archive export failed part-way');
        zip.abort(err);
      });
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="documents-${biz.environment === 'production' ? '' : 'TEST-'}${q.from}-to-${q.to}.zip"`)
        .header('Cache-Control', 'no-store')
        .send(zip.stream);
    },
  );
}
