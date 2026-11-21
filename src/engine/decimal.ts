/**
 * Exact decimal arithmetic for money and quantities.
 *
 * JavaScript numbers are binary floats (0.1 + 0.2 !== 0.3), which is not
 * acceptable for tax documents. Every amount in the engine is either:
 *   - a `Dec`: an exact decimal held as a BigInt plus a scale, used for
 *     intermediate values that must not be rounded, or
 *   - `Cents`: a BigInt count of cents, used for final, rounded results.
 *
 * Because Cents is a bigint, mixing it with a plain number (cents + 1) throws a
 * TypeError instead of silently going through floating point.
 */

/** A rounded money amount, in cents. */
export type Cents = bigint;

/** An exact decimal: value = units / 10^scale. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string such as "3000", "5.7354" or "-0.50".
 * Numbers are deliberately not accepted, so callers cannot pass a float that
 * has already lost precision.
 */
export function parseDecimal(input: string, options: { maxScale?: number; field?: string } = {}): Dec {
  const field = options.field ?? 'value';
  if (typeof input !== 'string') {
    throw new TypeError(`${field} must be a decimal string, got ${typeof input}`);
  }
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (!match) {
    throw new RangeError(`${field} is not a valid decimal: "${input}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (options.maxScale !== undefined && fraction.length > options.maxScale) {
    throw new RangeError(`${field} has more than ${options.maxScale} decimal places: "${input}"`);
  }
  const units = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);
  return { units, scale: fraction.length };
}

export function dec(units: bigint, scale = 0): Dec {
  return { units, scale };
}

export function fromCents(cents: Cents): Dec {
  return { units: cents, scale: 2 };
}

export const ZERO: Dec = { units: 0n, scale: 0 };

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

export function mul(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** `percent` of `base`, where a percent of 12.5 means 12.5%. Exact, not rounded. */
export function percentOf(base: Dec, percent: Dec): Dec {
  return { units: base.units * percent.units, scale: base.scale + percent.scale + 2 };
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce(add, ZERO);
}

export function isZero(d: Dec): boolean {
  return d.units === 0n;
}

export function compare(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Round to whole cents, half away from zero (2.345 -> 2.35, -2.345 -> -2.35).
 * For positive amounts this is the usual "round half up".
 */
export function roundToCents(d: Dec): Cents {
  if (d.scale <= 2) {
    return d.units * pow10(2 - d.scale);
  }
  const divisor = pow10(d.scale - 2);
  const quotient = d.units / divisor; // BigInt division truncates toward zero
  const remainder = d.units % divisor;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= divisor) {
    return quotient + (d.units < 0n ? -1n : 1n);
  }
  return quotient;
}

/** Format cents as a decimal string with exactly two places: 1720620n -> "17206.20". */
export function formatCents(cents: Cents): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Parse a money string with at most two decimals into cents: "17206.2" -> 1720620n. */
export function parseCents(input: string, field = 'amount'): Cents {
  return roundToCents(parseDecimal(input, { maxScale: 2, field }));
}
