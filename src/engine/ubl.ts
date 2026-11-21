/**
 * UBL 2.1 XML for Electronic Tax Documents (Tax Invoice, Tax Receipt, Debit
 * Note, Credit Note), with the BTS/CIAT "EFDR" extension block.
 *
 * Source: BTS Orientation Manual for Issuers of Electronic Tax Documents
 * v1.30 (May 2026), chapter 4 and Annex I. Where the manual's prose and its
 * XML examples disagree, this follows the XML examples, and the README lists
 * each such choice.
 *
 * Output is unsigned. The sign module adds a second UBLExtension holding the
 * XAdES signature. Element order follows the OASIS UBL 2.1 schemas exactly;
 * BTS validates the schema (code 220) and the tests do too.
 *
 * Pure and stateless: everything tenant-specific is passed in.
 */

import { type Cents, formatCents } from './decimal.ts';
import type { DocumentTotals, LineResult, TaxSubtotal } from './calc.ts';
import { ETD_TYPES, type EtdType, OPER_MODES, parseEtdui, type ParsedEtdui } from './etdui.ts';
import { buildSequenceInfo, DEFAULT_SEQUENCE_OPTIONS, isSequenceHash, type SequenceOptions } from './sequence.ts';
import { BELIZE_UTC_OFFSET } from './time.ts';
import { el, leaf, optLeaf, serialize, type XmlElement } from './xml.ts';

export const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  // "Componentes" is the manual's spelling and must be copied exactly (checked by BTS rule C04).
  efdr: 'ciat:org:efdr:CommonComponentes-2-4',
} as const;

/** Names inside the BTS extension block (manual table 4-22 and the example in 4.7). */
export const EFDR = {
  extensions: 'EFDRExtensions',
  etduiAddElem: 'ETDUIAddElem',
  etdType: 'ETDType',
  series: 'series',
  operMode: 'operMode',
  receptionEnv: 'receptionEnv',
  securityCode: 'securityCode',
  checkDigit: 'checkDigit',
  sequenceInfo: 'sequenceInfo',
  sequenceThis: 'sequenceInfoThisETD',
  sequencePrevious: 'sequenceInfoPreviousETD',
  contingencyInfo: 'contingencyInfo',
  contingencyReason: 'contingencyReason',
  contingencyInitDate: 'contingencyInitDate',
  contingencyInitTime: 'contingencyInitTime',
} as const;

export const UBL_VERSION_ID = '2.1';
export const CUSTOMIZATION_ID = 'urn:ciat:efdr:customization:1.0';
export const PROFILE_ID = 'urn:ciat:efdr:profile:standard';
export const CURRENCY = 'BZD';

/** BTS limit on a whole document (rule B01, code 210). */
export const MAX_DOCUMENT_BYTES = 500_000;
/** Room left for the signature, which the sign module adds later. */
export const SIGNATURE_RESERVE_BYTES = 16_000;

/** Belize districts, manual table 10-8. */
export const BELIZE_DISTRICTS = {
  '1': 'Belize',
  '2': 'Cayo',
  '3': 'Corozal',
  '4': 'Orange Walk',
  '5': 'Stann Creek',
  '6': 'Toledo',
} as const;
export type DistrictCode = keyof typeof BELIZE_DISTRICTS;

/** Names for cbc:DocumentType on a document reference (BTS warning 282). */
export const ETD_TYPE_NAMES: Record<EtdType, string> = {
  '01': 'Tax Invoice',
  '02': 'Tax Receipt',
  '03': 'Debit Note',
  '04': 'Credit Note',
  '05': 'Application Response',
};

export type IssuedEtdType = Exclude<EtdType, '05'>;

export interface UblOptions {
  /**
   * UN/CEFACT 1001 type code per document type (manual tables 10-3 and 10-4).
   * A wrong code is only a warning (277). The manual says issuers may use just
   * 380 for invoices, 80 for debit notes and 381 for credit notes.
   */
  typeCodes: Record<IssuedEtdType, string>;
  /** ISO 3166-1 alpha-3 code for Belize (manual table 10-7). */
  countryCode: string;
  countryName: string;
  sequence: SequenceOptions;
}

