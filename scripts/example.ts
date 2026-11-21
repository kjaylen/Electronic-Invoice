/**
 * Print a sample unsigned document, indented for reading.
 *
 *   npm run example            # Tax Invoice
 *   npm run example -- 04      # Credit Note (01, 02, 03 or 04)
 *
 * Useful for comparing our output with the signed samples in the manual's annex.
 */
import { validateXML } from 'xmllint-wasm';
import { buildUblDocument, type IssuedEtdType } from '../src/engine/ubl.ts';
import { makeDocument } from '../test/fixtures.ts';

const type = (process.argv[2] ?? '01') as IssuedEtdType;
if (!['01', '02', '03', '04'].includes(type)) {
  console.error('Document type must be 01, 02, 03 or 04');
  process.exit(1);
}

const { xml, byteLength } = buildUblDocument(makeDocument(type));
const formatted = await validateXML({ xml: { fileName: 'doc.xml', contents: xml }, normalization: 'format' });
process.stdout.write(formatted.normalized);
console.error(`\n${byteLength} bytes unsigned`);
