/**
 * A store's site, as the site builder edits it: one document holding the
 * theme (colours, fonts, shapes, logo), the header (announcement, menu), the
 * footer (link columns, social links), the home page, extra sections on
 * product pages, and the store's own pages, each a list of sections.
 *
 * Owners edit a draft; publishing copies it to what customers see, and keeps
 * the published version (the last 30) to go back to. A store that never used
 * the builder gets a site made from its settings, which looks like the store
 * did before.
 *
 * Every saved document goes through normalizeSite: unknown fields are dropped,
 * text is cut to its limit, choices fall back to their default, links and
 * picture references are checked. Nothing a browser sends reaches the page
 * unchecked, and the storefront renders it as text (never as HTML), apart
 * from custom code sections, which are rendered and sanitized on the server.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import {
  type Field, FONT_KEYS, ICONS, LINK_TYPES, type PageKind, PRESET_BY_KEY, PRESETS, SECTION_BY_TYPE, type SiteLink, type Theme, THEME_OPTIONS,
} from './site-schema.ts';

export const MAX_SITE_BYTES = 600_000;
const MAX_SECTIONS = 40;
const MAX_PAGES = 40;
const MAX_MENU = 12;
const MAX_VERSIONS = 30;

export class SiteError extends Error {
  override name = 'SiteError';
  readonly code: 'invalid_site' | 'not_found' | 'conflict';
  constructor(code: SiteError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Block { id: string; settings: Record<string, unknown> }
export interface Section { id: string; type: string; hidden: boolean; settings: Record<string, unknown>; blocks: Block[] }
export interface MenuItem { id: string; label: string; link: SiteLink; children: MenuItem[] }
export interface SitePage { id: string; slug: string; title: string; seoTitle: string; seoDescription: string; sections: Section[] }
export interface SiteDoc {
  version: 1;
  theme: Theme;
  header: { announcement: { enabled: boolean; text: string; link: SiteLink | null; style: 'primary' | 'accent' | 'dark' }; menu: MenuItem[]; sticky: boolean; showSearch: boolean };
  footer: { columns: Array<{ id: string; title: string; links: MenuItem[] }>; text: string; showSocial: boolean; showContact: boolean; showPayments: boolean };
  social: { facebook: string; instagram: string; tiktok: string; youtube: string; x: string };
  seo: { title: string; description: string; image: string };
  home: { sections: Section[] };
  product: { sections: Section[]; showRelated: boolean; relatedTitle: string };
  pages: SitePage[];
}

// ---------- checking what is saved ----------

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, def = '') => (typeof v === 'string' ? v.replace(CONTROL, '').slice(0, max) : def);
const line = (v: unknown, max: number, def = '') => str(v, max, def).replace(/[\r\n]+/g, ' ');
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const oneOf = <T extends string>(v: unknown, options: readonly T[], def: T): T => (typeof v === 'string' && (options as readonly string[]).includes(v) ? v as T : def);
const color = (v: unknown, def: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : def);
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const imageRef = (v: unknown) => (typeof v === 'string' && /^(a|p):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : '');
export const newId = () => randomBytes(6).toString('hex');
/** An address made from any text ("Our Story!" gives "our-story"). */
export const slugOf = (v: unknown) => (typeof v === 'string' ? v : '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

/** A link a customer may follow: the store's own pages, or a web, email, phone or WhatsApp address. */
export function safeUrl(v: string): string {
  const s = v.trim();
  if (/\s/.test(s) || s.length > 500) return '';
  if (/^(https?:\/\/[^/]|mailto:|tel:)/i.test(s)) return s;
  if (/^\/(?!\/)/.test(s) || s.startsWith('#')) return s;
  return '';
}

function link(v: unknown): SiteLink {
  if (!isObj(v)) return { type: 'home' };
  const type = oneOf(v.type, LINK_TYPES, 'home');
  const value = typeof v.value === 'string' ? v.value.trim().slice(0, 500) : '';
  switch (type) {
    case 'url': {
      const url = safeUrl(value);
      return url ? { type, value: url } : { type: 'home' };
    }
    case 'collection': case 'page': case 'product':
      return HANDLE.test(value) ? { type, value } : { type: type === 'collection' ? 'collections' : 'home' };
    case 'category':
      return value ? { type, value: line(value, 80) } : { type: 'catalog' };
    default:
      return { type };
  }
}

function ids(seen: Set<string>) {
  return (v: unknown) => {
    const id = typeof v === 'string' && /^[a-z0-9-]{4,40}$/.test(v) && !seen.has(v) ? v : newId();
    seen.add(id);
    return id;
  };
}

function fieldValue(f: Field, v: unknown): unknown {
  switch (f.type) {
    case 'text': return line(v, f.maxLength ?? 200, f.default as string ?? '');
    case 'textarea': case 'richtext': case 'code': return str(v, f.maxLength ?? 2000, f.default as string ?? '');
    case 'select': return oneOf(v, (f.options ?? []).map(([k]) => k), (f.default as string) ?? f.options?.[0]?.[0] ?? '');
    case 'icon': return oneOf(v, ICONS, (f.default as (typeof ICONS)[number]) ?? 'check');
    case 'number': {
      const def = (f.default as number) ?? f.min ?? 0;
      if (typeof v !== 'number' || !Number.isFinite(v)) return def;
      const step = f.step ?? 1;
      return Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, Math.round(v / step) * step));
    }
    case 'toggle': return bool(v, (f.default as boolean) ?? false);
    case 'image': return imageRef(v);
    case 'images': return Array.isArray(v) ? [...new Set(v.map(imageRef).filter(Boolean))].slice(0, f.maxItems ?? 24) : [];
    case 'link': return link(v ?? f.default);
    case 'collection': return typeof v === 'string' && HANDLE.test(v) ? v : '';
    case 'collections': case 'products':
      return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && HANDLE.test(x)))].slice(0, f.maxItems ?? 12) : [];
    case 'category': return line(v, 80);
    case 'datetime': return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : '';
  }
}

