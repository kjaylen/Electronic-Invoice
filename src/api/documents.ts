/**
 * Documents: issue, list and search, get, signed XML, printed copy (PDF),
 * cancel, email to the customer, share links.
 *
 * POST /v1/documents answers 201 whenever a document was created, whatever
 * BTS decided: check "status" (authorized, authorized_with_alert, rejected,
 * contingency_pending, pending). A rejected document still exists and used a
 * serial number; its "conditions" say which BTS rules failed.
 *
 * Send an Idempotency-Key header (any unique string per sale) so a retried
 * request returns the original response instead of issuing twice.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { formatCents } from '../engine/decimal.ts';
import { calculateDocument, type LineInput } from '../engine/calc.ts';
import { BELIZE_DISTRICTS, type Customer, type DocumentReference, ETD_TYPE_NAMES, type IssuedEtdType } from '../engine/ubl.ts';
import { cancelDocument, issueDocument, type IssueRequest, type IssueResult, type PipelineDeps } from '../pipeline/issue.ts';
import { renderReceipt, renderSheet } from '../render/pdf.ts';
import QRCode from 'qrcode';
import { qrUrl, readEtdForPrint } from '../render/view.ts';
import { type Queryable, toBigInt } from '../db/database.ts';
import { simpleHtml } from '../mail/mailer.ts';
import { type CustomerBody, customerFromRow, likePattern, loadCustomer, loadItems, nextCursor, parsePage } from './catalog.ts';
import { audit } from '../db/audit.ts';
import { overLimit } from '../db/ratelimit.ts';
import { publicLink, requireMail, type ServerContext } from './context.ts';
import { can, requirePermission } from './permissions.ts';
import { ApiError, notFound } from './errors.ts';
import { date as dateSchema, issueSchema, listQuery, uuid } from './schemas.ts';
import { assertCanIssue } from '../billing/billing.ts';
import { type PaymentMethod, receivable, recordPayment, statusesFor } from '../receivables/receivables.ts';

const PRINTABLE = ['authorized', 'authorized_with_alert', 'contingency_pending'];
// Emails per business per hour (shared by every server process), so a compromised account cannot send spam at volume.
const EMAIL_LIMIT_PER_HOUR = 200;
export const SHARE_TTL_MS = 90 * 24 * 3600 * 1000;
const shareHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');


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
  paid?: { method: PaymentMethod; reference?: string };
}

const DOC_COLUMNS = `d.id, d.etdui, d.etd_type, d.series_number, d.serial, d.issue_date::text as issue_date, d.issue_time::text as issue_time,
  d.oper_mode, d.reception_env, d.customer_id, d.customer_snapshot, d.referenced_etdui, d.line_count, d.line_extension_cents, d.gst_cents,
  d.tax_cents, d.tax_inclusive_cents, d.payable_cents, d.status, d.status_detail, d.protocol_number, d.supersedes_document_id,
  d.created_at, d.settled_at,
  (select u.name from users u where u.id = d.issued_by) as issued_by_name,
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
  issued_by_name: string | null;
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
    issuedBy: r.issued_by_name,
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
export async function toIssueRequest(deps: PipelineDeps, tenantId: string, body: IssueBody): Promise<IssueRequest> {
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

/**
 * Issue a document from a POST /v1/documents body: counts against the plan
 * (credit notes never do), checks the customer's credit limit, signs and
 * sends it to BTS. Quotes and recurring invoices issue through here too.
 */
export async function issueFromBody(deps: PipelineDeps, tenantId: string, body: IssueBody, userId: string | null): Promise<IssueResult> {
  const issueRequest = await toIssueRequest(deps, tenantId, body);
  if (issueRequest.etdType !== '04') await assertCanIssue(deps.db, tenantId);
  await checkCreditLimit(deps, tenantId, issueRequest);
  const result = await issueDocument(deps, tenantId, issueRequest);
  // Who issued it (not part of the signed record). Also on the contingency reissue, if there was one.
  if (userId) await deps.db.query('update documents set issued_by = $3 where tenant_id = $1 and (id = $2 or supersedes_document_id = $2)', [tenantId, result.documentId, userId]);
  return result;
}

