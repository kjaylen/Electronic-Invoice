/**
 * Liquid, the template language Shopify themes use (liquidjs), set up so a business can edit its
 * own emails, printed documents and store safely:
 *   - no file system: {% include %} and {% render %} find nothing; no prototype access;
 *   - output is HTML-escaped unless a template asks for `| raw`;
 *   - limits on template size, render time and memory, so one template cannot hold up the server;
 *   - unknown filters are errors, with the line, so mistakes show while editing.
 *
 * Filters on top of Liquid's own: money (BZ$1,234.50), amount (1,234.50), pluralize, asset_url
 * (an uploaded image: {{ 'logo.png' | asset_url }}).
 * Tag: {% bts %} prints what BTS requires on a printed copy (QR code, ETDUI, authorization, legal
 * notices); printed documents must keep it (see catalog.ts).
 */

import { Liquid, Tag, type Context, type Emitter, type TagToken, type TopLevelToken, type Liquid as LiquidEngine } from 'liquidjs';

export class TemplateError extends Error {
  override name = 'TemplateError';
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(message);
    if (line !== undefined) this.line = line;
  }
}

/** "1234.5" or 1234.5 -> "1,234.50" (amounts come as decimal strings, like the API's). */
export function formatAmount(value: unknown): string {
  const raw = typeof value === 'number' ? value.toFixed(2) : String(value ?? '0').trim() || '0';
  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = raw.replace('-', '').split('.');
  const digits = whole.replace(/\D/g, '') || '0';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${(fraction.replace(/\D/g, '') + '00').slice(0, 2)}`;
}

const LIMITS = { parseLimit: 200_000, renderLimit: 2_000, memoryLimit: 16_000_000 };

/** The compliance block: what {% bts %} prints, already built from the signed document. */
export interface BtsBlock { html: string }

class BtsTag extends Tag {
  private readonly variant: string;
  constructor(token: TagToken, remain: TopLevelToken[], liquid: LiquidEngine) {
    super(token, remain, liquid);
    this.variant = token.args.trim().replace(/^['"]|['"]$/g, '');
  }
  render(ctx: Context, emitter: Emitter): void {
    const block = ctx.getSync(['__bts']) as BtsBlock | undefined;
    if (!block) return;
    emitter.write(this.variant === 'stacked' ? block.html.replace('class="bts"', 'class="bts bts-stacked"') : block.html);
  }
}

function make(escape: boolean, locale: string): Liquid {
  const engine = new Liquid({
    ...(escape && { outputEscape: 'escape' as const }),
    // Month and day names in | date (the server's own locale never leaks in).
    locale,
    strictFilters: true,
    strictVariables: false,
    ownPropertyOnly: true,
    timezoneOffset: 0,
    templates: {},
    cache: false,
    ...LIMITS,
  });
  engine.registerFilter('money', (v: unknown) => `BZ$${formatAmount(v)}`);
  engine.registerFilter('amount', (v: unknown) => formatAmount(v));
  engine.registerFilter('pluralize', (n: unknown, one: string, many: string) => (Number(n) === 1 ? one : many));
  // {{ 'logo.png' | asset_url }}: an uploaded image's address, as the render's asset map has it.
  engine.registerFilter('asset_url', function (this: { context: Context }, name: unknown) {
    const map = this.context.getSync(['__assets']) as Record<string, string> | undefined;
    const url = map?.[String(name)];
    if (url === undefined) throw new Error(`No image named "${String(name)}": upload it under Images, or check the name`);
    return url;
  });
  engine.registerTag('bts', BtsTag);
  return engine;
}

/** The language a template renders in (month names in | date): English, or Spanish for Spanish emails. */
export type RenderLang = 'en' | 'es';
const LOCALES: Record<RenderLang, string> = { en: 'en-US', es: 'es' };
/** HTML output (emails, documents, store sections): escaped by default. */
const html: Record<RenderLang, Liquid> = { en: make(true, LOCALES.en), es: make(true, LOCALES.es) };
/** Plain text (email subjects, CSS): nothing escaped. */
const text: Record<RenderLang, Liquid> = { en: make(false, LOCALES.en), es: make(false, LOCALES.es) };

function wrap(e: unknown): TemplateError {
  const message = e instanceof Error ? e.message : String(e);
  const line = /line:(\d+)/.exec(message)?.[1];
  // liquidjs appends ", line:3, col:5" and a code frame; keep the first line, readable.
  const clean = message.split('\n')[0]!.replace(/,\s*line:\d+, col:\d+$/, '').replace(/^ENOENT: Failed to lookup/, 'No such template:');
  return new TemplateError(clean, line ? Number(line) : undefined);
}

/** Check a template parses; throws TemplateError with the line of the first problem. */
export function parseTemplate(source: string): void {
  try {
    html.en.parse(source);
  } catch (e) {
    throw wrap(e);
  }
}

export async function renderHtml(source: string, context: Record<string, unknown>, bts?: BtsBlock, lang: RenderLang = 'en'): Promise<string> {
  try {
    return await html[lang].parseAndRender(source, { ...context, ...(bts && { __bts: bts }) });
  } catch (e) {
    throw wrap(e);
  }
}

export async function renderText(source: string, context: Record<string, unknown>, lang: RenderLang = 'en'): Promise<string> {
  try {
    return await text[lang].parseAndRender(source, context);
  } catch (e) {
    throw wrap(e);
  }
}

/** An HTML email as plain text, for the text part: links kept, tags gone, entities decoded. */
export function htmlToText(input: string): string {
  const decode = (s: string) => s.replace(/&amp;/g, '&');
  return input
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    // Line breaks in the source between tags are layout, not text.
    .replace(/>\s+</g, (m) => (m.includes('\n') ? '><' : m))
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      return !text || decode(text) === decode(href) ? href : `${text}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<\/?(p|div|h[1-6]|tr|li|table|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&times;/g, '×')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, all) => l || (all[i - 1] ?? '') !== '')
    .join('\n').trim();
}