function settingsFor(fields: Field[], v: unknown): Record<string, unknown> {
  const input = isObj(v) ? v : {};
  return Object.fromEntries(fields.map((f) => [f.key, fieldValue(f, input[f.key])]));
}

function sections(v: unknown, kind: PageKind, seen: Set<string>): Section[] {
  if (!Array.isArray(v)) return [];
  const id = ids(seen);
  const out: Section[] = [];
  for (const raw of v.slice(0, MAX_SECTIONS)) {
    if (!isObj(raw)) continue;
    const schema = typeof raw.type === 'string' ? SECTION_BY_TYPE.get(raw.type) : undefined;
    if (!schema || (schema.pages && !schema.pages.includes(kind))) continue;
    const blockIds = ids(seen);
    out.push({
      id: id(raw.id),
      type: schema.type,
      hidden: bool(raw.hidden, false),
      settings: settingsFor(schema.fields, raw.settings),
      blocks: schema.blocks && Array.isArray(raw.blocks)
        ? raw.blocks.slice(0, schema.blocks.max).filter(isObj).map((b) => ({ id: blockIds(b.id), settings: settingsFor(schema.blocks!.fields, b.settings) }))
        : [],
    });
  }
  return out;
}

function menu(v: unknown, seen: Set<string>, depth = 0): MenuItem[] {
  if (!Array.isArray(v)) return [];
  const id = ids(seen);
  return v.slice(0, MAX_MENU).filter(isObj).map((m) => ({
    id: id(m.id),
    label: line(m.label, 60) || 'Link',
    link: link(m.link),
    children: depth === 0 ? menu(m.children, seen, 1) : [],
  }));
}

