/**
 * What goes on the printed copy (graphical representation, manual 3.4).
 *
 * The manual allows the printed copy to show only information that is in the
 * signed XML (plus the issuer's own messages and BTS's authorization
 * protocol), so everything here is read back from the signed document itself,
 * never from the database or the original request.
 */

import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { parseEtdui } from '../engine/etdui.ts';
import { ETD_TYPE_NAMES, NS } from '../engine/ubl.ts';

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

export class PrintError extends Error {
  override name = 'PrintError';
}

function children(parent: Element | undefined, ns: string, name: string): Element[] {
  if (!parent) return [];
  return Array.from(parent.childNodes).filter((n): n is Element => (n as Element).namespaceURI === ns && (n as Element).localName === name);
}
const first = (parent: Element | undefined, ns: string, name: string) => children(parent, ns, name)[0];
const text = (parent: Element | undefined, ns: string, name: string): string | undefined => {
  const v = first(parent, ns, name)?.textContent?.trim();
  return v ? v : undefined;
};
/** First descendant with this name (for nested groups like Party/PartyTaxScheme/CompanyID). */
const deepText = (parent: Element | undefined, ns: string, name: string): string | undefined =>
  parent?.getElementsByTagNameNS(ns, name)[0]?.textContent?.trim() || undefined;

