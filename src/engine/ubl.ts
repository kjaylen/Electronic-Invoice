/**
 * UBL 2.1 XML for Electronic Tax Documents (Tax Invoice, Tax Receipt, Debit
 * Note, Credit Note), with the BTS/CIAT "EFDR" extension block.
 *
 * Output is unsigned. The sign module adds a second UBLExtension holding the
 * XAdES signature.
 *
 * Element order follows the OASIS UBL 2.1 schemas exactly (UBL is strict about
 * order), and the tests validate output against those schemas.
 *
 * Pure and stateless: everything tenant-specific is passed in.
 */

import { type Cents, formatCents } from './decimal.ts';
import type { DocumentTotals, LineResult, TaxSubtotal } from './calc.ts';
import { ETD_TYPES, type EtdType, OPER_MODES, parseEtdui } from './etdui.ts';
import type { SequenceInfo } from './sequence.ts';
import { el, leaf, optLeaf, serialize, type XmlElement } from './xml.ts';

export const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  // "Componentes" is the manual's spelling and must be copied exactly.
  efdr: 'ciat:org:efdr:CommonComponentes-2-4',
} as const;

/**
 * Names inside the BTS extension block.
 *
 * VERIFY AGAINST THE MANUAL'S ANNEX before the first test submission. The
 * ETDUIAddElem children and the two sequence names come from the spec; the
 * contingencyInfo children are a best guess (the spec lists the fields, not
 * the names), as is placing the sequence and contingency elements as siblings
 * of ETDUIAddElem.
 */
export const EFDR = {
  extensions: 'EFDRExtensions',
  etduiAddElem: 'ETDUIAddElem',
  etdType: 'ETDType',
  series: 'series',
  operMode: 'operMode',
  receptionEnv: 'receptionEnv',
  securityCode: 'securityCode',
  checkDigit: 'checkDigit',
  sequenceThis: 'sequenceInfoThisETD',
  sequencePrevious: 'sequenceInfoPreviousETD',
  contingencyInfo: 'contingencyInfo',
  contingencyReason: 'contingencyReason', // unverified
  contingencyStartDate: 'contingencyStartDate', // unverified
  contingencyStartTime: 'contingencyStartTime', // unverified
} as const;

export const UBL_VERSION_ID = '2.1';
export const CUSTOMIZATION_ID = 'urn:ciat:efdr:customization:1.0';
export const PROFILE_ID = 'urn:ciat:efdr:profile:standard';
export const CURRENCY = 'BZD';

/** BTS limit on a whole document. */
export const MAX_DOCUMENT_BYTES = 500_000;
/** Room left for the signature, which the sign module adds later. */
export const SIGNATURE_RESERVE_BYTES = 16_000;

export type IssuedEtdType = Exclude<EtdType, '05'>;

export interface UblOptions {
  /** UN/CEFACT 1001 type code per document type. Open question for BTS: 380 or 388 for a Tax Invoice. */
  typeCodes: Record<IssuedEtdType, string>;
  /** Country code written for Belize. Open question for BTS: the manual shows both BZE and BLZ. */
  countryCode: string;
  countryName: string;
  /** Write schemeID attributes naming the UN/ECE code lists on tax scheme and category IDs. */
  writeCodeListAttributes: boolean;
}

export const DEFAULT_UBL_OPTIONS: UblOptions = Object.freeze({
  typeCodes: Object.freeze({ '01': '388', '02': '383', '03': '383', '04': '381' }),
  countryCode: 'BLZ',
  countryName: 'Belize',
  writeCodeListAttributes: true,
});

export interface Address {
  street: string;
  additionalStreet?: string;
  city: string;
  /** Belize district name, e.g. "Cayo". */
  districtName: string;
  /** Belize district code, 1 to 6. */
  districtCode: '1' | '2' | '3' | '4' | '5' | '6';
}

export interface Contact {
  telephone: string;
  email: string;
}

