/**
 * Templates: the Liquid behind the business's emails, printed documents and online store, edited
 * like a Shopify theme. The code on one side, a live preview on the other (sample data with the
 * business's own details; the store preview is the real store), problems marked on their lines,
 * a history of saves, and a way back to the default.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { BUSINESS } from '../business';
import type { CodeEditorHandle } from '../code-editor';
import { useT } from '../i18n';
import { Icons } from '../icons';
import { withTransition } from '../motion';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Modal, Segmented, Select, useDebounced, usePageTitle } from '../ui';

// CodeMirror is most of this page's weight: load it while the page frame shows.
const CodeEditor = lazy(() => import('../code-editor').then((m) => ({ default: m.CodeEditor })));

type Group = 'emails' | 'documents' | 'store';
type Frame = 'email' | 'a4' | 'receipt' | 'section' | 'css';

interface TemplateSummary {
  key: string;
  group: Group;
  name: string;
  description: string;
  language: 'html' | 'css';
  preview: Frame;
  hasSubject: boolean;
  custom: boolean;
  updatedAt: string | null;
}

type EmailLanguage = 'en' | 'es';

interface TemplateDetail extends TemplateSummary {
  /** For emails: the language they go out in. */
  lang: EmailLanguage;
  source: string;
  subject: string | null;
  default: { source: string; subject: string | null };
  variables: Array<{ name: string; description: string }>;
  rules: string[];
}

interface Problem { message: string; line?: number; where: 'template' | 'subject' }
interface PreviewResult { html: string | null; problems: Problem[]; text?: string; subject?: string }
interface Version { id: string; action: 'saved' | 'reverted'; savedAt: string; savedBy: string | null; size: number }
interface Asset { id: string; name: string; contentType: string; bytes: number; width: number | null; height: number | null; url: string; logo: boolean; createdAt: string }
interface AssetList { data: Asset[]; logoId: string | null; maxBytes: number; max: number }

/** The images view's place in the page (?key=images): not a template. */
const IMAGES = 'images';

/** Plain newlines, whatever the source had (the code editor uses them). */
const lf = (s: string) => s.replace(/\r\n?/g, '\n');

const GROUPS: Array<[Group, string]> = [['emails', 'Emails'], ['documents', 'Printed documents'], ['store', 'Online store']];

// ---------- the page ----------

