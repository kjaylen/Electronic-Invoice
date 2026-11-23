/**
 * qbXML (QuickBooks Desktop) and qbposXML (QuickBooks Point of Sale): the
 * requests the Web Connector carries into QuickBooks, and reading what comes
 * back. Only what the connector needs: invoices, sales receipts, customers,
 * items and the write-back of the BTS details, and POS sales receipts.
 *
 * Element order matters to QuickBooks (it validates against its schema), so
 * requests are written out in the order the SDK reference gives.
 */

import { DOMParser, type Element } from '@xmldom/xmldom';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function parseXml(xml: string): Element {
  const root = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml').documentElement;
  if (!root) throw new Error('Not XML');
  return root;
}
export const kids = (el: Element | null | undefined, name: string): Element[] =>
  el ? (Array.from(el.childNodes).filter((n) => n.nodeType === 1 && ((n as Element).localName ?? (n as Element).nodeName) === name) as Element[]) : [];
export const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
export const txt = (el: Element | null | undefined, ...path: string[]): string | null => {
  let e: Element | null | undefined = el;
  for (const p of path) e = kid(e, p);
  const v = e?.textContent?.trim();
  return v ? v : null;
};
/** Descendants by name, at any depth. */
export const all = (el: Element, name: string): Element[] => Array.from(el.getElementsByTagName(name)) as unknown as Element[];

// ---------- QuickBooks Desktop ----------

const QBXML_VERSION = '13.0';