/**
 * A body with every line written out (description, unit, price, GST) from
 * the catalog: what a quote or a recurring invoice keeps, so a later price
 * change in the catalog does not change what was offered.
 */
export async function resolveBody(deps: PipelineDeps, tenantId: string, body: IssueBody): Promise<{ body: IssueBody; totals: { subtotal: bigint; gst: bigint; total: bigint } }> {
  const req = await toIssueRequest(deps, tenantId, body);
  const lines = body.lines.map((l, i) => {
    const r = req.lines[i]!;
    return {
      ...l,
      description: r.description, unitCode: r.unitCode, unitPrice: r.unitPrice, gstCategory: r.gstCategory,
      ...(r.itemName && { itemName: r.itemName }), ...(r.sellerItemCode && { sellerItemCode: r.sellerItemCode }),
      ...(r.exemptionReasonCode && { exemptionReasonCode: r.exemptionReasonCode }),
    };
  });
  const t = calculateDocument({ lines: req.lines }, deps.tax);
  return { body: { ...body, lines }, totals: { subtotal: t.lineExtensionAmount, gst: t.gstAmount, total: t.taxInclusiveAmount } };
}

// ---------- what is left to credit ----------

const COUNTED_STATUSES = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];

/**
 * How much of a document can still be credited: its total, plus debit notes
 * issued against it, minus credit notes already issued against it (counting
 * those still on their way to BTS, so two at once cannot both pass).
 */
export async function creditBalance(db: PipelineDeps['db'], tenantId: string, etdui: string): Promise<{ original: bigint; debited: bigint; credited: bigint; remaining: bigint } | null> {
  const original = (await db.query<{ tax_inclusive_cents: unknown }>(
    'select tax_inclusive_cents from documents where tenant_id = $1 and etdui = $2', [tenantId, etdui],
  )).rows[0];
  if (!original) return null;
  const sums = (await db.query<{ debited: unknown; credited: unknown }>(
    `select coalesce(sum(tax_inclusive_cents) filter (where etd_type = '03'), 0)::bigint as debited,
            coalesce(sum(tax_inclusive_cents) filter (where etd_type = '04'), 0)::bigint as credited
     from documents where tenant_id = $1 and referenced_etdui = $2 and status = any($3::text[])`,
    [tenantId, etdui, COUNTED_STATUSES],
  )).rows[0]!;
  const o = toBigInt(original.tax_inclusive_cents);
  const debited = toBigInt(sums.debited);
  const credited = toBigInt(sums.credited);
  return { original: o, debited, credited, remaining: o + debited - credited };
}

/** Refuse a credit note larger than what is left to credit on the original (when the original is ours). */
export async function checkCreditLimit(deps: PipelineDeps, tenantId: string, req: IssueRequest): Promise<void> {
  if (req.etdType !== '04' || !req.reference) return;
  const balance = await creditBalance(deps.db, tenantId, req.reference.etdui);
  if (!balance) return;
  const total = calculateDocument({ lines: req.lines }, deps.tax).taxInclusiveAmount;
  const left = balance.remaining < 0n ? 0n : balance.remaining;
  if (total > left) {
    throw new ApiError(422, 'credit_exceeds_original',
      `This credit note (BZ$${formatCents(total)}) is more than what is left to credit on the original: BZ$${formatCents(left)}`,
      { remaining: formatCents(left), requested: formatCents(total) });
  }
}

const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

interface LineRow {
  line_number: number;
  description: string;
  quantity: string;
  unit_code: string;
  unit_price: string;
  net_cents: unknown;
  gst_category: 'S' | 'Z' | 'E';
  gst_cents: unknown;
  tax_cents: unknown;
  line_total_cents: unknown;
}

