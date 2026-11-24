/**
 * Compress the built web app's scripts and styles ahead of time (Brotli and
 * gzip, beside each file), so the server sends them a third of the size
 * without compressing anything while it serves, and whatever proxy sits in
 * front need not be set up to do it. Run after `npm run web:build`:
 *
 *   npm run web:compress
 *
 * The server sends the compressed file to browsers that accept it
 * (src/api/app.ts) and the plain one otherwise. web/dist/assets is
 * compressed (its files have their content in their names, so they never
 * change once written), and the embed script other sites load (a fixed name,
 * compressed afresh on every build).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = fileURLToPath(new URL('../web/dist/assets/', import.meta.url));
const embed = fileURLToPath(new URL('../web/dist/embed.js', import.meta.url));
let before = 0;
let after = 0;
let files = 0;
for (const path of [...readdirSync(dir).filter((name) => /\.(js|css|svg|json)$/.test(name)).map((name) => `${dir}${name}`), embed]) {
  const data = readFileSync(path);
  // Small files gain nothing worth a second file.
  if (data.length < 1024) continue;
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  writeFileSync(`${path}.br`, br);
  writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
  before += statSync(path).size;
  after += br.length;
  files++;
}
process.stdout.write(`Compressed ${files} files: ${(before / 1024).toFixed(0)} kB as built, ${(after / 1024).toFixed(0)} kB with Brotli\n`);
