import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, formatCents, mul, parseCents, parseDecimal, percentOf, roundToCents } from '../src/engine/decimal.ts';

test('parses decimal strings exactly', () => {
  assert.deepEqual(parseDecimal('5.7354'), { units: 57354n, scale: 4 });
  assert.deepEqual(parseDecimal('-0.50'), { units: -50n, scale: 2 });
  assert.deepEqual(parseDecimal('3000'), { units: 3000n, scale: 0 });
});

test('rejects non-decimal input and too many places', () => {
  assert.throws(() => parseDecimal('1e3'));
  assert.throws(() => parseDecimal('1,000.00'));
  assert.throws(() => parseDecimal(''));
  assert.throws(() => parseDecimal(1.5 as unknown as string), TypeError);
  assert.throws(() => parseDecimal('1.2345678', { maxScale: 6 }), /more than 6/);
});

test('avoids floating point error', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point.
  assert.equal(roundToCents(add(parseDecimal('0.1'), parseDecimal('0.2'))), 30n);
  assert.equal(roundToCents(mul(parseDecimal('3000'), parseDecimal('5.7354'))), 1720620n);
});

test('rounds half away from zero', () => {
  assert.equal(roundToCents(parseDecimal('2.345')), 235n);
  assert.equal(roundToCents(parseDecimal('2.344999')), 234n);
  assert.equal(roundToCents(parseDecimal('-2.345')), -235n);
  assert.equal(roundToCents(parseDecimal('0.005')), 1n);
  assert.equal(roundToCents(parseDecimal('0.004')), 0n);
});

test('percentOf: 12.5% of 26964.30 is 3370.5375 exactly', () => {
  const exact = percentOf(parseDecimal('26964.30'), parseDecimal('12.5'));
  assert.equal(exact.units * 10n ** BigInt(10 - exact.scale), 33705375000000n);
  assert.equal(roundToCents(exact), 337054n);
});

test('formats and parses cents', () => {
  assert.equal(formatCents(1720620n), '17206.20');
  assert.equal(formatCents(5n), '0.05');
  assert.equal(formatCents(-150n), '-1.50');
  assert.equal(formatCents(0n), '0.00');
  assert.equal(parseCents('17206.2'), 1720620n);
  assert.throws(() => parseCents('1.005'));
});
