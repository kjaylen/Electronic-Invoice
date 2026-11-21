/**
 * Validate XML against the official OASIS UBL 2.1 schemas (in schemas/ubl-2.1),
 * using libxml2 compiled to WebAssembly, so no native install is needed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';

const ROOT = fileURLToPath(new URL('../schemas/ubl-2.1/', import.meta.url));

let commonFiles: XMLFileInfo[] | undefined;
function common(): XMLFileInfo[] {
  commonFiles ??= readdirSync(join(ROOT, 'common')).map((f) => ({
    fileName: `common/${f}`,
    contents: readFileSync(join(ROOT, 'common', f), 'utf8'),
  }));
  return commonFiles;
}

export type UblRoot = 'Invoice' | 'CreditNote' | 'ApplicationResponse';

export async function validateUbl(xml: string, root: UblRoot): Promise<{ valid: boolean; errors: string[] }> {
  const schemaName = `UBL-${root}-2.1.xsd`;
  const result = await validateXML({
    xml: { fileName: 'document.xml', contents: xml },
    // Placed in maindoc/ so its "../common/..." imports resolve against the preloaded files.
    schema: { fileName: `maindoc/${schemaName}`, contents: readFileSync(join(ROOT, 'maindoc', schemaName), 'utf8') },
    preload: common(),
    maxMemoryPages: 4096,
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.message) };
}
