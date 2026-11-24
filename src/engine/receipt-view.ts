/**
 * The printed copy of a Tax Receipt made on a till offline, built from the
 * same calculation the server signs later, without the XML: the till prints
 * it before the server has seen the sale.
 *
 * It must equal what the server's own reader (render/view.ts,
 * readEtdForPrint) gets from the signed XML of the same sale; the test
 * offline-receipt.test.ts checks that field by field. Runs in the browser
 * (no Node modules) as well as on the server.
 */

import type { DocumentTotals } from './calc.ts';
import { formatCents } from './decimal.ts';
import { type PrintParty, type PrintView, REGULATORY_MESSAGES } from './print-view.ts';

export interface ReceiptViewInput {
  etdui: string;
  series: number;
  serial: number;
  issueDate: string;
  /** HH:MM:SS. */
  issueTime: string;
  operMode: number;
  /** '01' production, '02' test. */
  receptionEnv: string;
  /** The business as its receipts show it (from the server's snapshot). */
  issuer: PrintParty;
  /** A customer's TIN, or another ID, if given. */
  customer?: { tin?: string; otherId?: { scheme: string; value: string } };
  totals: DocumentTotals;
  note?: string;
  payment?: { terms?: string };
}

const addCents = (a: string, b: string): string => {
  const toCents = (s: string) => {
    const [w = '0', f = ''] = s.replace('-', '').split('.');
    const v = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
    return s.startsWith('-') ? -v : v;
  };
  const c = toCents(a) + toCents(b);
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

export function receiptPrintView(input: ReceiptViewInput): PrintView {
  const t = input.totals;
  const pendingAuthorization = input.operMode !== 1;
  const testEnvironment = input.receptionEnv === '02';
  // Document TaxTotals: one per scheme, in the order the subtotals come (GST first).
  const schemes = [...new Set(t.taxSubtotals.map((s) => s.scheme))];
  const schemeTotal = (scheme: string) => formatCents(t.taxSubtotals.filter((s) => s.scheme === scheme).reduce((a, s) => a + s.taxAmount, 0n));
  const view: PrintView = {
    etdType: '02',
    // ETD_TYPE_NAMES['02'] (ubl.ts, which needs Node's crypto for the hash chain).
    typeName: 'Tax Receipt',
    etdui: input.etdui,
    number: String(input.serial).padStart(9, '0'),
    series: String(input.series).padStart(3, '0'),
    issueDate: input.issueDate,
    issueTime: input.issueTime.slice(0, 8),
    operMode: input.operMode,
    receptionEnv: input.receptionEnv,
    pendingAuthorization,
    testEnvironment,
    issuer: input.issuer,
    lines: t.lines.map((l) => {
      const net = formatCents(l.netAmount);
      const tax = formatCents(l.taxAmount);
      return {
        number: String(l.lineNumber),
        quantity: l.quantity,
        unitCode: l.unitCode,
        description: l.description,
        ...(l.sellerItemCode !== undefined && { code: l.sellerItemCode }),
        unitPrice: l.unitPrice,
        adjustments: l.allowanceCharges.map((ac) => ({ reason: ac.reason || (ac.isCharge ? 'Charge' : 'Discount'), amount: formatCents(ac.amount), isCharge: ac.isCharge })),
        net,
        tax,
        total: addCents(net, tax),
      };
    }),
    totals: {
      taxExclusive: formatCents(t.taxExclusiveAmount),
      gst: schemes[0] ? schemeTotal(schemes[0]) : '0.00',
      otherTaxes: schemes.slice(1).map((scheme) => ({ scheme, amount: schemeTotal(scheme) })),
      taxInclusive: formatCents(t.taxInclusiveAmount),
      payable: formatCents(t.payableAmount),
    },
    regulatory: [
      ...(testEnvironment ? [REGULATORY_MESSAGES.testEnvironment] : []),
      ...(pendingAuthorization ? [REGULATORY_MESSAGES.pendingAuthorization] : []),
    ],
  };
  if (t.prepaidAmount !== 0n) view.totals.prepaid = formatCents(t.prepaidAmount);
  const c = input.customer;
  if (c?.tin || c?.otherId) {
    view.customer = { addressLines: [], ...(c.otherId && { otherId: `${c.otherId.scheme} ${c.otherId.value}` }), ...(c.tin && { tin: c.tin }) };
  }
  if (input.note) view.note = input.note;
  if (input.payment?.terms) view.payment = { terms: input.payment.terms };
  return view;
}
