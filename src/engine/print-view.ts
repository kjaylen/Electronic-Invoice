/**
 * The printed copy of an ETD as data: what the PDF, the till's receipt
 * printer and the on-screen copy show. Browser-safe (no Node modules), so the
 * till apps build the same copy for a receipt they made offline
 * (receipt-view.ts) as the server reads from the signed XML (render/view.ts).
 */

export const QR_BASE_URLS = {
  /** From the manual (3.5.2). */
  production: 'https://portal.prod.bz.efdrciat.org/QRCode?UUID=',
  /** Assumed by analogy with the API hosts; confirm with BTS. */
  test: 'https://portal.test.bz.efdrciat.org/QRCode?UUID=',
} as const;

/** Exact texts from manual table 3-3. */
export const REGULATORY_MESSAGES = {
  testEnvironment: 'Transmitted to tests environment, no fiscal value',
  pendingAuthorization: 'Pending of BTS authorization',
} as const;

export interface PrintParty {
  name?: string;
  tin?: string;
  otherId?: string;
  addressLines: string[];
  telephone?: string;
  email?: string;
}

export interface PrintLine {
  number: string;
  quantity: string;
  unitCode: string;
  description: string;
  code?: string;
  unitPrice: string;
  adjustments: Array<{ reason: string; amount: string; isCharge: boolean }>;
  /** LineExtensionAmount: after allowances and charges, before taxes. */
  net: string;
  /** Line TaxTotal/TaxAmount: GST plus any other taxes on the line. */
  tax: string;
  /** net + tax. */
  total: string;
}

export interface PrintView {
  etdType: string;
  typeName: string;
  etdui: string;
  number: string;
  series: string;
  issueDate: string;
  issueTime: string;
  operMode: number;
  receptionEnv: string;
  /** Subsequent authorization (operMode 2 or 3). */
  pendingAuthorization: boolean;
  testEnvironment: boolean;
  issuer: PrintParty;
  customer?: PrintParty;
  lines: PrintLine[];
  totals: {
    taxExclusive: string;
    /** First document-level TaxTotal: GST. */
    gst: string;
    otherTaxes: Array<{ scheme: string; amount: string }>;
    taxInclusive: string;
    prepaid?: string;
    payable: string;
  };
  reference?: { etdui: string; documentType: string; reason: string };
  contingency?: { reason: string; initDate: string; initTime: string };
  note?: string;
  payment?: { dueDate?: string; terms?: string };
  /** Messages required by regulation (table 3-3) for this document. */
  regulatory: string[];
}

/** What the printed texts depend on besides the document. */
export interface PrintedOptions {
  /** BTS's authorization number, once it has one. */
  protocolNumber?: string;
  /** Not authorized yet: say so. */
  draft?: boolean;
}

export function authorizationText(view: PrintView, options: PrintedOptions): string {
  if (view.pendingAuthorization) return REGULATORY_MESSAGES.pendingAuthorization;
  return options.protocolNumber ?? 'DRAFT - NOT AUTHORIZED BY BTS';
}

export function regulatoryLines(view: PrintView, options: PrintedOptions): string[] {
  const lines = [...view.regulatory];
  if (!view.pendingAuthorization && !options.protocolNumber && options.draft) lines.unshift('DRAFT - NOT AUTHORIZED BY BTS');
  if (view.contingency) lines.push(`Contingency since ${view.contingency.initDate} ${view.contingency.initTime}: ${view.contingency.reason}`);
  if (view.reference) lines.push(`${view.typeName} for ${view.reference.documentType} ${view.reference.etdui}: ${view.reference.reason}`);
  return lines;
}

export function infoLines(view: PrintView): string[] {
  const lines: string[] = [];
  if (view.payment?.dueDate) lines.push(`Payment due ${view.payment.dueDate}`);
  if (view.payment?.terms) lines.push(`Terms: ${view.payment.terms}`);
  if (view.note) lines.push(view.note);
  return lines;
}
