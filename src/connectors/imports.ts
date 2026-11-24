/**
 * Issuing what connectors picked up: a QuickBooks Desktop invoice or sales
 * receipt, a QuickBooks POS receipt, or a NetSuite invoice, cash sale or
 * credit memo becomes a document issued through the same pipeline as
 * everything else (signed, sent to BTS, numbered here).
 *
 * Nothing is guessed silently. Each import is checked first, and held for a
 * person ("attention") when:
 *   - a line uses a sales tax code not mapped to a GST category yet;
 *   - the tax QuickBooks charged differs from the GST worked out here, or its
 *     lines do not add up to its subtotal (a layout we cannot read);
 *   - it is a return or credit whose original was not sent through here (a
 *     credit note needs the document it corrects);
 *   - it is in a currency other than Belize dollars (NetSuite);
 *   - issuing refuses it (a plan limit, a missing detail).
 * A person fixes the cause (a mapping here, the document in QuickBooks) and
 * sends it again; "issue anyway" overrides a tax difference.
 *
 * Issued documents are flagged for write-back (QuickBooks Desktop, NetSuite):
 * the next Web Connector session, or the next read of NetSuite, writes the
 * BTS number back. When a document's BTS
 * status changes later (an offline one authorized), it is written again.
 */

import { ApiError } from '../api/errors.ts';
import { type IssueBody, issueFromBody } from '../api/documents.ts';
import type { Queryable } from '../db/database.ts';
import { calculateDocument, type LineInput } from '../engine/calc.ts';
import { type DistrictCode, UblError } from '../engine/ubl.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { type ConnectorLink, LINK_SELECT } from './qbwc.ts';
import type { NsTxn } from './netsuite.ts';
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
      // Its line was left out for an unmapped tax code: that is what to fix first.
      if (!prev && unmapped.size) continue;
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
  spreadDiscount(lines, Math.round(Number(p.discount ?? 0) * 100), 'Discount on the receipt');
  return {
    body: { type: '02', lines, payment: { meansCode: meansFor(p.tender), terms: `Paid by ${(p.tender ?? 'cash').toLowerCase()}` }, note: `QuickBooks Point of Sale receipt ${p.number ?? ''} of ${p.txnDate}`.trim() },
    check: { label: 'tax', theirs: Number(p.taxAmount ?? NaN), ours: NaN },
  };
}

/** A discount on the whole document: shared over the lines by their value (after their own discounts), the last line taking the remainder. */
function spreadDiscount(lines: LineInput[], discountCents: number, reason: string) {
  if (discountCents <= 0 || !lines.length) return;
  const values = lines.map((l) => Math.round(Number(l.quantity) * Number(l.unitPrice) * 100) - (l.allowanceCharges ?? []).reduce((a, x) => a + (x.isCharge ? -1 : 1) * Math.round(Number(x.amount) * 100), 0));
  const total = values.reduce((a, v) => a + v, 0);
  if (total <= 0) return;
  let left = discountCents;
  lines.forEach((l, i) => {
    const share = i === lines.length - 1 ? left : Math.round((discountCents * values[i]!) / total);
    left -= share;
    if (share > 0) l.allowanceCharges = [...(l.allowanceCharges ?? []), { isCharge: false, reason, amount: (share / 100).toFixed(2) }];
  });
}

// ---------- NetSuite ----------

const NS_SKIP = new Set(['Subtotal', 'Description', 'Group', 'EndGroup', 'Payment']);
const NS_KIND_WORDS: Record<NsTxn['kind'], string> = { invoice: 'invoice', sales_receipt: 'cash sale', credit_memo: 'credit memo' };

