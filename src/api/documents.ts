/**
 * Documents: issue, list, get, signed XML, printed copy (PDF), cancel.
 *
 * POST /v1/documents answers 201 whenever a document was created, whatever
 * BTS decided: check "status" (authorized, authorized_with_alert, rejected,
 * contingency_pending, pending). A rejected document still exists and used a
 * serial number; its "conditions" say which BTS rules failed.
 *
 * Send an Idempotency-Key header (any unique string per sale) so a retried
 * request returns the original response instead of issuing twice.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { formatCents } from '../engine/decimal.ts';
import type { LineInput } from '../engine/calc.ts';
import { BELIZE_DISTRICTS, type Customer, type DocumentReference, ETD_TYPE_NAMES, type IssuedEtdType } from '../engine/ubl.ts';
import { cancelDocument, issueDocument, type IssueRequest, type PipelineDeps } from '../pipeline/issue.ts';
import { renderReceipt, renderSheet } from '../render/pdf.ts';
import { readEtdForPrint } from '../render/view.ts';
import { toBigInt } from '../db/database.ts';
import { type CustomerBody, customerFromRow, loadCustomer, loadItems, nextCursor, parsePage } from './catalog.ts';
import { ApiError, notFound } from './errors.ts';
import { issueSchema, listQuery, uuid } from './schemas.ts';

interface LineBody extends Partial<Omit<LineInput, 'quantity'>> {
  itemId?: string;
  quantity: string;
}

export interface IssueBody {
  type: IssuedEtdType;
  series?: number;
  customerId?: string;
  customer?: Omit<CustomerBody, 'name'> & { name?: string };
  lines: LineBody[];
  reference?: { documentId?: string; etdui?: string; issueDate?: string; issueTime?: string; reason: string };
  payment?: { meansCode?: string; dueDate?: string; terms?: string };
  note?: string;
  prepaidAmount?: string;
  payableRoundingAmount?: string;
}

const DOC_COLUMNS = `d.id, d.etdui, d.etd_type, d.series_number, d.serial, d.issue_date::text as issue_date, d.issue_time::text as issue_time,
  d.oper_mode, d.reception_env, d.customer_id, d.customer_snapshot, d.referenced_etdui, d.line_count, d.line_extension_cents, d.gst_cents,
  d.tax_cents, d.tax_inclusive_cents, d.payable_cents, d.status, d.status_detail, d.protocol_number, d.supersedes_document_id,
  d.created_at, d.settled_at,
  (select s.id from documents s where s.supersedes_document_id = d.id and s.tenant_id = d.tenant_id limit 1) as superseded_by_id`;

interface DocRow {
  id: string;
  etdui: string;
  etd_type: IssuedEtdType;
  series_number: number;
  serial: unknown;
  issue_date: string;
  issue_time: string;
  oper_mode: number;
  reception_env: string;
  customer_id: string | null;
  customer_snapshot: Customer | null;
  referenced_etdui: string | null;
  line_count: number;
  line_extension_cents: unknown;
  gst_cents: unknown;
  tax_cents: unknown;
  tax_inclusive_cents: unknown;
  payable_cents: unknown;
  status: string;
  status_detail: { conditions?: unknown[]; problem?: string; reason?: string; recoveredBy?: string; resolution?: string } | null;
  protocol_number: string | null;
  supersedes_document_id: string | null;
  superseded_by_id: string | null;
  created_at: string | Date;
  settled_at: string | Date | null;
}

const cents = (v: unknown) => formatCents(toBigInt(v));

function documentJson(r: DocRow) {
  const detail = r.status_detail ?? {};
  return {
    id: r.id,
    etdui: r.etdui,
    type: r.etd_type,
    typeName: ETD_TYPE_NAMES[r.etd_type],
    series: String(r.series_number).padStart(3, '0'),
    serial: Number(r.serial),
    number: String(r.serial).padStart(9, '0'),
    status: r.status,
    contingency: r.oper_mode !== 1,
    environment: r.reception_env === '01' ? 'production' : 'test',
    protocolNumber: r.protocol_number,
    issueDate: r.issue_date,
    issueTime: r.issue_time.slice(0, 8),
    customerId: r.customer_id,
    customer: r.customer_snapshot,
    referencedEtdui: r.referenced_etdui,
    lineCount: r.line_count,
    totals: {
      lineExtension: cents(r.line_extension_cents),
      gst: cents(r.gst_cents),
      tax: cents(r.tax_cents),
      taxInclusive: cents(r.tax_inclusive_cents),
      payable: cents(r.payable_cents),
    },
    conditions: detail.conditions ?? [],
    ...(detail.problem && { problem: { kind: detail.problem, reason: detail.reason ?? null } }),
    ...(detail.resolution && { resolution: detail.resolution }),
    supersedes: r.supersedes_document_id,
    supersededBy: r.superseded_by_id,
    createdAt: new Date(r.created_at).toISOString(),
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    links: { self: `/v1/documents/${r.id}`, xml: `/v1/documents/${r.id}/xml`, pdf: `/v1/documents/${r.id}/pdf` },
  };
}

async function loadDocument(deps: PipelineDeps, tenantId: string, id: string): Promise<DocRow> {
  const row = (await deps.db.query<DocRow>(`select ${DOC_COLUMNS} from documents d where d.id = $1 and d.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!row) throw notFound('Document');
  return row;
}

/** Turn the API body into a pipeline request: resolve the saved customer, catalog items and referenced document. */
async function toIssueRequest(deps: PipelineDeps, tenantId: string, body: IssueBody): Promise<IssueRequest> {
  if (body.customerId && body.customer) throw new ApiError(422, 'invalid_document', 'Give customerId or customer, not both');
  let customer: Customer | undefined;
  if (body.customerId) {
    customer = customerFromRow(await loadCustomer(deps, tenantId, body.customerId));
  } else if (body.customer) {
    const c = body.customer;
    customer = {
      ...(c.name && { name: c.name }),
      ...(c.tin && { tin: c.tin }),
      ...(c.otherId && { otherId: c.otherId }),
      ...(c.address && { address: { ...c.address, districtName: BELIZE_DISTRICTS[c.address.districtCode] } }),
      ...(c.contact && { contact: c.contact }),
    };
  }

  const items = await loadItems(deps, tenantId, [...new Set(body.lines.map((l) => l.itemId).filter((x): x is string => Boolean(x)))]);
  const lines: LineInput[] = body.lines.map((l, i) => {
    const item = l.itemId ? items.get(l.itemId) : undefined;
    if (l.itemId && !item) throw new ApiError(422, 'invalid_document', `Line ${i + 1}: item ${l.itemId} not found`);
    const description = l.description ?? item?.description;
    const unitCode = l.unitCode ?? item?.unitCode;
    const unitPrice = l.unitPrice ?? item?.unitPrice;
    const gstCategory = l.gstCategory ?? item?.gstCategory;
    if (!description || !unitCode || !unitPrice || !gstCategory) {
      throw new ApiError(422, 'invalid_document', `Line ${i + 1}: give an itemId, or description, unitCode, unitPrice and gstCategory`);
    }
    const exemptionReasonCode = l.exemptionReasonCode ?? item?.exemptionReasonCode ?? undefined;
    const itemName = l.itemName ?? (item && item.name !== description ? item.name : undefined);
    const sellerItemCode = l.sellerItemCode ?? item?.sellerCode ?? undefined;
    return {
      description,
      quantity: l.quantity,
      unitCode,
      unitPrice,
      gstCategory,
      ...(itemName && { itemName }),
      ...(sellerItemCode && { sellerItemCode }),
      ...(exemptionReasonCode && { exemptionReasonCode }),
      ...(l.exemptionReason && { exemptionReason: l.exemptionReason }),
      ...(l.allowanceCharges && { allowanceCharges: l.allowanceCharges }),
      ...(l.otherTaxes && { otherTaxes: l.otherTaxes }),
    };
  });

  let reference: DocumentReference | undefined;
  if (body.reference) {
    const r = body.reference;
    if (r.documentId) {
      const original = await loadDocument(deps, tenantId, r.documentId);
      reference = { etdui: original.etdui, issueDate: original.issue_date, issueTime: original.issue_time.slice(0, 8), reason: r.reason };
    } else if (r.etdui) {
      reference = { etdui: r.etdui, ...(r.issueDate && { issueDate: r.issueDate }), ...(r.issueTime && { issueTime: r.issueTime }), reason: r.reason };
    } else {
      throw new ApiError(422, 'invalid_document', 'A reference needs a documentId or an etdui');
    }
  }

  return {
    etdType: body.type,
    ...(body.series !== undefined && { seriesNumber: body.series }),
    ...(customer && { customer }),
    ...(body.customerId && { customerId: body.customerId }),
    lines,
    ...(reference && { reference }),
    ...(body.payment && { payment: body.payment }),
    ...(body.note && { note: body.note }),
    ...(body.prepaidAmount && { prepaidAmount: body.prepaidAmount }),
    ...(body.payableRoundingAmount && { payableRoundingAmount: body.payableRoundingAmount }),
  };
}

