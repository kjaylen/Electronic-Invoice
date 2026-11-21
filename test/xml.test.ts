import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el, leaf, optLeaf, serialize, XmlError } from '../src/engine/xml.ts';

test('serializes compactly with a declaration', () => {
  const xml = serialize(el('a', { x: '1' }, leaf('b', 'text'), el('c', undefined)));
  assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?><a x="1"><b>text</b><c/></a>');
});

test('escapes text and attributes', () => {
  const xml = serialize(leaf('n', 'Tom & Jerry <Ltd> "quoted"', { a: 'x"y<z&\n' }), { declaration: false });
  assert.equal(xml, '<n a="x&quot;y&lt;z&amp;&#10;">Tom &amp; Jerry &lt;Ltd&gt; "quoted"</n>');
});

test('keeps non-ASCII text such as Spanish names', () => {
  assert.equal(serialize(leaf('n', 'Peña Comercial – Año 2026'), { declaration: false }), '<n>Peña Comercial – Año 2026</n>');
});

test('rejects control characters instead of dropping them', () => {
  assert.throws(() => leaf('n', 'bad\u0001value'), XmlError);
  assert.throws(() => leaf('n', 'ok', { a: '\u0000' }), XmlError);
  assert.throws(() => leaf('n', 'lone \uD800 surrogate'), XmlError);
  assert.equal(serialize(leaf('n', 'emoji 🙂'), { declaration: false }), '<n>emoji 🙂</n>');
});

test('rejects invalid element names', () => {
  assert.throws(() => leaf('1bad', 'x'), XmlError);
  assert.throws(() => el('a b', undefined), XmlError);
});

test('skips falsy children and empty optional leaves', () => {
  const xml = serialize(el('a', undefined, undefined, false, null, optLeaf('b', ''), optLeaf('c', 'y')), { declaration: false });
  assert.equal(xml, '<a><c>y</c></a>');
});

test('optional indentation for debugging', () => {
  const xml = serialize(el('a', undefined, leaf('b', '1')), { declaration: false, indent: '  ' });
  assert.equal(xml, '<a>\n  <b>1</b>\n</a>\n');
});
