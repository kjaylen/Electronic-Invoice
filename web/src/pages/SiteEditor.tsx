/**
 * The site builder: the store's pages (home, product pages, the business's
 * own pages) as sections to add, arrange, hide and edit; the theme (a preset,
 * colours, fonts, shapes, logo); the header and its menu; the footer; and
 * what search engines and link previews show. A live preview of the real
 * storefront follows every change; changes save themselves as a draft, and
 * customers see them once published. Earlier published versions can be
 * brought back.
 */

import { type DragEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, usePageTitle } from '../ui';
import { type EditorCtx, FieldInput, fieldShown, Group, ImageInput, LinkInput } from '../site/editor-fields';
import { copyOf, forgetSaved, freeSlug, insertAfter, linksToPage, MAX_SAVED, moved, type PageKey, pageKind, removePage, saveSection, sectionsOf, setPageSlug, setText, typingSlug, withSections } from '../site/doc';
import { contrast, FONT_FAMILIES, loadFonts } from '../site/theme';
import type { Builder, MenuItem, Section, SectionSchema, SiteDoc, SiteLink, Theme } from '../site/types';
import { useSiteDraft } from '../site/use-draft';

type Tab = 'pages' | 'theme' | 'header' | 'footer' | 'seo';
type Device = 'desktop' | 'tablet' | 'phone';

const newId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

/** What a section is about, for its row in the list. */
function summary(s: Section, schema: SectionSchema | undefined): string {
  const st = s.settings;
  const text = [st.heading, st.title, st.text].find((v) => typeof v === 'string' && v.trim());
  return typeof text === 'string' ? text.slice(0, 60) : schema?.description ?? '';
}

