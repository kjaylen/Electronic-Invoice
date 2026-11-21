/**
 * ETDUI: the 44-digit unique ID of an Electronic Tax Document.
 *
 * Our software, not BTS, generates it before sending. Layout (positions are
 * 1-based), following the manual's worked examples:
 *
 *   1-2   document type          01 to 05
 *   3     reserved               always 0
 *   4-9   issuer TIN             6 digits
 *   10-18 serial number          9 digits, zero padded
 *   19-21 series                 3 digits
 *   22-27 issue date             YYMMDD
 *   28-31 issue time             HHMM
 *   32    operating mode         1 normal, 2 contingency, 3 contingency (Tax Receipt)
 *   33-34 reception environment  01 production, 02 test
 *   35-43 security code          9 random digits
 *   44    check digit            modulus 11
 */

import { randomInt } from 'node:crypto';

export const ETD_TYPES = {
  TAX_INVOICE: '01',
  TAX_RECEIPT: '02',
  DEBIT_NOTE: '03',
  CREDIT_NOTE: '04',
  EVENT: '05',
} as const;
export type EtdType = (typeof ETD_TYPES)[keyof typeof ETD_TYPES];

export const OPER_MODES = {
  NORMAL: 1,
  CONTINGENCY: 2,
  CONTINGENCY_TAX_RECEIPT: 3,
} as const;
export type OperMode = (typeof OPER_MODES)[keyof typeof OPER_MODES];

export const RECEPTION_ENVS = {
  PRODUCTION: '01',
  TEST: '02',
} as const;
export type ReceptionEnv = (typeof RECEPTION_ENVS)[keyof typeof RECEPTION_ENVS];

export interface EtduiParts {
  etdType: EtdType;
  /** Issuer TIN, 6 digits. (Open question for BTS: one passage mentions 7.) */
  tin: string;
  /** Serial number, 1 to 999,999,999. */
  serial: number;
  /** Series, 0 to 999. */
  series: number;
  /** Local Belize issue date, YYYY-MM-DD. */
  issueDate: string;
  /** Local Belize issue time, HH:MM or HH:MM:SS. Seconds are not part of the ID. */
  issueTime: string;
  operMode: OperMode;
  receptionEnv: ReceptionEnv;
  /** 9 digits from a cryptographic random source. Use generateSecurityCode(). */
  securityCode: string;
}

export interface ParsedEtdui extends Omit<EtduiParts, 'issueDate' | 'issueTime'> {
  /** YYMMDD as stored in the ID. The century is not recoverable from the ID alone. */
  issueDateYYMMDD: string;
  /** HHMM as stored in the ID. */
  issueTimeHHMM: string;
  checkDigit: number;
}

export class EtduiError extends Error {
  override name = 'EtduiError';
}

const WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * What the check digit is when 11 - remainder is 10 or 11.
 *
 * The manual's examples show 1 for a remainder of 0 (result 11) and for a
 * remainder of 10 (result 1, which needs no mapping). No example shows a
 * remainder of 1 (result 10), and the manual states no rule. 1 is a
 * placeholder for both until BTS confirms (see "Open questions" in the spec).
 */
export const CHECK_DIGIT_WHEN_10_OR_11 = 1;

/** Modulus 11 check digit over the first 43 digits, weights 2..9 from the right. */
export function computeCheckDigit(first43: string): number {
  if (!/^\d{43}$/.test(first43)) {
    throw new EtduiError(`Check digit input must be exactly 43 digits, got "${first43}"`);
  }
  let total = 0;
  for (let i = 0; i < 43; i++) {
    const digit = first43.charCodeAt(42 - i) - 48;
    total += digit * WEIGHTS[i % WEIGHTS.length]!;
  }
  const result = 11 - (total % 11);
  return result >= 10 ? CHECK_DIGIT_WHEN_10_OR_11 : result;
}

/** A 9-digit security code from a cryptographic random source. */
export function generateSecurityCode(): string {
  return String(randomInt(0, 1_000_000_000)).padStart(9, '0');
}

function assertOperModeAllowed(etdType: EtdType, operMode: OperMode): void {
  if (operMode === OPER_MODES.NORMAL) return;
  if (etdType === ETD_TYPES.EVENT) {
    throw new EtduiError('Events cannot be registered in contingency (operMode must be 1)');
  }
  if (etdType === ETD_TYPES.TAX_RECEIPT && operMode !== OPER_MODES.CONTINGENCY_TAX_RECEIPT) {
    throw new EtduiError('A Tax Receipt in contingency must use operMode 3');
  }
  if (etdType !== ETD_TYPES.TAX_RECEIPT && operMode !== OPER_MODES.CONTINGENCY) {
    throw new EtduiError(`Document type ${etdType} in contingency must use operMode 2`);
  }
}

