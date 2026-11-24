/**
 * The site editor's own logic (web/src/site/doc.ts): page addresses stay
 * unique and typeable, links follow a page that is renamed or deleted, and
 * undo keeps one step per burst of typing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSite, newSection, normalizeSite } from '../src/commerce/site.ts';
import { EMPTY_HISTORY, freeSlug, historyReducer, linksToPage, moved, removePage, setPageSlug, slugify, typingSlug } from '../web/src/site/doc.ts';
import type { SiteDoc } from '../web/src/site/types.ts';

function site(): SiteDoc {
  const base = defaultSite({ name: 'Corner Store', tagline: 'Fresh', about: '', logoAssetId: null, accounts: true });
  const hero = newSection('hero');
  hero.settings.buttonLabel = 'Our story';
  hero.settings.buttonLink = { type: 'page', value: 'about' };
  const columns = newSection('columns');
  columns.blocks[0]!.settings.link = { type: 'page', value: 'about' };
  return normalizeSite({
    ...base,
    header: { ...base.header, announcement: { enabled: true, text: 'Hi', link: { type: 'page', value: 'about' }, style: 'dark' }, menu: [{ label: 'About', link: { type: 'page', value: 'about' }, children: [{ label: 'Contact', link: { type: 'page', value: 'contact' } }] }] },
    footer: { ...base.footer, columns: [{ title: 'Help', links: [{ label: 'About', link: { type: 'page', value: 'about' } }] }] },
    home: { sections: [hero, columns] },
    pages: [{ slug: 'about', title: 'About us', sections: [] }, { slug: 'contact', title: 'Contact', sections: [] }],
  }) as SiteDoc;
}

test('page addresses: made from any text, typeable with hyphens, never two the same', () => {
  assert.equal(slugify('  Envíos y Devoluciones! '), 'envios-y-devoluciones');
  assert.equal(slugify('***'), '');
  assert.equal(typingSlug('about-'), 'about-', 'a hyphen being typed stays');
  assert.equal(typingSlug('About  Us'), 'about-us');
  assert.equal(typingSlug('--x'), 'x');
  const s = site();
  assert.equal(freeSlug(s.pages, 'About'), 'about-2');
  assert.equal(freeSlug(s.pages, 'about', s.pages[0]!.id), 'about', 'a page may keep its own address');
  assert.equal(freeSlug(s.pages, '!!!'), 'page');
});

test('renaming a page: every link to it follows; a taken address gets a number', () => {
  const s = site();
  const about = s.pages[0]!;
  assert.equal(linksToPage(s, 'about'), 5);
  const renamed = setPageSlug(s, about.id, 'Our Story');
  assert.equal(renamed.pages[0]!.slug, 'our-story');
  assert.equal(linksToPage(renamed, 'about'), 0);
  assert.equal(linksToPage(renamed, 'our-story'), 5);
  assert.equal(linksToPage(renamed, 'contact'), 1, 'other links are left alone');
  assert.deepEqual(renamed.home.sections[0]!.settings.buttonLink, { type: 'page', value: 'our-story' });
  assert.deepEqual(renamed.home.sections[1]!.blocks[0]!.settings.link, { type: 'page', value: 'our-story' });
  // The address another page has is not taken from it.
  assert.equal(setPageSlug(s, about.id, 'contact').pages[0]!.slug, 'contact-2');
  // Nothing typed: the address is made from the title. The same address: nothing changes.
  assert.equal(setPageSlug(s, about.id, '').pages[0]!.slug, 'about-us');
  assert.equal(setPageSlug(s, about.id, 'about'), s);
  // What the editor makes, the server keeps as it is.
  assert.deepEqual(normalizeSite(renamed), renamed);
});

test('deleting a page: links to it go to the home page', () => {
  const s = site();
  const without = removePage(s, s.pages[0]!.id);
  assert.deepEqual(without.pages.map((p) => p.slug), ['contact']);
  assert.equal(linksToPage(without, 'about'), 0);
  assert.deepEqual(without.header.menu[0]!.link, { type: 'home' });
  assert.deepEqual(without.header.menu[0]!.children[0]!.link, { type: 'page', value: 'contact' });
  assert.deepEqual(without.header.announcement.link, { type: 'home' });
});

test('undo and redo: one step per burst of typing; loading a site is not a change to save', () => {
  const s = site();
  const title = (doc: SiteDoc, v: string): SiteDoc => ({ ...doc, seo: { ...doc.seo, title: v } });
  let h = historyReducer(EMPTY_HISTORY, { type: 'load', doc: s });
  assert.equal(h.touched, 0);
  // Three keystrokes in one field, close together: one step.
  h = historyReducer(h, { type: 'edit', next: (d) => title(d, 'A'), key: 'seo-title', at: 1000 });
  h = historyReducer(h, { type: 'edit', next: (d) => title(d, 'AB'), key: 'seo-title', at: 1400 });
  h = historyReducer(h, { type: 'edit', next: (d) => title(d, 'ABC'), key: 'seo-title', at: 1900 });
  assert.equal(h.past.length, 1);
  assert.equal(h.touched, 3);
  // Later, or elsewhere: a step of its own.
  h = historyReducer(h, { type: 'edit', next: (d) => title(d, 'ABCD'), key: 'seo-title', at: 9000 });
  h = historyReducer(h, { type: 'edit', next: (d) => ({ ...d, seo: { ...d.seo, description: 'x' } }), key: 'seo-description', at: 9100 });
  assert.equal(h.past.length, 3);
  h = historyReducer(h, { type: 'undo' });
  h = historyReducer(h, { type: 'undo' });
  assert.equal(h.doc!.seo.title, 'ABC');
  h = historyReducer(h, { type: 'undo' });
  assert.equal(h.doc!.seo.title, '');
  assert.equal(historyReducer(h, { type: 'undo' }), h, 'nothing left to undo');
  h = historyReducer(h, { type: 'redo' });
  assert.equal(h.doc!.seo.title, 'ABC');
  // A new edit ends redo.
  h = historyReducer(h, { type: 'edit', next: (d) => title(d, 'Z'), at: 20000 });
  assert.equal(h.future.length, 0);
  // An edit that changes nothing is not a step.
  assert.equal(historyReducer(h, { type: 'edit', next: (d) => d, at: 30000 }), h);
  // A discarded or restored site can be undone back to what was there.
  const before = h.doc;
  const touched = h.touched;
  h = historyReducer(h, { type: 'load', doc: s, undoable: true });
  assert.equal(h.touched, touched);
  h = historyReducer(h, { type: 'undo' });
  assert.equal(h.doc, before);
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moved(['a', 'b'], 0, 5), ['a', 'b']);
});