function themeOf(v: unknown): Theme {
  const t = isObj(v) ? v : {};
  const base = PRESET_BY_KEY.get(typeof t.preset === 'string' ? t.preset : '')?.theme ?? PRESETS[0]!.theme;
  const c = isObj(t.colors) ? t.colors : {};
  const f = isObj(t.fonts) ? t.fonts : {};
  const font = (x: unknown, def: string) => (typeof x === 'string' && FONT_KEYS.has(x) ? x : def);
  const o = THEME_OPTIONS;
  return {
    preset: base.preset,
    colors: {
      background: color(c.background, base.colors.background), surface: color(c.surface, base.colors.surface), text: color(c.text, base.colors.text),
      primary: color(c.primary, base.colors.primary), primaryText: color(c.primaryText, base.colors.primaryText), accent: color(c.accent, base.colors.accent),
    },
    fonts: { heading: font(f.heading, base.fonts.heading), body: font(f.body, base.fonts.body) },
    radius: oneOf(t.radius, o.radius, base.radius),
    buttons: oneOf(t.buttons, o.buttons, base.buttons),
    cards: oneOf(t.cards, o.cards, base.cards),
    imageShape: oneOf(t.imageShape, o.imageShape, base.imageShape),
    width: oneOf(t.width, o.width, base.width),
    spacing: oneOf(t.spacing, o.spacing, base.spacing),
    headerLayout: oneOf(t.headerLayout, o.headerLayout, base.headerLayout),
    headerStyle: oneOf(t.headerStyle, o.headerStyle, base.headerStyle),
    headingCase: oneOf(t.headingCase, o.headingCase, base.headingCase),
    logo: imageRef(t.logo),
    logoHeight: typeof t.logoHeight === 'number' && Number.isFinite(t.logoHeight) ? Math.min(96, Math.max(20, Math.round(t.logoHeight))) : base.logoHeight,
    favicon: imageRef(t.favicon),
  };
}

const socialUrl = (v: unknown) => {
  const s = typeof v === 'string' ? safeUrl(v) : '';
  return /^https:\/\//i.test(s) ? s : '';
};

/** A saved site, checked and completed (see the top of the file). */
export function normalizeSite(input: unknown): SiteDoc {
  if (!isObj(input)) throw new SiteError('invalid_site', 'The site must be an object');
  if (JSON.stringify(input).length > MAX_SITE_BYTES) throw new SiteError('invalid_site', 'The site is too large; remove some sections or pages');
  const seen = new Set<string>();
  const h = isObj(input.header) ? input.header : {};
  const a = isObj(h.announcement) ? h.announcement : {};
  const ft = isObj(input.footer) ? input.footer : {};
  const so = isObj(input.social) ? input.social : {};
  const seo = isObj(input.seo) ? input.seo : {};
  const home = isObj(input.home) ? input.home : {};
  const product = isObj(input.product) ? input.product : {};
  const colId = ids(seen);
  const slugs = new Set<string>();
  const pageId = ids(seen);
  const pages: SitePage[] = [];
  for (const p of (Array.isArray(input.pages) ? input.pages : []).slice(0, MAX_PAGES)) {
    if (!isObj(p)) continue;
    // A page is never dropped for its address: a bad one is made from the title, a taken one gets a number.
    const wanted = typeof p.slug === 'string' && HANDLE.test(p.slug) ? p.slug : slugOf(p.slug) || slugOf(p.title) || 'page';
    let slug = wanted;
    for (let i = 2; slugs.has(slug); i++) slug = `${wanted.slice(0, 70)}-${i}`;
    slugs.add(slug);
    pages.push({ id: pageId(p.id), slug, title: line(p.title, 120) || slug, seoTitle: line(p.seoTitle, 120), seoDescription: line(p.seoDescription, 300), sections: sections(p.sections, 'page', seen) });
  }
  return {
    version: 1,
    theme: themeOf(input.theme),
    header: {
      announcement: { enabled: bool(a.enabled, false), text: line(a.text, 200), link: a.link ? link(a.link) : null, style: oneOf(a.style, ['primary', 'accent', 'dark'] as const, 'dark') },
      menu: menu(h.menu, seen),
      sticky: bool(h.sticky, true),
      showSearch: bool(h.showSearch, true),
    },
    footer: {
      columns: (Array.isArray(ft.columns) ? ft.columns : []).slice(0, 4).filter(isObj).map((c) => ({ id: colId(c.id), title: line(c.title, 60), links: menu(c.links, seen, 1) })),
      text: str(ft.text, 600),
      showSocial: bool(ft.showSocial, true),
      showContact: bool(ft.showContact, true),
      showPayments: bool(ft.showPayments, true),
    },
    social: { facebook: socialUrl(so.facebook), instagram: socialUrl(so.instagram), tiktok: socialUrl(so.tiktok), youtube: socialUrl(so.youtube), x: socialUrl(so.x) },
    seo: { title: line(seo.title, 120), description: line(seo.description, 300), image: imageRef(seo.image) },
    home: { sections: sections(home.sections, 'home', seen) },
    product: { sections: sections(product.sections, 'product', seen), showRelated: bool(product.showRelated, true), relatedTitle: line(product.relatedTitle, 80, 'You may also like') || 'You may also like' },
    pages,
  };
}