/** A NetSuite invoice (tax invoice), cash sale (tax receipt) or credit memo (credit note against what it was made from). */
export function nsBody(link: ConnectorLink, imp: ImportRow, original: { documentId: string } | null): Built {
  const t = imp.payload as unknown as NsTxn;
  if (t.exchangeRate !== null && Number(t.exchangeRate) !== 1) {
    return { attention: `In ${t.currency ?? 'another currency'}: only documents in Belize dollars are sent to BTS from NetSuite. Issue it here in Belize dollars, then skip this one.` };
  }
  const lines: LineInput[] = [];
  const extras = new Set<LineInput>();
  const unmapped = new Set<string>();
  for (const l of t.lines) {
    if (l.itemType && NS_SKIP.has(l.itemType)) continue;
    if (!l.itemId && !Number(l.amount ?? 0) && l.itemType !== 'Shipping' && l.itemType !== 'Handling') continue;
    const amount = Number(l.amount ?? 0);
    if (l.itemType === 'Discount' || l.itemType === 'Markup' || amount < 0) {
      // Discount and markup items act on the line just before them, as NetSuite applies them.
      const prev = lines.at(-1);
      if (!prev && unmapped.size) continue;
      if (!prev) return { attention: `The ${amount < 0 || l.itemType === 'Discount' ? 'discount' : 'markup'} "${l.itemName ?? l.itemType}" has no line before it to apply to. Move it below the line it applies to in NetSuite.` };
      prev.allowanceCharges = [...(prev.allowanceCharges ?? []), { isCharge: amount > 0, reason: (l.itemName ?? (amount > 0 ? 'Markup' : 'Discount')).slice(0, 100), amount: money2(Math.abs(amount)) }];
      continue;
    }
    const gst = gstFor(link, l.taxCode, l.taxable);
    if ('unmapped' in gst) {
      unmapped.add(gst.unmapped);
      continue;
    }
    const hasRate = l.rate !== null && l.quantity !== null && Number(l.quantity) !== 0 && !String(l.rate).includes('%') && Math.abs(Number(l.quantity) * Number(l.rate) - amount) < 0.011;
    const unit = l.unit ? UNIT_CODES[l.unit.trim().toLowerCase()] : undefined;
    const extra = l.itemType === 'Shipping' || l.itemType === 'Handling';
    lines.push({
      description: (l.description ?? l.itemName ?? 'Item').slice(0, 1000),
      ...(l.itemName && !extra && { itemName: l.itemName.slice(0, 200) }),
      quantity: hasRate ? String(Math.abs(Number(l.quantity))) : '1',
      unitCode: unit ?? (l.itemType === 'Service' || l.itemType === 'Shipping' || l.itemType === 'Handling' ? 'E48' : 'H87'),
      unitPrice: hasRate ? String(Number(l.rate)) : money2(amount),
      gstCategory: gst.category,
      ...(gst.category === 'E' && { exemptionReasonCode: gst.exemption }),
    });
    if (extra) extras.add(lines.at(-1)!);
  }
  if (unmapped.size) return { attention: `Map these NetSuite tax codes to GST first: ${[...unmapped].join(', ')}.` };
  if (!lines.length) return { attention: 'Nothing on it with a price.' };
  // A discount on the whole transaction (NetSuite's header discount) is shared over the lines; shipping and handling are lines of their own already.
  const header = Math.round(Math.abs(Number(t.discountTotal ?? 0)) * 100);
  const goods = lines.filter((l) => !extras.has(l));
  spreadDiscount(goods.length ? goods : lines, header, 'Discount');
  const customer = customerFrom(t.customer, t.billAddress);
  if (t.kind === 'invoice' && !customer.name) return { attention: 'The invoice has no customer name.' };
  const note = `NetSuite ${NS_KIND_WORDS[t.kind]} ${t.tranId ?? ''} of ${t.tranDate}`.replace(/\s+/g, ' ');
  const today = belizeToday();
  let body: IssueBody;
  if (t.kind === 'invoice') {
    body = { type: '01', customer, lines, payment: { meansCode: '30', dueDate: t.dueDate && t.dueDate >= today ? t.dueDate : addDays(today, 30), ...(t.terms && { terms: t.terms.slice(0, 200) }) }, note };
  } else if (t.kind === 'sales_receipt') {
    body = { type: '02', ...(Object.keys(customer).length > 0 && { customer }), lines, payment: { meansCode: meansFor(t.paymentMethod), terms: `Paid by ${(t.paymentMethod ?? 'cash').toLowerCase()}` }, note };
  } else {
    if (!t.createdFrom) return { attention: 'A credit memo not made from an invoice or cash sale: a credit note needs the document it corrects. Make it from the invoice in NetSuite (Credit), or issue the credit note here and skip this one.' };
    if (!original) return { attention: `Made from ${t.createdFrom.name ?? 'a transaction'}, which was not sent to BTS through here. Send that one first, or issue the credit note here and skip this one.` };
    body = { type: '04', ...(Object.keys(customer).length > 0 && { customer }), lines, reference: { documentId: original.documentId, reason: (t.memo || `NetSuite credit memo ${t.tranId ?? ''}`).trim().slice(0, 500) }, payment: { meansCode: '30', terms: `Credited against ${t.createdFrom.name ?? 'the original'}`.slice(0, 200) }, note };
  }
  return { body, check: { label: 'tax', theirs: Number(t.taxTotal ?? NaN), ours: NaN }, ...(t.netTotal !== null && { subtotal: Number(t.netTotal) }) };
}

