/**
 * Every label the site builder shows from its definitions (section names and
 * descriptions, field labels, hints and choices, look names), one per line:
 * what the Spanish dictionary (web/src/es.ts) must hold for the builder.
 *
 *   node scripts/site-labels.ts            the labels
 *   node scripts/site-labels.ts --missing  those web/src/es.ts does not have yet
 */

import { readFileSync } from 'node:fs';
import { PRESETS, SECTIONS } from '../src/commerce/site-schema.ts';

const out = new Set<string>();
for (const s of SECTIONS) {
  out.add(s.name);
  out.add(s.description);
  if (s.blocks) out.add(s.blocks.label);
  for (const f of [...s.fields, ...(s.blocks?.fields ?? [])]) {
    out.add(f.label);
    if (f.hint) out.add(f.hint);
    for (const [, label] of f.options ?? []) out.add(label);
  }
}
for (const p of PRESETS) {
  out.add(p.name);
  out.add(p.description);
}

let labels = [...out];
if (process.argv.includes('--missing')) {
  const es = readFileSync(new URL('../web/src/es.ts', import.meta.url), 'utf8');
  labels = labels.filter((l) => !es.includes(`${JSON.stringify(l)}:`));
}
process.stdout.write(`${JSON.stringify(labels, null, 1)}\n`);
