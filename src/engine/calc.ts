/**
 * Line and document totals, GST and rounding.
 *
 * Rules (from the spec):
 *   - All inputs are decimal strings; nothing goes through floating point.
 *   - Rounding happens once per printed amount, half up to two decimals, and
 *     never on intermediate values.
 *   - Line net (LineExtensionAmount) = quantity x unit price + charges - allowances.
 *   - GST base = line net + any other taxes GST applies on top of
 *     (excise and environmental tax on fuel).
 *   - Document totals are sums of the rounded line amounts, so every number
 *     printed in the XML adds up exactly.
 *
 * Pure and stateless: safe to call concurrently for any number of tenants.
 * Tax rates come from a TaxConfig argument so a rate change is a config
 * change, not a code change.
 */

import {
  type Cents,
  type Dec,
  add,
  fromCents,
  mul,
  parseCents,
  parseDecimal,
  percentOf,
  roundToCents,
  sub,
  sum,
} from './decimal.ts';

/** UN/ECE 5305 tax categories used by BTS for GST. */
export type GstCategory = 'S' | 'Z' | 'E';
/** UN/ECE 5153 tax schemes other than GST. */
export type OtherTaxScheme = 'ENV' | 'EXC';

export interface TaxConfig {
  /** Standard GST rate as a percent string, e.g. "12.5". */
  gstStandardRatePercent: string;
}

/** Belize standard GST rate per the spec. Pass a different TaxConfig if the law changes. */
export const DEFAULT_TAX_CONFIG: TaxConfig = Object.freeze({ gstStandardRatePercent: '12.5' });

export const MAX_QUANTITY_DECIMALS = 6;
export const MAX_UNIT_PRICE_DECIMALS = 6;

/** A line-level allowance (discount) or charge. Give exactly one of amount, percent, perUnit. */
export interface AllowanceChargeInput {
  /** true = charge (adds to the line), false = allowance (reduces it). UBL ChargeIndicator. */
  isCharge: boolean;
  reason: string;
  /** A fixed amount, at most 2 decimals. */
  amount?: string;
  /** A percent of quantity x unit price, written as "20" for 20%. */
  percent?: string;
  /** An amount per unit of quantity, e.g. freight of 0.11 per gallon. */
  perUnit?: string;
}

/** A tax other than GST on a line. Give exactly one of perUnit, percent. */
export interface OtherTaxInput {
  scheme: OtherTaxScheme;
  /** Amount per unit of quantity, e.g. excise of 2.9727 per gallon. */
  perUnit?: string;
  /** Percent of the line net. */
  percent?: string;
  /** Whether GST is charged on top of this tax. Defaults to true, as for fuel. */
  inGstBase?: boolean;
}

export interface LineInput {
  description: string;
  quantity: string;
  /** UN/ECE Rec 20 unit code, e.g. "GLL" for gallon, "H87" for piece. */
  unitCode: string;
  unitPrice: string;
  gstCategory: GstCategory;
  /** Required when gstCategory is "E". */
  exemptionReasonCode?: string;
  allowanceCharges?: AllowanceChargeInput[];
  otherTaxes?: OtherTaxInput[];
}

export interface DocumentInput {
  lines: LineInput[];
  /** Amount already paid, at most 2 decimals. */
  prepaidAmount?: string;
  /** Rounding adjustment to the payable amount, at most 2 decimals, may be negative. */
  payableRoundingAmount?: string;
}

export interface AllowanceChargeResult {
  isCharge: boolean;
  reason: string;
  amount: Cents;
  /** Set when the input was a percent. */
  percent?: string;
  /** The amount the percent was applied to. */
  baseAmount?: Cents;
}

export interface OtherTaxResult {
  scheme: OtherTaxScheme;
  amount: Cents;
  inGstBase: boolean;
}

export interface LineResult {
  lineNumber: number;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  /** quantity x unit price, rounded. Shown on the printed copy; not used in later sums. */
  grossAmount: Cents;
  allowanceCharges: AllowanceChargeResult[];
  /** LineExtensionAmount: net of all taxes. */
  netAmount: Cents;
  otherTaxes: OtherTaxResult[];
  gstCategory: GstCategory;
  gstRatePercent: string;
  exemptionReasonCode?: string;
  gstBase: Cents;
  gstAmount: Cents;
  /** GST plus other taxes on this line. */
  taxAmount: Cents;
  /** Net plus all taxes. */
  lineTotal: Cents;
}

export interface TaxSubtotal {
  scheme: 'GST' | OtherTaxScheme;
  /** Only for GST. */
  category?: GstCategory;
  ratePercent?: string;
  taxableAmount: Cents;
  taxAmount: Cents;
}