function assertParts(p: EtduiParts): void {
  if (!Object.values(ETD_TYPES).includes(p.etdType)) {
    throw new EtduiError(`Unknown document type "${p.etdType}"`);
  }
  if (!/^\d{6}$/.test(p.tin)) {
    throw new EtduiError(`TIN must be exactly 6 digits, got "${p.tin}"`);
  }
  if (!Number.isInteger(p.serial) || p.serial < 1 || p.serial > 999_999_999) {
    throw new EtduiError(`Serial must be an integer from 1 to 999999999, got ${p.serial}`);
  }
  if (!Number.isInteger(p.series) || p.series < 0 || p.series > 999) {
    throw new EtduiError(`Series must be an integer from 0 to 999, got ${p.series}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.issueDate) || Number.isNaN(Date.parse(`${p.issueDate}T00:00:00Z`))) {
    throw new EtduiError(`Issue date must be YYYY-MM-DD, got "${p.issueDate}"`);
  }
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(p.issueTime);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59) {
    throw new EtduiError(`Issue time must be HH:MM or HH:MM:SS, got "${p.issueTime}"`);
  }
  if (!Object.values(OPER_MODES).includes(p.operMode)) {
    throw new EtduiError(`Unknown operating mode ${p.operMode}`);
  }
  assertOperModeAllowed(p.etdType, p.operMode);
  if (!Object.values(RECEPTION_ENVS).includes(p.receptionEnv)) {
    throw new EtduiError(`Unknown reception environment "${p.receptionEnv}"`);
  }
  if (!/^\d{9}$/.test(p.securityCode)) {
    throw new EtduiError('Security code must be exactly 9 digits');
  }
}

/** Build the 44-digit ETDUI. Throws EtduiError on any invalid part. */
export function buildEtdui(parts: EtduiParts): string {
  assertParts(parts);
  const yymmdd = parts.issueDate.slice(2, 4) + parts.issueDate.slice(5, 7) + parts.issueDate.slice(8, 10);
  const hhmm = parts.issueTime.slice(0, 2) + parts.issueTime.slice(3, 5);
  const first43 =
    parts.etdType +
    '0' +
    parts.tin +
    String(parts.serial).padStart(9, '0') +
    String(parts.series).padStart(3, '0') +
    yymmdd +
    hhmm +
    String(parts.operMode) +
    parts.receptionEnv +
    parts.securityCode;
  return first43 + String(computeCheckDigit(first43));
}

/** Split an ETDUI into its parts and verify format and check digit. */
export function parseEtdui(id: string): ParsedEtdui {
  if (!/^\d{44}$/.test(id)) {
    throw new EtduiError('ETDUI must be exactly 44 digits');
  }
  const expected = computeCheckDigit(id.slice(0, 43));
  const checkDigit = Number(id[43]);
  if (checkDigit !== expected) {
    throw new EtduiError(`ETDUI check digit is ${checkDigit}, expected ${expected}`);
  }
  if (id[2] !== '0') {
    throw new EtduiError('ETDUI position 3 (reserved) must be 0');
  }
  const etdType = id.slice(0, 2) as EtdType;
  const operMode = Number(id[31]) as OperMode;
  const receptionEnv = id.slice(32, 34) as ReceptionEnv;
  if (!Object.values(ETD_TYPES).includes(etdType)) {
    throw new EtduiError(`Unknown document type "${etdType}"`);
  }
  if (!Object.values(OPER_MODES).includes(operMode)) {
    throw new EtduiError(`Unknown operating mode ${operMode}`);
  }
  if (!Object.values(RECEPTION_ENVS).includes(receptionEnv)) {
    throw new EtduiError(`Unknown reception environment "${receptionEnv}"`);
  }
  return {
    etdType,
    tin: id.slice(3, 9),
    serial: Number(id.slice(9, 18)),
    series: Number(id.slice(18, 21)),
    issueDateYYMMDD: id.slice(21, 27),
    issueTimeHHMM: id.slice(27, 31),
    operMode,
    receptionEnv,
    securityCode: id.slice(34, 43),
    checkDigit,
  };
}

export function isValidEtdui(id: string): boolean {
  try {
    parseEtdui(id);
    return true;
  } catch {
    return false;
  }
}