/** A section with its default settings and blocks (what "Add section" puts in). */
export function newSection(type: string): Section {
  const schema = SECTION_BY_TYPE.get(type);
  if (!schema) throw new SiteError('invalid_site', `There is no section called ${type}`);
  return {
    id: newId(),
    type,
    hidden: false,
    settings: settingsFor(schema.fields, {}),
    blocks: (schema.defaultBlocks ?? []).map((b) => ({ id: newId(), settings: settingsFor(schema.blocks!.fields, b) })),
  };
}

// ---------- a store without a site yet ----------

export interface StoreFacts { name: string; tagline: string; about: string; city: string; logoAssetId: string | null; accounts: boolean; open: boolean }

/** The site a store has before it uses the builder: its name, tagline and every product, as the store looked before. */
export function defaultSite(s: Pick<StoreFacts, 'name' | 'tagline' | 'about' | 'logoAssetId' | 'accounts'>): SiteDoc {
  const hero = newSection('hero');
  hero.settings = { ...hero.settings, heading: s.name, text: s.tagline, height: 'small', showPerks: true, buttonLabel: '', overlay: 30 };
  const grid = newSection('product_grid');
  return normalizeSite({
    theme: { ...PRESETS[0]!.theme, logo: s.logoAssetId ? `a:${s.logoAssetId}` : '' },
    header: { menu: [{ label: 'Home', link: { type: 'home' } }, { label: 'Shop all', link: { type: 'catalog' } }], sticky: true, showSearch: false },
    footer: {
      columns: [{ title: 'Shop', links: [{ label: 'All products', link: { type: 'catalog' } }, { label: 'Gift card balance', link: { type: 'gift_card' } }, ...(s.accounts ? [{ label: 'My account', link: { type: 'account' } }] : [])] }],
      text: s.about, showSocial: true, showContact: true, showPayments: true,
    },
    home: { sections: [hero, { ...newSection('template_section') }, grid] },
    product: { sections: [], showRelated: true, relatedTitle: 'You may also like' },
    pages: [],
  });
}

export async function storeFacts(db: Queryable, tenantId: string): Promise<StoreFacts> {
  const t = (await db.query<{ name: string; city: string | null; store_settings: { enabled?: boolean; tagline?: string; about?: string; accounts?: { enabled?: boolean } } | null; logo_asset_id: string | null }>(
    'select coalesce(trade_name, legal_name) as name, city, store_settings, logo_asset_id from tenants where id = $1', [tenantId],
  )).rows[0]!;
  return { name: t.name, city: t.city ?? '', tagline: t.store_settings?.tagline ?? '', about: t.store_settings?.about ?? '', logoAssetId: t.logo_asset_id, accounts: t.store_settings?.accounts?.enabled ?? true, open: t.store_settings?.enabled ?? false };
}

// ---------- drafts, publishing, versions ----------

interface SiteRow { draft: unknown; published: unknown; draft_updated_at: Date | string; published_at: Date | string | null }

export async function loadSite(db: Queryable, tenantId: string) {
  const row = (await db.query<SiteRow>('select draft, published, draft_updated_at, published_at from store_sites where tenant_id = $1', [tenantId])).rows[0];
  if (!row) {
    const site = defaultSite(await storeFacts(db, tenantId));
    return { draft: site, published: null as SiteDoc | null, changed: false, publishedAt: null as string | null, draftUpdatedAt: null as string | null };
  }
  const draft = normalizeSite(row.draft);
  const published = row.published ? normalizeSite(row.published) : null;
  return {
    draft,
    published,
    changed: !published || JSON.stringify(draft) !== JSON.stringify(published),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    draftUpdatedAt: new Date(row.draft_updated_at).toISOString(),
  };
}

/** What customers see: the published site, or the one made from the store's settings. */
export async function publishedSite(db: Queryable, tenantId: string): Promise<SiteDoc> {
  const row = (await db.query<{ published: unknown }>('select published from store_sites where tenant_id = $1', [tenantId])).rows[0];
  return row?.published ? normalizeSite(row.published) : defaultSite(await storeFacts(db, tenantId));
}

/**
 * Save the draft. With `base` (when the editor last saw the draft change), the save is refused if
 * someone else has saved since, so two people editing never overwrite each other without knowing.
 */