const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerDocumentRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.post<{ Body: IssueBody }>('/documents', { schema: { body: issueSchema } }, async (request, reply) => {
    const tenantId = request.tenantId;
    const key = request.headers['idempotency-key'];
    if (Array.isArray(key)) throw new ApiError(400, 'invalid_request', 'Send one Idempotency-Key header');
    if (key !== undefined && (key.length < 1 || key.length > 255)) throw new ApiError(400, 'invalid_request', 'Idempotency-Key must be 1 to 255 characters');
    const requestHash = createHash('sha256').update(JSON.stringify(request.body)).digest('hex');

    if (key) {
      const claimed = await db.query<{ key: string }>(
        `insert into idempotency_keys (tenant_id, key, request_hash, status) values ($1, $2, $3, 'in_progress')
         on conflict (tenant_id, key) do nothing returning key`,
        [tenantId, key, requestHash],
      );
      if (claimed.rows.length === 0) {
        const prior = (await db.query<{ request_hash: string; status: string; response_code: number | null; response_body: unknown }>(
          'select request_hash, status, response_code, response_body from idempotency_keys where tenant_id = $1 and key = $2', [tenantId, key],
        )).rows[0]!;
        if (prior.request_hash !== requestHash) {
          throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
        }
        if (prior.status !== 'completed') throw new ApiError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed');
        return reply.code(prior.response_code ?? 201).header('Idempotent-Replayed', 'true').send(prior.response_body);
      }
    }

    let documentId: string | undefined;
    try {
      const result = await issueDocument(deps, tenantId, await toIssueRequest(deps, tenantId, request.body));
      documentId = result.documentId;
      const body = documentJson(await loadDocument(deps, tenantId, result.documentId));
      if (key) {
        await db.query(
          `update idempotency_keys set status = 'completed', response_code = 201, response_body = $3, document_id = $4, completed_at = now()
           where tenant_id = $1 and key = $2`,
          [tenantId, key, JSON.stringify(body), result.documentId],
        );
      }
      return reply.code(201).header('Location', `/v1/documents/${result.documentId}`).send(body);
    } catch (e) {
      // Nothing was issued: release the key so the corrected request can be sent with it.
      if (key && !documentId) await db.query(`delete from idempotency_keys where tenant_id = $1 and key = $2 and status = 'in_progress'`, [tenantId, key]).catch(() => {});
      throw e;
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; status?: string; type?: string } }>(
    '/documents',
    {
      schema: {
        querystring: listQuery({
          status: { type: 'string', enum: ['pending', 'authorized', 'authorized_with_alert', 'rejected', 'contingency_pending', 'superseded', 'cancelled'] },
          type: { type: 'string', enum: ['01', '02', '03', '04'] },
        }),
      },
    },
    async (request) => {
      const page = parsePage(request.query);
      const params: unknown[] = [request.tenantId];
      let where = 'd.tenant_id = $1';
      if (request.query.status) {
        params.push(request.query.status);
        where += ` and d.status = $${params.length}`;
      }
      if (request.query.type) {
        params.push(request.query.type);
        where += ` and d.etd_type = $${params.length}`;
      }
      if (page.after) {
        params.push(page.after.createdAt, page.after.id);
        where += ` and (d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(page.limit + 1);
      const rows = (await db.query<DocRow>(`select ${DOC_COLUMNS} from documents d where ${where} order by d.created_at desc, d.id desc limit $${params.length}`, params)).rows;
      const { items, nextCursor: next } = nextCursor(rows, page.limit);
      return { data: items.map(documentJson), nextCursor: next };
    },
  );

  app.get<{ Params: { id: string } }>('/documents/:id', { schema: { params: idParams } }, async (request) =>
    documentJson(await loadDocument(deps, request.tenantId, request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/documents/:id/xml', { schema: { params: idParams } }, async (request, reply) => {
    const row = (await db.query<{ signed_xml: string; etdui: string }>('select signed_xml, etdui from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!row) throw notFound('Document');
    return reply.type('application/xml; charset=utf-8').header('Content-Disposition', `attachment; filename="${row.etdui}.xml"`).send(row.signed_xml);
  });

  app.get<{ Params: { id: string }; Querystring: { format?: 'sheet' | 'receipt'; paper?: 'A4' | 'LETTER'; orientation?: 'landscape' | 'portrait'; widthMm?: string; draft?: 'true' | 'false' } }>(
    '/documents/:id/pdf',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            format: { type: 'string', enum: ['sheet', 'receipt'] },
            paper: { type: 'string', enum: ['A4', 'LETTER'] },
            orientation: { type: 'string', enum: ['landscape', 'portrait'] },
            widthMm: { type: 'string', pattern: '^\\d{2}$' },
            draft: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
    },
    async (request, reply) => {
      const row = (await db.query<{ signed_xml: string; status: string; protocol_number: string | null; etdui: string }>(
        'select signed_xml, status, protocol_number, etdui from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId],
      )).rows[0];
      if (!row) throw notFound('Document');
      const q = request.query;
      const draft = q.draft === 'true';
      if (['rejected', 'superseded', 'cancelled'].includes(row.status)) {
        throw new ApiError(409, 'not_printable', `A ${row.status} document has no valid printed copy`);
      }
      if (row.status === 'pending' && !draft) {
        throw new ApiError(409, 'not_printable', 'The document is not authorized yet; add ?draft=true for a draft copy');
      }
      const view = readEtdForPrint(row.signed_xml);
      const common = { ...(row.protocol_number && { protocolNumber: row.protocol_number }), ...(draft && { draft: true }) };
      const pdf = q.format === 'receipt'
        ? await renderReceipt(view, { ...common, ...(q.widthMm && { widthMm: Number(q.widthMm) }) })
        : await renderSheet(view, { ...common, ...(q.paper && { paper: q.paper }), ...(q.orientation && { orientation: q.orientation }) });
      return reply
        .type('application/pdf')
        .header('Content-Disposition', `inline; filename="${view.typeName.replace(/ /g, '-')}-${view.series}-${view.number}.pdf"`)
        .send(pdf);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/documents/:id/cancel',
    { schema: { params: idParams, body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } } },
    async (request, reply) => {
      await loadDocument(deps, request.tenantId, request.params.id); // 404 for another tenant's document
      const result = await cancelDocument(deps, request.tenantId, request.params.id, request.body.reason);
      const document = documentJson(await loadDocument(deps, request.tenantId, request.params.id));
      return reply.code(result.status === 'pending' ? 202 : 200).send({
        cancellation: { eventId: result.eventId, etdui: result.eventEtdui, status: result.status, conditions: result.conditions, protocolNumber: result.protocolNumber ?? null },
        document,
      });
    },
  );
}