export interface DocumentTotals {
  lines: LineResult[];
  lineCount: number;
  /** Sum of line nets. LegalMonetaryTotal/LineExtensionAmount. */
  lineExtensionAmount: Cents;
  /** LegalMonetaryTotal/TaxExclusiveAmount. Equal to lineExtensionAmount until document-level allowances exist. */
  taxExclusiveAmount: Cents;
  /** Total of all taxes (GST, ENV, EXC). */
  taxAmount: Cents;
  gstAmount: Cents;
  taxSubtotals: TaxSubtotal[];
  /** LegalMonetaryTotal/TaxInclusiveAmount. */
  taxInclusiveAmount: Cents;
  prepaidAmount: Cents;
  payableRoundingAmount: Cents;
  /** LegalMonetaryTotal/PayableAmount. */
  payableAmount: Cents;
}

export class CalcError extends Error {
  override name = 'CalcError';
}

function exactlyOne(values: Array<string | undefined>, field: string, options: string): void {
  if (values.filter((v) => v !== undefined).length !== 1) {
    throw new CalcError(`${field} must have exactly one of ${options}`);
  }
}

function gstRateFor(category: GstCategory, config: TaxConfig): string {
  return category === 'S' ? config.gstStandardRatePercent : '0';
}

export function calculateLine(input: LineInput, lineNumber: number, config: TaxConfig = DEFAULT_TAX_CONFIG): LineResult {
  const where = `Line ${lineNumber}`;
  if (!input.description?.trim()) throw new CalcError(`${where}: description is required`);
  if (!input.unitCode?.trim()) throw new CalcError(`${where}: unitCode is required`);

  const quantity = parseDecimal(input.quantity, { maxScale: MAX_QUANTITY_DECIMALS, field: `${where} quantity` });
  const unitPrice = parseDecimal(input.unitPrice, { maxScale: MAX_UNIT_PRICE_DECIMALS, field: `${where} unitPrice` });
  if (quantity.units <= 0n) throw new CalcError(`${where}: quantity must be greater than zero`);
  if (unitPrice.units < 0n) throw new CalcError(`${where}: unitPrice cannot be negative`);

  if (!['S', 'Z', 'E'].includes(input.gstCategory)) {
    throw new CalcError(`${where}: unknown GST category "${input.gstCategory}"`);
  }
  if (input.gstCategory === 'E' && !input.exemptionReasonCode?.trim()) {
    throw new CalcError(`${where}: an exempt line (category E) needs an exemptionReasonCode`);
  }
  if (input.gstCategory !== 'E' && input.exemptionReasonCode !== undefined) {
    throw new CalcError(`${where}: exemptionReasonCode is only allowed on exempt lines`);
  }

  const gross: Dec = mul(quantity, unitPrice);

  const allowanceCharges: AllowanceChargeResult[] = (input.allowanceCharges ?? []).map((ac, i) => {
    const field = `${where} allowance/charge ${i + 1}`;
    exactlyOne([ac.amount, ac.percent, ac.perUnit], field, 'amount, percent, perUnit');
    if (!ac.reason?.trim()) throw new CalcError(`${field}: reason is required`);
    let amount: Cents;
    let extra: Pick<AllowanceChargeResult, 'percent' | 'baseAmount'> = {};
    if (ac.amount !== undefined) {
      amount = parseCents(ac.amount, `${field} amount`);
    } else if (ac.percent !== undefined) {
      amount = roundToCents(percentOf(gross, parseDecimal(ac.percent, { field: `${field} percent` })));
      extra = { percent: ac.percent, baseAmount: roundToCents(gross) };
    } else {
      amount = roundToCents(mul(quantity, parseDecimal(ac.perUnit!, { field: `${field} perUnit` })));
    }
    if (amount < 0n) throw new CalcError(`${field}: amount cannot be negative`);
    return { isCharge: ac.isCharge, reason: ac.reason, amount, ...extra };
  });

  const charges = sum(allowanceCharges.filter((a) => a.isCharge).map((a) => fromCents(a.amount)));
  const allowances = sum(allowanceCharges.filter((a) => !a.isCharge).map((a) => fromCents(a.amount)));
  const netAmount = roundToCents(sub(add(gross, charges), allowances));
  if (netAmount < 0n) throw new CalcError(`${where}: allowances exceed the line amount`);

  const otherTaxes: OtherTaxResult[] = (input.otherTaxes ?? []).map((t, i) => {
    const field = `${where} ${t.scheme ?? 'tax'} ${i + 1}`;
    if (t.scheme !== 'ENV' && t.scheme !== 'EXC') throw new CalcError(`${field}: unknown scheme "${t.scheme}"`);
    exactlyOne([t.perUnit, t.percent], field, 'perUnit, percent');
    const amount =
      t.perUnit !== undefined
        ? roundToCents(mul(quantity, parseDecimal(t.perUnit, { field: `${field} perUnit` })))
        : roundToCents(percentOf(fromCents(netAmount), parseDecimal(t.percent!, { field: `${field} percent` })));
    if (amount < 0n) throw new CalcError(`${field}: amount cannot be negative`);
    return { scheme: t.scheme, amount, inGstBase: t.inGstBase ?? true };
  });

  const gstRatePercent = gstRateFor(input.gstCategory, config);
  const gstBase =
    netAmount + otherTaxes.filter((t) => t.inGstBase).reduce((acc, t) => acc + t.amount, 0n);
  const gstAmount = roundToCents(percentOf(fromCents(gstBase), parseDecimal(gstRatePercent)));
  const otherTaxTotal = otherTaxes.reduce((acc, t) => acc + t.amount, 0n);
  const taxAmount = gstAmount + otherTaxTotal;

  return {
    lineNumber,
    description: input.description,
    quantity: input.quantity,
    unitCode: input.unitCode,
    unitPrice: input.unitPrice,
    grossAmount: roundToCents(gross),
    allowanceCharges,
    netAmount,
    otherTaxes,
    gstCategory: input.gstCategory,
    gstRatePercent,
    ...(input.exemptionReasonCode !== undefined && { exemptionReasonCode: input.exemptionReasonCode }),
    gstBase,
    gstAmount,
    taxAmount,
    lineTotal: netAmount + taxAmount,
  };
}

