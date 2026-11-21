/**
 * Sequence hash chain between documents in a series.
 *
 * Each invoice, receipt, debit note and credit note carries a hash of itself
 * (sequenceInfoThisETD) and the hash of the previous document in the same
 * series (sequenceInfoPreviousETD), so BTS can detect a gap or a deleted
 * document. Events must not carry it.
 *
 *   sequenceInfoThisETD = Base64(SHA-1(UTF-8(UUID + LineCountNumeric + TaxAmount + LineExtensionAmount)))
 *
 * Three details are unclear in the manual and must be settled against the BTS
 * test server (BTS answers 270 for a missing value, 271 for a wrong hash):
 *   1. whether a separator sits between the four values,
 *   2. how amounts are written (the manual's example seems to turn 549.90 into 5499),
 *   3. what the first document in a new series uses as its previous value.
 * They are options here, so settling them is a config change, not a rewrite.
 *
 * Pure and stateless. Finding the previous document in the series is the
 * caller's job, done under the per-series lock.
 */

import { createHash } from 'node:crypto';
import { type Cents, formatCents } from './decimal.ts';

/**
 * How amounts are written into the hash input, shown for 549.90 and 500.00:
 *   fixed2            "549.90"  "500.00"   (as written in the XML)
 *   fixed2-no-point   "54990"   "50000"
 *   compact           "549.9"   "500"
 *   compact-no-point  "5499"    "500"      (matches the manual's worked example)
 */
export type AmountFormat = 'fixed2' | 'fixed2-no-point' | 'compact' | 'compact-no-point';

export interface SequenceOptions {
  /** Text placed between the four values. */
  separator: string;
  amountFormat: AmountFormat;
  /** What sequenceInfoPreviousETD holds for the first document in a series. */
  firstInSeries: 'self' | 'empty';
}

/**
 * Best guess until the BTS test server confirms. "compact-no-point" follows the
 * manual's worked example; "self" avoids an empty value, which BTS may reject as
 * missing (code 270).
 */
export const DEFAULT_SEQUENCE_OPTIONS: SequenceOptions = Object.freeze({
  separator: '',
  amountFormat: 'compact-no-point',
  firstInSeries: 'self',
});

export interface SequenceInput {
  /** The document's 44-digit ETDUI (cbc:UUID). */
  uuid: string;
  /** cbc:LineCountNumeric. */
  lineCount: number;
  /** The document TaxAmount, in cents. */
  taxAmount: Cents;
  /** LegalMonetaryTotal/LineExtensionAmount, in cents. */
  lineExtensionAmount: Cents;
}

export interface SequenceInfo {
  thisEtd: string;
  previousEtd: string;
}

export class SequenceError extends Error {
  override name = 'SequenceError';
}

export function formatAmount(cents: Cents, format: AmountFormat): string {
  const fixed = formatCents(cents);
  switch (format) {
    case 'fixed2':
      return fixed;
    case 'fixed2-no-point':
      return fixed.replace('.', '');
    case 'compact':
      return fixed.replace(/\.?0+$/, '');
    case 'compact-no-point':
      return fixed.replace(/\.?0+$/, '').replace('.', '');
    default: {
      const unknown: never = format;
      throw new SequenceError(`Unknown amount format "${String(unknown)}"`);
    }
  }
}

/** The exact string that gets hashed. Exposed so it can be logged while tuning against BTS. */
export function sequenceSource(input: SequenceInput, options: SequenceOptions = DEFAULT_SEQUENCE_OPTIONS): string {
  if (!/^\d{44}$/.test(input.uuid)) {
    throw new SequenceError('uuid must be a 44-digit ETDUI');
  }
  if (!Number.isInteger(input.lineCount) || input.lineCount < 1) {
    throw new SequenceError(`lineCount must be a positive integer, got ${input.lineCount}`);
  }
  return [
    input.uuid,
    String(input.lineCount),
    formatAmount(input.taxAmount, options.amountFormat),
    formatAmount(input.lineExtensionAmount, options.amountFormat),
  ].join(options.separator);
}

/** sequenceInfoThisETD for one document. */
export function sequenceHash(input: SequenceInput, options: SequenceOptions = DEFAULT_SEQUENCE_OPTIONS): string {
  return createHash('sha1').update(Buffer.from(sequenceSource(input, options), 'utf8')).digest('base64');
}

/**
 * Both sequence values for a document.
 *
 * @param previousHash sequenceInfoThisETD of the last issued document in the
 *   same series (skipping serials that will never be used), or null if this is
 *   the first document in the series.
 */
export function buildSequenceInfo(
  input: SequenceInput,
  previousHash: string | null,
  options: SequenceOptions = DEFAULT_SEQUENCE_OPTIONS,
): SequenceInfo {
  const thisEtd = sequenceHash(input, options);
  if (previousHash !== null) {
    if (!/^[A-Za-z0-9+/]{27}=$/.test(previousHash)) {
      throw new SequenceError('previousHash must be a Base64 SHA-1 digest (28 characters)');
    }
    return { thisEtd, previousEtd: previousHash };
  }
  return { thisEtd, previousEtd: options.firstInSeries === 'self' ? thisEtd : '' };
}
