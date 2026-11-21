import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildSequenceInfo,
  DEFAULT_SEQUENCE_OPTIONS,
  formatAmount,
  sequenceHash,
  sequenceSource,
  type SequenceOptions,
} from '../src/engine/sequence.ts';

const UUID = '01012345600000123402124110113341014732985144';
const INPUT = { uuid: UUID, lineCount: 2, taxAmount: 6874n, lineExtensionAmount: 54990n };

test('amount formats', () => {
  assert.equal(formatAmount(54990n, 'fixed2'), '549.90');
  assert.equal(formatAmount(54990n, 'fixed2-no-point'), '54990');
  assert.equal(formatAmount(54990n, 'compact'), '549.9');
  assert.equal(formatAmount(54990n, 'compact-no-point'), '5499'); // the manual's example
  assert.equal(formatAmount(50000n, 'compact'), '500');
  assert.equal(formatAmount(50000n, 'compact-no-point'), '500');
  assert.equal(formatAmount(0n, 'compact'), '0');
  assert.equal(formatAmount(509n, 'compact-no-point'), '509');
});

test('source string follows the configured options', () => {
  // Default: no separator, "compact-no-point" (68.74 -> 6874, 549.90 -> 5499).
  assert.equal(sequenceSource(INPUT), `${UUID}268745499`);
  const opts: SequenceOptions = { separator: '|', amountFormat: 'fixed2', firstInSeries: 'empty' };
  assert.equal(sequenceSource(INPUT, opts), `${UUID}|2|68.74|549.90`);
});

test('hash is Base64 SHA-1 of the UTF-8 source', () => {
  const expected = createHash('sha1').update(`${UUID}268745499`, 'utf8').digest('base64');
  assert.equal(sequenceHash(INPUT), expected);
  assert.match(sequenceHash(INPUT), /^[A-Za-z0-9+/]{27}=$/);
});

test('any change to the inputs changes the hash', () => {
  const h = sequenceHash(INPUT);
  assert.notEqual(sequenceHash({ ...INPUT, lineCount: 3 }), h);
  assert.notEqual(sequenceHash({ ...INPUT, taxAmount: 6875n }), h);
  assert.notEqual(sequenceHash({ ...INPUT, uuid: `${UUID.slice(0, 43)}5` }), h);
});

test('chains to the previous document', () => {
  const first = buildSequenceInfo(INPUT, null);
  const second = buildSequenceInfo({ ...INPUT, uuid: UUID.replace('000001234', '000001235') }, first.thisEtd);
  assert.equal(second.previousEtd, first.thisEtd);
  assert.notEqual(second.thisEtd, first.thisEtd);
});

test('first document in a series: self by default, empty when configured', () => {
  assert.equal(DEFAULT_SEQUENCE_OPTIONS.firstInSeries, 'self');
  const self = buildSequenceInfo(INPUT, null);
  assert.equal(self.previousEtd, self.thisEtd);
  const empty = buildSequenceInfo(INPUT, null, { ...DEFAULT_SEQUENCE_OPTIONS, firstInSeries: 'empty' });
  assert.equal(empty.previousEtd, '');
});

test('rejects bad input', () => {
  assert.throws(() => sequenceSource({ ...INPUT, uuid: '123' }), /44-digit/);
  assert.throws(() => sequenceSource({ ...INPUT, lineCount: 0 }), /positive integer/);
  assert.throws(() => buildSequenceInfo(INPUT, 'not-a-hash'), /Base64/);
});