export function calculateDocument(input: DocumentInput, config: TaxConfig = DEFAULT_TAX_CONFIG): DocumentTotals {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new CalcError('A document needs at least one line');
  }
  // Validate the configured rate once, so a bad config fails loudly.
  const rate = parseDecimal(config.gstStandardRatePercent, { field: 'gstStandardRatePercent' });
  if (rate.units < 0n) throw new CalcError('GST rate cannot be negative');

  const lines = input.lines.map((line, i) => calculateLine(line, i + 1, config));

  const lineExtensionAmount = lines.reduce((acc, l) => acc + l.netAmount, 0n);
  const gstAmount = lines.reduce((acc, l) => acc + l.gstAmount, 0n);
  const taxAmount = lines.reduce((acc, l) => acc + l.taxAmount, 0n);
  const taxExclusiveAmount = lineExtensionAmount;
  const taxInclusiveAmount = taxExclusiveAmount + taxAmount;
  const prepaidAmount = input.prepaidAmount !== undefined ? parseCents(input.prepaidAmount, 'prepaidAmount') : 0n;
  const payableRoundingAmount =
    input.payableRoundingAmount !== undefined ? parseCents(input.payableRoundingAmount, 'payableRoundingAmount') : 0n;
  if (prepaidAmount < 0n) throw new CalcError('prepaidAmount cannot be negative');

  return {
    lines,
    lineCount: lines.length,
    lineExtensionAmount,
    taxExclusiveAmount,
    taxAmount,
    gstAmount,
    taxSubtotals: buildTaxSubtotals(lines),
    taxInclusiveAmount,
    prepaidAmount,
    payableRoundingAmount,
    payableAmount: taxInclusiveAmount - prepaidAmount + payableRoundingAmount,
  };
}

function buildTaxSubtotals(lines: LineResult[]): TaxSubtotal[] {
  const groups = new Map<string, TaxSubtotal>();
  const bump = (key: string, init: Omit<TaxSubtotal, 'taxableAmount' | 'taxAmount'>, taxable: Cents, tax: Cents) => {
    const g = groups.get(key) ?? { ...init, taxableAmount: 0n, taxAmount: 0n };
    g.taxableAmount += taxable;
    g.taxAmount += tax;
    groups.set(key, g);
  };
  for (const line of lines) {
    bump(
      `GST:${line.gstCategory}`,
      { scheme: 'GST', category: line.gstCategory, ratePercent: line.gstRatePercent },
      line.gstBase,
      line.gstAmount,
    );
    for (const t of line.otherTaxes) {
      bump(t.scheme, { scheme: t.scheme }, line.netAmount, t.amount);
    }
  }
  const order = ['GST:S', 'GST:Z', 'GST:E', 'EXC', 'ENV'];
  return [...groups.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([, g]) => g);
}

// Re-exported so callers can format results without importing decimal.ts.
export { formatCents } from './decimal.ts';