export async function saveDraft(db: Queryable, tenantId: string, input: unknown, userId: string | null, base?: string | null): Promise<SiteDoc> {
  const site = normalizeSite(input);
  const saved = (await db.query(
    `insert into store_sites (tenant_id, draft, draft_updated_by) values ($1, $2, $3)
     on conflict (tenant_id) do update set draft = excluded.draft, draft_updated_at = now(), draft_updated_by = excluded.draft_updated_by
     where $4::timestamptz is null or date_trunc('milliseconds', store_sites.draft_updated_at) = date_trunc('milliseconds', $4::timestamptz)
     returning tenant_id`,
    [tenantId, JSON.stringify(site), userId, base ?? null],
  )).rows.length;
  if (!saved) {
    const other = (await db.query<{ name: string | null }>('select u.name from store_sites s left join users u on u.id = s.draft_updated_by where s.tenant_id = $1', [tenantId])).rows[0];
    throw new SiteError('conflict', `${other?.name ?? 'Someone else'} changed the site while you were editing`);
  }
  return site;
}

export async function publishSite(db: Queryable, tenantId: string, userId: string | null, note?: string): Promise<{ publishedAt: string }> {
  const current = await loadSite(db, tenantId);
  const site = JSON.stringify(current.draft);
  const r = (await db.query<{ published_at: Date }>(
    `insert into store_sites (tenant_id, draft, published, published_at, published_by) values ($1, $2, $2, now(), $3)
     on conflict (tenant_id) do update set published = excluded.draft, published_at = now(), published_by = excluded.published_by
     returning published_at`,
    [tenantId, site, userId],
  )).rows[0]!;
  await db.query('insert into store_site_versions (id, tenant_id, content, note, published_by) values ($1, $2, $3, $4, $5)', [randomUUID(), tenantId, site, note?.trim() || null, userId]);
  await db.query(
    `delete from store_site_versions where tenant_id = $1 and id not in (select id from store_site_versions where tenant_id = $1 order by created_at desc limit $2)`,
    [tenantId, MAX_VERSIONS],
  );
  return { publishedAt: new Date(r.published_at).toISOString() };
}

/** Throw the draft away: back to what is published (or the starting site). */
export async function discardDraft(db: Queryable, tenantId: string, userId: string | null): Promise<SiteDoc> {
  const row = (await db.query<{ published: unknown }>('select published from store_sites where tenant_id = $1', [tenantId])).rows[0];
  const site = row?.published ? normalizeSite(row.published) : defaultSite(await storeFacts(db, tenantId));
  return saveDraft(db, tenantId, site, userId);
}

export async function listVersions(db: Queryable, tenantId: string) {
  return (await db.query<{ id: string; note: string | null; created_at: Date; by: string | null }>(
    'select v.id, v.note, v.created_at, u.name as by from store_site_versions v left join users u on u.id = v.published_by where v.tenant_id = $1 order by v.created_at desc',
    [tenantId],
  )).rows.map((v) => ({ id: v.id, note: v.note, publishedAt: new Date(v.created_at).toISOString(), by: v.by }));
}

/** An earlier published version, as the draft (publish it to go back to it). */
export async function restoreVersion(db: Queryable, tenantId: string, versionId: string, userId: string | null): Promise<SiteDoc> {
  const v = (await db.query<{ content: unknown }>('select content from store_site_versions where id = $1 and tenant_id = $2', [versionId, tenantId])).rows[0];
  if (!v) throw new SiteError('not_found', 'That version is not kept any more');
  return saveDraft(db, tenantId, v.content, userId);
}

/** Every picture the site (draft or published) uses: the business's images it cannot delete. */
export async function siteImageRefs(db: Queryable, tenantId: string): Promise<Set<string>> {
  const row = (await db.query<{ draft: unknown; published: unknown }>('select draft, published from store_sites where tenant_id = $1', [tenantId])).rows[0];
  const text = row ? `${JSON.stringify(row.draft)} ${JSON.stringify(row.published)}` : '';
  return new Set(text.match(/a:[0-9a-f-]{36}/g) ?? []);
}

/** Every custom code section in a site (to render on the server). */
export function customCodeSections(site: SiteDoc): Section[] {
  return [...site.home.sections, ...site.product.sections, ...site.pages.flatMap((p) => p.sections)].filter((s) => s.type === 'custom_code');
}