// ---------- running ----------

/** Check an import's numbers against what its system charged: GST and the lines' sum. */
function checkTotals(deps: PipelineDeps, built: Extract<Built, { body: IssueBody }>, source: string): string | null {
  const t = calculateDocument({ lines: built.body.lines as unknown as LineInput[] }, deps.tax);
  const gst = Number(t.gstAmount) / 100;
  const net = Number(t.lineExtensionAmount) / 100;
  const tolerance = Math.max(0.02, built.body.lines.length * 0.01);
  if (built.subtotal !== undefined && Number.isFinite(built.subtotal) && Math.abs(built.subtotal - net) > tolerance) {
    return `Its lines come to BZ$${net.toFixed(2)} here but BZ$${built.subtotal.toFixed(2)} in ${source} (a discount or subtotal arranged in a way that cannot be read). Check it in ${source}, then send it again.`;
  }
  if (built.check && Number.isFinite(built.check.theirs) && Math.abs(built.check.theirs - gst) > tolerance) {
    return `${source} charged BZ$${built.check.theirs.toFixed(2)} ${built.check.label}; the e-invoice would carry BZ$${gst.toFixed(2)} GST (12.5%). Check the tax code mapping or ${source}' tax rate, then send it again, or issue it anyway.`.replace("NetSuite' tax", "NetSuite's tax");
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
     where d.id = i.document_id and l.id = i.link_id and l.kind in ('qbd', 'netsuite') and i.writeback = 'done' and i.written_status is distinct from d.status`,
  );
  const claimed = (await db.query<ImportRow>(
    `update connector_imports set status = 'issuing', attempts = attempts + 1, updated_at = now()
     where id in (select id from connector_imports where status = 'new' and tenant_id not in (select id from tenants where closed_at is not null) order by created_at limit $1 for update skip locked) returning *`,
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
      let built: Built;
      if (link.kind === 'netsuite') {
        // A credit memo corrects what it was made from, if that was issued here.
        const from = (imp.payload as unknown as NsTxn).createdFrom;
        const original = imp.source_type === 'credit_memo' && from
          ? (await db.query<{ document_id: string }>(
            "select document_id from connector_imports where link_id = $1 and source_type in ('invoice', 'sales_receipt') and source_id = $2 and status = 'issued' and document_id is not null",
            [link.id, from.id],
          )).rows[0]
          : undefined;
        built = nsBody(link, imp, original ? { documentId: original.document_id } : null);
      } else built = imp.source_type === 'pos_receipt' ? posBody(link, imp) : qbdBody(link, imp);
      if ('attention' in built) {
        await hold(built.attention);
        continue;
      }
      if (!imp.force && !link.settings.issueOnTaxMismatch) {
        const problem = checkTotals(deps, built, link.kind === 'netsuite' ? 'NetSuite' : 'QuickBooks');
        if (problem) {
          await hold(problem);
          continue;
        }
      }
      const r = await issueFromBody(deps, imp.tenant_id, built.body, null, { accountLimit: 'skip' });
      const writes = link.kind === 'qbpos' ? 'none' : 'pending';
      if (STANDING.includes(r.status)) {
        await db.query("update connector_imports set status = 'issued', document_id = $2, problem = null, force = false, writeback = $3, updated_at = now() where id = $1", [imp.id, r.documentId, writes]);
        result.issued++;
      } else {
        const why = (r as { conditions?: Array<{ code?: string; description?: string }> }).conditions?.map((c) => [c.code, c.description].filter(Boolean).join(' ')).join('; ') || 'BTS did not accept it';
        await db.query("update connector_imports set status = 'rejected', document_id = $2, problem = $3, writeback = $4, updated_at = now() where id = $1", [imp.id, r.documentId, `BTS rejected it: ${why}`.slice(0, 1000), writes]);
        result.rejected++;
      }
    } catch (e) {
      // A refusal or a document that cannot be built is for a person; anything else (the database, a timeout) is tried again.
      if (e instanceof ApiError || e instanceof UblError) await hold(e.message);
      else if (imp.attempts >= 5) await hold(`Could not be issued: ${(e as Error).message}`);
      else await db.query("update connector_imports set status = 'new', updated_at = now() where id = $1", [imp.id]);
    }
  }
  return result;
}

export async function connectorTodo(db: Queryable, tenantId: string): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int as n from connector_imports where tenant_id = $1 and status in ('attention', 'rejected')", [tenantId])).rows[0]!.n;
}