const trimDecimal = (v: string) => String(v).replace(/(\.\d{2}\d*?)0+$/, '$1').replace(/\.$/, '');
const trimQuantity = (v: string) => String(v).replace(/\.?0+$/, '');

async function documentLines(deps: PipelineDeps, tenantId: string, documentId: string) {
  const rows = (await deps.db.query<LineRow>(
    `select line_number, description, quantity::text as quantity, unit_code, unit_price::text as unit_price, net_cents, gst_category, gst_cents, tax_cents, line_total_cents
     from document_lines where document_id = $1 and tenant_id = $2 order by line_number`,
    [documentId, tenantId],
  )).rows;
  return rows.map((l) => ({
    lineNumber: l.line_number,
    description: l.description,
    quantity: trimQuantity(l.quantity),
    unitCode: l.unit_code,
    unitPrice: trimDecimal(l.unit_price),
    gstCategory: l.gst_category,
    net: cents(l.net_cents),
    gst: cents(l.gst_cents),
    tax: cents(l.tax_cents),
    total: cents(l.line_total_cents),
  }));
}

/** The printed copy, for any route that serves or sends it. */
export async function printedCopy(deps: PipelineDeps, tenantId: string, documentId: string, format: 'sheet' | 'receipt' = 'sheet') {
  const row = (await deps.db.query<{ signed_xml: string; status: string; protocol_number: string | null }>(
    'select signed_xml, status, protocol_number from documents where id = $1 and tenant_id = $2', [documentId, tenantId],
  )).rows[0];
  if (!row) throw notFound('Document');
  if (!PRINTABLE.includes(row.status)) throw new ApiError(409, 'not_printable', `A ${row.status.replace(/_/g, ' ')} document has no valid printed copy`);
  const view = readEtdForPrint(row.signed_xml);
  const common = row.protocol_number ? { protocolNumber: row.protocol_number } : {};
  const pdf = format === 'receipt' ? await renderReceipt(view, common) : await renderSheet(view, common);
  return { pdf, view, signedXml: row.signed_xml, filename: `${view.typeName.replace(/ /g, '-')}-${view.series}-${view.number}` };
}

/**
 * Email a document's printed copy (PDF) and signed XML, replies going to the
 * business, and record it. Throws on failure (after recording the failure).
 */
export async function sendDocumentEmail(
  deps: PipelineDeps,
  ctx: ServerContext,
  tenantId: string,
  documentId: string,
  opts: {
    to: string;
    message?: string;
    userId?: string | null;
    /** A reminder or a payment request: its own subject and opening lines instead of "Please find attached". */
    subject?: string;
    intro?: string[];
    /** A button to pay the invoice online. */
    payUrl?: string;
  },
): Promise<string> {
  const copy = await printedCopy(deps, tenantId, documentId);
  const biz = (await deps.db.query<{ name: string; email: string }>('select coalesce(trade_name, legal_name) as name, email from tenants where id = $1', [tenantId])).rows[0]!;
  const v = copy.view;
  const title = `${v.typeName} ${v.series}-${v.number}`;
  const body = [
    ...(opts.intro?.length ? opts.intro : [`Please find attached ${v.typeName.toLowerCase()} ${v.series}-${v.number} from ${biz.name}.`]),
    ...(opts.message?.trim() ? [opts.message.trim()] : []),
  ];
  const legal = 'The PDF is the printed copy. The XML file is the electronic tax document as authorized by the Belize Tax Service.';
  const lines = [...body, ...(opts.payUrl ? [`Pay online: ${opts.payUrl}`] : []), legal];
  const id = randomUUID();
  try {
    await ctx.mailer.send({
      to: opts.to,
      replyTo: biz.email,
      subject: opts.subject ?? `${title} from ${biz.name}`,
      text: lines.join('\n\n'),
      html: simpleHtml({ heading: title, paragraphs: [...body, legal], ...(opts.payUrl && { button: { label: 'Pay online', url: opts.payUrl } }) }),
      attachments: [
        { filename: `${copy.filename}.pdf`, content: copy.pdf, contentType: 'application/pdf' },
        { filename: `${copy.filename}.xml`, content: copy.signedXml, contentType: 'application/xml' },
      ],
    });
  } catch (e) {
    await deps.db.query(`insert into document_messages (id, tenant_id, document_id, channel, recipient, status, error, sent_by) values ($1, $2, $3, 'email', $4, 'failed', $5, $6)`,
      [id, tenantId, documentId, opts.to, String((e as Error).message ?? e).slice(0, 500), opts.userId ?? null]);
    throw e;
  }
  await deps.db.query(`insert into document_messages (id, tenant_id, document_id, channel, recipient, status, sent_by) values ($1, $2, $3, 'email', $4, 'sent', $5)`,
    [id, tenantId, documentId, opts.to, opts.userId ?? null]);
  return id;
}

