/**
 * Printed documents from the business's templates: tax documents (A4 or receipt roll), quotes
 * and statements. Returns null when no PDF browser is configured or printing fails, and the
 * caller uses its built-in layout instead, so a PDF is never missing.
 */

import type { Queryable } from '../db/database.ts';
import { pdfRenderer } from '../render/browser-pdf.ts';
import type { QuoteInput } from '../render/quote.ts';
import type { StatementInput } from '../render/statement.ts';
import type { PrintView } from '../render/view.ts';
import { businessContext, documentPrintContext, renderDocumentHtml } from './render.ts';

async function print(fn: () => Promise<{ html: string }>, page: { size: 'css' } | { widthMm: number }): Promise<Buffer | null> {
  const renderer = pdfRenderer();
  if (!renderer) return null;
  try {
    const { html } = await fn();
    return await renderer.pdf(html, page);
  } catch (e) {
    console.error('template PDF failed; using the built-in layout:', (e as Error).message.split('\n')[0]);
    return null;
  }
}

/** A tax document's printed copy from the template: "sheet" (A4) or "receipt" (80 mm roll). */
export function documentPdf(db: Queryable, tenantId: string, view: PrintView, format: 'sheet' | 'receipt', options: { protocolNumber?: string | null; draft?: boolean; message?: string | null } = {}) {
  return print(async () => {
    const { context, bts } = await documentPrintContext(view, options);
    return renderDocumentHtml(db, tenantId, format === 'receipt' ? 'document.receipt' : 'document.invoice', { ...context, business: await businessContext(db, tenantId) }, bts);
  }, format === 'receipt' ? { widthMm: 80 } : { size: 'css' });
}

export function quoteContext(q: QuoteInput, business: Awaited<ReturnType<typeof businessContext>>) {
  return {
    business,
    customer: { name: q.customer.name, tin: q.customer.tin, address_lines: q.customer.addressLines, email: q.customer.email },
    quote: {
      number: q.number, date: q.date, valid_until: q.validUntil, status: q.status, expired: q.expired, terms: q.terms, note: q.note, accepted_by: q.acceptedBy,
      lines: q.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unitPrice, gst: l.gst, total: l.total })),
      totals: q.totals,
    },
  };
}

export function quotePdf(db: Queryable, tenantId: string, q: QuoteInput) {
  return print(async () => renderDocumentHtml(db, tenantId, 'document.quote', quoteContext(q, await businessContext(db, tenantId))), { size: 'css' });
}

export function statementContext(s: StatementInput, business: Awaited<ReturnType<typeof businessContext>>) {
  return {
    business,
    customer: s.customer,
    pay_url: s.payUrl ?? null,
    statement: {
      as_of: s.asOf, total_due: s.totalDue, overdue: s.overdue, note: s.note ?? null,
      open: s.open.map((r) => ({ type: r.type === '03' ? 'Debit note' : r.type === '01' ? 'Tax invoice' : r.type, number: r.number, issue_date: r.issueDate, due_date: r.dueDate, days_overdue: r.daysOverdue, total: r.total, paid: r.paid, credited: r.credited, balance: r.balance })),
      payments: s.payments.map((p) => ({ number: p.number, paid_on: p.paidOn, method: p.method, reference: p.reference, amount: p.amount })),
    },
  };
}

export function statementPdf(db: Queryable, tenantId: string, s: StatementInput) {
  return print(async () => renderDocumentHtml(db, tenantId, 'document.statement', statementContext(s, await businessContext(db, tenantId))), { size: 'css' });
}
