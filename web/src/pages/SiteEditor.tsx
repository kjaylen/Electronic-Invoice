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
import { api } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, usePageTitle } from '../ui';
import { type EditorCtx, FieldInput, fieldShown, Group, ImageInput, LinkInput } from '../site/editor-fields';
import { contrast, FONT_FAMILIES, loadFonts } from '../site/theme';
import type { Builder, MenuItem, Section, SectionSchema, SiteDoc, SiteLink, Theme } from '../site/types';

type PageKey = 'home' | 'product' | `page:${string}`;
type Tab = 'pages' | 'theme' | 'header' | 'footer' | 'seo';
type Device = 'desktop' | 'tablet' | 'phone';

interface Loaded { draft: SiteDoc; changed: boolean; publishedAt: string | null; slug: string; builder: Builder }

const newId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const clone = <T,>(x: T): T => structuredClone(x);
const slugify = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function sectionsOf(doc: SiteDoc, page: PageKey): Section[] {
  if (page === 'home') return doc.home.sections;
  if (page === 'product') return doc.product.sections;
  return doc.pages.find((p) => `page:${p.id}` === page)?.sections ?? [];
}
function withSections(doc: SiteDoc, page: PageKey, sections: Section[]): SiteDoc {
  if (page === 'home') return { ...doc, home: { sections } };
  if (page === 'product') return { ...doc, product: { ...doc.product, sections } };
  return { ...doc, pages: doc.pages.map((p) => (`page:${p.id}` === page ? { ...p, sections } : p)) };
}
const pageKind = (page: PageKey) => (page === 'home' ? 'home' : page === 'product' ? 'product' : 'page');

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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [doc, setDoc] = useState<SiteDoc | null>(null);
  const [past, setPast] = useState<SiteDoc[]>([]);
  const [future, setFuture] = useState<SiteDoc[]>([]);
  const lastEdit = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const [changed, setChanged] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('pages');
  const [page, setPage] = useState<PageKey>('home');
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [html, setHtml] = useState<Record<string, string>>({});
  const [productHandle, setProductHandle] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const frameReady = useRef(false);
  const skipSave = useRef(true);

  useEffect(() => {
    void api<Loaded>('/v1/store-site').then((r) => {
      setLoaded(r);
      setDoc(r.draft);
      setChanged(r.changed);
      loadFonts(r.builder.fonts.map((f) => f.key));
    }).catch(setError);
  }, []);
  useEffect(() => {
    if (loaded) void api<{ data: Array<{ handle: string }> }>(`/v1/store/${loaded.slug}/products?limit=1`, { headers: { 'X-Site-Preview': '1' } }).then((r) => setProductHandle(r.data[0]?.handle ?? null)).catch(() => {});
  }, [loaded]);

  /** Change the site: one step of undo per burst of typing in the same place. */
  const update = useCallback((next: SiteDoc | ((d: SiteDoc) => SiteDoc), key = '') => {
    setDoc((current) => {
      if (!current) return current;
      const value = typeof next === 'function' ? next(current) : next;
      const now = Date.now();
      if (!(key && lastEdit.current.key === key && now - lastEdit.current.at < 1200)) setPast((p) => [...p.slice(-60), current]);
      lastEdit.current = { key, at: now };
      setFuture([]);
      return value;
    });
  }, []);
  const undo = () => {
    if (!past.length || !doc) return;
    setFuture((f) => [doc, ...f]);
    setDoc(past[past.length - 1]!);
    setPast((p) => p.slice(0, -1));
    lastEdit.current = { key: '', at: 0 };
  };
  const redo = () => {
    if (!future.length || !doc) return;
    setPast((p) => [...p, doc]);
    setDoc(future[0]!);
    setFuture((f) => f.slice(1));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Saved as a draft a moment after each change.
  useEffect(() => {
    if (!doc) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    setSaving('saving');
    const timer = setTimeout(() => {
      void api<{ draft: SiteDoc; changed: boolean }>('/v1/store-site/draft', { method: 'PUT', body: { site: doc } })
        .then((r) => {
          setChanged(r.changed);
          setSaving('saved');
        })
        .catch((e) => {
          setSaving('error');
          setError(e);
        });
    }, 700);
    return () => clearTimeout(timer);
  }, [doc]);

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
      const data = e.data as { type?: string; id?: string; path?: string };
      if (data.type === 'site-ready') {
        frameReady.current = true;
        if (previewDoc) post({ type: 'site-preview', site: previewDoc });
      }
      if (data.type === 'site-select' && data.id) {
        setTab('pages');
        setSelected(data.id);
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
  }, [previewDoc, post, doc]);
  const goTo = (p: PageKey) => {
    setPage(p);
    setSelected(null);
    const path = pathFor(p);
    if (path) post({ type: 'site-navigate', path });
  };
  useEffect(() => {
    if (selected) post({ type: 'site-highlight', id: selected });
  }, [selected, post]);

  if (error && !doc) return <div className="stack"><h1>{t('Site')}</h1><ErrorText error={error} /></div>;
  if (!doc || !loaded) return <div className="stack"><h1>{t('Site')}</h1><div className="skeleton" style={{ height: '24rem' }} /></div>;

  const ctx: EditorCtx = { slug: loaded.slug, builder: loaded.builder, site: doc };
  const schemas = new Map(loaded.builder.sections.map((s) => [s.type, s]));
  const sections = sectionsOf(doc, page);
  const current = selected ? sections.find((s) => s.id === selected) ?? null : null;
  const setSections = (next: Section[], key = '') => update((d) => withSections(d, page, next), key);
  const setSection = (id: string, next: Section, key = '') => setSections(sections.map((s) => (s.id === id ? next : s)), key);

  const publish = async () => {
    setPublishing(true);
    try {
      // Whatever is still waiting to be saved goes first.
      await api('/v1/store-site/draft', { method: 'PUT', body: { site: doc } });
      await api('/v1/store-site/publish', { method: 'POST', body: {} });
      setChanged(false);
      toast(t('Published. Customers see the new site now.'));
    } catch (e) {
      setError(e);
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    if (!window.confirm(t('Throw away every change since the last publish?'))) return;
    const r = await api<{ draft: SiteDoc }>('/v1/store-site/discard', { method: 'POST', body: {} });
    skipSave.current = true;
    setPast([]);
    setFuture([]);
    setDoc(r.draft);
    setChanged(false);
    setSelected(null);
    toast(t('Back to the published site'));
  };

  const pageOptions: Array<[PageKey, string]> = [['home', t('Home page')], ['product', t('Product pages')], ...doc.pages.map((p) => [`page:${p.id}` as PageKey, p.title] as [PageKey, string])];
  const currentPage = page.startsWith('page:') ? doc.pages.find((p) => `page:${p.id}` === page) ?? null : null;

  return (
    <div className="site-editor">
      <header className="se-top">
        <Link to="/settings?tab=store" className="se-back" aria-label={t('Back to store settings')}>←</Link>
        <div className="se-title">
          <strong>{t('Site')}</strong>
          <span className={`se-status ${saving}`} role="status">
            {saving === 'saving' ? t('Saving…') : saving === 'error' ? t('Not saved') : changed ? t('Draft: not published yet') : t('Published')}
          </span>
        </div>
        <span className="spacer" />
        <div className="tabs se-devices" role="group" aria-label={t('Preview size')}>
          {([['desktop', t('Computer')], ['tablet', t('Tablet')], ['phone', t('Phone')]] as Array<[Device, string]>).map(([d, l]) => <button key={d} type="button" aria-pressed={device === d} className={device === d ? 'active' : ''} onClick={() => setDevice(d)}>{l}</button>)}
        </div>
        <button type="button" className="secondary" onClick={undo} disabled={!past.length} aria-label={t('Undo')} title={t('Undo')}>↶</button>
        <button type="button" className="secondary" onClick={redo} disabled={!future.length} aria-label={t('Redo')} title={t('Redo')}>↷</button>
        <button type="button" className="secondary" onClick={() => setHistory(true)}>{t('History')}</button>
        <a className="button secondary" href={`/${loaded.slug}/shop`} target="_blank" rel="noreferrer">{t('View store')}</a>
        <button type="button" onClick={() => void publish()} disabled={publishing || !changed || saving === 'saving'}>{publishing ? t('Publishing…') : t('Publish')}</button>
      </header>
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
                const copy = { ...clone(current), id: newId(), blocks: current.blocks.map((b) => ({ ...clone(b), id: newId() })) };
                const i = sections.findIndex((s) => s.id === current.id);
                setSections([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)]);
                setSelected(copy.id);
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
              <NewPage ctx={ctx} onAdd={(title) => {
                const base = slugify(title) || 'page';
                let slug = base;
                for (let i = 2; doc.pages.some((p) => p.slug === slug); i++) slug = `${base}-${i}`;
                const id = newId();
                update((d) => ({ ...d, pages: [...d.pages, { id, slug, title, seoTitle: '', seoDescription: '', sections: [] }] }));
                setPage(`page:${id}`);
                setSelected(null);
                setTimeout(() => post({ type: 'site-navigate', path: `/shop/pages/${slug}` }), 150);
              }} />
              {currentPage && <PageSettings page={currentPage} pages={doc.pages} onChange={(next) => update((d) => ({ ...d, pages: d.pages.map((p) => (p.id === next.id ? next : p)) }), `page-${next.id}`)} onDelete={() => {
                if (!window.confirm(t('Delete the page “{title}”? Menus that link to it will go to the home page.', { title: currentPage.title }))) return;
                update((d) => ({ ...d, pages: d.pages.filter((p) => p.id !== currentPage.id) }));
                goTo('home');
              }} />}
              {page === 'product' && (
                <Group title={t('Every product page')}>
                  <p className="small muted" style={{ margin: 0 }}>{t('Sections here appear under every product, after its photos, price and description.')}</p>
                  <label className="row toggle se-toggle"><input type="checkbox" checked={doc.product.showRelated} onChange={(e) => update((d) => ({ ...d, product: { ...d.product, showRelated: e.target.checked } }))} /> {t('Show related products')}</label>
                  {doc.product.showRelated && <Field label={t('Their title')}><input maxLength={80} value={doc.product.relatedTitle} onChange={(e) => update((d) => ({ ...d, product: { ...d.product, relatedTitle: e.target.value } }), 'related-title')} /></Field>}
                </Group>
              )}
              <SectionList sections={sections} schemas={schemas} onSelect={setSelected} onChange={setSections} />
              <button type="button" onClick={() => setAdding(true)}>+ {t('Add section')}</button>
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
            <iframe ref={frame} src={`/${loaded.slug}/shop?site-preview`} title={t('Preview of your store')} onLoad={() => { frameReady.current = false; }} />
          </div>
        </div>
      </div>

      {adding && <AddSection schemas={loaded.builder.sections} kind={pageKind(page)} onClose={() => setAdding(false)} onAdd={async (type) => {
        const r = await api<{ section: Section }>('/v1/store-site/sections', { method: 'POST', body: { type } });
        setSections([...sections, r.section]);
        setAdding(false);
        setSelected(r.section.id);
      }} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} onRestored={(draft) => {
        skipSave.current = true;
        setPast((p) => [...p, doc]);
        setDoc(draft);
        setChanged(true);
        setHistory(false);
        setSelected(null);
        toast(t('That version is your draft now. Publish it to bring it back.'));
      }} />}
    </div>
  );
}