export const qbxml = (requests: string, version = QBXML_VERSION) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="${version}"?>\n<QBXML><QBXMLMsgsRq onError="continueOnError">${requests}</QBXMLMsgsRq></QBXML>`;

/** Invoices or sales receipts changed since a moment, with their lines and custom fields, in pages. */
export function txnQuery(kind: 'Invoice' | 'SalesReceipt', opts: { from?: string; iteratorId?: string; max?: number }): string {
  const it = opts.iteratorId ? ` iterator="Continue" iteratorID="${esc(opts.iteratorId)}"` : ' iterator="Start"';
  const filter = opts.iteratorId || !opts.from ? '' : `<ModifiedDateRangeFilter><FromModifiedDate>${esc(opts.from)}</FromModifiedDate></ModifiedDateRangeFilter>`;
  return `<${kind}QueryRq requestID="${kind}"${it}><MaxReturned>${opts.max ?? 50}</MaxReturned>${filter}<IncludeLineItems>true</IncludeLineItems><OwnerID>0</OwnerID></${kind}QueryRq>`;
}

export function customerQuery(listIds: string[]): string {
  return `<CustomerQueryRq requestID="Customer">${listIds.map((id) => `<ListID>${esc(id)}</ListID>`).join('')}<OwnerID>0</OwnerID></CustomerQueryRq>`;
}

export function itemQuery(listIds: string[]): string {
  return `<ItemQueryRq requestID="Item">${listIds.map((id) => `<ListID>${esc(id)}</ListID>`).join('')}</ItemQueryRq>`;
}

/** Write the BTS number in the "Other" field (it can be printed on QuickBooks forms) and the details in the memo. */
export function txnMod(kind: 'Invoice' | 'SalesReceipt', requestId: string, txnId: string, editSequence: string, memo: string, other: string): string {
  return `<${kind}ModRq requestID="${esc(requestId)}"><${kind}Mod><TxnID>${esc(txnId)}</TxnID><EditSequence>${esc(editSequence)}</EditSequence><Memo>${esc(memo.slice(0, 4095))}</Memo><Other>${esc(other.slice(0, 29))}</Other></${kind}Mod></${kind}ModRq>`;
}

export interface QbAddress { lines: string[]; city: string | null; state: string | null; country: string | null }
export interface QbLine {
  itemListId: string | null;
  itemName: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  ratePercent: string | null;
  amount: string | null;
  taxCode: string | null;
  unit: string | null;
}
export interface QbTxn {
  kind: 'invoice' | 'sales_receipt';
  txnId: string;
  editSequence: string;
  timeModified: string;
  txnDate: string;
  refNumber: string | null;
  customer: { listId: string | null; name: string | null };
  billAddress: QbAddress | null;
  dueDate: string | null;
  terms: string | null;
  paymentMethod: string | null;
  memo: string | null;
  other: string | null;
  subtotal: string | null;
  salesTaxTotal: string | null;
  salesTaxPercent: string | null;
  isPending: boolean;
  lines: QbLine[];
  custom: Record<string, string>;
}

const address = (el: Element | null): QbAddress | null => {
  if (!el) return null;
  const lines = ['Addr1', 'Addr2', 'Addr3', 'Addr4', 'Addr5'].map((n) => txt(el, n)).filter((x): x is string => Boolean(x));
  return { lines, city: txt(el, 'City'), state: txt(el, 'State'), country: txt(el, 'Country') };
};
const dataExt = (el: Element): Record<string, string> => Object.fromEntries(
  kids(el, 'DataExtRet').map((d) => [txt(d, 'DataExtName') ?? '', txt(d, 'DataExtValue') ?? '']).filter(([k]) => k),
);
const line = (l: Element): QbLine => ({
  itemListId: txt(l, 'ItemRef', 'ListID'),
  itemName: txt(l, 'ItemRef', 'FullName'),
  description: txt(l, 'Desc'),
  quantity: txt(l, 'Quantity'),
  rate: txt(l, 'Rate'),
  ratePercent: txt(l, 'RatePercent'),
  amount: txt(l, 'Amount'),
  taxCode: txt(l, 'SalesTaxCodeRef', 'FullName'),
  unit: txt(l, 'UnitOfMeasure'),
});

export interface QueryResult<T> { status: string; message: string; items: T[]; iteratorId: string | null; remaining: number }

const statusOf = (rs: Element) => ({ status: rs.getAttribute('statusCode') ?? '0', message: rs.getAttribute('statusMessage') ?? '' });

/** Read an InvoiceQueryRs or SalesReceiptQueryRs. */
export function readTxns(xml: string, kind: 'Invoice' | 'SalesReceipt'): QueryResult<QbTxn> {
  const root = parseXml(xml);
  const rs = all(root, `${kind}QueryRs`)[0];
  if (!rs) return { status: 'missing', message: `No ${kind}QueryRs in the response`, items: [], iteratorId: null, remaining: 0 };
  const items = kids(rs, `${kind}Ret`).map((r): QbTxn => {
    const lines: QbLine[] = [];
    // Lines in their order; a group's lines are taken one by one (the group itself carries no price of its own).
    for (const n of Array.from(r.childNodes)) {
      if (n.nodeType !== 1) continue;
      const e = n as Element;
      const name = e.localName ?? e.nodeName;
      if (name === `${kind}LineRet`) lines.push(line(e));
      else if (name === `${kind}LineGroupRet`) for (const g of kids(e, `${kind}LineRet`)) lines.push(line(g));
    }
    return {
      kind: kind === 'Invoice' ? 'invoice' : 'sales_receipt',
      txnId: txt(r, 'TxnID') ?? '',
      editSequence: txt(r, 'EditSequence') ?? '',
      timeModified: txt(r, 'TimeModified') ?? '',
      txnDate: txt(r, 'TxnDate') ?? '',
      refNumber: txt(r, 'RefNumber'),
      customer: { listId: txt(r, 'CustomerRef', 'ListID'), name: txt(r, 'CustomerRef', 'FullName') },
      billAddress: address(kid(r, 'BillAddress')),
      dueDate: txt(r, 'DueDate'),
      terms: txt(r, 'TermsRef', 'FullName'),
      paymentMethod: txt(r, 'PaymentMethodRef', 'FullName'),
      memo: txt(r, 'Memo'),
      other: txt(r, 'Other'),
      subtotal: txt(r, 'Subtotal'),
      salesTaxTotal: txt(r, 'SalesTaxTotal'),
      salesTaxPercent: txt(r, 'SalesTaxPercentage'),
      isPending: txt(r, 'IsPending') === 'true',
      lines,
      custom: dataExt(r),
    };
  });
  return { ...statusOf(rs), items, iteratorId: rs.getAttribute('iteratorID') || null, remaining: Number(rs.getAttribute('iteratorRemainingCount') ?? 0) };
}

export interface QbCustomer { listId: string; name: string; companyName: string | null; email: string | null; phone: string | null; resaleNumber: string | null; accountNumber: string | null; billAddress: QbAddress | null; custom: Record<string, string> }

export function readCustomers(xml: string): QueryResult<QbCustomer> {
  const rs = all(parseXml(xml), 'CustomerQueryRs')[0];
  if (!rs) return { status: 'missing', message: 'No CustomerQueryRs', items: [], iteratorId: null, remaining: 0 };
  return {
    ...statusOf(rs), iteratorId: null, remaining: 0,
    items: kids(rs, 'CustomerRet').map((c) => ({
      listId: txt(c, 'ListID') ?? '',
      name: txt(c, 'FullName') ?? txt(c, 'Name') ?? '',
      companyName: txt(c, 'CompanyName'),
      email: txt(c, 'Email'),
      phone: txt(c, 'Phone'),
      resaleNumber: txt(c, 'ResaleNumber'),
      accountNumber: txt(c, 'AccountNumber'),
      billAddress: address(kid(c, 'BillAddress')),
      custom: dataExt(c),
    })),
  };
}

export type QbItemType = 'service' | 'inventory' | 'non_inventory' | 'other_charge' | 'discount' | 'subtotal' | 'sales_tax' | 'sales_tax_group' | 'payment' | 'group' | 'other';
const ITEM_TYPES: Record<string, QbItemType> = {
  ItemServiceRet: 'service', ItemInventoryRet: 'inventory', ItemInventoryAssemblyRet: 'inventory', ItemNonInventoryRet: 'non_inventory',
  ItemOtherChargeRet: 'other_charge', ItemDiscountRet: 'discount', ItemSubtotalRet: 'subtotal', ItemSalesTaxRet: 'sales_tax',
  ItemSalesTaxGroupRet: 'sales_tax_group', ItemPaymentRet: 'payment', ItemGroupRet: 'group', ItemFixedAssetRet: 'other',
};

export function readItems(xml: string): QueryResult<{ listId: string; name: string; type: QbItemType }> {
  const rs = all(parseXml(xml), 'ItemQueryRs')[0];
  if (!rs) return { status: 'missing', message: 'No ItemQueryRs', items: [], iteratorId: null, remaining: 0 };
  const items = Array.from(rs.childNodes).filter((n) => n.nodeType === 1).map((n) => {
    const e = n as Element;
    return { listId: txt(e, 'ListID') ?? '', name: txt(e, 'FullName') ?? txt(e, 'Name') ?? '', type: ITEM_TYPES[e.localName ?? e.nodeName] ?? 'other' };
  }).filter((i) => i.listId);
  return { ...statusOf(rs), items, iteratorId: null, remaining: 0 };
}

/** Read every *ModRs in a response: which write-backs worked, and the new EditSequence. */
export function readMods(xml: string): Array<{ requestId: string; status: string; message: string; editSequence: string | null }> {
  const root = parseXml(xml);
  return [...all(root, 'InvoiceModRs'), ...all(root, 'SalesReceiptModRs')].map((rs) => ({
    requestId: rs.getAttribute('requestID') ?? '',
    ...statusOf(rs),
    editSequence: txt(kid(rs, 'InvoiceRet') ?? kid(rs, 'SalesReceiptRet'), 'EditSequence'),
  }));
}

// ---------- QuickBooks Point of Sale ----------

const QBPOSXML_VERSION = '3.0';

export const qbposxml = (requests: string, version = QBPOSXML_VERSION) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<?qbposxml version="${version}"?>\n<QBPOSXML><QBPOSXMLMsgsRq onError="continueOnError">${requests}</QBPOSXMLMsgsRq></QBPOSXML>`;