export const DEFAULT_UBL_OPTIONS: UblOptions = Object.freeze({
  typeCodes: Object.freeze({ '01': '380', '02': '380', '03': '80', '04': '381' }),
  countryCode: 'BLZ',
  countryName: 'Belize',
  sequence: DEFAULT_SEQUENCE_OPTIONS,
});

export interface Address {
  street: string;
  additionalStreet?: string;
  city: string;
  /** Belize district name, e.g. "Cayo". Must match districtCode. */
  districtName: string;
  districtCode: DistrictCode;
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
  /** UBL needs both telephone and email in a Contact; a contact with only one is left out. */
  contact?: Partial<Contact>;
}

export interface DocumentReference {
  /** ETDUI of the document being corrected. */
  etdui: string;
  /** Original issue date, YYYY-MM-DD. Taken from the ETDUI if left out. */
  issueDate?: string;
  /** Original issue time, HH:MM:SS. Taken from the ETDUI (seconds 00) if left out. */
  issueTime?: string;
  /** Why the note is issued. */
  reason: string;
}

export interface Contingency {
  reason: string;
  /** When the business entered contingency, Belize time. YYYY-MM-DD. */
  initDate: string;
  /** HH:MM:SS, Belize time. */
  initTime: string;
}

export interface Payment {
  /** UNTDID 4461, e.g. 10 cash, 20 cheque, 30 credit transfer, 48 bank card. */
  meansCode?: string;
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
  /**
   * sequenceInfoThisETD of the last issued document in the same series, or null
   * for the first. This document's own hash is computed here from the XML.
   */
  previousSequenceHash: string | null;
  /** Required on Debit and Credit Notes. */
  reference?: DocumentReference;
  /** Mandatory for operMode 2, optional for 3, forbidden for 1. */
  contingency?: Contingency;
  payment?: Payment;
  note?: string;
}

export interface UblResult {
  xml: string;
  byteLength: number;
  rootElement: 'Invoice' | 'CreditNote';
  /** Store this on the series so the next document can chain to it. */
  sequenceInfoThisEtd: string;
  /** The exact string that was hashed, for logging while testing against BTS. */
  sequenceSource: string;
}

