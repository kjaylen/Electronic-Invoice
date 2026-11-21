import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalcError, calculateDocument, formatCents, type LineInput } from '../src/engine/calc.ts';

// Worked example from the BTS Orientation Manual: 3,000 gallons of diesel.
const DIESEL: LineInput = {
  description: 'Diesel',
  quantity: '3000',
  unitCode: 'GLL',
  unitPrice: '5.7354',
  gstCategory: 'S',
  allowanceCharges: [{ isCharge: true, reason: 'Freight', perUnit: '0.11' }],
  otherTaxes: [
    { scheme: 'ENV', perUnit: '0.17' },
    { scheme: 'EXC', perUnit: '2.9727' },
  ],
};

const money = (c: bigint) => formatCents(c);

test('manual diesel example balances to 30,334.84', () => {
  const doc = calculateDocument({ lines: [DIESEL] });
  const line = doc.lines[0]!;
  assert.equal(money(line.grossAmount), '17206.20');
  assert.equal(money(line.allowanceCharges[0]!.amount), '330.00');
  assert.equal(money(line.netAmount), '17536.20');
  assert.deepEqual(
    line.otherTaxes.map((t) => [t.scheme, money(t.amount)]),
    [
      ['ENV', '510.00'],
      ['EXC', '8918.10'],
    ],
  );
  assert.equal(money(line.gstBase), '26964.30');
  assert.equal(money(line.gstAmount), '3370.54');
  assert.equal(money(line.lineTotal), '30334.84');

  assert.equal(money(doc.lineExtensionAmount), '17536.20');
  assert.equal(money(doc.taxAmount), '12798.64');
  assert.equal(money(doc.taxInclusiveAmount), '30334.84');
  assert.equal(money(doc.payableAmount), '30334.84');
});

test('simple retail invoice with standard, zero-rated and exempt lines', () => {
  const doc = calculateDocument({
    lines: [
      { description: 'Rice 25 lb', quantity: '2', unitCode: 'H87', unitPrice: '32.50', gstCategory: 'Z' },
      { description: 'Phone charger', quantity: '1', unitCode: 'H87', unitPrice: '24.99', gstCategory: 'S' },
      {
        description: 'Medical service',
        quantity: '1',
        unitCode: 'H87',
        unitPrice: '100',
        gstCategory: 'E',
        exemptionReasonCode: 'MED',
      },
    ],
  });
  assert.equal(doc.lineCount, 3);
  assert.equal(money(doc.lineExtensionAmount), '189.99');
  // 24.99 x 12.5% = 3.12375 -> 3.12
  assert.equal(money(doc.gstAmount), '3.12');
  assert.equal(money(doc.taxInclusiveAmount), '193.11');
  assert.deepEqual(
    doc.taxSubtotals.map((s) => [s.scheme, s.category, s.ratePercent, money(s.taxableAmount), money(s.taxAmount)]),
    [
      ['GST', 'S', '12.5', '24.99', '3.12'],
      ['GST', 'Z', '0', '65.00', '0.00'],
      ['GST', 'E', '0', '100.00', '0.00'],
    ],
  );
});

test('GST rounds half up on the final value only', () => {
  // 0.04 x 12.5% = 0.005 -> 0.01
  const a = calculateDocument({
    lines: [{ description: 'x', quantity: '1', unitCode: 'H87', unitPrice: '0.04', gstCategory: 'S' }],
  });
  assert.equal(money(a.gstAmount), '0.01');
  // 3 x 0.3333 = 0.9999 net -> 1.00; GST on 1.00 = 0.125 -> 0.13
  const b = calculateDocument({
    lines: [{ description: 'x', quantity: '3', unitCode: 'H87', unitPrice: '0.3333', gstCategory: 'S' }],
  });
  assert.equal(money(b.lineExtensionAmount), '1.00');
  assert.equal(money(b.gstAmount), '0.13');
});

test('quantities with six decimals', () => {
  const doc = calculateDocument({
    lines: [{ description: 'Cable', quantity: '12.345678', unitCode: 'MTR', unitPrice: '2.5', gstCategory: 'S' }],
  });
  // 12.345678 x 2.5 = 30.864195 -> 30.86; GST 3.8575 -> 3.86
  assert.equal(money(doc.lineExtensionAmount), '30.86');
  assert.equal(money(doc.gstAmount), '3.86');
});

