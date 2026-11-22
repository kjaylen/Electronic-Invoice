// Copy the built till (web/dist, from `npm run web:build` at the repository root) into the app.
// Set VITE_TILL_SERVER when building the web app to pre-fill the server address in the app.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', '..', 'web', 'dist');
const target = join(here, '..', 'web');
if (!existsSync(join(dist, 'pos.html'))) {
  console.error('Build the web app first: npm run web:build (at the repository root)');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true, filter: (src) => !src.endsWith('.map') && !src.endsWith('sw.js') });
console.log(`Copied the till into ${target}`);