export function posReceiptQuery(opts: { from?: string; iteratorId?: string; max?: number }): string {
  const it = opts.iteratorId ? ` iterator="Continue" iteratorID="${esc(opts.iteratorId)}"` : ' iterator="Start"';
  const filter = opts.iteratorId || !opts.from ? '' : `<TimeModifiedRangeFilter><FromTimeModified>${esc(opts.from)}</FromTimeModified></TimeModifiedRangeFilter>`;
  return `<SalesReceiptQueryRq requestID="PosReceipt"${it}><MaxReturned>${opts.max ?? 50}</MaxReturned>${filter}</SalesReceiptQueryRq>`;
}

export interface PosLine { description: string | null; quantity: string | null; price: string | null; extendedPrice: string | null; discount: string | null; taxAmount: string | null; taxCode: string | null }
export interface PosReceipt {
  txnId: string;
  timeModified: string;
  txnDate: string;
  number: string | null;
  type: 'sale' | 'return';
  state: string | null;
  customerListId: string | null;
  subtotal: string | null;
  discount: string | null;
  taxAmount: string | null;
  total: string | null;
  tender: string | null;
  comments: string | null;
  lines: PosLine[];
}

export function readPosReceipts(xml: string): QueryResult<PosReceipt> {
  const rs = all(parseXml(xml), 'SalesReceiptQueryRs')[0];
  if (!rs) return { status: 'missing', message: 'No SalesReceiptQueryRs', items: [], iteratorId: null, remaining: 0 };
  const items = kids(rs, 'SalesReceiptRet').map((r): PosReceipt => ({
    txnId: txt(r, 'TxnID') ?? '',
    timeModified: txt(r, 'TimeModified') ?? '',
    txnDate: (txt(r, 'TxnDate') ?? '').slice(0, 10),
    number: txt(r, 'SalesReceiptNumber'),
    type: /return/i.test(txt(r, 'SalesReceiptType') ?? '') ? 'return' : 'sale',
    state: txt(r, 'TxnState'),
    customerListId: txt(r, 'CustomerListID'),
    subtotal: txt(r, 'Subtotal'),
    discount: txt(r, 'Discount'),
    taxAmount: txt(r, 'TaxAmount'),
    total: txt(r, 'Total'),
    tender: txt(r, 'TenderType'),
    comments: txt(r, 'Comments'),
    lines: kids(r, 'SalesReceiptItemRet').map((l) => ({
      description: [txt(l, 'Desc1'), txt(l, 'Desc2')].filter(Boolean).join(' ') || null,
      quantity: txt(l, 'Qty'),
      price: txt(l, 'Price'),
      extendedPrice: txt(l, 'ExtendedPrice'),
      discount: txt(l, 'Discount'),
      taxAmount: txt(l, 'TaxAmount'),
      taxCode: txt(l, 'TaxCode'),
    })),
  }));
  return { ...statusOf(rs), items, iteratorId: rs.getAttribute('iteratorID') || null, remaining: Number(rs.getAttribute('iteratorRemainingCount') ?? 0) };
}
