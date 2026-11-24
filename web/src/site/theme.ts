/**
 * A site's theme as CSS: the storefront's colour, type, shape and spacing
 * variables (which every shop component already uses), plus the few rules
 * that need a computed colour (buttons, the header, the order summary).
 * Colours that are not given (hover, borders, muted text) are mixed from the
 * six the owner chooses, so any combination stays coherent.
 */

import type { Theme } from './types';

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '000000';
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (c: RGB) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
/** `a` with `amount` (0..1) of `b` mixed in. */
export const mix = (a: string, b: string, amount: number) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as RGB);
};
const rgba = (hex: string, alpha: number) => `rgba(${hexToRgb(hex).join(', ')}, ${alpha})`;

/** Relative luminance (WCAG). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Contrast ratio between two colours (1 to 21; 4.5 is the minimum for text). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const isDark = (hex: string) => luminance(hex) < 0.4;
/** Black or white, whichever reads better on `hex`. */
export const readableOn = (hex: string) => (contrast('#ffffff', hex) >= contrast('#111111', hex) ? '#ffffff' : '#111111');

const RADIUS = { none: [0, 0, 0, 0], small: [3, 4, 6, 8], medium: [6, 8, 12, 16], large: [10, 14, 20, 26] } as const;
const WIDTH = { narrow: '1000px', normal: '1180px', wide: '1400px' } as const;
const GAP = { compact: 0.7, normal: 1, airy: 1.35 } as const;

/** The CSS for a theme, scoped to the storefront (`.shop`). `fonts` maps a font key to its CSS family. */
export function themeCss(t: Theme, fonts: Record<string, string>): string {
  const c = t.colors;
  const dark = isDark(c.background);
  const ink2 = mix(c.text, c.background, 0.22);
  const muted = mix(c.text, c.background, 0.42);
  const hairline = mix(c.background, c.text, dark ? 0.16 : 0.1);
  const hairlineStrong = mix(c.background, c.text, dark ? 0.26 : 0.18);
  const primaryHover = isDark(c.primary) ? mix(c.primary, '#ffffff', 0.12) : mix(c.primary, '#000000', 0.1);
  const [rs, r, rl, rx] = RADIUS[t.radius];
  // The order summary ("ticket") is a dark card on light themes and a lifted one on dark themes.
  const ticket = dark ? mix(c.surface, '#ffffff', 0.06) : c.text;
  const ticketText = readableOn(ticket);
  const ticketFigure = contrast(c.accent, ticket) >= 3 ? c.accent : contrast(c.primary, ticket) >= 3 ? c.primary : ticketText;
  const header = t.headerStyle === 'brand' ? c.primary : t.headerStyle === 'dark' ? (dark ? c.surface : '#111111') : c.background;
  const headerText = t.headerStyle === 'light' ? c.text : t.headerStyle === 'brand' ? c.primaryText : readableOn(header);
  const pill = t.buttons === 'pill' ? '999px' : `${r}px`;
  const heading = fonts[t.fonts.heading] ?? fonts.inter ?? 'system-ui, sans-serif';
  const body = fonts[t.fonts.body] ?? fonts.inter ?? 'system-ui, sans-serif';
  const gap = GAP[t.spacing];
  const outline = t.buttons === 'outline';
  return `
.shop {
  --sheet: ${c.background}; --sheet-2: ${c.surface}; --paper: ${c.surface}; --paper-2: ${mix(c.surface, c.text, 0.05)};
  --ink: ${c.text}; --ink-2: ${ink2}; --muted: ${muted}; --hairline: ${hairline}; --hairline-strong: ${hairlineStrong};
  --brand: ${c.primary}; --brand-hover: ${primaryHover}; --brand-ink: ${contrast(c.primary, c.background) >= 4.5 ? c.primary : c.text};
  --brand-soft: ${mix(c.background, c.primary, 0.08)}; --brand-line: ${mix(c.background, c.primary, 0.25)}; --lavender: ${mix(c.background, c.primary, 0.1)};
  --on-brand: ${c.primaryText}; --accent: ${c.accent}; --on-accent: ${readableOn(c.accent)};
  --lime: ${ticketFigure}; --lime-ink: ${contrast(c.accent, c.background) >= 4.5 ? c.accent : c.text};
  --ring: 0 0 0 3px ${rgba(c.primary, 0.25)};
  --radius-sm: ${rs}px; --radius: ${r}px; --radius-lg: ${rl}px; --radius-xl: ${rx}px; --button-radius: ${pill};
  --sans: ${body}; --display: ${heading}; --figures: ${body};
  --site-width: ${WIDTH[t.width]}; --gap: ${gap};
  --ticket: ${ticket}; --ticket-text: ${ticketText};
  --header-bg: ${header}; --header-text: ${headerText};
  --image-ratio: ${t.imageShape === 'portrait' ? '4 / 5' : t.imageShape === 'landscape' ? '4 / 3' : '1 / 1'};
  background: ${c.background}; color: ${c.text};
  color-scheme: ${dark ? 'dark' : 'light'};
}
.shop h1, .shop h2, .shop h3 { font-family: var(--display); color: var(--ink); ${t.headingCase === 'upper' ? 'text-transform: uppercase; letter-spacing: 0.02em;' : ''} }
.shop button:not(.secondary):not(.link):not(.option):not(.icon-button):not([role="tab"]):not([aria-pressed]):not(.shop-qty button), .shop .button:not(.secondary) {
  background: ${outline ? 'transparent' : 'var(--brand)'}; border-color: var(--brand); color: ${outline ? 'var(--brand-ink)' : 'var(--on-brand)'}; border-radius: var(--button-radius);
}
.shop button:not(.secondary):not(.link):not(.option):not(.icon-button):not([role="tab"]):not([aria-pressed]):not(.shop-qty button):hover:not(:disabled), .shop .button:not(.secondary):hover {
  background: ${outline ? 'var(--brand)' : 'var(--brand-hover)'}; border-color: var(--brand-hover); color: var(--on-brand);
}
.shop button.secondary, .shop .button.secondary { border-radius: var(--button-radius); background: transparent; color: var(--ink); border-color: var(--hairline-strong); }
.shop .chip { color: inherit; }
.shop .quick-tabs button[aria-pressed='true'], .shop .quick-tabs button[aria-pressed='true']:hover:not(:disabled) { background: var(--ink); border-color: var(--ink); color: var(--sheet); }
.shop input, .shop select, .shop textarea { background: ${dark ? mix(c.background, '#ffffff', 0.06) : '#ffffff'}; color: var(--ink); border-color: var(--hairline-strong); }
.shop .card { background: ${dark ? c.surface : c.background}; border-color: var(--hairline); }
.shop .ticket { background: var(--ticket) !important; color: var(--ticket-text); }
.shop .summary > div span:first-child { color: ${rgba(ticketText, 0.78)}; }
.shop .summary .grand span:first-child { color: var(--ticket-text) !important; }
.shop .shop-header { background: ${rgba(header, 0.94)}; color: var(--header-text); border-bottom-color: ${t.headerStyle === 'light' ? 'var(--hairline)' : 'transparent'}; }
.shop .shop-header a, .shop .shop-header .shop-name, .shop .shop-header .site-nav a { color: var(--header-text); }
.shop .shop-header .shop-tagline { color: ${rgba(headerText, 0.7)}; }
.shop .shop-thumb, .shop .site-product-card .site-thumb { aspect-ratio: var(--image-ratio); }
.shop .shop-main { max-width: var(--site-width); }
.shop .site-card-frame { ${t.cards === 'bordered' ? 'border: 1px solid var(--hairline); padding: 0.6rem; border-radius: var(--radius-lg); background: var(--sheet);' : t.cards === 'shadow' ? 'box-shadow: 0 6px 24px -10px rgba(0,0,0,0.25); padding: 0.6rem; border-radius: var(--radius-lg); background: var(--sheet);' : ''} }
`;
}