export class UblError extends Error {
  override name = 'UblError';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;
const nonEmpty = (s: string | undefined): s is string => typeof s === 'string' && s.trim().length > 0;

// ---------- validation ----------

function validate(input: UblDocumentInput, options: UblOptions): ParsedEtdui {
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

  if (etdType === ETD_TYPES.TAX_INVOICE && (!customer || !nonEmpty(customer.name))) {
    throw new UblError('A Tax Invoice needs a customer with a name (BTS code 283)');
  }
  if (customer?.address) validateAddress(customer.address, 'Customer');
  if (customer?.tin !== undefined && !/^\d{6}$/.test(customer.tin)) {
    throw new UblError('Customer TIN must be 6 digits');
  }
  if (customer?.otherId && (!nonEmpty(customer.otherId.scheme) || !nonEmpty(customer.otherId.value))) {
    throw new UblError('Customer otherId needs a scheme and a value');
  }

  const isNote = etdType === ETD_TYPES.DEBIT_NOTE || etdType === ETD_TYPES.CREDIT_NOTE;
  if (isNote) {
    const r = input.reference;
    if (!r) throw new UblError('Debit and Credit Notes must reference the original document');
    const ref = parseEtdui(r.etdui); // codes 272 to 274
    if (!['01', '02', '03'].includes(ref.etdType)) {
      throw new UblError(`A note cannot reference document type ${ref.etdType}`);
    }
    if (ref.tin !== id.tin) throw new UblError('A note can only reference a document from the same issuer');
    if (!nonEmpty(r.reason)) throw new UblError('A note needs a reason');
    if (r.issueDate !== undefined && !DATE.test(r.issueDate)) throw new UblError('Reference issueDate must be YYYY-MM-DD');
    if (r.issueTime !== undefined && !TIME.test(r.issueTime)) throw new UblError('Reference issueTime must be HH:MM:SS');
  } else if (input.reference) {
    throw new UblError('Only Debit and Credit Notes carry a document reference');
  }

  if (id.operMode === OPER_MODES.SUBSEQUENT_AUTHORIZATION && !input.contingency) {
    throw new UblError('operMode 2 needs contingency info (BTS code 244)');
  }
  if (id.operMode === OPER_MODES.PREVIOUS_AUTHORIZATION && input.contingency) {
    throw new UblError('operMode 1 must not carry contingency info (BTS code 246)');
  }
  if (input.contingency) {
    const c = input.contingency;
    if (!nonEmpty(c.reason)) throw new UblError('Contingency needs a reason');
    if (!DATE.test(c.initDate) || !TIME.test(c.initTime)) {
      throw new UblError('Contingency initDate must be YYYY-MM-DD and initTime HH:MM:SS (BTS code 245)');
    }
  }

  if (totals.lines.length === 0 || totals.lineCount !== totals.lines.length) {
    throw new UblError('Totals must come from calculateDocument and contain at least one line');
  }
  if (input.previousSequenceHash !== null && !isSequenceHash(input.previousSequenceHash)) {
    throw new UblError('previousSequenceHash must be a Base64 SHA-1 digest');
  }

  const p = input.payment;
  if (totals.payableAmount > 0n && !p?.dueDate && !nonEmpty(p?.terms)) {
    throw new UblError('A document with an amount due needs a payment due date or payment terms');
  }
  if (p?.dueDate !== undefined && !DATE.test(p.dueDate)) throw new UblError('Payment dueDate must be YYYY-MM-DD');
  if (p?.dueDate && !p.meansCode) throw new UblError('A payment due date needs a payment means code');
  if (p?.meansCode !== undefined && !/^\d{1,3}$/.test(p.meansCode)) {
    throw new UblError('Payment meansCode must be a UNTDID 4461 code, e.g. 10, 30 or 48');
  }
  return id;
}

function validateAddress(a: Address | undefined, who: string): void {
  if (!a) throw new UblError(`${who} address is required`);
  if (!nonEmpty(a.street) || !nonEmpty(a.city) || !nonEmpty(a.districtName)) {
    throw new UblError(`${who} address needs street, city and district name`);
  }
  const expected = BELIZE_DISTRICTS[a.districtCode];
  if (!expected) throw new UblError(`${who} district code must be 1 to 6`);
  if (a.districtName.trim().toLowerCase() !== expected.toLowerCase()) {
    throw new UblError(`${who} district code ${a.districtCode} is ${expected}, not "${a.districtName}"`);
  }
}

// ---------- element builders ----------

const amount = (name: string, cents: Cents) => leaf(`cbc:${name}`, formatCents(cents), { currencyID: CURRENCY });

// The manual writes these attributes without a space ("UN/ECE5305"); BTS does not validate them.
const CATEGORY_ATTRS = { schemeID: 'UN/ECE5305', schemeAgencyID: '6' };
const SCHEME_ATTRS = { schemeID: 'UN/ECE5153', schemeAgencyID: '6' };
const TYPE_CODE_ATTRS = { listID: 'UN/ECE 1001 Subset', listAgencyID: 'UN/CEFACT' }; // warnings 278, 279

function taxScheme(id: string): XmlElement {
  return el('cac:TaxScheme', undefined, leaf('cbc:ID', id, SCHEME_ATTRS));
}

interface CategoryParts {
  percent?: string;
  perUnitAmount?: string;
  exemptionReasonCode?: string;
  exemptionReason?: string;
}

/** TaxCategory and ClassifiedTaxCategory share this content and order. */
function categoryElement(tag: 'cac:TaxCategory' | 'cac:ClassifiedTaxCategory', category: string, scheme: string, p: CategoryParts = {}) {
  return el(
    tag,
    undefined,
    leaf('cbc:ID', category, CATEGORY_ATTRS),
    optLeaf('cbc:Percent', p.percent),
    p.perUnitAmount !== undefined && leaf('cbc:PerUnitAmount', p.perUnitAmount, { currencyID: CURRENCY }),
    optLeaf('cbc:TaxExemptionReasonCode', p.exemptionReasonCode, { listID: 'CWA15577', listAgencyID: 'ZZZ' }),
    optLeaf('cbc:TaxExemptionReason', p.exemptionReason),
    taxScheme(scheme),
  );
}

function belizeTime(hhmmss: string): string {
  return `${hhmmss}${BELIZE_UTC_OFFSET}`;
}

function efdrExtension(id: ParsedEtdui, thisEtd: string, previousEtd: string, c: Contingency | undefined): XmlElement {
  const e = (name: string) => `efdr:${name}`;
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
        el(
          e(EFDR.sequenceInfo),
          undefined,
          leaf(e(EFDR.sequenceThis), thisEtd),
          // An empty previous value (firstInSeries "empty") is written as an empty element.
          previousEtd ? leaf(e(EFDR.sequencePrevious), previousEtd) : el(e(EFDR.sequencePrevious), undefined),
        ),
        c &&
          el(
            e(EFDR.contingencyInfo),
            undefined,
            leaf(e(EFDR.contingencyReason), c.reason),
            leaf(e(EFDR.contingencyInitDate), c.initDate),
            leaf(e(EFDR.contingencyInitTime), belizeTime(c.initTime)),
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
    leaf('cbc:CountrySubentity', BELIZE_DISTRICTS[a.districtCode]),
    leaf('cbc:CountrySubentityCode', a.districtCode),
    el('cac:Country', undefined, leaf('cbc:IdentificationCode', options.countryCode), leaf('cbc:Name', options.countryName)),
  );
}

/** The TIN goes in PartyTaxScheme/CompanyID (manual tables 4-17, 4-34, 4-35). */
function partyTaxScheme(registrationName: string | undefined, tin: string): XmlElement {
  return el('cac:PartyTaxScheme', undefined, optLeaf('cbc:RegistrationName', registrationName), leaf('cbc:CompanyID', tin), taxScheme('GST'));
}

/** Manual 4.6.2 also names PartyLegalEntity/CompanyID for the TIN, so it is written there too. */
function partyLegalEntity(name: string, tin: string | undefined): XmlElement {
  return el('cac:PartyLegalEntity', undefined, leaf('cbc:RegistrationName', name), optLeaf('cbc:CompanyID', tin));
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
      partyTaxScheme(s.legalName, s.tin),
      partyLegalEntity(s.legalName, s.tin),
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
      el('cac:Party', undefined, otherId, c?.tin ? partyTaxScheme(undefined, c.tin) : undefined),
    );
  }

  if (!c) return el('cac:AccountingCustomerParty', undefined);
  const hasContact = nonEmpty(c.contact?.telephone) && nonEmpty(c.contact?.email);
  return el(
    'cac:AccountingCustomerParty',
    undefined,
    el(
      'cac:Party',
      undefined,
      otherId,
      nonEmpty(c.name) && el('cac:PartyName', undefined, leaf('cbc:Name', c.name)),
      c.address && postalAddress(c.address, options),
      c.tin ? partyTaxScheme(c.name, c.tin) : undefined,
      nonEmpty(c.name) && partyLegalEntity(c.name, c.tin),
      hasContact && el('cac:Contact', undefined, leaf('cbc:Telephone', c.contact!.telephone!), leaf('cbc:ElectronicMail', c.contact!.email!)),
    ),
  );
}

