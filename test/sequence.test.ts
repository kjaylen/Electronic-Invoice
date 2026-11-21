import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSequenceInfo,
  DEFAULT_SEQUENCE_OPTIONS,
  isSequenceHash,
  MANUAL_SAMPLE_PREVIOUS_HASH,
  sequenceHash,
  sequenceSource,
} from '../src/engine/sequence.ts';

test('reproduces both worked examples in manual section 4.3.4', () => {
  assert.equal(
    sequenceHash({
      uuid: '01023456710000000200126042412221025708090478',
      lineCount: '1',
      taxAmount: '549.90',
      lineExtensionAmount: '5499',
    }),
    'd5QAAlbjpFG2quXeQyi0Qf+HgdE=',
  );
  assert.equal(
    sequenceHash({
      uuid: '01023456710000000100126042412211025841364450',
      lineCount: '2',
      taxAmount: '879.80',
      lineExtensionAmount: '8798',
    }),
    '6PGtNGrH2fvMHjTn+cNgxvGtu5k=',
  );
});

test('reproduces the four complete samples in manual Annex I', () => {
  const samples: Array<[string, string]> = [
    ['01023456733742204000125060900011015999755402', 'dtkZmMFWrQnZ/BA4a11TDHA+48g='], // invoice
    ['02023456752676043500125060900041016500860171', 'FH2v5cZZlqyHHP/+PvhiMizyoTA='], // tax receipt
    ['03023456731483551100125060900061014645610444', 'ey+a+5XQdRBoFn/9hRQALbeXUqQ='], // debit note
    ['04023456759172926100125060900051015497916659', 'fZJNgEXKYY6Em5DkFXwS0yndq9M='], // credit note
  ];
  for (const [uuid, expected] of samples) {
    assert.equal(sequenceHash({ uuid, lineCount: '1', taxAmount: '14.517', lineExtensionAmount: '145.17' }), expected, uuid);
  }
});

test('values are concatenated with no separator, exactly as written', () => {
  const uuid = '01023456710000000200126042412221025708090478';
  assert.equal(
    sequenceSource({ uuid, lineCount: '1', taxAmount: '549.90', lineExtensionAmount: '5499' }),
    `${uuid}1549.905499`,
  );
  // "549.90" and "549.9" are different text, so they hash differently.
  const a = sequenceHash({ uuid, lineCount: '1', taxAmount: '549.90', lineExtensionAmount: '5499' });
  const b = sequenceHash({ uuid, lineCount: '1', taxAmount: '549.9', lineExtensionAmount: '5499' });
  assert.notEqual(a, b);
});

test('chains to the previous document', () => {
  const base = { uuid: '01023456710000000100126042412211025841364450', lineCount: '2', taxAmount: '879.80', lineExtensionAmount: '8798' };
  const first = buildSequenceInfo(base, null);
  const second = buildSequenceInfo(
    { uuid: '01023456710000000200126042412221025708090478', lineCount: '1', taxAmount: '549.90', lineExtensionAmount: '5499' },
    first.thisEtd,
  );
  assert.equal(second.previousEtd, first.thisEtd);
  assert.equal(second.thisEtd, 'd5QAAlbjpFG2quXeQyi0Qf+HgdE=');
});

test('first document in a series: self by default, empty when configured', () => {
  const input = { uuid: '01023456710000000200126042412221025708090478', lineCount: '1', taxAmount: '549.90', lineExtensionAmount: '5499' };
  assert.equal(DEFAULT_SEQUENCE_OPTIONS.firstInSeries, 'self');
  const self = buildSequenceInfo(input, null);
  assert.equal(self.previousEtd, self.thisEtd);
  assert.equal(buildSequenceInfo(input, null, { firstInSeries: 'empty' }).previousEtd, '');
  assert.ok(isSequenceHash(MANUAL_SAMPLE_PREVIOUS_HASH));
});

test('rejects bad input', () => {
  const ok = { uuid: '01023456710000000200126042412221025708090478', lineCount: '1', taxAmount: '549.90', lineExtensionAmount: '5499' };
  assert.throws(() => sequenceSource({ ...ok, uuid: '123' }), /44-digit/);
  assert.throws(() => sequenceSource({ ...ok, lineCount: '0' }), /positive integer/);
  assert.throws(() => sequenceSource({ ...ok, taxAmount: '1,000.00' }), /not a decimal/);
  assert.throws(() => buildSequenceInfo(ok, 'not-a-hash'), /Base64/);
});
