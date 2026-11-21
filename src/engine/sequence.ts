/**
 * Sequence hash chain between documents in a series (manual 4.3.4, EA-011 to EA-013).
 *
 * Every Invoice-schema and CreditNote-schema document carries, inside
 * efdr:sequenceInfo, a hash of itself (sequenceInfoThisETD) and the hash of the
 * previous document in the same series (sequenceInfoPreviousETD), so BTS can
 * detect a document that was issued but never sent. Events do not carry it.
 *
 *   sequenceInfoThisETD = Base64(SHA-1(UTF-8(UUID + LineCountNumeric + TaxAmount + LineExtensionAmount)))
 *
 * The four values are concatenated with no separator, each exactly as its text
 * appears in the XML. This reproduces both worked examples in section 4.3.4 and
 * all four complete samples in Annex I byte for byte. Because "as written" is
 * what counts, the ubl module computes this hash from the strings it writes.
 *
 * BTS validates only sequenceInfoThisETD on reception (codes 270 and 271); the
 * previous value is compared later to find gaps.
 */

import { createHash } from 'node:crypto';

export interface SequenceOptions {
  /**
   * What sequenceInfoPreviousETD holds for the first document in a series. The
   * manual does not say. "self" repeats this document's own hash, so the element
   * is never empty (BTS code 270 rejects a missing value).
   */
  firstInSeries: 'self' | 'empty';
}

export const DEFAULT_SEQUENCE_OPTIONS: SequenceOptions = Object.freeze({ firstInSeries: 'self' });

/** Every sample in the manual uses this as its previous value; kept for reference and tests. */
export const MANUAL_SAMPLE_PREVIOUS_HASH = '2M9dDwLvAsXLGhUF6gGOWM+npKc=';

export interface SequenceInput {
  /** cbc:UUID, the 44-digit ETDUI. */
  uuid: string;
  /** cbc:LineCountNumeric, as written. */
  lineCount: string;
  /** TaxTotal/TaxAmount, as written, e.g. "549.90". */
  taxAmount: string;
  /** LineExtensionAmount, as written, e.g. "5499" or "5499.00". */
  lineExtensionAmount: string;
}

export interface SequenceInfo {
  thisEtd: string;
  previousEtd: string;
}

export class SequenceError extends Error {
  override name = 'SequenceError';
}

const BASE64_SHA1 = /^[A-Za-z0-9+/]{27}=$/;
const AMOUNT = /^-?\d+(\.\d+)?$/;

/** The exact string that gets hashed. Exposed so it can be logged while testing against BTS. */
export function sequenceSource(input: SequenceInput): string {
  if (!/^\d{44}$/.test(input.uuid)) throw new SequenceError('uuid must be a 44-digit ETDUI');
  if (!/^[1-9]\d*$/.test(input.lineCount)) throw new SequenceError(`lineCount must be a positive integer, got "${input.lineCount}"`);
  if (!AMOUNT.test(input.taxAmount)) throw new SequenceError(`taxAmount is not a decimal: "${input.taxAmount}"`);
  if (!AMOUNT.test(input.lineExtensionAmount)) {
    throw new SequenceError(`lineExtensionAmount is not a decimal: "${input.lineExtensionAmount}"`);
  }
  return `${input.uuid}${input.lineCount}${input.taxAmount}${input.lineExtensionAmount}`;
}

/** sequenceInfoThisETD for one document. */
export function sequenceHash(input: SequenceInput): string {
  return createHash('sha1').update(Buffer.from(sequenceSource(input), 'utf8')).digest('base64');
}

export function isSequenceHash(value: string): boolean {
  return BASE64_SHA1.test(value);
}

/**
 * Both sequence values for a document.
 *
 * @param previousHash sequenceInfoThisETD of the last issued document in the
 *   same series (skipping serial numbers that will never be used), or null for
 *   the first document in the series.
 */
export function buildSequenceInfo(
  input: SequenceInput,
  previousHash: string | null,
  options: SequenceOptions = DEFAULT_SEQUENCE_OPTIONS,
): SequenceInfo {
  const thisEtd = sequenceHash(input);
  if (previousHash !== null) {
    if (!isSequenceHash(previousHash)) {
      throw new SequenceError('previousHash must be a Base64 SHA-1 digest (28 characters)');
    }
    return { thisEtd, previousEtd: previousHash };
  }
  return { thisEtd, previousEtd: options.firstInSeries === 'self' ? thisEtd : '' };
}
