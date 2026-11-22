// Copy the built till (web/dist, from `npm run web:build` at the repository root) into www/, with the
// till page as index.html (what Capacitor opens). Set VITE_TILL_SERVER when building the web app to
// pre-fill the server address in the app.

import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', '..', 'web', 'dist');
const www = join(here, '..', 'www');
if (!existsSync(join(dist, 'pos.html'))) {
  console.error('Build the web app first: npm run web:build (at the repository root)');
  process.exit(1);
}
rmSync(www, { recursive: true, force: true });
cpSync(dist, www, { recursive: true, filter: (src) => !src.endsWith('.map') && !src.endsWith('sw.js') && !src.endsWith('display.html') });
rmSync(join(www, 'index.html'));
renameSync(join(www, 'pos.html'), join(www, 'index.html'));
console.log(`Copied the till into ${www}`);
