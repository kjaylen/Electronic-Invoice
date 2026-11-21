/**
 * Events: UBL ApplicationResponse documents registered with BTS (manual 4.10, 7.8).
 *
 * Built here: 050, cancellation of an ETD by its issuer. The usual correction
 * for a wrong invoice is a credit note; cancellation is for documents that
 * should never have existed, e.g. a normal-mode document that turns out to
 * have been authorized after the sale was reissued in contingency (3.3.6.4).
 *
 * BTS rules enforced before building:
 *   - the event ETDUI has type 05 and series = the event code (257), operMode 1 (258)
 *   - ResponseCode equals the series (285); the description matches the code (286)
 *   - no sequenceInfo in the extension (287); one DocumentReference (227)
 *   - the author (SenderParty) is the issuer of the referenced ETD (268)
 *
 * Output is unsigned; sign it with signDocument like any other ETD.
 */

import { ETD_TYPES, OPER_MODES, parseEtdui, type ParsedEtdui } from './etdui.ts';
import { BELIZE_UTC_OFFSET } from './time.ts';
import { CUSTOMIZATION_ID, EFDR, ETD_TYPE_NAMES, MAX_DOCUMENT_BYTES, NS, SIGNATURE_RESERVE_BYTES, type Supplier, UBL_VERSION_ID } from './ubl.ts';
import { el, leaf, serialize, type XmlElement } from './xml.ts';

export const APPLICATION_RESPONSE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2';

export const EVENT_CODES = {
  ISSUER_CANCELLATION: '050',
} as const;

/** Exact texts from manual tables 4-27 and 4-32 (BTS checks the description, code 286). */
const EVENT_TEXTS = {
  '050': { description: 'ETD Cancellation', condition: 'ETD Cancellation: ETD cancelled by the issuer' },
} as const;

/** The event series number for cancellations: the event code as a number. */
export const CANCELLATION_SERIES = 50;

export interface CancellationInput {
  /** ETDUI of this event: type 05, series 050. */
  eventEtdui: string;
  /** Belize local date and time of the event, YYYY-MM-DD and HH:MM:SS. Must match the ETDUI. */
  issueDate: string;
  issueTime: string;
  /** The business cancelling its own document. */
  issuer: Supplier;
  /** ETDUI of the document being cancelled. */
  cancelledEtdui: string;
  reason: string;
}

export interface EventResult {
  xml: string;
  byteLength: number;
  rootElement: 'ApplicationResponse';
}

export class EventError extends Error {
  override name = 'EventError';
}

function validate(input: CancellationInput): { event: ParsedEtdui; cancelled: ParsedEtdui } {
  const event = parseEtdui(input.eventEtdui);
  if (event.etdType !== ETD_TYPES.EVENT) throw new EventError('An event ETDUI must have document type 05');
  if (event.series !== CANCELLATION_SERIES) throw new EventError('A cancellation event must use series 050, the event code (BTS code 257)');
  if (event.operMode !== OPER_MODES.PREVIOUS_AUTHORIZATION) throw new EventError('Events must use operMode 1 (BTS code 258)');
  if (event.tin !== input.issuer.tin) throw new EventError('Event ETDUI TIN does not match the issuer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate) || !/^\d{2}:\d{2}:\d{2}$/.test(input.issueTime)) {
    throw new EventError('issueDate must be YYYY-MM-DD and issueTime HH:MM:SS');
  }
  if (event.issueDateYYMMDD !== input.issueDate.slice(2).replaceAll('-', '') || event.issueTimeHHMM !== input.issueTime.slice(0, 5).replace(':', '')) {
    throw new EventError('Issue date and time do not match the event ETDUI');
  }
  const cancelled = parseEtdui(input.cancelledEtdui);
  if (cancelled.etdType === ETD_TYPES.EVENT) throw new EventError('Use event 051 to cancel an event, not 050');
  if (cancelled.tin !== input.issuer.tin) throw new EventError('Only the issuer of a document can cancel it (BTS code 268)');
  if (cancelled.receptionEnv !== event.receptionEnv) throw new EventError('The event and the cancelled document must be in the same environment');
  if (!input.reason?.trim()) throw new EventError('A cancellation needs a reason');
  if (!input.issuer.legalName?.trim()) throw new EventError('Issuer legal name is required');
  return { event, cancelled };
}