export interface Supplier {
  /** Registered legal name. */
  legalName: string;
  /** Trade name, if different. Shown as the party name. */
  tradeName?: string;
  /** Must match the TIN in the ETDUI and in the signing certificate (BTS code 243). */
  tin: string;
  address: Address;
  contact: Contact;
}

export interface Customer {
  name?: string;
  /** TIN, for a GST-registered customer. */
  tin?: string;
  /** Another identifier when there is no TIN, e.g. a passport or social security number. */
  otherId?: { scheme: string; value: string };
  address?: Address;
  contact?: Partial<Contact>;
}

export interface DocumentReference {
  /** ETDUI of the document being corrected. */
  etdui: string;
  /** Original issue date, YYYY-MM-DD, if known. */
  issueDate?: string;
  /** Why the note is issued. */
  reason: string;
}

export interface Contingency {
  reason: string;
  /** YYYY-MM-DD, Belize time. */
  startDate: string;
  /** HH:MM:SS, Belize time. */
  startTime: string;
}

export interface Payment {
  /** UN/ECE 4461: 10 cash, 20 cheque, 30 credit transfer, 48 bank card. */
  meansCode?: '10' | '20' | '30' | '48';
  /** YYYY-MM-DD. */
  dueDate?: string;
  /** Free-text terms, e.g. "Net 30". */
  terms?: string;
}

export interface UblDocumentInput {
  etdType: IssuedEtdType;
  /** The 44-digit ETDUI built for this document. */
  etdui: string;
  /** Belize local issue date, YYYY-MM-DD. Must match the ETDUI. */
  issueDate: string;
  /** Belize local issue time, HH:MM:SS. Must match the ETDUI. */
  issueTime: string;
  supplier: Supplier;
  /** Required on a Tax Invoice. Optional on a Tax Receipt, where only the ID is written. */
  customer?: Customer;
  totals: DocumentTotals;
  sequence: SequenceInfo;
  /** Required on Debit and Credit Notes. */
  reference?: DocumentReference;
  /** Required when the ETDUI's operating mode is contingency, forbidden otherwise. */
  contingency?: Contingency;
  payment?: Payment;
  note?: string;
}

export interface UblResult {
  xml: string;
  byteLength: number;
  rootElement: 'Invoice' | 'CreditNote';
}

