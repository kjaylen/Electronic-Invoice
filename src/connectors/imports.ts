/**
 * Issuing what connectors picked up: a QuickBooks Desktop invoice or sales
 * receipt, or a QuickBooks POS receipt, becomes a document issued through the
 * same pipeline as everything else (signed, sent to BTS, numbered here).
 *
 * Nothing is guessed silently. Each import is checked first, and held for a
 * person ("attention") when:
 *   - a line uses a sales tax code not mapped to a GST category yet;
 *   - the tax QuickBooks charged differs from the GST worked out here, or its
 *     lines do not add up to its subtotal (a layout we cannot read);
 *   - it is a return or credit (a credit note needs the original document);
 *   - issuing refuses it (a plan limit, a missing detail).
 * A person fixes the cause (a mapping here, the document in QuickBooks) and
 * sends it again; "issue anyway" overrides a tax difference.
 *
 * Issued documents are flagged for write-back (QuickBooks Desktop): the next
 * Web Connector session writes the BTS number back. When a document's BTS
 * status changes later (an offline one authorized), it is written again.
 */

import { ApiError } from '../api/errors.ts';
import { type IssueBody, issueFromBody } from '../api/documents.ts';
import type { Queryable } from '../db/database.ts';
import { calculateDocument, type LineInput } from '../engine/calc.ts';
import type { DistrictCode } from '../engine/ubl.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { type ConnectorLink, LINK_SELECT } from './qbwc.ts';
import type { PosReceipt, QbAddress, QbTxn } from './qbxml.ts';

