// Checks the till's colour pairs against WCAG AA in both themes (web/src/pos/design/tokens.css):
// text 4.5:1, large text and interface parts 3:1. Prints a Markdown table; exits 1 if a pair fails.
//   node scripts/pos-contrast.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'pos', 'design', 'tokens.css'), 'utf8');
const block = (start) => {
  const i = css.indexOf(start);
  return css.slice(i, css.indexOf('\n}', i));
};
const vars = (text) => Object.fromEntries([...text.matchAll(/(--pos-[a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = vars(block('body.till-body {'));
const dark = { ...light, ...vars(block("html[data-theme='dark'] body.till-body {")) };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, need, what]
const pairs = [
  ['--pos-text', '--pos-surface', 4.5, 'Body text on panels'],
  ['--pos-text', '--pos-bg', 4.5, 'Body text on the background'],
  ['--pos-text-2', '--pos-surface', 4.5, 'Secondary text'],
  ['--pos-text-muted', '--pos-surface', 4.5, 'Muted text on panels'],
  ['--pos-text-muted', '--pos-bg', 4.5, 'Muted text on the background'],
  ['--pos-text-muted', '--pos-surface-2', 4.5, 'Muted text on insets'],
  ['--pos-on-brand', '--pos-brand', 4.5, 'Primary button text'],
  ['--pos-brand-text', '--pos-surface', 4.5, 'Brand text (quiet buttons, links)'],
  ['--pos-brand-text', '--pos-brand-soft', 4.5, 'Selected item text'],
  ['--pos-on-bar', '--pos-bar', 4.5, 'Status bar text'],
  ['--pos-on-bar-muted', '--pos-bar', 4.5, 'Status bar secondary text'],
  ['--pos-border-strong', '--pos-surface', 3, 'Field edges'],
  ['--pos-brand', '--pos-surface', 3, 'Focus ring, selection edge'],
  ...['success', 'warning', 'danger', 'info'].flatMap((s) => [
    [`--pos-${s}-text`, `--pos-${s}-soft`, 4.5, `${s} badge and banner text`],
    [`--pos-${s}-text`, '--pos-surface', 4.5, `${s} text on panels`],
    [`--pos-${s}`, '--pos-surface', 3, `${s} icon on panels`],
  ]),
  ...['free', 'reserved', 'seated', 'ordered', 'sent', 'mains', 'bill', 'paid'].flatMap((s) => [
    [`--pos-t-${s}-ink`, `--pos-t-${s}`, 4.5, `table "${s}": its text`],
    [`--pos-t-${s}-edge`, '--pos-plan', 3, `table "${s}": its edge on the plan`],
  ]),
];

let failed = 0;
console.log('| Pair | Needs | Light | Dark |');
console.log('|---|---|---|---|');
for (const [fg, bg, need, what] of pairs) {
  const cells = [light, dark].map((t) => {
    if (!t[fg] || !t[bg]) return 'n/a';
    const r = ratio(t[fg], t[bg]);
    if (r < need) failed++;
    return `${r.toFixed(1)}:1${r < need ? ' FAIL' : ''}`;
  });
  console.log(`| ${what} (\`${fg}\` on \`${bg}\`) | ${need}:1 | ${cells[0]} | ${cells[1]} |`);
}
if (failed) {
  console.error(`${failed} pairs below AA`);
  process.exit(1);
}