/** Fonts are bundled with the app and loaded only when a theme uses them. */
const FONT_LOADERS: Record<string, () => Promise<unknown>> = {
  inter: () => Promise.resolve(),
  'inter-tight': () => Promise.resolve(),
  'dm-sans': () => import('@fontsource-variable/dm-sans'),
  montserrat: () => import('@fontsource-variable/montserrat'),
  nunito: () => import('@fontsource-variable/nunito'),
  outfit: () => import('@fontsource-variable/outfit'),
  'space-grotesk': () => import('@fontsource-variable/space-grotesk'),
  playfair: () => import('@fontsource-variable/playfair-display'),
  fraunces: () => import('@fontsource-variable/fraunces'),
  lora: () => import('@fontsource-variable/lora'),
  'dm-serif': () => import('@fontsource/dm-serif-display'),
};
const loaded = new Set<string>();
export function loadFonts(keys: string[]) {
  for (const k of keys) {
    if (loaded.has(k) || !FONT_LOADERS[k]) continue;
    loaded.add(k);
    void FONT_LOADERS[k]!().catch(() => loaded.delete(k));
  }
}

/** Font families, as the server lists them (kept here so the storefront needs no extra request). */
export const FONT_FAMILIES: Record<string, string> = {
  inter: "'Inter Variable', 'Inter', system-ui, sans-serif",
  'inter-tight': "'Inter Tight Variable', 'Inter Variable', system-ui, sans-serif",
  'dm-sans': "'DM Sans Variable', system-ui, sans-serif",
  montserrat: "'Montserrat Variable', system-ui, sans-serif",
  nunito: "'Nunito Variable', system-ui, sans-serif",
  outfit: "'Outfit Variable', system-ui, sans-serif",
  'space-grotesk': "'Space Grotesk Variable', system-ui, sans-serif",
  playfair: "'Playfair Display Variable', Georgia, serif",
  fraunces: "'Fraunces Variable', Georgia, serif",
  lora: "'Lora Variable', Georgia, serif",
  'dm-serif': "'DM Serif Display', Georgia, serif",
};