export function Templates() {
  const t = useT();
  usePageTitle(t('Templates'));
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);
  const dirty = useRef(false);
  const key = params.get('key');
  const current = list?.find((x) => x.key === key) ?? null;

  const [emailLanguage, setEmailLanguage] = useState<EmailLanguage>('en');
  const toast = useToast();
  const refresh = useCallback(() => api<{ data: TemplateSummary[]; emailLanguage: EmailLanguage }>('/v1/templates').then((r) => {
    setList(r.data);
    setEmailLanguage(r.emailLanguage);
  }).catch(setError), []);
  const changeLanguage = async (lang: EmailLanguage) => {
    const before = emailLanguage;
    setEmailLanguage(lang);
    try {
      await api('/v1/templates/settings', { method: 'PUT', body: { emailLanguage: lang } });
      toast(lang === 'es' ? t('Customer emails now go out in Spanish.') : t('Customer emails now go out in English.'));
    } catch (e) {
      setEmailLanguage(before);
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const go = (k: string | null) => withTransition(() => {
    dirty.current = false;
    setParams(k ? { key: k } : {});
  });
  const open = (k: string | null) => {
    if (k === key) return;
    if (dirty.current) setPending(k ?? '');
    else go(k);
  };

  if (error) return <div className="banner bad"><ErrorText error={error} /></div>;

  return (
    <div className="tpl">
      <div className="tpl-head">
        <div>
          <span className="kicker">{t('Business')}</span>
          <h1>{t('Templates')}</h1>
        </div>
        <span className="spacer" />
        {list && (
          <div className="tpl-picker">
            <Select aria-label={t('Template')} value={key ?? ''} onChange={(e) => open(e.target.value || null)}>
              <option value="">{t('All templates')}</option>
              {GROUPS.map(([g, label]) => (
                <optgroup key={g} label={t(label)}>
                  {list.filter((x) => x.group === g).map((x) => <option key={x.key} value={x.key}>{t(x.name)}</option>)}
                </optgroup>
              ))}
              <optgroup label={t('Files')}><option value={IMAGES}>{t('Images')}</option></optgroup>
            </Select>
          </div>
        )}
      </div>
      <div className="tpl-body">
        <nav className="tpl-rail" aria-label={t('Templates')}>
          <button type="button" className={`tpl-item tpl-all ${key ? '' : 'active'}`} aria-current={key ? undefined : 'page'} onClick={() => open(null)}>{t('All templates')}</button>
          {GROUPS.map(([g, label]) => (
            <div key={g} className="tpl-group">
              <h2 className="tpl-group-title">{t(label)}</h2>
              {(list ?? []).filter((x) => x.group === g).map((x) => (
                <button key={x.key} type="button" className={`tpl-item ${x.key === key ? 'active' : ''}`} aria-current={x.key === key ? 'page' : undefined} onClick={() => open(x.key)}>
                  <span>{t(x.name)}</span>
                  {x.custom && <span className="tpl-dot" title={t('Customized')} aria-label={t('Customized')} />}
                </button>
              ))}
              {!list && [0, 1, 2].map((i) => <div key={i} className="skeleton tpl-item-skeleton" />)}
            </div>
          ))}
          <div className="tpl-group">
            <h2 className="tpl-group-title">{t('Files')}</h2>
            <button type="button" className={`tpl-item ${key === IMAGES ? 'active' : ''}`} aria-current={key === IMAGES ? 'page' : undefined} onClick={() => open(IMAGES)}>
              <span>{t('Images')}</span>
            </button>
          </div>
        </nav>
        <div className="tpl-work tab-panel">
          {key === IMAGES ? <ImagesManager />
            : current
              ? <TemplateEditor key={`${current.key}:${emailLanguage}`} summary={current} onSaved={() => void refresh()} onDirty={(d) => { dirty.current = d; }} onOpen={open} />
              : <Overview list={list} onOpen={open} emailLanguage={emailLanguage} onLanguage={(l) => void changeLanguage(l)} />}
        </div>
      </div>
      {pending !== null && (
        <Modal title={t('Discard your changes?')} onClose={() => setPending(null)}>
          <p className="muted">{t('Your changes to this template are not saved. Leave it and lose them?')}</p>
          <div className="row end">
            <button type="button" className="secondary" autoFocus onClick={() => setPending(null)}>{t('Keep editing')}</button>
            <button type="button" className="danger" onClick={() => { const k = pending; setPending(null); go(k || null); }}>{t('Discard changes')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Overview({ list, onOpen, emailLanguage, onLanguage }: { list: TemplateSummary[] | null; onOpen: (key: string) => void; emailLanguage: EmailLanguage; onLanguage: (lang: EmailLanguage) => void }) {
  const t = useT();
  return (
    <div className="tpl-overview stack">
      <div className="tpl-intro card">
        <div className="tpl-intro-text">
          <h2>{t('Make every email, receipt and page yours')}</h2>
          <p className="muted">{t('Templates are written in Liquid, the language behind Shopify themes: HTML with a few extras for your data. Edit the code, watch the preview change as you type, and save when it looks right. You can always go back to the default.')}</p>
        </div>
        <div className="tpl-cheats" aria-label={t('Liquid at a glance')}>
          <div><code>{'{{ customer.name }}'}</code><span>{t('Prints a value')}</span></div>
          <div><code>{'{{ document.total | money }}'}</code><span>{t('A filter formats it: BZ$1,250.00')}</span></div>
          <div><code>{'{% if pay_url %}…{% endif %}'}</code><span>{t('Shows something only sometimes')}</span></div>
          <div><code>{'{% for line in document.lines %}'}</code><span>{t('Repeats for each item')}</span></div>
        </div>
      </div>
      {GROUPS.map(([g, label]) => (
        <section key={g} className="stack tpl-section">
          <div className="tpl-section-head">
            <h2 className="tpl-section-title">{t(label)}</h2>
            {g === 'emails' && (
              <div className="tpl-lang-setting">
                <span className="small muted">{t('Customers get them in')}</span>
                <Segmented label={t('Language of customer emails')} value={emailLanguage} onChange={onLanguage} options={[['en', 'English'], ['es', 'Español']]} />
              </div>
            )}
          </div>
          {g === 'emails' && (list ?? []).some((x) => x.group === 'emails' && x.custom) && (
            <p className="small muted tpl-lang-note">{t('Emails you customized keep your wording in either language; the others switch to the built-in text in that language.')}</p>
          )}
          <div className="tpl-cards">
            {(list ?? []).filter((x) => x.group === g).map((x) => (
              <button key={x.key} type="button" className="tpl-card card" onClick={() => onOpen(x.key)}>
                <span className="tpl-card-art" aria-hidden="true"><FrameArt frame={x.preview} /></span>
                <span className="tpl-card-text">
                  <span className="tpl-card-name">{t(x.name)}</span>
                  <span className="tpl-card-desc">{t(x.description)}</span>
                </span>
                <span className={`badge ${x.custom ? 'tpl-badge-custom' : 'tpl-badge-default'}`}>{x.custom ? t('Customized') : t('Default')}</span>
              </button>
            ))}
            {!list && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: '6.5rem' }} />)}
          </div>
        </section>
      ))}
      <section className="stack tpl-section">
        <h2 className="tpl-section-title">{t('Files')}</h2>
        <div className="tpl-cards">
          <button type="button" className="tpl-card card" onClick={() => onOpen(IMAGES)}>
            <span className="tpl-card-art" aria-hidden="true"><svg viewBox="0 0 48 36"><rect x="6" y="4" width="36" height="28" rx="3" /><circle cx="17" cy="13" r="3.5" /><path d="m8 30 11-11 8 8 5-5 10 10" /></svg></span>
            <span className="tpl-card-text">
              <span className="tpl-card-name">{t('Images')}</span>
              <span className="tpl-card-desc">{t('Your logo, and pictures for your emails, documents and store.')}</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}

/** A small drawing of what a template makes: an email, a sheet, a receipt, a store section. */
function FrameArt({ frame }: { frame: Frame }) {
  if (frame === 'email') return <svg viewBox="0 0 48 36"><rect x="2" y="4" width="44" height="28" rx="4" /><path d="m4 7 20 13L44 7" /></svg>;
  if (frame === 'a4') return <svg viewBox="0 0 48 36"><rect x="12" y="2" width="24" height="32" rx="2" /><path d="M17 9h10M17 14h14M17 18h14M17 22h9" /><rect x="17" y="26" width="5" height="5" /></svg>;
  if (frame === 'receipt') return <svg viewBox="0 0 48 36"><path d="M16 2h16v30l-2.7-2-2.6 2-2.7-2-2.6 2-2.7-2-2.7 2V2Z" /><path d="M20 9h8M20 13h8M20 17h5" /></svg>;
  if (frame === 'css') return <svg viewBox="0 0 48 36"><path d="M18 9 10 18l8 9M30 9l8 9-8 9" /></svg>;
  return <svg viewBox="0 0 48 36"><rect x="4" y="4" width="40" height="28" rx="3" /><path d="M4 11h40" /><rect x="9" y="16" width="9" height="11" rx="1.5" /><rect x="21" y="16" width="9" height="11" rx="1.5" /><rect x="33" y="16" width="6" height="11" rx="1.5" /></svg>;
}

// ---------- the editor ----------

function TemplateEditor({ summary, onSaved, onDirty, onOpen }: { summary: TemplateSummary; onSaved: () => void; onDirty: (dirty: boolean) => void; onOpen: (key: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [source, setSource] = useState('');
  const [subject, setSubject] = useState('');
  const [saved, setSaved] = useState({ source: '', subject: '' });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saveProblems, setSaveProblems] = useState<Problem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [side, setSide] = useState<'variables' | 'images' | null>(null);
  const [dialog, setDialog] = useState<'versions' | 'revert' | null>(null);
  const [pane, setPane] = useState<'code' | 'preview'>('code');
  const editor = useRef<CodeEditorHandle>(null);

  useEffect(() => {
    api<TemplateDetail>(`/v1/templates/${summary.key}`).then((raw) => {
      const d = { ...raw, source: lf(raw.source), default: { ...raw.default, source: lf(raw.default.source) } };
      setDetail(d);
      setSource(d.source);
      setSubject(d.subject ?? '');
      setSaved({ source: d.source, subject: d.subject ?? '' });
    }).catch(setLoadError);
  }, [summary.key]);

  const dirty = detail !== null && (source !== saved.source || (detail.hasSubject && subject !== saved.subject));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The live preview: rendered by the server (the same engine that sends and prints), as you type.
  const draft = useDebounced(useMemo(() => (detail ? { source, subject } : null), [detail, source, subject]), 320);
  useEffect(() => {
    if (!detail || !draft) return;
    const controller = new AbortController();
    setPreviewing(true);
    api<PreviewResult>(`/v1/templates/${detail.key}/preview`, { method: 'POST', body: { source: draft.source, ...(detail.hasSubject && { subject: draft.subject }) }, signal: controller.signal })
      .then((p) => {
        setPreview(p);
        setSaveProblems(null);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setPreviewing(false);
      });
    return () => controller.abort();
  }, [draft, detail]);

  const save = useCallback(async () => {
    if (!detail || saving || !dirty) return;
    setSaving(true);
    try {
      const r = await api<{ source: string; subject: string | null; custom: boolean; updatedAt: string | null }>(`/v1/templates/${detail.key}`, {
        method: 'PUT', body: { source, ...(detail.hasSubject && { subject }) },
      });
      setSaved({ source: lf(r.source), subject: r.subject ?? '' });
      setDetail((d) => d && { ...d, custom: r.custom, updatedAt: r.updatedAt });
      setSaveProblems(null);
      toast(t('Saved. It is used from now on.'));
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_template') {
        const problems = (e.details as { problems?: Problem[] } | undefined)?.problems ?? [{ message: e.message, where: 'template' as const }];
        setSaveProblems(problems);
        const first = problems.find((p) => p.line);
        if (first?.line) editor.current?.goToLine(first.line);
        toast(t('Not saved: fix the problems first.'), 'bad');
      } else {
        toast(e instanceof Error ? e.message : String(e), 'bad');
      }
    } finally {
      setSaving(false);
    }
  }, [detail, saving, dirty, source, subject, toast, t, onSaved]);

  // Ctrl/⌘+S anywhere on the page (the code editor handles its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const revert = async () => {
    if (!detail) return;
    setDialog(null);
    try {
      const r = await api<{ source: string; subject: string | null; custom: boolean; updatedAt: string | null }>(`/v1/templates/${detail.key}`, { method: 'DELETE' });
      setSource(lf(r.source));
      setSubject(r.subject ?? '');
      setSaved({ source: lf(r.source), subject: r.subject ?? '' });
      setDetail((d) => d && { ...d, custom: false, updatedAt: null });
      toast(t('Back to the default template.'));
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };

  const openVersion = async (v: Version) => {
    if (!detail) return;
    try {
      const r = await api<{ source: string; subject: string | null }>(`/v1/templates/${detail.key}/versions/${v.id}`);
      setDialog(null);
      setSource(lf(r.source));
      if (detail.hasSubject) setSubject(r.subject ?? detail.default.subject ?? '');
      toast(t('That version is in the editor. Save to use it.'), 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };

  if (loadError) return <div className="banner bad"><ErrorText error={loadError} /></div>;
  if (!detail) return <div className="tpl-editor"><div className="skeleton" style={{ height: '3.5rem' }} /><div className="skeleton" style={{ flex: 1, minHeight: '24rem' }} /></div>;

  const problems = saveProblems ?? preview?.problems ?? [];

  return (
    <div className="tpl-editor">
      <div className="tpl-bar">
        <div className="tpl-title">
          <div className="row">
            <h2>{t(detail.name)}</h2>
            <span className={`badge ${detail.custom ? 'tpl-badge-custom' : 'tpl-badge-default'}`}>{detail.custom ? t('Customized') : t('Default')}</span>
            {detail.group === 'emails' && <span className="tpl-lang-chip" title={t('Language of customer emails')}>{detail.lang === 'es' ? 'Español' : 'English'}</span>}
            {dirty && <span className="tpl-unsaved">{t('Unsaved changes')}</span>}
          </div>
          <p className="muted small">{t(detail.description)}</p>
        </div>
        <div className="tpl-actions">
          <button type="button" className="secondary" onClick={() => setDialog('versions')}>{t('History')}</button>
          {detail.custom && <button type="button" className="secondary" onClick={() => setDialog('revert')}>{t('Use the default')}</button>}
          {dirty && <button type="button" className="secondary" onClick={() => { setSource(saved.source); setSubject(saved.subject); }}>{t('Discard')}</button>}
          <button type="button" onClick={() => void save()} disabled={!dirty || saving} title={t('Save (Ctrl+S)')}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
      <div className="tpl-pane-switch">
        <Segmented label={t('Show')} value={pane} switches onChange={setPane} options={[['code', t('Code')], ['preview', t('Preview')]]} />
      </div>
      <div className="tpl-panes" data-pane={pane}>
        <section className="tpl-code" aria-label={t('Code')}>
          {detail.hasSubject && (
            <label className="tpl-subject">
              <span>{t('Subject')}</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} spellCheck={false} autoComplete="off" />
            </label>
          )}
          <div className="tpl-code-tools">
            <span className="tpl-lang">{detail.language === 'css' ? 'Liquid · CSS' : 'Liquid · HTML'}</span>
            <span className="spacer" />
            <button type="button" className={`tpl-tool ${side === 'images' ? 'on' : ''}`} aria-pressed={side === 'images'} onClick={() => setSide((v) => (v === 'images' ? null : 'images'))}>{t('Images')}</button>
            <button type="button" className={`tpl-tool ${side === 'variables' ? 'on' : ''}`} aria-pressed={side === 'variables'} onClick={() => setSide((v) => (v === 'variables' ? null : 'variables'))}>{t('Variables')}</button>
          </div>
          <div className={`tpl-code-main ${side ? 'with-vars' : ''}`}>
            <Suspense fallback={<div className="code-editor tpl-code-loading" aria-busy="true" />}>
            <CodeEditor
              ref={editor}
              value={source}
              language={detail.language}
              variables={detail.variables}
              problems={problems.filter((p) => p.where === 'template')}
              onChange={setSource}
              onSave={() => void save()}
              label={t('Template code')}
            />
            </Suspense>
            {side === 'variables' && <VariablesPanel detail={detail} onInsert={(text) => editor.current?.insert(text)} onClose={() => setSide(null)} />}
            {side === 'images' && <ImagesPanel group={detail.group} onInsert={(text) => editor.current?.insert(text)} onClose={() => setSide(null)} onManage={() => onOpen(IMAGES)} />}
          </div>
          <Problems problems={problems} busy={previewing} onGo={(line) => editor.current?.goToLine(line)} />
        </section>
        <section className="tpl-preview" aria-label={t('Preview')}>
          <PreviewPane detail={detail} preview={preview} busy={previewing} />
        </section>
      </div>
      {dialog === 'versions' && <VersionsDialog templateKey={detail.key} onOpen={openVersion} onClose={() => setDialog(null)} />}
      {dialog === 'revert' && (
        <Modal title={t('Use the default template?')} onClose={() => setDialog(null)}>
          <p className="muted">{t('Your version is replaced by the built-in one, from now on. It stays in the history, so you can bring it back.')}</p>
          <div className="row end">
            <button type="button" className="secondary" autoFocus onClick={() => setDialog(null)}>{t('Cancel')}</button>
            <button type="button" className="danger" onClick={() => void revert()}>{t('Use the default')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Problems({ problems, busy, onGo }: { problems: Problem[]; busy: boolean; onGo: (line: number) => void }) {
  const t = useT();
  if (!problems.length) {
    return (
      <div className="tpl-problems ok" role="status">
        <span className="tpl-ok-dot" aria-hidden="true" />
        <span>{busy ? t('Updating the preview…') : t('No problems')}</span>
      </div>
    );
  }
  return (
    <div className="tpl-problems bad" role="alert">
      <strong>{problems.length === 1 ? t('1 problem') : t('{n} problems', { n: problems.length })}</strong>
      <ul>
        {problems.map((p, i) => (
          <li key={i}>
            {p.line
              ? <button type="button" className="tpl-line" onClick={() => onGo(p.line!)}>{t('Line {n}', { n: p.line })}</button>
              : <span className="tpl-line">{p.where === 'subject' ? t('Subject') : t('Template')}</span>}
            <span>{p.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SNIPPETS: Array<[string, string]> = [
  ['{{ customer.name | default: "there" }}', 'A value, with a fallback'],
  ['{% if pay_url %}\n  \n{% endif %}', 'Show only sometimes'],
  ['{% for line in document.lines %}\n  {{ line.description }}\n{% endfor %}', 'Repeat for each item'],
  ["{{ document.issue_date | date: '%-d %B %Y' }}", 'A date: 22 November 2026'],
  ['{{ document.total | money }}', 'An amount: BZ$1,250.00'],
  ['{{ customer.name | upcase }}', 'CAPITALS'],
];

function VariablesPanel({ detail, onInsert, onClose }: { detail: TemplateDetail; onInsert: (text: string) => void; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const shown = detail.variables.filter((v) => !q || `${v.name} ${v.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className="tpl-vars" aria-label={t('Variables')}>
      <div className="tpl-vars-head">
        <input type="search" placeholder={t('Find a variable')} aria-label={t('Find a variable')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><Icons.close /></button>
      </div>
      <div className="tpl-vars-body">
        {detail.rules.length > 0 && (
          <div className="tpl-rule">
            <strong>{t('Must keep')}</strong>
            {detail.rules.map((r) => <p key={r}>{t(r)}</p>)}
          </div>
        )}
        <p className="tpl-vars-hint">{t('Click to insert at the cursor.')}</p>
        {shown.map((v) => (
          <button key={v.name} type="button" className="tpl-var" onClick={() => onInsert(v.name.startsWith('{%') ? v.name : `{{ ${v.name} }}`)}>
            <code>{v.name}</code>
            <span>{t(v.description)}</span>
          </button>
        ))}
        {!q && (
          <>
            <h3 className="tpl-vars-title">{t('Liquid basics')}</h3>
            {SNIPPETS.map(([code, what]) => (
              <button key={code} type="button" className="tpl-var" onClick={() => onInsert(code)}>
                <code>{code.split('\n')[0]}</code>
                <span>{t(what)}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function VersionsDialog({ templateKey, onOpen, onClose }: { templateKey: string; onOpen: (v: Version) => void; onClose: () => void }) {
  const t = useT();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<{ data: Version[] }>(`/v1/templates/${templateKey}/versions`).then((r) => setVersions(r.data)).catch(setError);
  }, [templateKey]);
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <Modal title={t('History')} onClose={onClose}>
      <p className="muted small">{t('The last 30 saves. Open one to put it in the editor; nothing changes until you save.')}</p>
      {error ? <div className="banner bad"><ErrorText error={error} /></div> : !versions ? <div className="skeleton" style={{ height: '8rem' }} /> : versions.length === 0 ? (
        <p className="tpl-empty muted">{t('No saves yet: this template is the default.')}</p>
      ) : (
        <ul className="tpl-versions">
          {versions.map((v, i) => (
            <li key={v.id}>
              <div>
                <strong>{v.action === 'reverted' ? t('Back to the default') : i === 0 ? t('Saved (in use)') : t('Saved')}</strong>
                <span className="muted small">{when(v.savedAt)}{v.savedBy ? ` · ${v.savedBy}` : ''}</span>
              </div>
              <button type="button" className="secondary" onClick={() => onOpen(v)}>{t('Open')}</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---------- images ----------

const imgSnippet = (name: string) => `<img src="{{ '${name}' | asset_url }}" alt="">`;
/** The logo, only when there is one: business.logo, or store.logo in store templates. */
const logoSnippet = (group: Group) => {
  const who = group === 'store' ? 'store' : 'business';
  return `{% if ${who}.logo %}<img src="{{ ${who}.logo }}" alt="{{ ${who}.name }}">{% endif %}`;
};
const kb = (bytes: number) => (bytes < 1024 * 100 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes / 1024)} KB`);

function useAssets() {
  const [list, setList] = useState<AssetList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => api<AssetList>('/v1/templates/assets').then(setList).catch(setError), []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { list, error, reload };
}

async function uploadImage(file: File): Promise<Asset> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
  return api<Asset>('/v1/templates/assets', { method: 'POST', body: { name: file.name, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) } });
}

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';

function ImagesManager() {
  const t = useT();
  const toast = useToast();
  const { list, error, reload } = useAssets();
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const [confirm, setConfirm] = useState<Asset | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const forLogo = useRef(false);
  const max = list?.maxBytes ?? 2 * 1024 * 1024;

  const upload = async (files: File[], asLogo: boolean) => {
    let last: Asset | null = null;
    for (const f of files) {
      if (f.size > max) {
        toast(t('{name} is larger than 2 MB.', { name: f.name }), 'bad');
        continue;
      }
      setBusy((b) => b + 1);
      try {
        last = await uploadImage(f);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'bad');
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (last && asLogo && !last.logo) await api('/v1/templates/logo', { method: 'PUT', body: { assetId: last.id } }).catch(() => {});
    if (last) toast(asLogo || last.logo ? t('Your logo is in place.') : t('Uploaded.'));
    await reload();
  };
  const pick = (asLogo: boolean) => {
    forLogo.current = asLogo;
    input.current?.click();
  };
  const setLogo = async (id: string | null) => {
    try {
      await api('/v1/templates/logo', { method: 'PUT', body: { assetId: id } });
      toast(id ? t('That is your logo now.') : t('Your documents and emails no longer show a logo.'));
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };
  const remove = async (a: Asset) => {
    setConfirm(null);
    try {
      await api(`/v1/templates/assets/${a.id}`, { method: 'DELETE' });
      toast(t('{name} deleted.', { name: a.name }));
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };
  const copy = async (a: Asset) => {
    try {
      await navigator.clipboard.writeText(imgSnippet(a.name));
      toast(t('Copied. Paste it into a template.'));
    } catch {
      toast(t('Could not copy: select the name and copy it yourself.'), 'bad');
    }
  };

  if (error) return <div className="banner bad"><ErrorText error={error} /></div>;
  const logo = list?.data.find((a) => a.logo) ?? null;
  return (
    <div
      className={`tpl-images ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')), false);
      }}
    >
      <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length) void upload(forLogo.current ? files.slice(0, 1) : files, forLogo.current);
      }} />
      <div className="tpl-bar">
        <div className="tpl-title">
          <h2>{t('Images')}</h2>
          <p className="muted small">{t('Your logo, and pictures to use in your templates. PNG or JPEG show everywhere; SVG, WebP and GIF do not show in some email apps.')}</p>
        </div>
        <div className="tpl-actions">
          <button type="button" onClick={() => pick(false)} disabled={busy > 0}>{busy > 0 ? t('Uploading…') : t('Upload images')}</button>
        </div>
      </div>

      <section className="tpl-logo card">
        <div className="tpl-logo-art checker">
          {logo ? <img key={logo.id} src={logo.url} alt={t('Your logo')} /> : <span className="muted small">{t('No logo yet')}</span>}
        </div>
        <div className="tpl-logo-text">
          <h3>{t('Your logo')}</h3>
          <p className="muted">{t('Printed at the top of your receipts, invoices, quotes and statements, and shown at the top of your emails. The built-in templates use it as soon as you choose one.')}</p>
          {logo && !/png|jpeg/.test(logo.contentType) && <p className="tpl-warn small">{t('Use a PNG or JPEG logo to have it in every email app and on PDFs printed without your templates.')}</p>}
          <div className="row">
            <button type="button" className="secondary" onClick={() => pick(true)} disabled={busy > 0}>{logo ? t('Upload a new logo') : t('Upload your logo')}</button>
            {logo && <button type="button" className="link" onClick={() => void setLogo(null)}>{t('Stop using a logo')}</button>}
          </div>
        </div>
      </section>

      {!list ? <div className="skeleton" style={{ height: '12rem' }} /> : list.data.length === 0 ? (
        <button type="button" className="tpl-drop" onClick={() => pick(false)}>
          <strong>{t('Drop images here, or choose them')}</strong>
          <span className="muted small">{t('Up to 2 MB each. Each one gets a name to use in your templates.')}</span>
        </button>
      ) : (
        <div className="tpl-assets">
          {list.data.map((a) => (
            <figure key={a.id} className="tpl-asset card">
              <div className="tpl-asset-img checker">
                <img src={a.url} alt={a.name} loading="lazy" />
                {a.logo && <span className="tpl-asset-badge">{t('Logo')}</span>}
              </div>
              <figcaption>
                <code title={imgSnippet(a.name)}>{a.name}</code>
                <span className="muted small">{a.width && a.height ? `${a.width} × ${a.height} · ` : ''}{kb(a.bytes)}</span>
                <div className="tpl-asset-actions">
                  <button type="button" className="tpl-tool" onClick={() => void copy(a)}>{t('Copy code')}</button>
                  {!a.logo && <button type="button" className="tpl-tool" onClick={() => void setLogo(a.id)}>{t('Use as logo')}</button>}
                  <button type="button" className="tpl-tool tpl-tool-danger" onClick={() => setConfirm(a)}>{t('Delete')}</button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {over && <div className="tpl-drop-overlay" aria-hidden="true"><span>{t('Drop to upload')}</span></div>}
      {confirm && (
        <Modal title={t('Delete {name}?', { name: confirm.name })} onClose={() => setConfirm(null)}>
          <p className="muted">{confirm.logo ? t('It is your logo: your documents and emails will show none.') : t('Templates that use it would stop showing it.')}</p>
          <div className="row end">
            <button type="button" className="secondary" autoFocus onClick={() => setConfirm(null)}>{t('Cancel')}</button>
            <button type="button" className="danger" onClick={() => void remove(confirm)}>{t('Delete')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** In the editor: put an image where the cursor is (or upload one first). */
function ImagesPanel({ group, onInsert, onClose, onManage }: { group: Group; onInsert: (text: string) => void; onClose: () => void; onManage: () => void }) {
  const t = useT();
  const toast = useToast();
  const { list, reload } = useAssets();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const logo = list?.data.find((a) => a.logo) ?? null;
  const add = async (file: File) => {
    setBusy(true);
    try {
      const a = await uploadImage(file);
      await reload();
      onInsert(imgSnippet(a.name));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="tpl-vars" aria-label={t('Images')}>
      <div className="tpl-vars-head">
        <strong className="tpl-vars-name">{t('Images')}</strong>
        <span className="spacer" />
        <button type="button" className="tpl-tool" onClick={onManage}>{t('Manage')}</button>
        <button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><Icons.close /></button>
      </div>
      <div className="tpl-vars-body">
        <p className="tpl-vars-hint">{t('Click to insert at the cursor.')}</p>
        <button type="button" className="tpl-var tpl-img-row" onClick={() => onInsert(logoSnippet(group))}>
          <span className="tpl-img-thumb checker">{logo ? <img src={logo.url} alt="" /> : null}</span>
          <span className="tpl-img-text"><code>{group === 'store' ? 'store.logo' : 'business.logo'}</code><span>{logo ? t('Your logo, wherever it is set') : t('Your logo (choose one under Images)')}</span></span>
        </button>
        {(list?.data ?? []).map((a) => (
          <button key={a.id} type="button" className="tpl-var tpl-img-row" onClick={() => onInsert(imgSnippet(a.name))}>
            <span className="tpl-img-thumb checker"><img src={a.url} alt="" loading="lazy" /></span>
            <span className="tpl-img-text"><code>{a.name}</code><span>{a.width && a.height ? `${a.width} × ${a.height} · ` : ''}{kb(a.bytes)}</span></span>
          </button>
        ))}
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void add(f);
        }} />
        <button type="button" className="tpl-tool tpl-img-upload" onClick={() => input.current?.click()} disabled={busy}>{busy ? t('Uploading…') : t('Upload and insert an image')}</button>
      </div>
    </aside>
  );
}

// ---------- the preview ----------

function PreviewPane({ detail, preview, busy }: { detail: TemplateDetail; preview: PreviewResult | null; busy: boolean }) {
  const t = useT();
  // Keep showing the last good render while a problem is being fixed.
  const [shown, setShown] = useState<PreviewResult | null>(null);
  useEffect(() => {
    if (preview?.html !== null && preview !== null) setShown(preview);
  }, [preview]);
  const stale = preview !== null && preview.html === null;
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const store = detail.preview === 'section' || detail.preview === 'css';

  return (
    <div className={`tpl-canvas frame-${detail.preview}`}>
      <div className="tpl-canvas-bar">
        <span className="tpl-canvas-label">
          {store ? t('Your store, with your changes') : t('Sample data, with your business details')}
        </span>
        {busy && <span className="tpl-spinner" aria-label={t('Updating')} />}
        <span className="spacer" />
        {(detail.preview === 'email' || store) && (
          <Segmented label={t('Screen')} value={device} onChange={setDevice} options={[['desktop', t('Desktop')], ['phone', t('Phone')]]} />
        )}
      </div>
      <div className={`tpl-stage ${stale ? 'stale' : ''}`}>
        {stale && <div className="tpl-stale" role="status">{t('Preview paused: fix the problem to see your changes.')}</div>}
        {store
          ? <StorePreview detail={detail} content={shown?.html ?? null} device={device} />
          : !shown ? <div className="skeleton tpl-stage-skeleton" />
            : detail.preview === 'email' ? <EmailPreview detail={detail} preview={shown} device={device} />
              : detail.preview === 'a4' ? <SheetPreview html={shown.html!} />
                : <RollPreview html={shown.html!} />}
      </div>
    </div>
  );
}

/**
 * A frame for rendered HTML. Sandboxed (no scripts run in it); its document is rewritten in place
 * on each change, so the preview updates without flashing, and it is as tall as its content.
 */
function HtmlFrame({ html, title, width, height, onHeight, className }: { html: string; title: string; width?: number; height?: number; onHeight?: (h: number) => void; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const report = useRef(onHeight);
  report.current = onHeight;
  useEffect(() => {
    const frame = ref.current;
    const doc = frame?.contentDocument;
    if (!ready || !frame || !doc) return;
    doc.open();
    doc.write(html.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">') + (/<head/i.test(html) ? '' : '<base target="_blank">'));
    doc.close();
    const measure = () => {
      const h = Math.max(doc.documentElement?.offsetHeight ?? 0, doc.body?.scrollHeight ?? 0);
      report.current?.(Math.ceil(h));
    };
    measure();
    const images = [...doc.images];
    images.forEach((img) => img.addEventListener('load', measure));
    const timer = window.setTimeout(measure, 250);
    return () => {
      window.clearTimeout(timer);
      images.forEach((img) => img.removeEventListener('load', measure));
    };
  }, [html, ready]);
  return (
    <iframe
      ref={ref}
      className={className}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc="<!doctype html><html><head></head><body></body></html>"
      onLoad={() => setReady(true)}
      style={{ ...(width && { width }), ...(height && { height }) }}
    />
  );
}

function EmailPreview({ detail, preview, device }: { detail: TemplateDetail; preview: PreviewResult; device: 'desktop' | 'phone' }) {
  const t = useT();
  const { me, session } = useSession();
  const [height, setHeight] = useState(480);
  const from = me?.tradeName ?? me?.legalName ?? session?.business.tradeName ?? session?.business.legalName ?? '';
  const attachments = detail.key === 'email.document' || detail.key === 'email.reminder'
    ? ['Tax-Invoice-001-000000042.pdf', 'Tax-Invoice-001-000000042.xml']
    : detail.key === 'email.statement' ? ['statement-2026-11-22.pdf'] : detail.key === 'email.quote' ? ['quote-1007.pdf'] : [];
  return (
    <div className={`tpl-mail ${device}`}>
      <div className="tpl-mail-head">
        <div className="tpl-mail-subject">{preview.subject || <span className="muted">{t('(no subject)')}</span>}</div>
        <div className="tpl-mail-meta">
          <span className="tpl-avatar" aria-hidden="true">{from.slice(0, 1).toUpperCase()}</span>
          <div><strong>{from}</strong><span className="muted"> · {t('to')} {detail.key === 'email.order' ? 'maria@example.com' : 'accounts@islandlogistics.example'}</span></div>
        </div>
        {attachments.length > 0 && (
          <div className="tpl-mail-files">{attachments.map((a) => <span key={a} className="tpl-file"><span className="tpl-file-ext">{a.split('.').pop()}</span>{a}</span>)}</div>
        )}
      </div>
      <HtmlFrame html={preview.html!} title={t('Email preview')} height={height} onHeight={(h) => setHeight(Math.max(h, 200))} className="tpl-mail-body" />
    </div>
  );
}

/** The margins the template asks for when printed (@page), applied on screen so the sheet looks like the PDF. */
function asSheet(html: string): string {
  const margin = /@page\s*\{[^}]*?margin\s*:\s*([^;}]+)/i.exec(html)?.[1]?.trim() ?? '14mm';
  const screen = `<style>@media screen { html { background: #fff; } body { padding: ${margin}; box-sizing: border-box; min-height: 297mm; } }</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${screen}</head>`) : screen + html;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const A4_PX = 794; // 210 mm at 96 dpi

function SheetPreview({ html }: { html: string }) {
  const t = useT();
  const [ref, width] = useWidth();
  const [height, setHeight] = useState(1123);
  const scale = width ? Math.min(1, (width - 48) / A4_PX) : 0.6;
  const page = useMemo(() => asSheet(html), [html]);
  return (
    <div ref={ref} className="tpl-sheet-wrap">
      <div className="tpl-sheet" style={{ width: A4_PX * scale, height: Math.max(height, 1123) * scale }}>
        <div style={{ width: A4_PX, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          <HtmlFrame html={page} title={t('Document preview')} width={A4_PX} height={Math.max(height, 1123)} onHeight={setHeight} className="tpl-sheet-frame" />
        </div>
      </div>
      <p className="tpl-note">{t('A4. The PDF is printed from this page.')}</p>
    </div>
  );
}

function RollPreview({ html }: { html: string }) {
  const t = useT();
  const [height, setHeight] = useState(600);
  return (
    <div className="tpl-roll-wrap">
      <div className="tpl-roll">
        <HtmlFrame html={html} title={t('Receipt preview')} width={302} height={height} onHeight={setHeight} className="tpl-roll-frame" />
      </div>
      <p className="tpl-note">{t('80 mm roll, at actual size.')}</p>
    </div>
  );
}

/** Store templates preview on the real store: it opens in a frame and takes the draft as you type. */
function StorePreview({ detail, content, device }: { detail: TemplateDetail; content: string | null; device: 'desktop' | 'phone' }) {
  const t = useT();
  const [live, setLive] = useState<boolean | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(content);
  latest.current = content;
  useEffect(() => {
    api(`/v1/store/${BUSINESS}`).then(() => setLive(true)).catch(() => setLive(false));
  }, []);
  const send = useCallback(() => {
    const w = frame.current?.contentWindow;
    if (w && latest.current !== null) w.postMessage({ type: 'theme-preview', key: detail.key, content: latest.current }, window.location.origin);
  }, [detail.key]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.source === frame.current?.contentWindow && (e.data as { type?: string })?.type === 'theme-preview-ready') send();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [send]);
  useEffect(send, [content, send]);

  if (live === null) return <div className="skeleton tpl-stage-skeleton" />;
  if (!live) {
    return (
      <div className="tpl-store-off stack">
        <div className="banner info"><div><strong>{t('Your online store is not open yet.')}</strong> {t('Open it in Settings, Online store, to preview your changes on it. Until then, here is the section on its own.')}</div></div>
        {detail.preview === 'section' && content !== null && <SectionAlone html={content} />}
      </div>
    );
  }
  return (
    <div className={`tpl-store ${device}`}>
      <iframe ref={frame} src={`/${BUSINESS}/shop?theme-preview=1`} title={t('Store preview')} />
    </div>
  );
}

function SectionAlone({ html }: { html: string }) {
  const t = useT();
  const [height, setHeight] = useState(200);
  const styles = useMemo(() => [...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join(''), []);
  const page = `<!doctype html><html><head>${styles}</head><body style="background:#fff"><div class="shop"><main class="shop-main"><div class="theme-section">${html}</div></main></div></body></html>`;
  return (
    <div className="tpl-section-alone">
      <HtmlFrame html={page} title={t('Section preview')} height={Math.max(height, 120)} onHeight={setHeight} className="tpl-section-frame" />
    </div>
  );
}

export default Templates;