function party(tag: 'cac:SenderParty' | 'cac:ReceiverParty', s: Supplier): XmlElement {
  return el(
    tag,
    undefined,
    el('cac:PartyName', undefined, leaf('cbc:Name', s.tradeName?.trim() ? s.tradeName : s.legalName)),
    el(
      'cac:PartyTaxScheme',
      undefined,
      leaf('cbc:RegistrationName', s.legalName),
      leaf('cbc:CompanyID', s.tin),
      el('cac:TaxScheme', undefined, leaf('cbc:ID', 'GST')),
    ),
  );
}

export function buildCancellationEvent(input: CancellationInput): EventResult {
  const { event, cancelled } = validate(input);
  const code = EVENT_CODES.ISSUER_CANCELLATION;
  const texts = EVENT_TEXTS[code];
  const e = (name: string) => `efdr:${name}`;
  const time = `${input.issueTime}${BELIZE_UTC_OFFSET}`;

  const root = el(
    'ApplicationResponse',
    { xmlns: APPLICATION_RESPONSE_NS, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext, 'xmlns:efdr': NS.efdr },
    el(
      'ext:UBLExtensions',
      undefined,
      el(
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
              leaf(e(EFDR.etdType), event.etdType),
              leaf(e(EFDR.series), code),
              leaf(e(EFDR.operMode), String(event.operMode)),
              leaf(e(EFDR.receptionEnv), event.receptionEnv),
              leaf(e(EFDR.securityCode), event.securityCode),
              leaf(e(EFDR.checkDigit), String(event.checkDigit)),
            ),
            // No sequenceInfo: it is prohibited for ApplicationResponse (BTS code 287).
          ),
        ),
      ),
    ),
    leaf('cbc:UBLVersionID', UBL_VERSION_ID),
    leaf('cbc:CustomizationID', CUSTOMIZATION_ID),
    leaf('cbc:ID', String(event.serial).padStart(9, '0')),
    leaf('cbc:UUID', input.eventEtdui),
    leaf('cbc:IssueDate', input.issueDate),
    leaf('cbc:IssueTime', time),
    leaf('cbc:ResponseDate', input.issueDate),
    leaf('cbc:ResponseTime', time),
    party('cac:SenderParty', input.issuer),
    // The author of the referenced ETD (manual 4.10). For a cancellation, that is the issuer again.
    party('cac:ReceiverParty', input.issuer),
    el(
      'cac:DocumentResponse',
      undefined,
      el(
        'cac:Response',
        undefined,
        leaf('cbc:ReferenceID', 'Whole document'),
        leaf('cbc:ResponseCode', code),
        leaf('cbc:Description', texts.description),
        el('cac:Status', undefined, leaf('cbc:ConditionCode', code), leaf('cbc:Description', texts.condition), leaf('cbc:StatusReason', input.reason)),
      ),
      el(
        'cac:DocumentReference',
        undefined,
        leaf('cbc:ID', String(cancelled.serial).padStart(9, '0')), // required by the UBL schema
        leaf('cbc:UUID', input.cancelledEtdui),
        leaf('cbc:DocumentTypeCode', cancelled.etdType),
        leaf('cbc:DocumentType', ETD_TYPE_NAMES[cancelled.etdType]),
      ),
    ),
  );

  const xml = serialize(root);
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength > MAX_DOCUMENT_BYTES - SIGNATURE_RESERVE_BYTES) throw new EventError('Event exceeds the BTS size limit (code 210)');
  return { xml, byteLength, rootElement: 'ApplicationResponse' };
}
