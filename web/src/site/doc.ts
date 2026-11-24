/**
 * Changes to a site that need care, kept apart from the screens so they can
 * be tested on their own (test/site-doc.test.ts): page addresses (never two
 * the same, and every link follows a page that is renamed or deleted), the
 * sections of a page, and the editor's undo history.
 */

import type { MenuItem, Section, SiteDoc, SiteLink } from './types.ts';

export type PageKey = 'home' | 'product' | `page:${string}`;

// ---------- page addresses ----------

const DIACRITICS = /[̀-ͯ]/g;

/** An address from any text: "Our Story!" gives "our-story". */
export const slugify = (s: string) => s.normalize('NFKD').replace(DIACRITICS, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

/** The same while it is being typed: a hyphen at the end stays, so "about-us" can be written. */
export const typingSlug = (s: string) => s.normalize('NFKD').replace(DIACRITICS, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 60);

/** `wanted`, or `wanted-2`, `wanted-3`… when another page (not `exceptId`) has it. */
export function freeSlug(pages: SiteDoc['pages'], wanted: string, exceptId?: string): string {
  const base = slugify(wanted) || 'page';
  const taken = new Set(pages.filter((p) => p.id !== exceptId).map((p) => p.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const isLink = (v: unknown): v is SiteLink => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string' && Object.keys(v).every((k) => k === 'type' || k === 'value');

/** Every link in the site (menus, footer, announcement, buttons in sections and their blocks), through `f`. */
export function mapLinks(doc: SiteDoc, f: (l: SiteLink) => SiteLink): SiteDoc {
  const menu = (items: MenuItem[]): MenuItem[] => items.map((m) => ({ ...m, link: f(m.link), children: menu(m.children) }));
  const settings = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, isLink(v) ? f(v) : v]));
  const sections = (list: Section[]): Section[] => list.map((s) => ({ ...s, settings: settings(s.settings), blocks: s.blocks.map((b) => ({ ...b, settings: settings(b.settings) })) }));
  const a = doc.header.announcement;
  return {
    ...doc,
    header: { ...doc.header, announcement: { ...a, link: a.link ? f(a.link) : null }, menu: menu(doc.header.menu) },
    footer: { ...doc.footer, columns: doc.footer.columns.map((c) => ({ ...c, links: menu(c.links) })) },
    home: { sections: sections(doc.home.sections) },
    product: { ...doc.product, sections: sections(doc.product.sections) },
    pages: doc.pages.map((p) => ({ ...p, sections: sections(p.sections) })),
    ...(doc.saved && { saved: doc.saved.map((x) => ({ ...x, section: sections([x.section])[0]! })) }),
  };
}

/** Give a page a new address (made valid and free); every link to the page follows it. */
export function setPageSlug(doc: SiteDoc, pageId: string, wanted: string): SiteDoc {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return doc;
  const slug = freeSlug(doc.pages, wanted || page.title, pageId);
  if (slug === page.slug) return doc;
  const renamed = { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...p, slug } : p)) };
  return mapLinks(renamed, (l) => (l.type === 'page' && l.value === page.slug ? { type: 'page', value: slug } : l));
}

/** Delete a page; links to it go to the home page. */
export function removePage(doc: SiteDoc, pageId: string): SiteDoc {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return doc;
  const without = { ...doc, pages: doc.pages.filter((p) => p.id !== pageId) };
  return mapLinks(without, (l) => (l.type === 'page' && l.value === page.slug ? { type: 'home' } : l));
}

/** How many links point at a page. */
export function linksToPage(doc: SiteDoc, slug: string): number {
  let n = 0;
  mapLinks(doc, (l) => {
    if (l.type === 'page' && l.value === slug) n++;
    return l;
  });
  return n;
}

// ---------- the sections of a page ----------

export function sectionsOf(doc: SiteDoc, page: PageKey): Section[] {
  if (page === 'home') return doc.home.sections;
  if (page === 'product') return doc.product.sections;
  return doc.pages.find((p) => `page:${p.id}` === page)?.sections ?? [];
}

export function withSections(doc: SiteDoc, page: PageKey, sections: Section[]): SiteDoc {
  if (page === 'home') return { ...doc, home: { sections } };
  if (page === 'product') return { ...doc, product: { ...doc.product, sections } };
  return { ...doc, pages: doc.pages.map((p) => (`page:${p.id}` === page ? { ...p, sections } : p)) };
}

export const pageKind = (page: PageKey): 'home' | 'product' | 'page' => (page === 'home' ? 'home' : page === 'product' ? 'product' : 'page');