function party(wrapper: Element | undefined): PrintParty | undefined {
  const p = first(wrapper, NS.cac, 'Party');
  if (!p) return undefined;
  const address = first(p, NS.cac, 'PostalAddress');
  const contact = first(p, NS.cac, 'Contact');
  const otherId = first(p, NS.cac, 'PartyIdentification');
  const idEl = first(otherId, NS.cbc, 'ID');
  const result: PrintParty = {
    addressLines: [
      text(address, NS.cbc, 'StreetName'),
      text(address, NS.cbc, 'AdditionalStreetName'),
      [text(address, NS.cbc, 'CityName'), text(address, NS.cbc, 'CountrySubentity')].filter(Boolean).join(', ') || undefined,
    ].filter((x): x is string => Boolean(x)),
  };
  const name = text(first(p, NS.cac, 'PartyName'), NS.cbc, 'Name') ?? deepText(first(p, NS.cac, 'PartyTaxScheme'), NS.cbc, 'RegistrationName');
  const tin = text(first(p, NS.cac, 'PartyTaxScheme'), NS.cbc, 'CompanyID');
  if (name) result.name = name;
  if (tin) result.tin = tin;
  if (idEl?.textContent) result.otherId = `${idEl.getAttribute('schemeID') ?? 'ID'} ${idEl.textContent.trim()}`;
  const tel = text(contact, NS.cbc, 'Telephone');
  const email = text(contact, NS.cbc, 'ElectronicMail');
  if (tel) result.telephone = tel;
  if (email) result.email = email;
  return result;
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

export function readEtdForPrint(signedXml: string): PrintView {
  let doc: Document;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(signedXml, 'text/xml');
  } catch {
    throw new PrintError('Not well-formed XML');
  }
  const root = doc.documentElement;
  if (!root || !['Invoice', 'CreditNote'].includes(root.localName ?? '')) throw new PrintError('Only Invoice and CreditNote documents have a printed copy');
  const etdui = text(root, NS.cbc, 'UUID');
  if (!etdui) throw new PrintError('Document has no UUID');
  const id = parseEtdui(etdui);
  const addElem = root.getElementsByTagNameNS(NS.efdr, 'ETDUIAddElem')[0];
  const lineTag = root.localName === 'CreditNote' ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = root.localName === 'CreditNote' ? 'CreditedQuantity' : 'InvoicedQuantity';

  const lines: PrintLine[] = children(root, NS.cac, lineTag).map((l) => {
    const qty = first(l, NS.cbc, qtyTag);
    const net = text(l, NS.cbc, 'LineExtensionAmount') ?? '0.00';
    const tax = text(first(l, NS.cac, 'TaxTotal'), NS.cbc, 'TaxAmount') ?? '0.00';
    const item = first(l, NS.cac, 'Item');
    const line: PrintLine = {
      number: text(l, NS.cbc, 'ID') ?? '',
      quantity: qty?.textContent?.trim() ?? '',
      unitCode: qty?.getAttribute('unitCode') ?? '',
      description: text(item, NS.cbc, 'Description') ?? '',
      unitPrice: text(first(l, NS.cac, 'Price'), NS.cbc, 'PriceAmount') ?? '',
      adjustments: children(l, NS.cac, 'AllowanceCharge').map((ac) => ({
        reason: text(ac, NS.cbc, 'AllowanceChargeReason') ?? (text(ac, NS.cbc, 'ChargeIndicator') === 'true' ? 'Charge' : 'Discount'),
        amount: text(ac, NS.cbc, 'Amount') ?? '0.00',
        isCharge: text(ac, NS.cbc, 'ChargeIndicator') === 'true',
      })),
      net,
      tax,
      total: addCents(net, tax),
    };
    const code = text(first(item, NS.cac, 'StandardItemIdentification'), NS.cbc, 'ID') ?? text(first(item, NS.cac, 'SellersItemIdentification'), NS.cbc, 'ID');
    if (code) line.code = code;
    return line;
  });

  const taxTotals = children(root, NS.cac, 'TaxTotal');
  const schemeOf = (tt: Element) => deepText(first(first(first(tt, NS.cac, 'TaxSubtotal'), NS.cac, 'TaxCategory'), NS.cac, 'TaxScheme'), NS.cbc, 'ID') ?? 'GST';
  const legal = first(root, NS.cac, 'LegalMonetaryTotal');
  const contingencyEl = root.getElementsByTagNameNS(NS.efdr, 'contingencyInfo')[0];
  const refEl = first(root, NS.cac, 'AdditionalDocumentReference');
  const paymentMeans = first(root, NS.cac, 'PaymentMeans');
  const paymentTerms = first(root, NS.cac, 'PaymentTerms');

  const pendingAuthorization = id.operMode !== 1;
  const testEnvironment = id.receptionEnv === '02';
  const view: PrintView = {
    etdType: id.etdType,
    typeName: ETD_TYPE_NAMES[id.etdType],
    etdui,
    number: text(root, NS.cbc, 'ID') ?? String(id.serial).padStart(9, '0'),
    series: addElem ? (text(addElem, NS.efdr, 'series') ?? String(id.series).padStart(3, '0')) : String(id.series).padStart(3, '0'),
    issueDate: text(root, NS.cbc, 'IssueDate') ?? '',
    issueTime: (text(root, NS.cbc, 'IssueTime') ?? '').slice(0, 8),
    operMode: id.operMode,
    receptionEnv: id.receptionEnv,
    pendingAuthorization,
    testEnvironment,
    issuer: party(first(root, NS.cac, 'AccountingSupplierParty')) ?? { addressLines: [] },
    lines,
    totals: {
      taxExclusive: text(legal, NS.cbc, 'TaxExclusiveAmount') ?? '0.00',
      gst: taxTotals[0] ? (text(taxTotals[0], NS.cbc, 'TaxAmount') ?? '0.00') : '0.00',
      otherTaxes: taxTotals.slice(1).map((tt) => ({ scheme: schemeOf(tt), amount: text(tt, NS.cbc, 'TaxAmount') ?? '0.00' })),
      taxInclusive: text(legal, NS.cbc, 'TaxInclusiveAmount') ?? '0.00',
      payable: text(legal, NS.cbc, 'PayableAmount') ?? '0.00',
    },
    regulatory: [
      ...(testEnvironment ? [REGULATORY_MESSAGES.testEnvironment] : []),
      ...(pendingAuthorization ? [REGULATORY_MESSAGES.pendingAuthorization] : []),
    ],
  };
  const prepaid = text(legal, NS.cbc, 'PrepaidAmount');
  if (prepaid) view.totals.prepaid = prepaid;
  const customer = party(first(root, NS.cac, 'AccountingCustomerParty'));
  if (customer && (customer.name || customer.tin || customer.otherId)) view.customer = customer;
  if (refEl) {
    view.reference = {
      etdui: text(refEl, NS.cbc, 'UUID') ?? '',
      documentType: text(refEl, NS.cbc, 'DocumentType') ?? '',
      reason: text(refEl, NS.cbc, 'DocumentDescription') ?? '',
    };
  }
  if (contingencyEl) {
    view.contingency = {
      reason: text(contingencyEl, NS.efdr, 'contingencyReason') ?? '',
      initDate: text(contingencyEl, NS.efdr, 'contingencyInitDate') ?? '',
      initTime: (text(contingencyEl, NS.efdr, 'contingencyInitTime') ?? '').slice(0, 8),
    };
  }
  const note = text(root, NS.cbc, 'Note');
  if (note) view.note = note;
  const dueDate = text(paymentMeans, NS.cbc, 'PaymentDueDate');
  const terms = text(paymentTerms, NS.cbc, 'Note');
  if (dueDate || terms) view.payment = { ...(dueDate && { dueDate }), ...(terms && { terms }) };
  return view;
}

/** The URL encoded in the QR code: BTS's public lookup for this document (manual 3.5.2). */
export function qrUrl(etdui: string, options: { baseUrl?: string } = {}): string {
  const id = parseEtdui(etdui);
  const base = options.baseUrl ?? (id.receptionEnv === '01' ? QR_BASE_URLS.production : QR_BASE_URLS.test);
  return `${base}${etdui}`;
}