test('percent allowance, fixed charge, prepaid and rounding amount', () => {
  const doc = calculateDocument({
    lines: [
      {
        description: 'Laptop',
        quantity: '2',
        unitCode: 'H87',
        unitPrice: '1500',
        gstCategory: 'S',
        allowanceCharges: [
          { isCharge: false, reason: 'Discount', percent: '10' },
          { isCharge: true, reason: 'Setup', amount: '50.00' },
        ],
      },
    ],
    prepaidAmount: '1000.00',
    payableRoundingAmount: '-0.25',
  });
  const line = doc.lines[0]!;
  assert.equal(money(line.allowanceCharges[0]!.amount), '300.00');
  assert.equal(money(line.allowanceCharges[0]!.baseAmount!), '3000.00');
  assert.equal(money(line.netAmount), '2750.00');
  assert.equal(money(line.gstAmount), '343.75');
  assert.equal(money(doc.taxInclusiveAmount), '3093.75');
  assert.equal(money(doc.payableAmount), '2093.50');
});

test('a different GST rate is a config change', () => {
  const doc = calculateDocument(
    { lines: [{ description: 'x', quantity: '1', unitCode: 'H87', unitPrice: '100', gstCategory: 'S' }] },
    { gstStandardRatePercent: '15' },
  );
  assert.equal(money(doc.gstAmount), '15.00');
  assert.equal(doc.lines[0]!.gstRatePercent, '15');
});

test('document GST is rounded per category on the document total (manual 4.2)', () => {
  // Three lines of 0.04 at 12.5%: each line's GST is 0.005 -> 0.01, but the document GST is 0.015 -> 0.02.
  const line = { description: 'x', quantity: '1', unitCode: 'H87', unitPrice: '0.04', gstCategory: 'S' } as const;
  const doc = calculateDocument({ lines: [line, line, line] });
  assert.deepEqual(doc.lines.map((l) => money(l.gstAmount)), ['0.01', '0.01', '0.01']);
  assert.equal(money(doc.gstAmount), '0.02');
  assert.equal(money(doc.taxAmount), '0.02');
  assert.equal(money(doc.taxInclusiveAmount), '0.14');
});

test('document totals stay consistent on large documents', () => {
  const lines: LineInput[] = Array.from({ length: 200 }, (_, i) => ({
    description: `Item ${i}`,
    quantity: `${(i % 7) + 1}.${String(i * 37).padStart(3, '0').slice(-3)}`,
    unitCode: 'H87',
    unitPrice: `${i}.${String(i * 91).padStart(4, '0').slice(-4)}`,
    gstCategory: (['S', 'Z', 'S'] as const)[i % 3]!,
  }));
  const doc = calculateDocument({ lines });
  assert.equal(doc.taxInclusiveAmount, doc.taxExclusiveAmount + doc.taxAmount);
  assert.equal(doc.lineExtensionAmount, doc.lines.reduce((acc, l) => acc + l.netAmount, 0n));
  const gstSubtotals = doc.taxSubtotals.filter((s) => s.scheme === 'GST').reduce((acc, s) => acc + s.taxAmount, 0n);
  assert.equal(doc.gstAmount, gstSubtotals);
  // Document-level rounding differs from the sum of rounded lines by at most half a cent per line.
  const lineGst = doc.lines.reduce((acc, l) => acc + l.gstAmount, 0n);
  const diff = lineGst > doc.gstAmount ? lineGst - doc.gstAmount : doc.gstAmount - lineGst;
  assert.ok(diff <= BigInt(lines.length) / 2n, `difference ${diff} cents`);
});

test('rejects invalid input with a clear message', () => {
  const base = { description: 'x', quantity: '1', unitCode: 'H87', unitPrice: '1', gstCategory: 'S' } as const;
  const cases: Array<[Partial<LineInput>, RegExp]> = [
    [{ quantity: '0' }, /greater than zero/],
    [{ quantity: '-1' }, /greater than zero/],
    [{ quantity: '1.1234567' }, /more than 6/],
    [{ unitPrice: '-1' }, /cannot be negative/],
    [{ unitPrice: '1.5e2' }, /not a valid decimal/],
    [{ gstCategory: 'E' }, /exemptionReasonCode/],
    [{ exemptionReasonCode: 'X' }, /only allowed on exempt/],
    [{ gstCategory: 'X' as never }, /unknown GST category/],
    [{ description: ' ' }, /description is required/],
    [{ allowanceCharges: [{ isCharge: false, reason: 'd', amount: '1', percent: '5' }] }, /exactly one/],
    [{ allowanceCharges: [{ isCharge: false, reason: 'd', amount: '5' }] }, /allowances exceed/],
    [{ otherTaxes: [{ scheme: 'VAT' as never, percent: '1' }] }, /unknown scheme/],
  ];
  for (const [override, message] of cases) {
    assert.throws(() => calculateDocument({ lines: [{ ...base, ...override }] }), message, JSON.stringify(override));
  }
  assert.throws(() => calculateDocument({ lines: [] }), CalcError);
});