/** Move the item at `from` to sit at `to`. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}

/** Every section of the site, wherever it is, through `f` (the same object back means no change). */
export function mapSections(doc: SiteDoc, f: (s: Section) => Section): SiteDoc {
  const list = (sections: Section[]) => {
    const next = sections.map(f);
    return next.some((x, i) => x !== sections[i]) ? next : sections;
  };
  const home = list(doc.home.sections);
  const product = list(doc.product.sections);
  const pages = doc.pages.map((p) => {
    const sections = list(p.sections);
    return sections === p.sections ? p : { ...p, sections };
  });
  const samePages = pages.every((p, i) => p === doc.pages[i]);
  if (home === doc.home.sections && product === doc.product.sections && samePages) return doc;
  return { ...doc, home: home === doc.home.sections ? doc.home : { sections: home }, product: product === doc.product.sections ? doc.product : { ...doc.product, sections: product }, pages: samePages ? doc.pages : pages };
}

/** One text of a section (or of one of its blocks) set to `value`: what typing in the preview does. */
export function setText(doc: SiteDoc, sectionId: string, blockId: string | null, key: string, value: string): SiteDoc {
  return mapSections(doc, (s) => {
    if (s.id !== sectionId) return s;
    if (!blockId) return s.settings[key] === value ? s : { ...s, settings: { ...s.settings, [key]: value } };
    if (!s.blocks.some((b) => b.id === blockId && b.settings[key] !== value)) return s;
    return { ...s, blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, settings: { ...b.settings, [key]: value } } : b)) };
  });
}

/** `section` put after the section with id `after` (at the end when there is none). */
export function insertAfter(sections: Section[], section: Section, after: string | null): Section[] {
  const i = after ? sections.findIndex((s) => s.id === after) : -1;
  return i < 0 ? [...sections, section] : [...sections.slice(0, i + 1), section, ...sections.slice(i + 1)];
}

/** A copy of a section with ids of its own (a duplicate, or a saved section put on a page). */
export function copyOf(section: Section, newId: () => string): Section {
  return { ...structuredClone(section), id: newId(), blocks: section.blocks.map((b) => ({ ...structuredClone(b), id: newId() })) };
}

export const MAX_SAVED = 20;

/** Keep a section to reuse on any page, under a name (the newest first; the oldest go past twenty). */
export function saveSection(doc: SiteDoc, section: Section, name: string, newId: () => string): SiteDoc {
  const saved = { id: newId(), name: name.trim().slice(0, 60) || 'Saved section', section: { ...copyOf(section, newId), hidden: false } };
  return { ...doc, saved: [saved, ...(doc.saved ?? [])].slice(0, MAX_SAVED) };
}

export const forgetSaved = (doc: SiteDoc, id: string): SiteDoc => ({ ...doc, saved: (doc.saved ?? []).filter((x) => x.id !== id) });

// ---------- undo and redo ----------

const MAX_STEPS = 80;
/** Typing in one place within this long is one step of undo. */
const BURST_MS = 1200;

export interface History {
  doc: SiteDoc | null;
  past: SiteDoc[];
  future: SiteDoc[];
  /** Where the last edit was, and when (to join a burst of typing into one step). */
  key: string;
  at: number;
  /** Counts the changes that need saving (edits, undo, redo); loading a site does not count. */
  touched: number;
}

export const EMPTY_HISTORY: History = { doc: null, past: [], future: [], key: '', at: 0, touched: 0 };

export type HistoryAction =
  | { type: 'edit'; next: SiteDoc | ((d: SiteDoc) => SiteDoc); key?: string; at: number }
  | { type: 'undo' }
  | { type: 'redo' }
  /** A site from the server (first load, discard, a restored version). `undoable` keeps the current one a step back. */
  | { type: 'load'; doc: SiteDoc; undoable?: boolean };

export function historyReducer(h: History, action: HistoryAction): History {
  switch (action.type) {
    case 'load':
      return { ...h, doc: action.doc, past: action.undoable && h.doc ? [...h.past.slice(-MAX_STEPS + 1), h.doc] : [], future: [], key: '', at: 0 };
    case 'edit': {
      if (!h.doc) return h;
      const doc = typeof action.next === 'function' ? action.next(h.doc) : action.next;
      if (doc === h.doc) return h;
      const key = action.key ?? '';
      const sameBurst = Boolean(key) && key === h.key && action.at - h.at < BURST_MS;
      return { doc, past: sameBurst ? h.past : [...h.past.slice(-MAX_STEPS + 1), h.doc], future: [], key, at: action.at, touched: h.touched + 1 };
    }
    case 'undo': {
      const previous = h.past[h.past.length - 1];
      if (!previous || !h.doc) return h;
      return { doc: previous, past: h.past.slice(0, -1), future: [h.doc, ...h.future], key: '', at: 0, touched: h.touched + 1 };
    }
    case 'redo': {
      const next = h.future[0];
      if (!next || !h.doc) return h;
      return { doc: next, past: [...h.past, h.doc], future: h.future.slice(1), key: '', at: 0, touched: h.touched + 1 };
    }
  }
}