const STANDING = ['authorized', 'authorized_with_alert', 'contingency_pending', 'pending'];
const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const addDays = (isoDate: string, days: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface ImportRow {
  id: string;
  tenant_id: string;
  link_id: string;
  source_type: 'invoice' | 'sales_receipt' | 'credit_memo' | 'pos_receipt';
  source_ref: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  /** Set by "issue anyway": the tax difference is accepted. */
  force?: boolean;
}

type Built = { body: IssueBody; check?: { label: string; theirs: number; ours: number }; subtotal?: number } | { attention: string };

// ---------- shared ----------

/** Belize's districts from an address (1 Belize, 2 Cayo, 3 Corozal, 4 Orange Walk, 5 Stann Creek, 6 Toledo). */
export function districtOf(text: string): DistrictCode | null {
  const t = text.toLowerCase();
  const rules: Array<[RegExp, DistrictCode]> = [
    [/toledo|punta gorda/, '6'], [/stann creek|dangriga|hopkins|placencia|independence/, '5'], [/orange walk/, '4'], [/corozal/, '3'],
    [/cayo|belmopan|san ignacio|santa elena|benque|spanish lookout/, '2'], [/belize city|belize district|ladyville|san pedro|caye caulker|burrell boom|\bbelize\b/, '1'],
  ];
  return rules.find(([re]) => re.test(t))?.[1] ?? null;
}

function customerFrom(c: { name?: string | null; companyName?: string | null; email?: string | null; phone?: string | null; tin?: string | null; address?: QbAddress | null }, fallback: QbAddress | null) {
  const addr = c.address ?? fallback;
  const name = (c.companyName || c.name || '').trim();
  const street = addr?.lines.filter((l) => l && l.toLowerCase() !== name.toLowerCase()).join(', ') ?? '';
  const city = addr?.city ?? '';
  const district = addr ? districtOf([street, city, addr.state ?? ''].join(' ')) : null;
  return {
    ...(name && { name }),
    ...(c.tin && { tin: c.tin }),
    ...(street && city && district && { address: { street, city, districtCode: district } }),
    ...((c.email || c.phone) && { contact: { ...(c.email && { email: c.email }), ...(c.phone && { telephone: c.phone }) } }),
  };
}

const UNIT_CODES: Record<string, string> = { ea: 'EA', each: 'EA', pc: 'H87', pcs: 'H87', lb: 'LBR', lbs: 'LBR', kg: 'KGM', gal: 'GLL', gallon: 'GLL', l: 'LTR', ltr: 'LTR', hr: 'HUR', hrs: 'HUR', hour: 'HUR', hours: 'HUR', day: 'DAY', days: 'DAY', ft: 'FOT', m: 'MTR', box: 'BX', pack: 'PK' };

function gstFor(link: ConnectorLink, code: string | null, taxed: boolean | null): { category: 'S' | 'Z' | 'E'; exemption?: string } | { unmapped: string } {
  const key = code ?? '';
  const mapped = link.settings.taxCodes?.[key];
  if (mapped) return mapped === 'E' ? { category: 'E', exemption: link.settings.exemptions?.[key] ?? '' } : { category: mapped };
  // QuickBooks' two built-in codes need no mapping.
  if (/^tax$/i.test(key)) return { category: 'S' };
  if (/^non$/i.test(key)) return { category: 'Z' };
  if (!code && taxed !== null) return { category: taxed ? 'S' : 'Z' };
  return { unmapped: key || '(none)' };
}

const money2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

// ---------- QuickBooks Desktop ----------

export function qbdBody(link: ConnectorLink, imp: ImportRow): Built {
  const t = imp.payload as unknown as QbTxn & { customer: QbTxn['customer'] & { companyName?: string | null; email?: string | null; phone?: string | null; tin?: string | null; address?: QbAddress | null } };
  const types = link.cursor.itemTypes ?? {};
  const lines: Array<LineInput & { allowanceCharges?: LineInput['allowanceCharges'] }> = [];
  const unmapped = new Set<string>();
  for (const l of t.lines) {
    const type = l.itemListId ? types[l.itemListId]?.type : undefined;
    // Subtotals, sales tax lines, payments and group headers carry no sale of their own; neither do description-only lines.
    if (type === 'subtotal' || type === 'sales_tax' || type === 'sales_tax_group' || type === 'payment' || type === 'group') continue;
    if (!l.itemListId && !l.amount) continue;
    const amount = Number(l.amount ?? 0);
    if (type === 'discount' || amount < 0) {
      // A discount takes off the line just before it, as QuickBooks applies it.
      const prev = lines.at(-1);
      if (!prev) return { attention: `The discount "${l.itemName ?? 'Discount'}" has no line before it to apply to. Move it below the line it discounts in QuickBooks.` };
      prev.allowanceCharges = [...(prev.allowanceCharges ?? []), { isCharge: false, reason: (l.itemName ?? 'Discount').slice(0, 100), amount: money2(Math.abs(amount)) }];
      continue;
    }
    const gst = gstFor(link, l.taxCode, null);
    if ('unmapped' in gst) {
      unmapped.add(gst.unmapped);
      continue;
    }
    const hasRate = l.rate !== null && l.quantity !== null && Number(l.quantity) !== 0 && !l.ratePercent;
    const unit = l.unit ? UNIT_CODES[l.unit.trim().toLowerCase()] : undefined;
    lines.push({
      description: (l.description ?? l.itemName ?? 'Item').slice(0, 1000),
      ...(l.itemName && { itemName: l.itemName.slice(0, 200) }),
      quantity: hasRate ? String(Number(l.quantity)) : '1',
      unitCode: unit ?? (type === 'service' ? 'E48' : 'H87'),
      unitPrice: hasRate ? String(Number(l.rate)) : money2(amount),
      gstCategory: gst.category,
      ...(gst.category === 'E' && { exemptionReasonCode: gst.exemption }),
    });
  }
  if (unmapped.size) return { attention: `Map these QuickBooks sales tax codes to GST first: ${[...unmapped].join(', ')}.` };
  if (!lines.length) return { attention: 'Nothing on it to invoice (no lines with a price).' };
  const customer = customerFrom(t.customer, t.billAddress);
  if (t.kind === 'invoice' && !customer.name) return { attention: 'The invoice has no customer name.' };
  const note = `QuickBooks ${t.kind === 'invoice' ? 'invoice' : 'sales receipt'} ${t.refNumber ?? ''} of ${t.txnDate}`.replace(/\s+/g, ' ');
  const today = belizeToday();
  const body: IssueBody = t.kind === 'invoice'
    ? {
      type: '01',
      customer,
      lines,
      payment: { meansCode: '30', dueDate: t.dueDate && t.dueDate >= today ? t.dueDate : addDays(today, 30), ...(t.terms && { terms: t.terms.slice(0, 200) }) },
      note,
    }
    : {
      type: '02',
      ...(Object.keys(customer).length > 0 && { customer }),
      lines,
      payment: { meansCode: meansFor(t.paymentMethod), terms: `Paid by ${(t.paymentMethod ?? 'cash').toLowerCase()}` },
      note,
    };
  return { body, check: { label: 'sales tax', theirs: Number(t.salesTaxTotal ?? NaN), ours: NaN }, ...(t.subtotal && { subtotal: Number(t.subtotal) }) };
}

function meansFor(method: string | null): string {
  const m = (method ?? '').toLowerCase();
  if (/check|cheque/.test(m)) return '20';
  if (/visa|master|card|amex|american express|discover|credit|debit/.test(m)) return '48';
  if (/transfer|wire|ach|bank|deposit/.test(m)) return '30';
  return '10';
}

// ---------- QuickBooks Point of Sale ----------

export function posBody(link: ConnectorLink, imp: ImportRow): Built {
  const p = imp.payload as unknown as PosReceipt;
  if (p.type === 'return') return { attention: 'A return: issue a credit note against the original receipt here (a credit note needs the document it corrects).' };
  if (/void/i.test(p.state ?? '')) return { attention: 'Voided in QuickBooks Point of Sale: nothing to send. Skip it.' };
  const lines: LineInput[] = [];
  const unmapped = new Set<string>();
  for (const l of p.lines) {
    const qty = Number(l.quantity ?? 1) || 1;
    const price = Number(l.price ?? 0);
    if (!price && !Number(l.extendedPrice ?? 0)) continue;
    const gst = gstFor(link, l.taxCode, l.taxAmount === null ? null : Number(l.taxAmount) > 0);
    if ('unmapped' in gst) {
      unmapped.add(gst.unmapped);
      continue;
    }
    const lineDiscount = Number(l.discount ?? 0);
    lines.push({
      description: (l.description ?? 'Item').slice(0, 1000),
      quantity: String(qty),
      unitCode: 'H87',
      unitPrice: String(price),
      gstCategory: gst.category,
      ...(gst.category === 'E' && { exemptionReasonCode: gst.exemption }),
      ...(lineDiscount > 0 && { allowanceCharges: [{ isCharge: false, reason: 'Discount', amount: money2(lineDiscount) }] }),
    });
  }
  if (unmapped.size) return { attention: `Map these Point of Sale tax codes to GST first: ${[...unmapped].join(', ')}.` };
  if (!lines.length) return { attention: 'Nothing on it with a price.' };
  // A discount on the whole receipt: shared over the lines by their value, the last line taking the remainder.
  const discount = Math.round(Number(p.discount ?? 0) * 100);
  if (discount > 0) {
    const values = lines.map((l) => Math.round(Number(l.quantity) * Number(l.unitPrice) * 100) - Math.round(Number(l.allowanceCharges?.[0]?.amount ?? 0) * 100));
    const total = values.reduce((a, v) => a + v, 0);
    let left = discount;
    lines.forEach((l, i) => {
      const share = i === lines.length - 1 ? left : Math.round((discount * values[i]!) / total);
      left -= share;
      if (share > 0) l.allowanceCharges = [...(l.allowanceCharges ?? []), { isCharge: false, reason: 'Discount on the receipt', amount: (share / 100).toFixed(2) }];
    });
  }
  return {
    body: { type: '02', lines, payment: { meansCode: meansFor(p.tender), terms: `Paid by ${(p.tender ?? 'cash').toLowerCase()}` }, note: `QuickBooks Point of Sale receipt ${p.number ?? ''} of ${p.txnDate}`.trim() },
    check: { label: 'tax', theirs: Number(p.taxAmount ?? NaN), ours: NaN },
  };
}

// ---------- running ----------

/** Check an import's numbers against what its system charged: GST and the lines' sum. */
function checkTotals(deps: PipelineDeps, built: Extract<Built, { body: IssueBody }>): string | null {
  const t = calculateDocument({ lines: built.body.lines as unknown as LineInput[] }, deps.tax);
  const gst = Number(t.gstAmount) / 100;
  const net = Number(t.lineExtensionAmount) / 100;
  const tolerance = Math.max(0.02, built.body.lines.length * 0.01);
  if (built.subtotal !== undefined && Number.isFinite(built.subtotal) && Math.abs(built.subtotal - net) > tolerance) {
    return `Its lines come to BZ$${net.toFixed(2)} here but BZ$${built.subtotal.toFixed(2)} in QuickBooks (a discount or subtotal arranged in a way that cannot be read). Check it in QuickBooks, then send it again.`;
  }
  if (built.check && Number.isFinite(built.check.theirs) && Math.abs(built.check.theirs - gst) > tolerance) {
    return `QuickBooks charged BZ$${built.check.theirs.toFixed(2)} ${built.check.label}; the e-invoice would carry BZ$${gst.toFixed(2)} GST (12.5%). Check the tax code mapping or QuickBooks' tax rate, then send it again, or issue it anyway.`;
  }
  return null;
}

/** Issue the waiting imports (claimed a few at a time), and keep write-backs up to date. */
export async function processConnectorImports(deps: PipelineDeps, options: { limit?: number } = {}): Promise<{ issued: number; held: number; rejected: number }> {
  const result = { issued: 0, held: 0, rejected: 0 };
  const db = deps.db;
  // A document's BTS status changed since it was written back (an offline one authorized, one rejected later): write it again.
  await db.query(
    `update connector_imports i set writeback = 'pending', status = case when d.status = 'rejected' then 'rejected' else i.status end, updated_at = now()
     from documents d, connector_links l
     where d.id = i.document_id and l.id = i.link_id and l.kind = 'qbd' and i.writeback = 'done' and i.written_status is distinct from d.status`,
  );
  const claimed = (await db.query<ImportRow>(
    `update connector_imports set status = 'issuing', attempts = attempts + 1, updated_at = now()
     where id in (select id from connector_imports where status = 'new' order by created_at limit $1 for update skip locked) returning *`,
    [options.limit ?? 25],
  )).rows;
  for (const imp of claimed) {
    const link = (await db.query<ConnectorLink>(`${LINK_SELECT} where id = $1`, [imp.link_id])).rows[0];
    if (!link) continue;
    const hold = async (problem: string) => {
      await db.query("update connector_imports set status = 'attention', problem = $2, updated_at = now() where id = $1", [imp.id, problem.slice(0, 1000)]);
      result.held++;
    };
    try {
      const built = imp.source_type === 'pos_receipt' ? posBody(link, imp) : qbdBody(link, imp);
      if ('attention' in built) {
        await hold(built.attention);
        continue;
      }
      if (!imp.force && !link.settings.issueOnTaxMismatch) {
        const problem = checkTotals(deps, built);
        if (problem) {
          await hold(problem);
          continue;
        }
      }
      const r = await issueFromBody(deps, imp.tenant_id, built.body, null, { accountLimit: 'skip' });
      const writes = link.kind === 'qbd' ? 'pending' : 'none';
      if (STANDING.includes(r.status)) {
        await db.query("update connector_imports set status = 'issued', document_id = $2, problem = null, force = false, writeback = $3, updated_at = now() where id = $1", [imp.id, r.documentId, writes]);
        result.issued++;
      } else {
        const why = (r as { conditions?: Array<{ code?: string; description?: string }> }).conditions?.map((c) => [c.code, c.description].filter(Boolean).join(' ')).join('; ') || 'BTS did not accept it';
        await db.query("update connector_imports set status = 'rejected', document_id = $2, problem = $3, writeback = $4, updated_at = now() where id = $1", [imp.id, r.documentId, `BTS rejected it: ${why}`.slice(0, 1000), writes]);
        result.rejected++;
      }
    } catch (e) {
      if (e instanceof ApiError) await hold(e.message);
      else if (imp.attempts >= 5) await hold(`Could not be issued: ${(e as Error).message}`);
      else await db.query("update connector_imports set status = 'new', updated_at = now() where id = $1", [imp.id]);
    }
  }
  return result;
}

export async function connectorTodo(db: Queryable, tenantId: string): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int as n from connector_imports where tenant_id = $1 and status in ('attention', 'rejected')", [tenantId])).rows[0]!.n;
}