export class UblError extends Error {
  override name = 'UblError';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;
const nonEmpty = (s: string | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

function validate(input: UblDocumentInput, options: UblOptions): ReturnType<typeof parseEtdui> {
  const { etdType, supplier, customer, totals } = input;
  if (!(etdType in options.typeCodes)) {
    throw new UblError(`Document type ${etdType} is not built by the ubl module (events use ApplicationResponse)`);
  }
  const id = parseEtdui(input.etdui);
  if (id.etdType !== etdType) {
    throw new UblError(`ETDUI is for document type ${id.etdType}, not ${etdType}`);
  }
  if (!DATE.test(input.issueDate) || !TIME.test(input.issueTime)) {
    throw new UblError('issueDate must be YYYY-MM-DD and issueTime HH:MM:SS');
  }
  const yymmdd = input.issueDate.slice(2).replaceAll('-', '');
  const hhmm = input.issueTime.slice(0, 5).replace(':', '');
  if (id.issueDateYYMMDD !== yymmdd || id.issueTimeHHMM !== hhmm) {
    throw new UblError('Issue date and time do not match the ETDUI');
  }

  if (!nonEmpty(supplier.legalName)) throw new UblError('Supplier legal name is required');
  if (supplier.tin !== id.tin) throw new UblError('Supplier TIN does not match the ETDUI');
  validateAddress(supplier.address, 'Supplier');
  if (!nonEmpty(supplier.contact?.telephone) || !nonEmpty(supplier.contact?.email)) {
    throw new UblError('Supplier telephone and email are required');
  }

  if (etdType === ETD_TYPES.TAX_INVOICE) {
    if (!customer || !nonEmpty(customer.name)) {
      throw new UblError('A Tax Invoice needs a customer with a name (BTS code 283)');
    }
    if (customer.address) validateAddress(customer.address, 'Customer');
  }
  if (customer?.otherId && (!nonEmpty(customer.otherId.scheme) || !nonEmpty(customer.otherId.value))) {
    throw new UblError('Customer otherId needs a scheme and a value');
  }

  const isNote = etdType === ETD_TYPES.DEBIT_NOTE || etdType === ETD_TYPES.CREDIT_NOTE;
  if (isNote) {
    if (!input.reference) throw new UblError('Debit and Credit Notes must reference the original document');
    const ref = parseEtdui(input.reference.etdui);
    if (!['01', '02', '03'].includes(ref.etdType)) {
      throw new UblError(`A note cannot reference document type ${ref.etdType}`);
    }
    if (ref.tin !== id.tin) throw new UblError('A note can only reference a document from the same issuer');
    if (!nonEmpty(input.reference.reason)) throw new UblError('A note needs a reason');
    if (input.reference.issueDate !== undefined && !DATE.test(input.reference.issueDate)) {
      throw new UblError('Reference issueDate must be YYYY-MM-DD');
    }
  } else if (input.reference) {
    throw new UblError('Only Debit and Credit Notes carry a document reference');
  }

  const inContingency = id.operMode !== OPER_MODES.NORMAL;
  if (inContingency && !input.contingency) {
    throw new UblError('A contingency document needs contingency info (BTS code 244)');
  }
  if (!inContingency && input.contingency) {
    throw new UblError('A normal-mode document must not carry contingency info (BTS code 246)');
  }
  if (input.contingency) {
    const c = input.contingency;
    if (!nonEmpty(c.reason) || !DATE.test(c.startDate) || !TIME.test(c.startTime)) {
      throw new UblError('Contingency needs a reason, startDate YYYY-MM-DD and startTime HH:MM:SS');
    }
  }

  if (totals.lines.length === 0 || totals.lineCount !== totals.lines.length) {
    throw new UblError('Totals must come from calculateDocument and contain at least one line');
  }
  if (!input.sequence?.thisEtd) throw new UblError('Sequence info is required (BTS code 270)');

  const p = input.payment;
  if (totals.payableAmount > 0n && !p?.dueDate && !nonEmpty(p?.terms)) {
    throw new UblError('A document with an amount due needs a payment due date or payment terms');
  }
  if (p?.dueDate !== undefined && !DATE.test(p.dueDate)) throw new UblError('Payment dueDate must be YYYY-MM-DD');
  if (p?.dueDate && !p.meansCode) throw new UblError('A payment due date needs a payment means code');
  return id;
}

function validateAddress(a: Address | undefined, who: string): void {
  if (!a) throw new UblError(`${who} address is required`);
  if (!nonEmpty(a.street) || !nonEmpty(a.city) || !nonEmpty(a.districtName)) {
    throw new UblError(`${who} address needs street, city and district name`);
  }
  if (!['1', '2', '3', '4', '5', '6'].includes(a.districtCode)) {
    throw new UblError(`${who} district code must be 1 to 6`);
  }
}

// ---------- element builders ----------

const amount = (name: string, cents: Cents) => leaf(`cbc:${name}`, formatCents(cents), { currencyID: CURRENCY });

function schemeAttrs(list: '5153' | '5305', options: UblOptions) {
  return options.writeCodeListAttributes ? { schemeID: `UN/ECE ${list}`, schemeAgencyID: '6' } : undefined;
}

function taxScheme(id: string, options: UblOptions): XmlElement {
  return el('cac:TaxScheme', undefined, leaf('cbc:ID', id, schemeAttrs('5153', options)));
}

function efdrExtension(input: UblDocumentInput, id: ReturnType<typeof parseEtdui>): XmlElement {
  const e = (name: string) => `efdr:${name}`;
  const c = input.contingency;
  return el(
    'ext:UBLExtension',
    undefined,
    el(
      'ext:ExtensionContent',
      undefined,
      el(
        e(EFDR.extensions),
        undefined,
        el(
          e(EFDR.etduiAddElem),
          undefined,
          leaf(e(EFDR.etdType), id.etdType),
          leaf(e(EFDR.series), String(id.series).padStart(3, '0')),
          leaf(e(EFDR.operMode), String(id.operMode)),
          leaf(e(EFDR.receptionEnv), id.receptionEnv),
          leaf(e(EFDR.securityCode), id.securityCode),
          leaf(e(EFDR.checkDigit), String(id.checkDigit)),
        ),
        leaf(e(EFDR.sequenceThis), input.sequence.thisEtd),
        leaf(e(EFDR.sequencePrevious), input.sequence.previousEtd),
        c &&
          el(
            e(EFDR.contingencyInfo),
            undefined,
            leaf(e(EFDR.contingencyReason), c.reason),
            leaf(e(EFDR.contingencyStartDate), c.startDate),
            leaf(e(EFDR.contingencyStartTime), c.startTime),
          ),
      ),
    ),
  );
}

function postalAddress(a: Address, options: UblOptions): XmlElement {
  return el(
    'cac:PostalAddress',
    undefined,
    leaf('cbc:StreetName', a.street),
    optLeaf('cbc:AdditionalStreetName', a.additionalStreet),
    leaf('cbc:CityName', a.city),
    leaf('cbc:CountrySubentity', a.districtName),
    leaf('cbc:CountrySubentityCode', a.districtCode),
    el('cac:Country', undefined, leaf('cbc:IdentificationCode', options.countryCode), leaf('cbc:Name', options.countryName)),
  );
}

function partyTaxScheme(registrationName: string | undefined, tin: string, options: UblOptions): XmlElement {
  return el(
    'cac:PartyTaxScheme',
    undefined,
    optLeaf('cbc:RegistrationName', registrationName),
    leaf('cbc:CompanyID', tin),
    taxScheme('GST', options),
  );
}

function supplierParty(s: Supplier, options: UblOptions): XmlElement {
  return el(
    'cac:AccountingSupplierParty',
    undefined,
    el(
      'cac:Party',
      undefined,
      el('cac:PartyName', undefined, leaf('cbc:Name', nonEmpty(s.tradeName) ? s.tradeName : s.legalName)),
      postalAddress(s.address, options),
      partyTaxScheme(s.legalName, s.tin, options),
      el('cac:PartyLegalEntity', undefined, leaf('cbc:RegistrationName', s.legalName)),
      el('cac:Contact', undefined, leaf('cbc:Telephone', s.contact.telephone), leaf('cbc:ElectronicMail', s.contact.email)),
    ),
  );
}

function customerParty(input: UblDocumentInput, options: UblOptions): XmlElement {
  const c = input.customer;
  const otherId = c?.otherId
    ? el('cac:PartyIdentification', undefined, leaf('cbc:ID', c.otherId.value, { schemeID: c.otherId.scheme }))
    : undefined;

  // A Tax Receipt carries only the customer's ID, and only if one was given.
  // UBL requires the AccountingCustomerParty element, so an anonymous receipt has an empty one.
  if (input.etdType === ETD_TYPES.TAX_RECEIPT) {
    if (!c?.tin && !otherId) return el('cac:AccountingCustomerParty', undefined);
    return el(
      'cac:AccountingCustomerParty',
      undefined,
      el('cac:Party', undefined, otherId, c?.tin ? partyTaxScheme(undefined, c.tin, options) : undefined),
    );
  }

  if (!c) return el('cac:AccountingCustomerParty', undefined);
  const hasContact = nonEmpty(c.contact?.telephone) || nonEmpty(c.contact?.email);
  return el(
    'cac:AccountingCustomerParty',
    undefined,
    el(
      'cac:Party',
      undefined,
      otherId,
      nonEmpty(c.name) && el('cac:PartyName', undefined, leaf('cbc:Name', c.name)),
      c.address && postalAddress(c.address, options),
      c.tin ? partyTaxScheme(c.name, c.tin, options) : undefined,
      nonEmpty(c.name) && el('cac:PartyLegalEntity', undefined, leaf('cbc:RegistrationName', c.name)),
      hasContact &&
        el('cac:Contact', undefined, optLeaf('cbc:Telephone', c.contact?.telephone), optLeaf('cbc:ElectronicMail', c.contact?.email)),
    ),
  );
}

function documentReference(ref: DocumentReference): XmlElement {
  const original = parseEtdui(ref.etdui);
  return el(
    'cac:AdditionalDocumentReference',
    undefined,
    leaf('cbc:ID', String(original.serial).padStart(9, '0')),
    leaf('cbc:UUID', ref.etdui),
    optLeaf('cbc:IssueDate', ref.issueDate),
    leaf('cbc:DocumentTypeCode', original.etdType),
    leaf('cbc:DocumentDescription', ref.reason),
  );
}

function paymentElements(p: Payment | undefined): XmlElement[] {
  if (!p) return [];
  const out: XmlElement[] = [];
  if (p.meansCode) {
    out.push(el('cac:PaymentMeans', undefined, leaf('cbc:PaymentMeansCode', p.meansCode), optLeaf('cbc:PaymentDueDate', p.dueDate)));
  }
  if (nonEmpty(p.terms)) out.push(el('cac:PaymentTerms', undefined, leaf('cbc:Note', p.terms)));
  return out;
}

function taxCategory(
  category: string,
  options: UblOptions,
  scheme: string,
  extra: { percent?: string; exemptionReasonCode?: string } = {},
): XmlElement {
  return el(
    'cac:TaxCategory',
    undefined,
    leaf('cbc:ID', category, schemeAttrs('5305', options)),
    optLeaf('cbc:Percent', extra.percent),
    optLeaf('cbc:TaxExemptionReasonCode', extra.exemptionReasonCode),
    taxScheme(scheme, options),
  );
}

function documentTaxSubtotal(s: TaxSubtotal, options: UblOptions): XmlElement {
  return el(
    'cac:TaxSubtotal',
    undefined,
    amount('TaxableAmount', s.taxableAmount),
    amount('TaxAmount', s.taxAmount),
    s.scheme === 'GST'
      ? taxCategory(s.category!, options, 'GST', { percent: s.ratePercent })
      : taxCategory('S', options, s.scheme),
  );
}

function lineTaxTotal(line: LineResult, options: UblOptions): XmlElement {
  const other = line.otherTaxes.map((t) =>
    el(
      'cac:TaxSubtotal',
      undefined,
      amount('TaxableAmount', line.netAmount),
      amount('TaxAmount', t.amount),
      optLeaf('cbc:Percent', t.percent),
      t.perUnit !== undefined && leaf('cbc:BaseUnitMeasure', '1', { unitCode: line.unitCode }),
      t.perUnit !== undefined && leaf('cbc:PerUnitAmount', t.perUnit, { currencyID: CURRENCY }),
      taxCategory('S', options, t.scheme),
    ),
  );
  const gst = el(
    'cac:TaxSubtotal',
    undefined,
    amount('TaxableAmount', line.gstBase),
    amount('TaxAmount', line.gstAmount),
    taxCategory(line.gstCategory, options, 'GST', {
      percent: line.gstRatePercent,
      exemptionReasonCode: line.exemptionReasonCode,
    }),
  );
  return el('cac:TaxTotal', undefined, amount('TaxAmount', line.taxAmount), ...other, gst);
}

function documentLine(line: LineResult, isCreditNote: boolean, options: UblOptions): XmlElement {
  const allowanceCharges = line.allowanceCharges.map((ac) =>
    el(
      'cac:AllowanceCharge',
      undefined,
      leaf('cbc:ChargeIndicator', ac.isCharge ? 'true' : 'false'),
      leaf('cbc:AllowanceChargeReason', ac.reason),
      // Per the spec, a percentage is written as 20 for 20%.
      optLeaf('cbc:MultiplierFactorNumeric', ac.percent),
      amount('Amount', ac.amount),
      ac.baseAmount !== undefined && amount('BaseAmount', ac.baseAmount),
    ),
  );
  const tag = isCreditNote ? 'CreditNoteLine' : 'InvoiceLine';
  const quantityTag = isCreditNote ? 'CreditedQuantity' : 'InvoicedQuantity';
  return el(
    `cac:${tag}`,
    undefined,
    leaf('cbc:ID', String(line.lineNumber)),
    leaf(`cbc:${quantityTag}`, line.quantity.trim(), { unitCode: line.unitCode }),
    amount('LineExtensionAmount', line.netAmount),
    // InvoiceLine puts AllowanceCharge before TaxTotal; CreditNoteLine after it.
    ...(isCreditNote ? [] : allowanceCharges),
    lineTaxTotal(line, options),
    ...(isCreditNote ? allowanceCharges : []),
    el('cac:Item', undefined, leaf('cbc:Description', line.description)),
    el('cac:Price', undefined, leaf('cbc:PriceAmount', line.unitPrice.trim(), { currencyID: CURRENCY })),
  );
}

function legalMonetaryTotal(t: DocumentTotals): XmlElement {
  return el(
    'cac:LegalMonetaryTotal',
    undefined,
    amount('LineExtensionAmount', t.lineExtensionAmount),
    amount('TaxExclusiveAmount', t.taxExclusiveAmount),
    amount('TaxInclusiveAmount', t.taxInclusiveAmount),
    t.prepaidAmount !== 0n && amount('PrepaidAmount', t.prepaidAmount),
    t.payableRoundingAmount !== 0n && amount('PayableRoundingAmount', t.payableRoundingAmount),
    amount('PayableAmount', t.payableAmount),
  );
}

// ---------- document ----------

export function buildUblDocument(input: UblDocumentInput, options: UblOptions = DEFAULT_UBL_OPTIONS): UblResult {
  const id = validate(input, options);
  const isCreditNote = input.etdType === ETD_TYPES.CREDIT_NOTE;
  const rootElement = isCreditNote ? 'CreditNote' : 'Invoice';
  const t = input.totals;

  const root = el(
    rootElement,
    {
      xmlns: isCreditNote ? NS.creditNote : NS.invoice,
      'xmlns:cac': NS.cac,
      'xmlns:cbc': NS.cbc,
      'xmlns:ext': NS.ext,
      'xmlns:efdr': NS.efdr,
    },
    el('ext:UBLExtensions', undefined, efdrExtension(input, id)),
    leaf('cbc:UBLVersionID', UBL_VERSION_ID),
    leaf('cbc:CustomizationID', CUSTOMIZATION_ID),
    leaf('cbc:ProfileID', PROFILE_ID),
    leaf('cbc:ID', String(id.serial).padStart(9, '0')),
    leaf('cbc:UUID', input.etdui),
    leaf('cbc:IssueDate', input.issueDate),
    leaf('cbc:IssueTime', `${input.issueTime}-06:00`),
    leaf(isCreditNote ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', options.typeCodes[input.etdType]),
    optLeaf('cbc:Note', input.note),
    leaf('cbc:DocumentCurrencyCode', CURRENCY),
    leaf('cbc:LineCountNumeric', String(t.lineCount)),
    input.reference && documentReference(input.reference),
    supplierParty(input.supplier, options),
    customerParty(input, options),
    ...paymentElements(input.payment),
    el('cac:TaxTotal', undefined, amount('TaxAmount', t.taxAmount), ...t.taxSubtotals.map((s) => documentTaxSubtotal(s, options))),
    legalMonetaryTotal(t),
    ...t.lines.map((line) => documentLine(line, isCreditNote, options)),
  );

  const xml = serialize(root);
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength > MAX_DOCUMENT_BYTES - SIGNATURE_RESERVE_BYTES) {
    throw new UblError(
      `Document is ${byteLength} bytes; with the signature it would exceed the BTS limit of ${MAX_DOCUMENT_BYTES} (code 210)`,
    );
  }
  return { xml, byteLength, rootElement };
}
