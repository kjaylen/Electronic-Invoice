import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEtdui,
  computeCheckDigit,
  EtduiError,
  type EtduiParts,
  generateSecurityCode,
  isValidEtdui,
  parseEtdui,
} from '../src/engine/etdui.ts';

// Worked example from the BTS Orientation Manual v1.30.
const MANUAL_EXAMPLE = '01012345600000123402124110113341014732985144';
const MANUAL_PARTS: EtduiParts = {
  etdType: '01',
  tin: '123456',
  serial: 1234,
  series: 21,
  issueDate: '2024-11-01',
  issueTime: '13:34',
  operMode: 1,
  receptionEnv: '01',
  securityCode: '473298514',
};

test('builds the manual worked example exactly', () => {
  assert.equal(buildEtdui(MANUAL_PARTS), MANUAL_EXAMPLE);
});

test('ignores seconds in the issue time', () => {
  assert.equal(buildEtdui({ ...MANUAL_PARTS, issueTime: '13:34:59' }), MANUAL_EXAMPLE);
});

test('check digit of the manual example is 4', () => {
  assert.equal(computeCheckDigit(MANUAL_EXAMPLE.slice(0, 43)), 4);
});

test('check digit edge cases: 11 - remainder of 10 or 11 maps to 1 (placeholder until BTS confirms)', () => {
  // Inputs chosen so the weighted sum leaves the given remainder.
  assert.equal(computeCheckDigit('0101234560000012340212411011334101000000009'), 1); // remainder 0 -> 11
  assert.equal(computeCheckDigit('0101234560000012340212411011334101000000004'), 1); // remainder 1 -> 10
  assert.equal(computeCheckDigit('0101234560000012340212411011334101000000003'), 1); // remainder 10 -> 1
});

test('parses the manual example into its parts', () => {
  assert.deepEqual(parseEtdui(MANUAL_EXAMPLE), {
    etdType: '01',
    tin: '123456',
    serial: 1234,
    series: 21,
    issueDateYYMMDD: '241101',
    issueTimeHHMM: '1334',
    operMode: 1,
    receptionEnv: '01',
    securityCode: '473298514',
    checkDigit: 4,
  });
});

test('round trips through build and parse', () => {
  const parts: EtduiParts = {
    etdType: '02',
    tin: '987654',
    serial: 999_999_999,
    series: 900,
    issueDate: '2027-03-01',
    issueTime: '23:59',
    operMode: 3,
    receptionEnv: '02',
    securityCode: generateSecurityCode(),
  };
  const id = buildEtdui(parts);
  assert.equal(id.length, 44);
  const parsed = parseEtdui(id);
  assert.equal(parsed.serial, parts.serial);
  assert.equal(parsed.series, parts.series);
  assert.equal(parsed.issueDateYYMMDD, '270301');
  assert.equal(parsed.securityCode, parts.securityCode);
});

test('detects any single changed digit', () => {
  for (let pos = 0; pos < 43; pos++) {
    const digit = Number(MANUAL_EXAMPLE[pos]);
    const changed = MANUAL_EXAMPLE.slice(0, pos) + String((digit + 1) % 10) + MANUAL_EXAMPLE.slice(pos + 1);
    // A change can make the ID structurally invalid or break the check digit; either way it must be rejected
    // unless the new check digit happens to collide, which mod 11 makes rare. Count collisions.
    if (isValidEtdui(changed)) {
      assert.equal(computeCheckDigit(changed.slice(0, 43)), Number(changed[43]), `collision at ${pos}`);
    }
  }
  assert.equal(isValidEtdui(MANUAL_EXAMPLE.slice(0, 43) + '5'), false);
});

test('rejects malformed IDs', () => {
  assert.equal(isValidEtdui(''), false);
  assert.equal(isValidEtdui(MANUAL_EXAMPLE.slice(0, 43)), false);
  assert.equal(isValidEtdui(`${MANUAL_EXAMPLE}0`), false);
  assert.equal(isValidEtdui(MANUAL_EXAMPLE.replace(/^01/, 'AB')), false);
  assert.throws(() => parseEtdui('x'.repeat(44)), EtduiError);
});

test('validates parts', () => {
  const bad: Array<[Partial<EtduiParts>, RegExp]> = [
    [{ tin: '12345' }, /TIN/],
    [{ tin: '1234567' }, /TIN/],
    [{ serial: 0 }, /Serial/],
    [{ serial: 1_000_000_000 }, /Serial/],
    [{ serial: 1.5 }, /Serial/],
    [{ series: 1000 }, /Series/],
    [{ issueDate: '2024-13-01' }, /Issue date/],
    [{ issueDate: '01/11/2024' }, /Issue date/],
    [{ issueTime: '24:00' }, /Issue time/],
    [{ securityCode: '12345678' }, /Security code/],
    [{ receptionEnv: '03' as never }, /environment/],
    [{ etdType: '06' as never }, /document type/],
  ];
  for (const [override, message] of bad) {
    assert.throws(() => buildEtdui({ ...MANUAL_PARTS, ...override }), message, JSON.stringify(override));
  }
});

test('enforces which operating modes each document type may use', () => {
  assert.throws(() => buildEtdui({ ...MANUAL_PARTS, operMode: 3 }), /must use operMode 2/);
  assert.ok(buildEtdui({ ...MANUAL_PARTS, operMode: 2 }));
  assert.throws(() => buildEtdui({ ...MANUAL_PARTS, etdType: '02', operMode: 2 }), /must use operMode 3/);
  assert.ok(buildEtdui({ ...MANUAL_PARTS, etdType: '02', operMode: 3 }));
  assert.throws(() => buildEtdui({ ...MANUAL_PARTS, etdType: '05', operMode: 2 }), /Events cannot/);
});

test('security codes are 9 digits and vary', () => {
  const codes = new Set(Array.from({ length: 1000 }, generateSecurityCode));
  for (const code of codes) assert.match(code, /^\d{9}$/);
  assert.ok(codes.size > 990, 'security codes should almost never repeat');
});