export function SiteEditor() {
  const t = useT();
  const toast = useToast();
  usePageTitle(t('Site'));
  const draft = useSiteDraft();
  const { loaded, doc, update, undo, redo, changed, save } = draft;
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('pages');
  const [page, setPage] = useState<PageKey>('home');
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  // Where a new section goes: undefined (not adding), null (at the end), or after the section with this id.
  const [addAfter, setAddAfter] = useState<string | null | undefined>(undefined);
  const fromPreview = useRef(false);
  const [history, setHistory] = useState(false);
  const [starting, setStarting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [html, setHtml] = useState<Record<string, string>>({});
  const [productHandle, setProductHandle] = useState<string | null | undefined>(undefined);
  const frame = useRef<HTMLIFrameElement>(null);
  const frameReady = useRef(false);

  useEffect(() => {
    if (loaded) loadFonts(loaded.builder.fonts.map((f) => f.key));
  }, [loaded]);
  useEffect(() => {
    if (loaded) void api<{ data: Array<{ handle: string }> }>(`/v1/store/${loaded.slug}/products?limit=1`, { headers: { 'X-Site-Preview': '1' } }).then((r) => setProductHandle(r.data[0]?.handle ?? null)).catch(() => setProductHandle(null));
  }, [loaded]);

  // Ctrl+Z and Ctrl+Y (inside a text box, the browser's own undo of the typing applies instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Custom code sections, rendered by the server for the preview.
  const codeKey = JSON.stringify(doc ? [...doc.home.sections, ...doc.product.sections, ...doc.pages.flatMap((p) => p.sections)].filter((s) => s.type === 'custom_code').map((s) => [s.id, s.settings.code]) : []);
  useEffect(() => {
    const pairs = JSON.parse(codeKey) as Array<[string, string]>;
    if (!pairs.length) return;
    const timer = setTimeout(() => {
      for (const [id, code] of pairs) void api<{ html: string }>('/v1/store-site/render', { method: 'POST', body: { code: code ?? '' } }).then((r) => setHtml((h) => ({ ...h, [id]: r.html }))).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [codeKey]);

  // The preview: the draft (with rendered custom code) goes into the storefront frame.
  const previewDoc = useMemo(() => {
    if (!doc) return null;
    const fill = (sections: Section[]) => sections.map((s) => (s.type === 'custom_code' ? { ...s, settings: { ...s.settings, html: html[s.id] ?? '' } } : s));
    return { ...doc, home: { sections: fill(doc.home.sections) }, product: { ...doc.product, sections: fill(doc.product.sections) }, pages: doc.pages.map((p) => ({ ...p, sections: fill(p.sections) })) };
  }, [doc, html]);
  const post = useCallback((message: unknown) => frame.current?.contentWindow?.postMessage(message, window.location.origin), []);
  useEffect(() => {
    if (frameReady.current && previewDoc) post({ type: 'site-preview', site: previewDoc });
  }, [previewDoc, post]);
  const pathFor = useCallback((p: PageKey): string | null => {
    if (p === 'home') return '/shop';
    if (p === 'product') return productHandle ? `/shop/products/${productHandle}` : null;
    const pg = doc?.pages.find((x) => `page:${x.id}` === p);
    return pg ? `/shop/pages/${pg.slug}` : null;
  }, [doc, productHandle]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const data = e.data as { type?: string; id?: string; path?: string; block?: string | null; key?: string; value?: string; after?: string };
      if (data.type === 'site-ready') {
        frameReady.current = true;
        if (previewDoc) post({ type: 'site-preview', site: previewDoc });
      }
      if (data.type === 'site-select' && data.id) {
        fromPreview.current = true;
        setTab('pages');
        setSelected(data.id);
      }
      if (data.type === 'site-add' && data.after) {
        setTab('pages');
        setAddAfter(data.after);
      }
      // Typed in the preview: only a section's own short texts, cut to their length, as the form would.
      if (data.type === 'site-edit' && data.id && typeof data.key === 'string' && typeof data.value === 'string' && doc && loaded) {
        const section = [...doc.home.sections, ...doc.product.sections, ...doc.pages.flatMap((x) => x.sections)].find((x) => x.id === data.id);
        const schema = section && loaded.builder.sections.find((x) => x.type === section.type);
        const field = (data.block ? schema?.blocks?.fields : schema?.fields)?.find((f) => f.key === data.key);
        if (!section || !field || (field.type !== 'text' && field.type !== 'textarea')) return;
        const { id, key, value } = data as { id: string; key: string; value: string };
        update((d) => setText(d, id, data.block ?? null, key, value.slice(0, field.maxLength ?? 200)), `${data.block ?? id}-${key}`);
      }
      if (data.type === 'site-location' && data.path && doc) {
        // The editor follows the preview to the page shown there.
        if (/^\/shop\/?$/.test(data.path)) setPage('home');
        else if (data.path.startsWith('/shop/products/')) setPage('product');
        else {
          const m = /^\/shop\/pages\/([a-z0-9-]+)/.exec(data.path);
          const pg = m && doc.pages.find((x) => x.slug === m[1]);
          if (pg) setPage(`page:${pg.id}`);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewDoc, post, doc, loaded, update]);
  const goTo = (p: PageKey) => {
    setPage(p);
    setSelected(null);
    const path = pathFor(p);
    if (path) post({ type: 'site-navigate', path });
  };
  // The page being edited is gone (undone, deleted, another version loaded): back to the home page.
  const pageGone = Boolean(doc) && page.startsWith('page:') && !doc!.pages.some((x) => `page:${x.id}` === page);
  useEffect(() => {
    if (!pageGone) return;
    setPage('home');
    setSelected(null);
    post({ type: 'site-navigate', path: '/shop' });
  }, [pageGone, post]);
  useEffect(() => {
    // Chosen in the list: the preview brings it into view. Clicked in the preview: it stays where it is.
    if (selected) post({ type: 'site-highlight', id: selected, scroll: !fromPreview.current });
    fromPreview.current = false;
  }, [selected, post]);

  if (draft.loadError && !doc) return <div className="stack"><h1>{t('Site')}</h1><ErrorText error={draft.loadError} /><div><button type="button" onClick={() => window.location.reload()}>{t('Try again')}</button></div></div>;
  if (!doc || !loaded) return <div className="stack"><h1>{t('Site')}</h1><div className="skeleton" style={{ height: '24rem' }} /></div>;

  const ctx: EditorCtx = { slug: loaded.slug, builder: loaded.builder, site: doc };
  const schemas = new Map(loaded.builder.sections.map((s) => [s.type, s]));
  const sections = sectionsOf(doc, page);
  const current = selected ? sections.find((s) => s.id === selected) ?? null : null;
  const setSections = (next: Section[], key = '') => update((d) => withSections(d, page, next), key);
  const setSection = (id: string, next: Section, key = '') => setSections(sections.map((s) => (s.id === id ? next : s)), key);

  /** One of the editor's actions: its problem is shown, and cleared by the next one that works. */
  const act = async (f: () => Promise<void>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e);
    }
  };
  const publish = async () => {
    setPublishing(true);
    await act(async () => {
      // Whatever is still waiting to be saved goes first; nothing is published that is not saved.
      if (!(await draft.flush())) return;
      await api('/v1/store-site/publish', { method: 'POST', body: {} });
      draft.setChanged(false);
      toast(loaded.store && !loaded.store.open ? t('Published. Customers will see it when you open the store.') : t('Published. Customers see the new site now.'));
    });
    setPublishing(false);
  };
  const discard = () => act(async () => {
    if (!window.confirm(t('Throw away every change since the last publish?'))) return;
    await draft.flush();
    const r = await api<{ draft: SiteDoc; draftUpdatedAt: string | null }>('/v1/store-site/discard', { method: 'POST', body: {} });
    draft.adopt({ ...r, changed: false }, true);
    setSelected(null);
    toast(t('Back to the published site'));
  });

  // Who saved meanwhile, from the server's message ("Ana changed the site while you were editing").
  const conflictName = draft.saveError instanceof ApiError ? / changed the site while you were editing$/.test(draft.saveError.message) && !draft.saveError.message.startsWith('Someone else') ? draft.saveError.message.replace(/ changed the site while you were editing$/, '') : '' : '';
  const pageOptions: Array<[PageKey, string]> = [['home', t('Home page')], ['product', t('Product pages')], ...doc.pages.map((p) => [`page:${p.id}` as PageKey, p.title] as [PageKey, string])];
  const currentPage = page.startsWith('page:') ? doc.pages.find((p) => `page:${p.id}` === page) ?? null : null;

  return (
    <div className="site-editor">
      <header className="se-top">
        <Link to="/settings?tab=store" className="se-back" aria-label={t('Back to store settings')}>←</Link>
        <div className="se-title">
          <h1>{t('Site')}</h1>
          <span className={`se-status ${save}`} role="status">
            {save === 'saving' || save === 'pending' ? t('Saving…') : save === 'error' || save === 'conflict' ? t('Not saved') : changed ? t('Draft: not published yet') : t('Published')}
          </span>
        </div>
        <span className="spacer" />
        <div className="tabs se-devices" role="group" aria-label={t('Preview size')}>
          {([['desktop', t('Computer')], ['tablet', t('Tablet')], ['phone', t('Phone')]] as Array<[Device, string]>).map(([d, l]) => <button key={d} type="button" aria-pressed={device === d} className={device === d ? 'active' : ''} onClick={() => setDevice(d)}>{l}</button>)}
        </div>
        <button type="button" className="secondary" onClick={undo} disabled={!draft.canUndo} aria-label={t('Undo')} title={t('Undo')}>↶</button>
        <button type="button" className="secondary" onClick={redo} disabled={!draft.canRedo} aria-label={t('Redo')} title={t('Redo')}>↷</button>
        <button type="button" className="secondary" onClick={() => setHistory(true)}>{t('History')}</button>
        <a className="button secondary" href={`/${loaded.slug}/shop`} target="_blank" rel="noreferrer">{t('View store')}</a>
        <button type="button" onClick={() => void publish()} disabled={publishing || !changed || save === 'conflict'}>{publishing ? t('Publishing…') : t('Publish')}</button>
      </header>
      {loaded.store && !loaded.store.open && (
        <div className="banner info se-notice" role="note">
          <div><strong>{t('Your store is closed')}</strong>{loaded.store.planAllows ? t('Customers cannot see it yet. Build and publish your site here, then open the store when you are ready.') : t('Your plan does not include the online store. You can build your site here; customers will see it once the store is open.')}</div>
          <Link className="button secondary" to="/settings?tab=store">{t('Open the store')}</Link>
        </div>
      )}
      {save === 'conflict' && (
        <div className="banner warn se-notice" role="alert">
          <div><strong>{conflictName ? t('{name} changed the site while you were editing', { name: conflictName }) : t('Someone else changed the site while you were editing')}</strong>{t('Your changes are not saved yet. Load their version to carry on from it, or keep yours and replace theirs.')}</div>
          <button type="button" className="secondary" onClick={() => void act(draft.loadTheirs)}>{t('Load their version')}</button>
          <button type="button" onClick={() => void act(draft.keepMine)}>{t('Keep mine')}</button>
        </div>
      )}
      {save === 'error' && (
        <div className="banner warn se-notice" role="alert">
          <div><strong>{t('Your last changes are not saved yet')}</strong>{draft.saveError instanceof ApiError && draft.saveError.status !== 0 ? t(draft.saveError.message) : t('Check your connection. Your work is kept on this device and will be saved when the connection returns.')}</div>
          <button type="button" onClick={() => void draft.flush()}>{t('Try again')}</button>
        </div>
      )}
      {draft.backup && (
        <div className="banner se-notice" role="status">
          <div><strong>{t('You have changes that were never saved')}</strong>{t('From {when}, kept on this device.', { when: new Date(draft.backup.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })}</div>
          <button type="button" className="secondary" onClick={draft.dropBackup}>{t('Throw them away')}</button>
          <button type="button" onClick={draft.restoreBackup}>{t('Bring them back')}</button>
        </div>
      )}
      <ErrorText error={error} />
      <div className="se-body">
        <aside className="se-panel" aria-label={t('Site settings')}>
          <div className="tabs se-tabs" role="group" aria-label={t('Edit')}>
            {([['pages', t('Pages')], ['theme', t('Theme')], ['header', t('Header')], ['footer', t('Footer')], ['seo', t('Search')]] as Array<[Tab, string]>).map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>

          {tab === 'pages' && (current ? (
            <SectionEditor
              section={current}
              schema={schemas.get(current.type)}
              ctx={ctx}
              onBack={() => setSelected(null)}
              onChange={(next, key) => setSection(current.id, next, key)}
              onDuplicate={() => {
                const copy = copyOf(current, newId);
                setSections(insertAfter(sections, copy, current.id));
                setSelected(copy.id);
              }}
              onAddBelow={() => setAddAfter(current.id)}
              canSave={(doc.saved?.length ?? 0) < MAX_SAVED}
              onSave={(name) => {
                update((d) => saveSection(d, current, name, newId));
                toast(t('Saved. Find it under “Add section” on any page.'));
              }}
              onDelete={() => {
                setSections(sections.filter((s) => s.id !== current.id));
                setSelected(null);
              }}
            />
          ) : (
            <div className="stack">
              <Field label={t('Page')}>
                <select value={page} onChange={(e) => goTo(e.target.value as PageKey)}>
                  {pageOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
              {!loaded.publishedAt && !draft.canUndo && page === 'home' && (
                <div className="se-welcome">
                  <strong>{t('New here? Start from a ready-made site')}</strong>
                  <span className="small muted">{t('A home page, About and Contact pages, a menu and a look, filled in with your store’s name. Change anything afterwards.')}</span>
                  <button type="button" onClick={() => setStarting(true)}>{t('Choose a starting site')}</button>
                </div>
              )}
              <NewPage templates={loaded.builder.pageTemplates} onAdd={(title, template) => act(async () => {
                const made = template === 'blank' ? { sections: [] as Section[] } : (await api<{ page: { sections: Section[] } }>(`/v1/store-site/page-templates/${template}`, { method: 'POST', body: {} })).page;
                const slug = freeSlug(doc.pages, title);
                const id = newId();
                update((d) => ({ ...d, pages: [...d.pages, { id, slug, title, seoTitle: '', seoDescription: '', sections: made.sections }] }));
                setPage(`page:${id}`);
                setSelected(null);
                setTimeout(() => post({ type: 'site-navigate', path: `/shop/pages/${slug}` }), 150);
              })} />
              {currentPage && <PageSettings key={currentPage.id} page={currentPage} onChange={(next) => update((d) => ({ ...d, pages: d.pages.map((p) => (p.id === next.id ? next : p)) }), `page-${next.id}`)}
                onSlug={(wanted) => {
                  // Links to the page follow its new address; the preview moves there too.
                  const next = setPageSlug(doc, currentPage.id, wanted);
                  const slug = next.pages.find((p) => p.id === currentPage.id)!.slug;
                  if (next !== doc) {
                    update(next);
                    setTimeout(() => post({ type: 'site-navigate', path: `/shop/pages/${slug}` }), 150);
                  }
                  return slug;
                }}
                onDelete={() => {
                  const links = linksToPage(doc, currentPage.slug);
                  if (!window.confirm(links ? t('Delete the page “{title}”? {n} links to it will go to the home page instead.', { title: currentPage.title, n: links }) : t('Delete the page “{title}”?', { title: currentPage.title }))) return;
                  update((d) => removePage(d, currentPage.id));
                  goTo('home');
                }} />}
              {page === 'product' && productHandle === null && <p className="small muted se-empty" style={{ margin: 0 }}>{t('Add a product to see product pages in the preview.')} <Link to="/products">{t('Products')}</Link></p>}
              {page === 'product' && (
                <Group title={t('Every product page')}>
                  <p className="small muted" style={{ margin: 0 }}>{t('Sections here appear under every product, after its photos, price and description.')}</p>
                  <label className="row toggle se-toggle"><input type="checkbox" checked={doc.product.showRelated} onChange={(e) => update((d) => ({ ...d, product: { ...d.product, showRelated: e.target.checked } }))} /> {t('Show related products')}</label>
                  {doc.product.showRelated && <Field label={t('Their title')}><input maxLength={80} value={doc.product.relatedTitle} onChange={(e) => update((d) => ({ ...d, product: { ...d.product, relatedTitle: e.target.value } }), 'related-title')} /></Field>}
                </Group>
              )}
              <SectionList sections={sections} schemas={schemas} onSelect={setSelected} onChange={setSections} />
              <button type="button" onClick={() => setAddAfter(null)}>+ {t('Add section')}</button>
              {page === 'home' && <div><button type="button" className="link small" onClick={() => setStarting(true)}>{t('Start again from a ready-made site')}</button></div>}
            </div>
          ))}

          {tab === 'theme' && <ThemePanel theme={doc.theme} builder={loaded.builder} ctx={ctx} onChange={(theme, key) => update((d) => ({ ...d, theme }), key)} />}
          {tab === 'header' && <HeaderPanel doc={doc} ctx={ctx} onChange={(header, key) => update((d) => ({ ...d, header }), key)} />}
          {tab === 'footer' && <FooterPanel doc={doc} ctx={ctx} onChange={(next, key) => update((d) => ({ ...d, ...next }), key)} />}
          {tab === 'seo' && (
            <div className="stack">
              <p className="small muted" style={{ margin: 0 }}>{t('What search engines and link previews (WhatsApp, Facebook) show for your store’s home page.')}</p>
              <Field label={t('Title')} hint={t('Leave empty to use your store name and tagline.')}><input maxLength={120} value={doc.seo.title} onChange={(e) => update((d) => ({ ...d, seo: { ...d.seo, title: e.target.value } }), 'seo-title')} /></Field>
              <Field label={t('Description')} hint={t('One or two sentences, up to about 160 characters.')}><textarea rows={3} maxLength={300} value={doc.seo.description} onChange={(e) => update((d) => ({ ...d, seo: { ...d.seo, description: e.target.value } }), 'seo-description')} /></Field>
              <ImageInput label={t('Picture for link previews')} value={doc.seo.image} ctx={ctx} onChange={(v) => update((d) => ({ ...d, seo: { ...d.seo, image: v } }))} />
              <div className="se-serp">
                <span className="se-serp-url">{window.location.host}/{loaded.slug}/shop</span>
                <strong>{doc.seo.title || doc.home.sections.find((s) => s.type === 'hero')?.settings.heading as string || loaded.slug}</strong>
                <span className="small">{doc.seo.description || t('Your store’s description shows here.')}</span>
              </div>
            </div>
          )}

          <div className="se-panel-foot small">
            {changed && <button type="button" className="link small" onClick={() => void discard()}>{t('Discard changes')}</button>}
          </div>
        </aside>
        <div className="se-stage">
          <div className={`se-frame device-${device}`}>
            <iframe ref={frame} src={`/${loaded.slug}/shop?site-preview`} title={t('Preview of your store')} />
          </div>
        </div>
      </div>

      {addAfter !== undefined && <AddSection schemas={loaded.builder.sections} saved={doc.saved ?? []} kind={pageKind(page)} onClose={() => setAddAfter(undefined)}
        onForget={(id) => update((d) => forgetSaved(d, id))}
        onAdd={async (type, saved) => {
          const section = saved ? copyOf(saved, newId) : (await api<{ section: Section }>('/v1/store-site/sections', { method: 'POST', body: { type } })).section;
          setSections(insertAfter(sections, section, addAfter));
          setAddAfter(undefined);
          setSelected(section.id);
        }} />}
      {starting && <StarterDialog builder={loaded.builder} onClose={() => setStarting(false)} onPick={async (key) => {
        const r = await api<{ site: SiteDoc }>(`/v1/store-site/starters/${key}`, { method: 'POST', body: {} });
        update(r.site);
        setStarting(false);
        setTab('pages');
        goTo('home');
        toast(t('Your new site is ready to edit. Undo brings the old one back.'));
      }} />}
      {history && <HistoryDialog beforeRestore={draft.flush} onClose={() => setHistory(false)} onRestored={(r) => {
        draft.adopt(r, true);
        setHistory(false);
        setSelected(null);
        toast(t('That version is your draft now. Publish it to bring it back.'));
      }} />}
    </div>
  );
}

// ---------- the sections of a page ----------

/**
 * Drag to reorder a list (with a mouse; the arrows beside each row do the same by keyboard and touch).
 * `row(i)` gives a row its drag handlers and whether something is being dropped on it.
 */
function useDragOrder(onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  return (i: number, enabled = true) => ({
    draggable: enabled,
    dropTarget: over === i && dragging !== null && dragging !== i,
    handlers: {
      onDragStart: (e: DragEvent) => { e.stopPropagation(); setDragging(i); e.dataTransfer.effectAllowed = 'move'; },
      onDragOver: (e: DragEvent) => { if (dragging === null) return; e.preventDefault(); e.stopPropagation(); setOver(i); },
      onDragEnd: (e: DragEvent) => { e.stopPropagation(); end(); },
      onDrop: (e: DragEvent) => { if (dragging === null) return; e.preventDefault(); e.stopPropagation(); onMove(dragging, i); end(); },
    },
  });
}

function SectionList({ sections, schemas, onSelect, onChange }: { sections: Section[]; schemas: Map<string, SectionSchema>; onSelect: (id: string) => void; onChange: (s: Section[]) => void }) {
  const t = useT();
  const move = (from: number, to: number) => {
    const next = moved(sections, from, to);
    if (next !== sections) onChange(next);
  };
  const row = useDragOrder(move);
  if (!sections.length) return <div className="se-empty small muted">{t('No sections on this page yet. Add one below.')}</div>;
  return (
    <ol className="se-sections" aria-label={t('Sections, top to bottom')}>
      {sections.map((s, i) => {
        const schema = schemas.get(s.type);
        const drag = row(i);
        return (
          <li key={s.id} draggable className={`${s.hidden ? 'hidden-section' : ''} ${drag.dropTarget ? 'drop-target' : ''}`} {...drag.handlers}>
            <span className="se-handle" aria-hidden="true">⋮⋮</span>
            <button type="button" className="se-section-main" onClick={() => onSelect(s.id)}>
              <strong>{schema ? t(schema.name) : s.type}</strong>
              <span className="small muted">{summary(s, schema)}</span>
            </button>
            <button type="button" className="link small se-eye" onClick={() => onChange(sections.map((x) => (x.id === s.id ? { ...x, hidden: !x.hidden } : x)))} aria-label={s.hidden ? t('Show') : t('Hide')} aria-pressed={!s.hidden} title={s.hidden ? t('Hidden from customers. Show it') : t('Customers see it. Hide it')}><EyeIcon off={s.hidden} /></button>
            <button type="button" className="link small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t('Move up')}>↑</button>
            <button type="button" className="link small" disabled={i === sections.length - 1} onClick={() => move(i, i + 1)} aria-label={t('Move down')}>↓</button>
          </li>
        );
      })}
    </ol>
  );
}

/** An eye, or an eye struck through: shown to customers, or hidden. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.4" />
      {off && <path d="M3.5 3.5 16.5 16.5" />}
    </svg>
  );
}

function SectionEditor({ section, schema, ctx, onBack, onChange, onDuplicate, onDelete, onAddBelow, onSave, canSave }: {
  section: Section; schema: SectionSchema | undefined; ctx: EditorCtx;
  onBack: () => void; onChange: (s: Section, key: string) => void; onDuplicate: () => void; onDelete: () => void;
  onAddBelow: () => void; onSave: (name: string) => void; canSave: boolean;
}) {
  const t = useT();
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  if (!schema) return <div className="stack"><button type="button" className="link" onClick={onBack}>← {t('Sections')}</button><p className="muted">{t('This section type is no longer available.')}</p></div>;
  const set = (key: string, value: unknown) => onChange({ ...section, settings: { ...section.settings, [key]: value } }, `${section.id}-${key}`);
  const blocks = section.blocks;
  const setBlocks = (next: Section['blocks'], key = '') => onChange({ ...section, blocks: next }, key);
  const moveBlock = (i: number, d: number) => setBlocks(moved(blocks, i, i + d));
  const blockRow = useDragOrder((from, to) => setBlocks(moved(blocks, from, to)));
  return (
    <div className="stack se-section-editor">
      <div className="row">
        <button type="button" className="link" onClick={onBack}>← {t('Sections')}</button>
        <span className="spacer" />
        <label className="row small se-toggle"><input type="checkbox" checked={!section.hidden} onChange={(e) => onChange({ ...section, hidden: !e.target.checked }, '')} /> {t('Visible')}</label>
      </div>
      <div>
        <h2 className="se-heading">{t(schema.name)}</h2>
        <p className="small muted" style={{ margin: 0 }}>{t(schema.description)}</p>
      </div>
      {schema.fields.filter((f) => fieldShown(f, section.settings)).map((f) => <FieldInput key={f.key} field={f} value={section.settings[f.key]} ctx={ctx} onChange={(v) => set(f.key, v)} />)}
      {schema.blocks && (
        <div className="stack se-blocks">
          <span className="field-label">{t(schema.blocks.label)} ({blocks.length}/{schema.blocks.max})</span>
          {blocks.map((b, i) => {
            const title = [b.settings.title, b.settings.heading, b.settings.question, b.settings.author, b.settings.days].find((v) => typeof v === 'string' && v) as string | undefined;
            // Dragged by its row while closed (open, its text boxes need the mouse for selecting).
            const drag = blockRow(i, openBlock !== b.id);
            return (
              <div key={b.id} className={`se-block ${openBlock === b.id ? 'open' : ''} ${drag.dropTarget ? 'drop-target' : ''}`} draggable={drag.draggable} {...drag.handlers}>
                <div className="row se-block-head">
                  {drag.draggable && <span className="se-handle" aria-hidden="true">⋮⋮</span>}
                  <button type="button" className="link se-block-title" onClick={() => setOpenBlock((o) => (o === b.id ? null : b.id))}>{title || `${t(schema.blocks!.label)} ${i + 1}`}</button>
                  <span className="spacer" />
                  <button type="button" className="link small" disabled={i === 0} onClick={() => moveBlock(i, -1)} aria-label={t('Move up')}>↑</button>
                  <button type="button" className="link small" disabled={i === blocks.length - 1} onClick={() => moveBlock(i, 1)} aria-label={t('Move down')}>↓</button>
                  <button type="button" className="link small" onClick={() => setBlocks(blocks.filter((x) => x.id !== b.id))} aria-label={t('Remove')}>✕</button>
                </div>
                {openBlock === b.id && (
                  <div className="stack">
                    {schema.blocks!.fields.map((f) => <FieldInput key={f.key} field={f} value={b.settings[f.key]} ctx={ctx} onChange={(v) => setBlocks(blocks.map((x) => (x.id === b.id ? { ...x, settings: { ...x.settings, [f.key]: v } } : x)), `${b.id}-${f.key}`)} />)}
                  </div>
                )}
              </div>
            );
          })}
          {blocks.length < schema.blocks.max && (
            <button type="button" className="secondary" onClick={() => {
              const id = newId();
              setBlocks([...blocks, { id, settings: Object.fromEntries(schema.blocks!.fields.map((f) => [f.key, f.default ?? ''])) }]);
              setOpenBlock(id);
            }}>+ {t('Add {item}', { item: t(schema.blocks.label).toLowerCase() })}</button>
          )}
        </div>
      )}
      {saving !== null && (
        <form className="stack se-new-page" onSubmit={(e) => { e.preventDefault(); onSave(saving); setSaving(null); }}>
          <Field label={t('Name for the saved section')} hint={t('Saved sections can be added to any page, as a copy to change freely.')}><input autoFocus maxLength={60} value={saving} onChange={(e) => setSaving(e.target.value)} /></Field>
          <div className="row">
            <button type="submit" disabled={!saving.trim()}>{t('Save')}</button>
            <button type="button" className="link" onClick={() => setSaving(null)}>{t('Cancel')}</button>
          </div>
        </form>
      )}
      <div className="row se-section-actions">
        <button type="button" className="secondary" onClick={onDuplicate}>{t('Duplicate')}</button>
        <button type="button" className="secondary" onClick={onAddBelow}>{t('Add below')}</button>
        {saving === null && <button type="button" className="secondary" disabled={!canSave} title={canSave ? undefined : t('Up to {n} saved sections. Remove one under “Add section” first.', { n: MAX_SAVED })} onClick={() => setSaving(String(section.settings.heading || section.settings.title || t(schema.name)).slice(0, 60))}>{t('Save for reuse')}</button>}
        <span className="spacer" />
        <button type="button" className="link danger-link" onClick={() => { if (window.confirm(t('Remove this section?'))) onDelete(); }}>{t('Remove section')}</button>
      </div>
    </div>
  );
}

function AddSection({ schemas, saved, kind, onAdd, onForget, onClose }: {
  schemas: SectionSchema[]; saved: NonNullable<SiteDoc['saved']>; kind: 'home' | 'page' | 'product';
  onAdd: (type: string, saved?: Section) => Promise<void>; onForget: (id: string) => void; onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const matches = (text: string) => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase());
  const shown = schemas.filter((s) => (!s.pages || s.pages.includes(kind)) && matches(`${t(s.name)} ${t(s.description)}`));
  const name = (type: string) => t(schemas.find((x) => x.type === type)?.name ?? type);
  const kept = saved.filter((x) => matches(`${x.name} ${name(x.section.type)}`));
  const add = (key: string, type: string, section?: Section) => {
    setBusy(key);
    setError(null);
    void onAdd(type, section).catch(setError).finally(() => setBusy(null));
  };
  return (
    <Modal title={t('Add a section')} onClose={onClose} wide>
      <div className="stack">
        <input type="search" autoFocus placeholder={t('Search sections')} aria-label={t('Search sections')} value={q} onChange={(e) => setQ(e.target.value)} />
        <ErrorText error={error} />
        {kept.length > 0 && (
          <div className="stack" style={{ gap: '0.4rem' }}>
            <span className="field-label">{t('Your saved sections')}</span>
            <ul className="se-list">
              {kept.map((x) => (
                <li key={x.id}>
                  <span className="grow"><strong>{x.name}</strong> <span className="small muted">{name(x.section.type)}</span></span>
                  <button type="button" className="secondary" disabled={busy !== null} onClick={() => add(x.id, x.section.type, x.section)}>{t('Add')}</button>
                  <button type="button" className="link small" onClick={() => { if (window.confirm(t('Remove “{name}” from your saved sections? Pages that use it keep their copy.', { name: x.name }))) onForget(x.id); }} aria-label={t('Remove {name}', { name: x.name })}>✕</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {shown.length === 0 && kept.length === 0 && <div className="empty">{t('No section matches “{q}”.', { q: q.trim() })}</div>}
        <div className="se-gallery">
          {shown.map((s) => (
            <button key={s.type} type="button" className="se-gallery-item" disabled={busy !== null} onClick={() => add(s.type, s.type)}>
              <span className={`se-gallery-art art-${s.type}`} aria-hidden="true" />
              <strong>{t(s.name)}</strong>
              <span className="small muted">{t(s.description)}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ---------- pages ----------

function NewPage({ templates, onAdd }: { templates: Builder['pageTemplates']; onAdd: (title: string, template: string) => Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState('blank');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = templates.find((x) => x.key === template);
  // The template's own title, until another is typed.
  const name = title.trim() || (chosen?.title ? t(chosen.title) : '');
  if (!open) return <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>+ {t('New page')}</button>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name || busy) return;
    setBusy(true);
    void onAdd(name, template).finally(() => {
      setBusy(false);
      setTitle('');
      setOpen(false);
    });
  };
  return (
    <form className="stack se-new-page" onSubmit={submit}>
      <Field label={t('Start from')} hint={chosen ? t(chosen.description) : undefined}>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((x) => <option key={x.key} value={x.key}>{t(x.name)}</option>)}
        </select>
      </Field>
      <Field label={t('Page title')}><input autoFocus placeholder={chosen?.title ? t(chosen.title) : t('e.g. About us, Shipping, FAQ')} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div className="row">
        <button type="submit" disabled={!name || busy}>{busy ? t('Adding…') : t('Add')}</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>{t('Cancel')}</button>
      </div>
    </form>
  );
}

/** Ready-made sites: pick one, and the home page, menu, footer and look become its; own pages and the logo stay. */
function StarterDialog({ builder, onPick, onClose }: { builder: Builder; onPick: (key: string) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pick = (key: string, name: string) => {
    if (!window.confirm(t('Use the {name} site? Your home page, menu, footer and look are replaced. Your logo and the pages you made stay. You can undo this.', { name }))) return;
    setBusy(key);
    setError(null);
    void onPick(key).catch(setError).finally(() => setBusy(null));
  };
  return (
    <Modal title={t('Start from a ready-made site')} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('Each one is a complete site written for a kind of business, with your store’s name filled in. Nothing reaches customers until you publish.')}</p>
        <ErrorText error={error} />
        <div className="se-starters">
          {builder.starters.map((s) => {
            const look = builder.presets.find((x) => x.key === s.preset)?.theme;
            return (
              <button key={s.key} type="button" className="se-starter" disabled={busy !== null} onClick={() => pick(s.key, t(s.name))}>
                {look && (
                  <span className="se-starter-art" aria-hidden="true" style={{ background: look.colors.background, color: look.colors.text, fontFamily: FONT_FAMILIES[look.fonts.heading] }}>
                    <span className="se-starter-bar" style={{ background: look.colors.surface }} />
                    <span className="se-starter-title" style={{ textTransform: look.headingCase === 'upper' ? 'uppercase' : 'none' }}>{t(s.name)}</span>
                    <span className="se-starter-button" style={{ background: look.buttons === 'outline' ? 'transparent' : look.colors.primary, color: look.buttons === 'outline' ? look.colors.text : look.colors.primaryText, border: `1px solid ${look.colors.primary}`, borderRadius: look.buttons === 'pill' ? 999 : look.radius === 'none' ? 0 : 6 }} />
                    <span className="se-starter-row">{[0, 1, 2, 3].map((i) => <span key={i} style={{ background: look.colors.surface, borderRadius: look.radius === 'none' ? 0 : 4 }} />)}</span>
                  </span>
                )}
                <strong>{busy === s.key ? t('Making your site…') : t(s.name)}</strong>
                <span className="small muted">{t(s.description)}</span>
                <span className="small">{s.includes.map((i) => t(i)).join(' · ')}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

function PageSettings({ page, onChange, onSlug, onDelete }: { page: SiteDoc['pages'][number]; onChange: (p: SiteDoc['pages'][number]) => void; onSlug: (wanted: string) => string; onDelete: () => void }) {
  const t = useT();
  // The address is typed freely and takes effect on leaving the box (made valid, never one another page has).
  const [slug, setSlug] = useState(page.slug);
  useEffect(() => setSlug(page.slug), [page.slug]);
  const commit = () => setSlug(onSlug(slug));
  return (
    <Group title={t('Page settings')} open={false}>
      <Field label={t('Title')}><input maxLength={120} value={page.title} onChange={(e) => onChange({ ...page, title: e.target.value })} /></Field>
      <Field label={t('Address')} hint={`/shop/pages/${slug || page.slug} · ${t('Links to this page follow when you change it.')}`}>
        <input value={slug} spellCheck={false} autoCapitalize="none" onChange={(e) => setSlug(typingSlug(e.target.value))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      </Field>
      <Field label={t('Search title')} hint={t('Optional.')}><input maxLength={120} value={page.seoTitle} onChange={(e) => onChange({ ...page, seoTitle: e.target.value })} /></Field>
      <Field label={t('Search description')} hint={t('Optional.')}><textarea rows={2} maxLength={300} value={page.seoDescription} onChange={(e) => onChange({ ...page, seoDescription: e.target.value })} /></Field>
      <button type="button" className="link danger-link small" style={{ alignSelf: 'flex-start' }} onClick={onDelete}>{t('Delete this page')}</button>
    </Group>
  );
}

// ---------- theme ----------

const COLOR_LABELS: Array<[keyof Theme['colors'], string]> = [['background', 'Background'], ['surface', 'Panels'], ['text', 'Text'], ['primary', 'Brand (buttons, links)'], ['primaryText', 'Text on buttons'], ['accent', 'Accent (sale badges)']];
const OPTION_LABELS: Record<string, Record<string, string>> = {
  radius: { none: 'Square', small: 'Slight', medium: 'Rounded', large: 'Very round' },
  buttons: { solid: 'Solid', outline: 'Outline', pill: 'Pill' },
  cards: { plain: 'Plain', bordered: 'Border', shadow: 'Shadow' },
  imageShape: { square: 'Square', portrait: 'Tall', landscape: 'Wide' },
  width: { narrow: 'Narrow', normal: 'Normal', wide: 'Wide' },
  spacing: { compact: 'Compact', normal: 'Normal', airy: 'Airy' },
  headerLayout: { left: 'Logo left', center: 'Logo centred' },
  headerStyle: { light: 'Light', brand: 'Brand colour', dark: 'Dark' },
  headingCase: { normal: 'Normal', upper: 'CAPITALS' },
};
const OPTION_TITLES: Record<string, string> = { radius: 'Corners', buttons: 'Buttons', cards: 'Product cards', imageShape: 'Product pictures', width: 'Page width', spacing: 'Spacing', headerLayout: 'Header', headerStyle: 'Header colour', headingCase: 'Headings' };

function ThemePanel({ theme, builder, ctx, onChange }: { theme: Theme; builder: Builder; ctx: EditorCtx; onChange: (t: Theme, key?: string) => void }) {
  const t = useT();
  const c = theme.colors;
  const textContrast = contrast(c.text, c.background);
  const buttonContrast = contrast(c.primaryText, c.primary);
  const fontName = (k: string) => builder.fonts.find((f) => f.key === k)?.name ?? k;
  return (
    <div className="stack">
      <Group title={t('Start from a look')}>
        <div className="se-presets">
          {builder.presets.map((p) => (
            <button key={p.key} type="button" className={`se-preset ${theme.preset === p.key ? 'active' : ''}`} aria-pressed={theme.preset === p.key}
              onClick={() => { if (theme.preset === p.key || window.confirm(t('Use the {name} look? Your colours, fonts and shapes change; your logo and content stay.', { name: t(p.name) }))) onChange({ ...p.theme, logo: theme.logo, logoHeight: theme.logoHeight, favicon: theme.favicon }); }}>
              <span className="se-swatches" aria-hidden="true">{(['background', 'primary', 'accent', 'text'] as const).map((k) => <span key={k} style={{ background: p.theme.colors[k] }} />)}</span>
              <strong style={{ fontFamily: FONT_FAMILIES[p.theme.fonts.heading] }}>{t(p.name)}</strong>
              <span className="small muted">{t(p.description)}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title={t('Logo')}>
        <ImageInput label={t('Logo')} value={theme.logo} ctx={ctx} onChange={(v) => onChange({ ...theme, logo: v })} />
        {theme.logo && <Field label={t('Logo height: {n} px', { n: theme.logoHeight })}><input type="range" min={20} max={96} value={theme.logoHeight} onChange={(e) => onChange({ ...theme, logoHeight: Number(e.target.value) }, 'logo-height')} /></Field>}
        <ImageInput label={t('Browser tab icon')} value={theme.favicon} ctx={ctx} onChange={(v) => onChange({ ...theme, favicon: v })} />
      </Group>
      <Group title={t('Colours')}>
        <div className="se-colors">
          {COLOR_LABELS.map(([k, label]) => (
            <label key={k} className="se-color">
              <input type="color" value={c[k]} onChange={(e) => onChange({ ...theme, colors: { ...c, [k]: e.target.value } }, `color-${k}`)} />
              <span className="stack" style={{ gap: 0 }}><span className="small">{t(label)}</span><input className="mono small" aria-label={t(label)} value={c[k]} maxLength={7} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && onChange({ ...theme, colors: { ...c, [k]: e.target.value.toLowerCase() } }, `color-${k}`)} /></span>
            </label>
          ))}
        </div>
        {textContrast < 4.5 && <p className="small late" role="alert">{t('Text and background are hard to read together (contrast {n}:1; aim for 4.5:1).', { n: textContrast.toFixed(1) })}</p>}
        {buttonContrast < 4.5 && <p className="small late" role="alert">{t('Button text is hard to read on the brand colour (contrast {n}:1; aim for 4.5:1).', { n: buttonContrast.toFixed(1) })}</p>}
      </Group>
      <Group title={t('Fonts')}>
        {(['heading', 'body'] as const).map((k) => (
          <Field key={k} label={k === 'heading' ? t('Headings') : t('Text')}>
            <select value={theme.fonts[k]} onChange={(e) => onChange({ ...theme, fonts: { ...theme.fonts, [k]: e.target.value } })} style={{ fontFamily: FONT_FAMILIES[theme.fonts[k]] }}>
              {builder.fonts.map((f) => <option key={f.key} value={f.key} style={{ fontFamily: f.family }}>{f.name}</option>)}
            </select>
          </Field>
        ))}
        <div className="se-font-sample">
          <strong style={{ fontFamily: FONT_FAMILIES[theme.fonts.heading], textTransform: theme.headingCase === 'upper' ? 'uppercase' : 'none' }}>{fontName(theme.fonts.heading)}</strong>
          <span style={{ fontFamily: FONT_FAMILIES[theme.fonts.body] }}>{t('Fresh coffee, roasted in San Ignacio and delivered to your door.')}</span>
        </div>
      </Group>
      <Group title={t('Shapes and layout')}>
        {(Object.keys(OPTION_LABELS) as Array<keyof typeof OPTION_LABELS>).map((k) => (
          <div key={k} className="se-choice">
            <span className="field-label">{t(OPTION_TITLES[k]!)}</span>
            <div className="tabs" role="group" aria-label={t(OPTION_TITLES[k]!)}>
              {(builder.themeOptions[k] ?? []).map((v) => <button key={v} type="button" aria-pressed={theme[k as keyof Theme] === v} className={theme[k as keyof Theme] === v ? 'active' : ''} onClick={() => onChange({ ...theme, [k]: v })}>{t(OPTION_LABELS[k]![v] ?? v)}</button>)}
            </div>
          </div>
        ))}
      </Group>
    </div>
  );
}

// ---------- header and footer ----------

function MenuEditor({ items, ctx, onChange, depth = 0, max = 12 }: { items: MenuItem[]; ctx: EditorCtx; onChange: (m: MenuItem[], key?: string) => void; depth?: number; max?: number }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const move = (i: number, d: number) => onChange(moved(items, i, i + d));
  const row = useDragOrder((from, to) => onChange(moved(items, from, to)));
  return (
    <div className="stack se-menu">
      {items.map((m, i) => (
        <div key={m.id} className={`se-block ${open === m.id ? 'open' : ''} ${row(i).dropTarget ? 'drop-target' : ''}`} draggable={open !== m.id} {...row(i).handlers}>
          <div className="row se-block-head">
            {open !== m.id && <span className="se-handle" aria-hidden="true">⋮⋮</span>}
            <button type="button" className="link se-block-title" onClick={() => setOpen((o) => (o === m.id ? null : m.id))}>{m.label || t('Link')}{m.children.length > 0 && <span className="muted small"> · {t('{n} below', { n: m.children.length })}</span>}</button>
            <span className="spacer" />
            <button type="button" className="link small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move up')}>↑</button>
            <button type="button" className="link small" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={t('Move down')}>↓</button>
            <button type="button" className="link small" onClick={() => onChange(items.filter((x) => x.id !== m.id))} aria-label={t('Remove')}>✕</button>
          </div>
          {open === m.id && (
            <div className="stack">
              <Field label={t('Text')}><input maxLength={60} value={m.label} onChange={(e) => onChange(items.map((x) => (x.id === m.id ? { ...x, label: e.target.value } : x)), `menu-${m.id}`)} /></Field>
              <LinkInput label={t('Goes to')} value={m.link} ctx={ctx} onChange={(link: SiteLink) => onChange(items.map((x) => (x.id === m.id ? { ...x, link } : x)))} />
              {depth === 0 && (
                <div className="se-submenu">
                  <span className="field-label">{t('Drop-down links')}</span>
                  <MenuEditor items={m.children} ctx={ctx} depth={1} onChange={(children, key) => onChange(items.map((x) => (x.id === m.id ? { ...x, children } : x)), key)} />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {items.length < max && <button type="button" className="secondary" onClick={() => { const id = newId(); onChange([...items, { id, label: t('New link'), link: { type: 'catalog' }, children: [] }]); setOpen(id); }}>+ {depth ? t('Add a drop-down link') : t('Add a link')}</button>}
    </div>
  );
}

function HeaderPanel({ doc, ctx, onChange }: { doc: SiteDoc; ctx: EditorCtx; onChange: (h: SiteDoc['header'], key?: string) => void }) {
  const t = useT();
  const h = doc.header;
  const a = h.announcement;
  return (
    <div className="stack">
      <Group title={t('Announcement bar')}>
        <label className="row toggle se-toggle"><input type="checkbox" checked={a.enabled} onChange={(e) => onChange({ ...h, announcement: { ...a, enabled: e.target.checked } })} /> {t('Show a message above the header')}</label>
        {a.enabled && (
          <>
            <Field label={t('Message')}><input maxLength={200} value={a.text} placeholder={t('Free delivery in town this week')} onChange={(e) => onChange({ ...h, announcement: { ...a, text: e.target.value } }, 'announcement')} /></Field>
            <label className="row small se-toggle"><input type="checkbox" checked={Boolean(a.link)} onChange={(e) => onChange({ ...h, announcement: { ...a, link: e.target.checked ? { type: 'catalog' } : null } })} /> {t('Make it a link')}</label>
            {a.link && <LinkInput label={t('Goes to')} value={a.link} ctx={ctx} onChange={(link) => onChange({ ...h, announcement: { ...a, link } })} />}
            <div className="se-choice">
              <span className="field-label">{t('Colour')}</span>
              <div className="tabs" role="group" aria-label={t('Colour')}>
                {([['primary', t('Brand colour')], ['accent', t('Accent colour')], ['dark', t('Dark')]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={a.style === k} className={a.style === k ? 'active' : ''} onClick={() => onChange({ ...h, announcement: { ...a, style: k } })}>{l}</button>)}
              </div>
            </div>
          </>
        )}
      </Group>
      <Group title={t('Menu')}>
        <p className="small muted" style={{ margin: 0 }}>{t('Links in the header. On phones they open from the menu button. A link can have drop-down links under it.')}</p>
        <MenuEditor items={h.menu} ctx={ctx} onChange={(menu, key) => onChange({ ...h, menu }, key)} />
      </Group>
      <Group title={t('Behaviour')}>
        <label className="row toggle se-toggle"><input type="checkbox" checked={h.sticky} onChange={(e) => onChange({ ...h, sticky: e.target.checked })} /> {t('Keep the header at the top while scrolling')}</label>
        <label className="row toggle se-toggle"><input type="checkbox" checked={h.showSearch} onChange={(e) => onChange({ ...h, showSearch: e.target.checked })} /> {t('Search button')}</label>
      </Group>
    </div>
  );
}

const SOCIAL_LABELS: Array<[keyof SiteDoc['social'], string, string]> = [['facebook', 'Facebook', 'https://facebook.com/…'], ['instagram', 'Instagram', 'https://instagram.com/…'], ['tiktok', 'TikTok', 'https://tiktok.com/@…'], ['youtube', 'YouTube', 'https://youtube.com/@…'], ['x', 'X', 'https://x.com/…']];

function FooterPanel({ doc, ctx, onChange }: { doc: SiteDoc; ctx: EditorCtx; onChange: (d: Partial<SiteDoc>, key?: string) => void }) {
  const t = useT();
  const f = doc.footer;
  return (
    <div className="stack">
      <Group title={t('About')}>
        <Field label={t('Text')} hint={t('A few words about the store. **bold**, *italics* and [links](https://…) work.')}><textarea rows={4} maxLength={600} value={f.text} onChange={(e) => onChange({ footer: { ...f, text: e.target.value } }, 'footer-text')} /></Field>
        <label className="row toggle se-toggle"><input type="checkbox" checked={f.showContact} onChange={(e) => onChange({ footer: { ...f, showContact: e.target.checked } })} /> {t('Phone, email and WhatsApp')}</label>
        <label className="row toggle se-toggle"><input type="checkbox" checked={f.showPayments} onChange={(e) => onChange({ footer: { ...f, showPayments: e.target.checked } })} /> {t('Ways to pay')}</label>
        <label className="row toggle se-toggle"><input type="checkbox" checked={f.showSocial} onChange={(e) => onChange({ footer: { ...f, showSocial: e.target.checked } })} /> {t('Social media links')}</label>
      </Group>
      <Group title={t('Link columns')}>
        {f.columns.map((col, i) => (
          <div key={col.id} className="se-block open">
            <div className="row se-block-head">
              <input aria-label={t('Column title')} maxLength={60} value={col.title} placeholder={t('Column title')} onChange={(e) => onChange({ footer: { ...f, columns: f.columns.map((c) => (c.id === col.id ? { ...c, title: e.target.value } : c)) } }, `col-${col.id}`)} />
              <button type="button" className="link small" onClick={() => onChange({ footer: { ...f, columns: f.columns.filter((c) => c.id !== col.id) } })} aria-label={t('Remove column {n}', { n: i + 1 })}>✕</button>
            </div>
            <MenuEditor items={col.links} ctx={ctx} depth={1} onChange={(links, key) => onChange({ footer: { ...f, columns: f.columns.map((c) => (c.id === col.id ? { ...c, links } : c)) } }, key)} />
          </div>
        ))}
        {f.columns.length < 4 && <button type="button" className="secondary" onClick={() => onChange({ footer: { ...f, columns: [...f.columns, { id: newId(), title: t('Help'), links: [] }] } })}>+ {t('Add a column')}</button>}
      </Group>
      <Group title={t('Social media')}>
        {SOCIAL_LABELS.map(([k, label, placeholder]) => (
          <Field key={k} label={label}><input type="url" placeholder={placeholder} value={doc.social[k]} onChange={(e) => onChange({ social: { ...doc.social, [k]: e.target.value.trim() } }, `social-${k}`)} /></Field>
        ))}
        <p className="small muted" style={{ margin: 0 }}>{t('Full addresses starting with https://. WhatsApp comes from your store settings.')}</p>
      </Group>
    </div>
  );
}

// ---------- history ----------

function HistoryDialog({ onClose, onRestored, beforeRestore }: { onClose: () => void; onRestored: (r: { draft: SiteDoc; changed: boolean; draftUpdatedAt: string | null }) => void; beforeRestore: () => Promise<unknown> }) {
  const t = useT();
  const [versions, setVersions] = useState<Array<{ id: string; note: string | null; publishedAt: string; by: string | null }> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const restore = (id: string) => {
    setBusy(id);
    setError(null);
    // What is still waiting to be saved goes first, so the restored version is not overwritten by it.
    void beforeRestore().then(() => api<{ draft: SiteDoc; changed: boolean; draftUpdatedAt: string | null }>(`/v1/store-site/versions/${id}/restore`, { method: 'POST', body: {} })).then(onRestored).catch(setError).finally(() => setBusy(null));
  };
  useEffect(() => {
    void api<{ data: NonNullable<typeof versions> }>('/v1/store-site/versions').then((r) => setVersions(r.data)).catch(setError);
  }, []);
  return (
    <Modal title={t('Published versions')} onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('The last 30 times the site was published. Bring one back as your draft, look it over, then publish it.')}</p>
        <ErrorText error={error} />
        {versions === null ? <div className="skeleton" style={{ height: '6rem' }} /> : versions.length === 0 ? <div className="empty">{t('Nothing published yet.')}</div> : (
          <ul className="se-list">
            {versions.map((v, i) => (
              <li key={v.id}>
                <span className="grow">
                  <strong>{new Date(v.publishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong>
                  {i === 0 && <span className="badge authorized" style={{ marginLeft: '0.5rem' }}>{t('Live')}</span>}
                  <span className="small muted">{[v.by, v.note].filter(Boolean).join(' · ')}</span>
                </span>
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => restore(v.id)}>{busy === v.id ? t('Bringing back…') : t('Bring back')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