/**
 * A link the customer can open without signing in (90 days): /d/<token> is the
 * PDF, /pay/<token> the page to pay it online. The token is stored hashed.
 */
export async function createShareLink(db: Queryable, ctx: ServerContext, tenantId: string, documentId: string, createdBy: string | null): Promise<{ token: string; url: string; payUrl: string; expiresAt: string }> {
  publicLink(ctx, '/');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SHARE_TTL_MS);
  await db.query('insert into share_links (id, tenant_id, document_id, token_hash, created_by, expires_at) values ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), tenantId, documentId, shareHash(token), createdBy, expiresAt.toISOString()]);
  return { token, url: publicLink(ctx, `/d/${token}`), payUrl: publicLink(ctx, `/pay/${token}`), expiresAt: expiresAt.toISOString() };
}

/** The document behind a share token, while the link is valid. */
export async function shareLinkFor(db: Queryable, token: string): Promise<{ tenantId: string; documentId: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const link = (await db.query<{ tenant_id: string; document_id: string; expires_at: string | Date }>(
    'select tenant_id, document_id, expires_at from share_links where token_hash = $1', [shareHash(token)],
  )).rows[0];
  if (!link || new Date(link.expires_at).getTime() <= Date.now()) return null;
  return { tenantId: link.tenant_id, documentId: link.document_id };
}