// ---------- the sections of a page ----------

function SectionList({ sections, schemas, onSelect, onChange }: { sections: Section[]; schemas: Map<string, SectionSchema>; onSelect: (id: string) => void; onChange: (s: Section[]) => void }) {
  const t = useT();
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= sections.length || from === to) return;
    const next = [...sections];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    onChange(next);
  };
  if (!sections.length) return <div className="se-empty small muted">{t('No sections on this page yet. Add one below.')}</div>;
  return (
    <ol className="se-sections" aria-label={t('Sections, top to bottom')}>
      {sections.map((s, i) => {
        const schema = schemas.get(s.type);
        return (
          <li
            key={s.id}
            draggable
            className={`${s.hidden ? 'hidden-section' : ''} ${over === i && dragging !== null && dragging !== i ? 'drop-target' : ''}`}
            onDragStart={(e: DragEvent) => { setDragging(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(i); }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDrop={(e: DragEvent) => { e.preventDefault(); if (dragging !== null) move(dragging, i); setDragging(null); setOver(null); }}
          >
            <span className="se-handle" aria-hidden="true">⋮⋮</span>
            <button type="button" className="se-section-main" onClick={() => onSelect(s.id)}>
              <strong>{schema ? t(schema.name) : s.type}</strong>
              <span className="small muted">{summary(s, schema)}</span>
            </button>
            <button type="button" className="link small" onClick={() => onChange(sections.map((x) => (x.id === s.id ? { ...x, hidden: !x.hidden } : x)))} aria-label={s.hidden ? t('Show') : t('Hide')} title={s.hidden ? t('Show') : t('Hide')}>{s.hidden ? '◌' : '●'}</button>
            <button type="button" className="link small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t('Move up')}>↑</button>
            <button type="button" className="link small" disabled={i === sections.length - 1} onClick={() => move(i, i + 1)} aria-label={t('Move down')}>↓</button>
          </li>
        );
      })}
    </ol>
  );
}

function SectionEditor({ section, schema, ctx, onBack, onChange, onDuplicate, onDelete }: {
  section: Section; schema: SectionSchema | undefined; ctx: EditorCtx;
  onBack: () => void; onChange: (s: Section, key: string) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const t = useT();
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  if (!schema) return <div className="stack"><button type="button" className="link" onClick={onBack}>← {t('Sections')}</button><p className="muted">{t('This section type is no longer available.')}</p></div>;
  const set = (key: string, value: unknown) => onChange({ ...section, settings: { ...section.settings, [key]: value } }, `${section.id}-${key}`);
  const blocks = section.blocks;
  const setBlocks = (next: Section['blocks'], key = '') => onChange({ ...section, blocks: next }, key);
  const moveBlock = (i: number, d: number) => {
    const next = [...blocks];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setBlocks(next);
  };
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
            return (
              <div key={b.id} className={`se-block ${openBlock === b.id ? 'open' : ''}`}>
                <div className="row se-block-head">
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
      <div className="row se-section-actions">
        <button type="button" className="secondary" onClick={onDuplicate}>{t('Duplicate')}</button>
        <span className="spacer" />
        <button type="button" className="link danger-link" onClick={() => { if (window.confirm(t('Remove this section?'))) onDelete(); }}>{t('Remove section')}</button>
      </div>
    </div>
  );
}

function AddSection({ schemas, kind, onAdd, onClose }: { schemas: SectionSchema[]; kind: 'home' | 'page' | 'product'; onAdd: (type: string) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const shown = schemas.filter((s) => (!s.pages || s.pages.includes(kind)) && (!q.trim() || `${t(s.name)} ${t(s.description)}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <Modal title={t('Add a section')} onClose={onClose} wide>
      <div className="stack">
        <input type="search" autoFocus placeholder={t('Search sections')} aria-label={t('Search sections')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="se-gallery">
          {shown.map((s) => (
            <button key={s.type} type="button" className="se-gallery-item" disabled={busy !== null} onClick={async () => { setBusy(s.type); await onAdd(s.type).finally(() => setBusy(null)); }}>
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

function NewPage({ onAdd }: { ctx: EditorCtx; onAdd: (title: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  if (!open) return <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>+ {t('New page')}</button>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim());
    setTitle('');
    setOpen(false);
  };
  return (
    <form className="row se-new-page" onSubmit={submit}>
      <input autoFocus aria-label={t('Page title')} placeholder={t('e.g. About us, Shipping, FAQ')} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      <button type="submit" disabled={!title.trim()}>{t('Add')}</button>
      <button type="button" className="link" onClick={() => setOpen(false)}>{t('Cancel')}</button>
    </form>
  );
}

function PageSettings({ page, pages, onChange, onDelete }: { page: SiteDoc['pages'][number]; pages: SiteDoc['pages']; onChange: (p: SiteDoc['pages'][number]) => void; onDelete: () => void }) {
  const t = useT();
  const taken = pages.some((p) => p.id !== page.id && p.slug === page.slug);
  return (
    <Group title={t('Page settings')} open={false}>
      <Field label={t('Title')}><input maxLength={120} value={page.title} onChange={(e) => onChange({ ...page, title: e.target.value })} /></Field>
      <Field label={t('Address')} hint={taken ? t('Another page already uses this address.') : `/shop/pages/${page.slug}`}><input value={page.slug} onChange={(e) => onChange({ ...page, slug: slugify(e.target.value) || page.slug })} /></Field>
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
  const move = (i: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  return (
    <div className="stack se-menu">
      {items.map((m, i) => (
        <div key={m.id} className={`se-block ${open === m.id ? 'open' : ''}`}>
          <div className="row se-block-head">
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

function HistoryDialog({ onClose, onRestored }: { onClose: () => void; onRestored: (draft: SiteDoc) => void }) {
  const t = useT();
  const [versions, setVersions] = useState<Array<{ id: string; note: string | null; publishedAt: string; by: string | null }> | null>(null);
  const [error, setError] = useState<unknown>(null);
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
                <button type="button" className="secondary" onClick={() => void api<{ draft: SiteDoc }>(`/v1/store-site/versions/${v.id}/restore`, { method: 'POST', body: {} }).then((r) => onRestored(r.draft)).catch(setError)}>{t('Bring back')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