function documentReference(ref: DocumentReference): XmlElement {
  const original = parseEtdui(ref.etdui);
  const yymmdd = original.issueDateYYMMDD;
  const hhmm = original.issueTimeHHMM;
  const issueDate = ref.issueDate ?? `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  const issueTime = ref.issueTime ?? `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`;
  return el(
    'cac:AdditionalDocumentReference',
    undefined,
    leaf('cbc:ID', String(original.serial).padStart(9, '0')),
    leaf('cbc:UUID', ref.etdui),
    leaf('cbc:IssueDate', issueDate),
    leaf('cbc:IssueTime', belizeTime(issueTime)),
    leaf('cbc:DocumentTypeCode', original.etdType),
    leaf('cbc:DocumentType', ETD_TYPE_NAMES[original.etdType]),
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

/**
 * Document-level TaxTotal: one per tax scheme, GST first (BD-002 is "the total
 * tax amount for a particular taxation scheme"; table 5-2 reads the GST paid
 * from Invoice/TaxTotal/TaxAmount).
 */
function documentTaxTotals(subtotals: TaxSubtotal[]): XmlElement[] {
  const schemes = [...new Set(subtotals.map((s) => s.scheme))];
  return schemes.map((scheme) => {
    const group = subtotals.filter((s) => s.scheme === scheme);
    const total = group.reduce((acc, s) => acc + s.taxAmount, 0n);
    return el(
      'cac:TaxTotal',
      undefined,
      amount('TaxAmount', total),
      ...group.map((s) =>
        scheme === 'GST'
          ? el(
              'cac:TaxSubtotal',
              undefined,
              amount('TaxableAmount', s.taxableAmount),
              amount('TaxAmount', s.taxAmount),
              categoryElement('cac:TaxCategory', s.category!, 'GST', { percent: s.ratePercent }),
            )
          : // TaxableAmount is optional here, and a document-wide quantity across lines is not meaningful.
            el('cac:TaxSubtotal', undefined, amount('TaxAmount', s.taxAmount), categoryElement('cac:TaxCategory', 'S', scheme)),
      ),
    );
  });
}

/**
 * Line TaxTotal, following the manual's fuel example in 4.8.2: one TaxTotal
 * holding the GST subtotal and one subtotal per other tax. A per-unit tax puts
 * the quantity in TaxableAmount and the rate in TaxCategory/PerUnitAmount.
 */
function lineTaxTotal(line: LineResult): XmlElement {
  const gst = el(
    'cac:TaxSubtotal',
    undefined,
    amount('TaxableAmount', line.gstBase),
    amount('TaxAmount', line.gstAmount),
    categoryElement('cac:TaxCategory', line.gstCategory, 'GST', {
      percent: line.gstRatePercent,
      exemptionReasonCode: line.exemptionReasonCode,
      exemptionReason: line.exemptionReason,
    }),
  );
  const other = line.otherTaxes.map((t) =>
    el(
      'cac:TaxSubtotal',
      undefined,
      t.perUnit !== undefined
        ? leaf('cbc:TaxableAmount', line.quantity, { currencyID: CURRENCY })
        : amount('TaxableAmount', line.netAmount),
      amount('TaxAmount', t.amount),
      categoryElement('cac:TaxCategory', 'S', t.scheme, { percent: t.percent, perUnitAmount: t.perUnit }),
    ),
  );
  return el('cac:TaxTotal', undefined, amount('TaxAmount', line.taxAmount), gst, ...other);
}

function lineAllowanceCharges(line: LineResult): XmlElement[] {
  return line.allowanceCharges.map((ac, i) =>
    el(
      'cac:AllowanceCharge',
      undefined,
      leaf('cbc:ID', String(i + 1)),
      leaf('cbc:ChargeIndicator', ac.isCharge ? 'true' : 'false'),
      leaf('cbc:AllowanceChargeReason', ac.reason),
      // Per the spec, a percentage is written as 20 for 20%.
      optLeaf('cbc:MultiplierFactorNumeric', ac.percent),
      amount('Amount', ac.amount),
      amount('BaseAmount', ac.baseAmount ?? line.grossAmount),
      categoryElement('cac:TaxCategory', line.gstCategory, 'GST', { percent: line.gstRatePercent }),
    ),
  );
}

function item(line: LineResult): XmlElement {
  return el(
    'cac:Item',
    undefined,
    leaf('cbc:Description', line.description),
    optLeaf('cbc:Name', line.itemName),
    line.sellerItemCode !== undefined && el('cac:SellersItemIdentification', undefined, leaf('cbc:ID', line.sellerItemCode)),
    ...line.otherTaxes.map((t) => categoryElement('cac:ClassifiedTaxCategory', 'S', t.scheme, { percent: t.percent, perUnitAmount: t.perUnit })),
    categoryElement('cac:ClassifiedTaxCategory', line.gstCategory, 'GST', {
      percent: line.gstRatePercent,
      exemptionReasonCode: line.exemptionReasonCode,
    }),
  );
}

function documentLine(line: LineResult, isCreditNote: boolean): XmlElement {
  const allowanceCharges = lineAllowanceCharges(line);
  const tag = isCreditNote ? 'CreditNoteLine' : 'InvoiceLine';
  const quantityTag = isCreditNote ? 'CreditedQuantity' : 'InvoicedQuantity';
  return el(
    `cac:${tag}`,
    undefined,
    leaf('cbc:ID', String(line.lineNumber)),
    leaf(`cbc:${quantityTag}`, line.quantity, { unitCode: line.unitCode }),
    amount('LineExtensionAmount', line.netAmount),
    // The UBL 2.1 schemas put AllowanceCharge before TaxTotal in InvoiceLine and after it in CreditNoteLine.
    ...(isCreditNote ? [] : allowanceCharges),
    lineTaxTotal(line),
    ...(isCreditNote ? allowanceCharges : []),
    item(line),
    el(
      'cac:Price',
      undefined,
      leaf('cbc:PriceAmount', line.unitPrice, { currencyID: CURRENCY }),
      leaf('cbc:BaseQuantity', '1', { unitCode: line.unitCode }),
    ),
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

  // The hash uses each value exactly as written below (manual 4.3.4).
  // TaxAmount: the first document-level TaxTotal, which is GST.
  // LineExtensionAmount: the document total. The manual cites the line element (CA-006);
  // with one line they are the same. Open question for BTS for multi-line documents.
  const sequenceInput = {
    uuid: input.etdui,
    lineCount: String(t.lineCount),
    taxAmount: formatCents(t.gstAmount),
    lineExtensionAmount: formatCents(t.lineExtensionAmount),
  };
  const sequence = buildSequenceInfo(sequenceInput, input.previousSequenceHash, options.sequence);

  const root = el(
    rootElement,
    {
      xmlns: isCreditNote ? NS.creditNote : NS.invoice,
      'xmlns:cac': NS.cac,
      'xmlns:cbc': NS.cbc,
      'xmlns:ext': NS.ext,
      'xmlns:efdr': NS.efdr,
    },
    el('ext:UBLExtensions', undefined, efdrExtension(id, sequence.thisEtd, sequence.previousEtd, input.contingency)),
    leaf('cbc:UBLVersionID', UBL_VERSION_ID),
    leaf('cbc:CustomizationID', CUSTOMIZATION_ID),
    leaf('cbc:ProfileID', PROFILE_ID),
    leaf('cbc:ID', String(id.serial).padStart(9, '0')),
    leaf('cbc:UUID', input.etdui),
    leaf('cbc:IssueDate', input.issueDate),
    leaf('cbc:IssueTime', belizeTime(input.issueTime)),
    leaf(isCreditNote ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', options.typeCodes[input.etdType], TYPE_CODE_ATTRS),
    optLeaf('cbc:Note', input.note),
    leaf('cbc:DocumentCurrencyCode', CURRENCY),
    leaf('cbc:LineCountNumeric', sequenceInput.lineCount),
    input.reference && documentReference(input.reference),
    supplierParty(input.supplier, options),
    customerParty(input, options),
    ...paymentElements(input.payment),
    ...documentTaxTotals(t.taxSubtotals),
    legalMonetaryTotal(t),
    ...t.lines.map((line) => documentLine(line, isCreditNote)),
  );

  const xml = serialize(root);
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength > MAX_DOCUMENT_BYTES - SIGNATURE_RESERVE_BYTES) {
    throw new UblError(
      `Document is ${byteLength} bytes; with the signature it would exceed the BTS limit of ${MAX_DOCUMENT_BYTES} (code 210)`,
    );
  }
  return {
    xml,
    byteLength,
    rootElement,
    sequenceInfoThisEtd: sequence.thisEtd,
    sequenceSource: `${sequenceInput.uuid}${sequenceInput.lineCount}${sequenceInput.taxAmount}${sequenceInput.lineExtensionAmount}`,
  };
}