/** GET /d/:token: the printed copy behind a share link. No login; the 256-bit token is the permission. */
export function registerPublicDocumentRoutes(app: FastifyInstance, deps: PipelineDeps) {
  app.get<{ Params: { token: string }; Querystring: { format?: string } }>('/d/:token', async (request, reply) => {
    const gone = (text: string) => reply.code(404).type('text/html; charset=utf-8').header('Cache-Control', 'no-store')
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link not available</title><body style="font-family:system-ui,sans-serif;background:#efe7d6;color:#160923;display:grid;place-items:center;min-height:90vh"><div style="max-width:28rem;text-align:center"><h1 style="font-size:1.3rem">This link is not available</h1><p>${text}</p></div>`);
    const token = request.params.token;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return gone('Check that you copied the whole link.');
    const link = (await deps.db.query<{ tenant_id: string; document_id: string; expires_at: string | Date }>(
      'select tenant_id, document_id, expires_at from share_links where token_hash = $1', [shareHash(token)],
    )).rows[0];
    if (!link) return gone('Check that you copied the whole link.');
    if (new Date(link.expires_at).getTime() <= Date.now()) return gone('It has expired. Ask the business to send it again.');
    try {
      const copy = await printedCopy(deps, link.tenant_id, link.document_id, request.query.format === 'receipt' ? 'receipt' : 'sheet');
      return reply.type('application/pdf').header('Cache-Control', 'private, no-store').header('X-Robots-Tag', 'noindex')
        .header('Content-Disposition', `inline; filename="${copy.filename}.pdf"`).send(copy.pdf);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_printable') return gone('This document is no longer valid (it was cancelled or replaced). Contact the business.');
      throw e;
    }
  });
}

export function registerDocumentRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;

  /** What is owed on a tax invoice or debit note (null for other documents, and for store orders paid at checkout). */
  const withPayment = async <T extends { id: string; type: string }>(tenantId: string, doc: T) => {
    if (doc.type !== '01' && doc.type !== '03') return { ...doc, payment: null };
    const r = await receivable(db, tenantId, doc.id);
    return { ...doc, payment: r ? { status: r.status, dueDate: r.dueDate, total: r.total, paid: r.paid, credited: r.credited, balance: r.balance, daysOverdue: r.daysOverdue } : null };
  };

  /** Invoices and receipts need documents.issue; credit and debit notes need documents.adjust. */
  const requireIssue = (request: FastifyRequest, type: string) => requirePermission(request, type === '03' || type === '04' ? 'documents.adjust' : 'documents.issue');

  app.post<{ Body: IssueBody }>('/documents', { schema: { body: issueSchema } }, async (request, reply) => {
    requireIssue(request, request.body.type);
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
      const result = await issueFromBody(deps, tenantId, request.body, request.userId || null);
      documentId = result.documentId;
      // Paid on the spot: record it, once the invoice has legal value (a rejected one is never owed).
      const paid = request.body.paid;
      if (paid && (request.body.type === '01' || request.body.type === '03') && can(request.principal, 'payments.record')) {
        const open = await receivable(db, tenantId, result.documentId);
        if (open && open.balanceCents > 0n) {
          await recordPayment(db, tenantId, result.documentId, { amountCents: open.balanceCents, method: paid.method, reference: paid.reference ?? null, paidOn: open.issueDate }, request.userId || null);
        }
      }
      const body = await withPayment(tenantId, documentJson(await loadDocument(deps, tenantId, result.documentId)));
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

  // Totals for a draft, without issuing anything: the web app calls this as the user types.
  app.post<{ Body: IssueBody }>('/documents/preview', { schema: { body: issueSchema } }, async (request) => {
    if (!can(request.principal, 'documents.issue')) requirePermission(request, 'documents.adjust');
    const req = await toIssueRequest(deps, request.tenantId, request.body);
    const t = calculateDocument(
      {
        lines: req.lines,
        ...(req.prepaidAmount !== undefined && { prepaidAmount: req.prepaidAmount }),
        ...(req.payableRoundingAmount !== undefined && { payableRoundingAmount: req.payableRoundingAmount }),
      },
      deps.tax,
    );
    return {
      lines: t.lines.map((l) => ({ lineNumber: l.lineNumber, net: formatCents(l.netAmount), gst: formatCents(l.gstAmount), tax: formatCents(l.taxAmount), total: formatCents(l.lineTotal) })),
      totals: {
        lineExtension: formatCents(t.lineExtensionAmount),
        gst: formatCents(t.gstAmount),
        tax: formatCents(t.taxAmount),
        taxInclusive: formatCents(t.taxInclusiveAmount),
        payable: formatCents(t.payableAmount),
      },
    };
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; status?: string; type?: string; q?: string; from?: string; to?: string; customerId?: string; environment?: 'test' | 'production' | 'all' } }>(
    '/documents',
    {
      schema: {
        querystring: listQuery({
          status: { type: 'string', enum: ['pending', 'authorized', 'authorized_with_alert', 'rejected', 'contingency_pending', 'superseded', 'cancelled'] },
          type: { type: 'string', enum: ['01', '02', '03', '04'] },
          q: { type: 'string', maxLength: 100 },
          from: dateSchema,
          to: dateSchema,
          customerId: uuid,
          environment: { type: 'string', enum: ['test', 'production', 'all'] },
        }),
      },
    },
    async (request) => {
      const page = parsePage(request.query);
      const params: unknown[] = [request.tenantId];
      let where = 'd.tenant_id = $1';
      // After going live, the list shows production documents unless test ones are asked for.
      const env = request.query.environment ?? 'current';
      if (env === 'current') where += ` and d.reception_env = (select case environment when 'production' then '01' else '02' end from tenants where id = $1)`;
      else if (env !== 'all') where += env === 'production' ? ` and d.reception_env = '01'` : ` and d.reception_env = '02'`;
      if (request.query.status) {
        params.push(request.query.status);
        where += ` and d.status = $${params.length}`;
      }
      if (request.query.type) {
        params.push(request.query.type);
        where += ` and d.etd_type = $${params.length}`;
      }
      if (request.query.from) {
        params.push(request.query.from);
        where += ` and d.issue_date >= $${params.length}::date`;
      }
      if (request.query.to) {
        params.push(request.query.to);
        where += ` and d.issue_date <= $${params.length}::date`;
      }
      if (request.query.customerId) {
        params.push(request.query.customerId);
        where += ` and d.customer_id = $${params.length}`;
      }
      const q = request.query.q?.trim();
      if (q) {
        // A document number ("12", "001-000000012"), an ETDUI, or part of the customer's name or TIN.
        const numbered = /^(?:(\d{1,3})-)?(\d{1,9})$/.exec(q);
        if (/^\d{44}$/.test(q)) {
          params.push(q);
          where += ` and d.etdui = $${params.length}`;
        } else {
          params.push(likePattern(q));
          const like = `$${params.length}`;
          let cond = `d.customer_snapshot->>'name' ilike ${like} or d.customer_snapshot->>'tin' like ${like}`;
          if (numbered) {
            params.push(Number(numbered[2]));
            cond += ` or (d.serial = $${params.length}`;
            if (numbered[1]) {
              params.push(Number(numbered[1]));
              cond += ` and d.series_number = $${params.length}`;
            }
            cond += ')';
          }
          where += ` and (${cond})`;
        }
      }
      if (page.after) {
        params.push(page.after.createdAt, page.after.id);
        where += ` and (d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(page.limit + 1);
      const rows = (await db.query<DocRow>(`select ${DOC_COLUMNS} from documents d where ${where} order by d.created_at desc, d.id desc limit $${params.length}`, params)).rows;
      const { items, nextCursor: next } = nextCursor(rows, page.limit);
      const payments = await statusesFor(db, request.tenantId, items.filter((r) => r.etd_type === '01' || r.etd_type === '03').map((r) => r.id));
      return { data: items.map((r) => ({ ...documentJson(r), payment: payments.get(r.id) ?? null })), nextCursor: next };
    },
  );

  app.get<{ Params: { id: string } }>('/documents/:id', { schema: { params: idParams } }, async (request) => {
    const row = await loadDocument(deps, request.tenantId, request.params.id);
    // For invoices and receipts: how much is left to credit (for the credit-note form).
    const balance = row.etd_type === '01' || row.etd_type === '02' ? await creditBalance(db, request.tenantId, row.etdui) : null;
    return {
      ...(await withPayment(request.tenantId, documentJson(row))),
      lines: await documentLines(deps, request.tenantId, request.params.id),
      ...(balance && { credit: { credited: formatCents(balance.credited), debited: formatCents(balance.debited), remaining: formatCents(balance.remaining < 0n ? 0n : balance.remaining) } }),
    };
  });

  // ---------- sending to the customer ----------

  const userId = (request: FastifyRequest) => request.userId || null;

  app.post<{ Params: { id: string }; Body: { to: string; message?: string } }>(
    '/documents/:id/email',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['to'],
          additionalProperties: false,
          properties: { to: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' }, message: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    async (request) => {
      requirePermission(request, 'documents.send');
      requireMail(ctx);
      if (await overLimit(db, `email|${request.tenantId}`, EMAIL_LIMIT_PER_HOUR, 3600_000)) throw new ApiError(429, 'too_many_emails', 'Too many emails sent in the last hour; try again later');
      const id = await sendDocumentEmail(deps, ctx, request.tenantId, request.params.id, { to: request.body.to, ...(request.body.message && { message: request.body.message }), userId: userId(request) })
        .catch((e) => {
          if (e instanceof ApiError) throw e;
          request.log.error({ err: e }, 'document email failed');
          throw new ApiError(502, 'email_failed', 'The email could not be sent. Check the address and try again.');
        });
      return { id, channel: 'email', recipient: request.body.to, status: 'sent', createdAt: new Date().toISOString() };
    },
  );

  app.get<{ Params: { id: string } }>('/documents/:id/messages', { schema: { params: idParams } }, async (request) => {
    await loadDocument(deps, request.tenantId, request.params.id);
    const rows = (await db.query<{ id: string; channel: string; recipient: string; status: string; created_at: string | Date; sent_by_name: string | null }>(
      `select m.id, m.channel, m.recipient, m.status, m.created_at, u.name as sent_by_name from document_messages m left join users u on u.id = m.sent_by
       where m.document_id = $1 and m.tenant_id = $2 order by m.created_at desc limit 50`,
      [request.params.id, request.tenantId],
    )).rows;
    return { data: rows.map((r) => ({ id: r.id, channel: r.channel, recipient: r.recipient, status: r.status, sentBy: r.sent_by_name, createdAt: new Date(r.created_at).toISOString() })) };
  });

  // A link the customer can open to get the PDF (for WhatsApp, SMS, or anywhere else).
  app.post<{ Params: { id: string } }>('/documents/:id/share', { schema: { params: idParams } }, async (request, reply) => {
    requirePermission(request, 'documents.send');
    const row = (await db.query<{ status: string }>('select status from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!row) throw notFound('Document');
    if (!PRINTABLE.includes(row.status)) throw new ApiError(409, 'not_printable', 'Only a valid document can be shared');
    const link = await createShareLink(db, ctx, request.tenantId, request.params.id, userId(request));
    return reply.code(201).send({ url: link.url, expiresAt: link.expiresAt });
  });

  app.get<{ Params: { id: string } }>('/documents/:id/xml', { schema: { params: idParams } }, async (request, reply) => {
    const row = (await db.query<{ signed_xml: string; etdui: string }>('select signed_xml, etdui from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!row) throw notFound('Document');
    return reply.type('application/xml; charset=utf-8').header('Content-Disposition', `attachment; filename="${row.etdui}.xml"`).send(row.signed_xml);
  });

  // The document as signed, for the on-screen copy: what the PDF shows, read from the signed XML (any status).
  app.get<{ Params: { id: string } }>('/documents/:id/view', { schema: { params: idParams } }, async (request) => {
    const row = (await db.query<{ signed_xml: string; status: string; protocol_number: string | null; etdui: string }>(
      'select signed_xml, status, protocol_number, etdui from documents where id = $1 and tenant_id = $2', [request.params.id, request.tenantId],
    )).rows[0];
    if (!row) throw notFound('Document');
    const view = readEtdForPrint(row.signed_xml);
    const url = qrUrl(row.etdui);
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
    return {
      view,
      status: row.status,
      protocolNumber: row.protocol_number,
      qr: { url, image: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}` },
    };
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
      requirePermission(request, 'documents.cancel');
      const original = await loadDocument(deps, request.tenantId, request.params.id); // 404 for another tenant's document
      const result = await cancelDocument(deps, request.tenantId, request.params.id, request.body.reason);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'document.cancelled', target: `${original.etd_type}-${String(original.series_number).padStart(3, '0')}-${String(original.serial).padStart(9, '0')}`, details: { reason: request.body.reason, result: result.status }, ip: request.ip });
      const document = documentJson(await loadDocument(deps, request.tenantId, request.params.id));
      return reply.code(result.status === 'pending' ? 202 : 200).send({
        cancellation: { eventId: result.eventId, etdui: result.eventEtdui, status: result.status, conditions: result.conditions, protocolNumber: result.protocolNumber ?? null },
        document,
      });
    },
  );
}
