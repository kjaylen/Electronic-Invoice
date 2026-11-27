/**
 * Copies a built release into a server's till downloads folder (TILL_DOWNLOADS_DIR):
 *
 *   npm run publish-local -- <folder>
 *
 * For each update file in release/ (latest.yml, latest-mac.yml, latest-linux.yml) it copies the files
 * it names and their .blockmap (what lets a till download only what changed), then the update file
 * itself last, so a till never sees a version whose installer is not there yet. For a server elsewhere,
 * copy the same files with rsync or the hosting's tools, in the same order.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run publish-local -- <folder>');
  process.exit(1);
}
const release = resolve(import.meta.dirname, '..', 'release');
const dest = resolve(to);
mkdirSync(dest, { recursive: true });

const ymls = readdirSync(release).filter((f) => /^latest(-mac|-linux)?\.yml$/.test(f));
if (!ymls.length) {
  console.error('No release found: run npm run dist:win (or dist:mac, dist:linux) first.');
  process.exit(1);
}
for (const yml of ymls) {
  const text = readFileSync(join(release, yml), 'utf8');
  const files = new Set([...text.matchAll(/^\s*(?:-\s*url|path):\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => basename(m[1])));
  for (const file of files) {
    for (const f of [file, `${file}.blockmap`]) {
      if (!existsSync(join(release, f))) {
        if (f === file) throw new Error(`${yml} names ${file}, which is not in release/`);
        continue;
      }
      copyFileSync(join(release, f), join(dest, f));
      console.log(`  ${f}`);
    }
  }
  copyFileSync(join(release, yml), join(dest, yml));
  console.log(`  ${yml}  (version ${/^version:\s*(\S+)/m.exec(text)?.[1]})`);
}
console.log(`Published to ${dest}`);
