/** Business tax: the worksheet (Reports), the kinds of receipts and the dates to remember (Settings → Business), and what is coming up (the overview). */

import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, link } from '../api';
import { type T, useI18n, useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, money, Select, toCents } from '../ui';

interface Worksheet {
  environment: 'test' | 'production';
  documents: number;
  kinds: Array<{ name: string; rate: string; categories: string[]; receipts: string; tax: string }>;
  receipts: string;
  tax: string;
  withheld: { invoices: number; amount: string };
  toPay: string;
  dueOn: string;
  warnings: string[];
}

interface TaxKind { name: string; rate: string; categories: string[] }
interface OwnDate { id?: string; name: string; repeats: 'monthly' | 'yearly' | 'once'; date: string }
interface TaxSettings { kinds: TaxKind[]; gstReturn: boolean; businessTax: boolean; email: boolean; dates: OwnDate[]; presets: Array<{ name: string; rate: string }> }

export interface DueDate { key: string; kind: 'gst' | 'business-tax' | 'own'; name: string; dueOn: string; daysLeft: number; period?: { from: string; to: string }; amount?: string }

const RATE = /^\d{1,2}(\.\d{1,2})?$/;
const dayText = (iso: string, lang: string, withYear = false) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es' : 'en-GB', { day: 'numeric', month: 'long', ...(withYear && { year: 'numeric' }), timeZone: 'UTC' });
const monthText = (iso: string, lang: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---------- Reports: the worksheet ----------

export function BusinessTaxView({ from, to }: { from: string; to: string }) {
  const t = useT();
  const { lang } = useI18n();
  const [r, setR] = useState<Worksheet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const qs = `from=${from}&to=${to}`;
  useEffect(() => {
    if (!from || !to || from > to) return;
    setR(null);
    api<Worksheet>(`/v1/reports/business-tax?${qs}`).then(setR).catch(setError);
  }, [qs, from, to]);
  if (error) return <ErrorText error={error} />;
  if (!r) return <div className="skeleton" style={{ height: '18rem' }} />;
  const owe = toCents(r.toPay) >= 0n;
  return (
    <div className="stack">
      <section className={`card gst-result ${owe ? 'owe' : 'credit'}`}>
        <div>
          <span className="kicker">{owe ? t('Business tax to pay by {date}', { date: dayText(r.dueOn, lang, true) }) : t('Credit to carry forward')}</span>
          <div className="gst-amount">{money(r.toPay.replace('-', ''))}</div>
          <p className="small">{t('Tax on receipts {tax} less contract tax your customers withheld {withheld}.', { tax: money(r.tax), withheld: money(r.withheld.amount) })}</p>
        </div>
        <span className="spacer" />
        <div className="row">
          <a className="button secondary" href={link(`/v1/reports/business-tax.pdf?${qs}`)} target="_blank" rel="noreferrer">PDF</a>
          <a className="button secondary" href={link(`/v1/reports/business-tax?${qs}&format=csv`)} download>CSV</a>
        </div>
      </section>
      {r.warnings.length > 0 && (
        <div className="banner warn"><div><strong>{t('Check before filing')}</strong><ul className="plain small">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>
      )}
      <section className="card">
        <div className="row"><h2>{t('Receipts ({n} documents)', { n: r.documents })}</h2><span className="spacer" /><Link to="/settings?tab=business#taxes" viewTransition className="small">{t('Kinds and rates')} →</Link></div>
        <div className="table-wrap">
          <table className="business-tax">
            <thead><tr><th scope="col">{t('Kind of receipt')}</th><th scope="col" className="right">{t('Receipts before GST')}</th><th scope="col" className="right">{t('Rate')}</th><th scope="col" className="right">{t('Business tax')}</th></tr></thead>
            <tbody>
              {r.kinds.map((k, i) => (
                <tr key={k.name}>
                  <td>{k.name}<div className="small muted">{i === 0 ? (r.kinds.length > 1 ? t('Everything not listed under another kind') : '') : k.categories.length ? k.categories.join(', ') : t('No categories chosen yet')}</div></td>
                  <td className="right">{money(k.receipts)}</td>
                  <td className="right">{k.rate}%</td>
                  <td className="right">{money(k.tax)}</td>
                </tr>
              ))}
              <tr className="total-row"><td><strong>{t('Total')}</strong></td><td className="right"><strong>{money(r.receipts)}</strong></td><td /><td className="right"><strong>{money(r.tax)}</strong></td></tr>
              <tr><td>{r.withheld.invoices === 1 ? t('Less contract tax withheld by customers (1 invoice)') : t('Less contract tax withheld by customers ({n} invoices)', { n: r.withheld.invoices })}</td><td /><td /><td className="right">{toCents(r.withheld.amount) > 0n ? `−${money(r.withheld.amount)}` : money('0.00')}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <p className="small muted">{t('A worksheet to help you fill in your business tax return: receipts come from your authorized e-invoices before GST (credit notes subtract), by the date they were issued. If you sell on account, ask your accountant whether to count a sale when invoiced or when paid. The rates are the ones you set under Settings; check them against what the Belize Tax Service publishes for your kind of business. The return you file is what counts.')}</p>
    </div>
  );
}

// ---------- Settings: kinds, rates, dates ----------

export function TaxSettingsCard() {
  const t = useT();
  const toast = useToast();
  const [saved, setSaved] = useState<TaxSettings | null>(null);
  const [s, setS] = useState<TaxSettings | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<TaxSettings>('/v1/tax-settings').then((r) => { setSaved(r); setS(r); }).catch(setError);
    api<{ data: Array<{ name: string }> }>('/v1/items/categories').then((r) => setCategories(r.data.map((c) => c.name))).catch(() => {});
  }, []);
  if (!s) return <section className="card stack" id="taxes"><h2>{t('Business tax and dates to remember')}</h2>{error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '8rem' }} />}</section>;
  const kind = (i: number, patch: Partial<TaxKind>) => setS({ ...s, kinds: s.kinds.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const date = (i: number, patch: Partial<OwnDate>) => setS({ ...s, dates: s.dates.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const has = (k: TaxKind, c: string) => k.categories.some((x) => x.toLowerCase() === c.toLowerCase());
  // A category belongs to one kind: choosing it here takes it from any other.
  const toggle = (i: number, c: string) => setS({ ...s, kinds: s.kinds.map((k, j) => (j === i ? { ...k, categories: has(k, c) ? k.categories.filter((x) => x.toLowerCase() !== c.toLowerCase()) : [...k.categories, c] } : { ...k, categories: k.categories.filter((x) => x.toLowerCase() !== c.toLowerCase()) })) });
  const unused = s.presets.filter((p) => !s.kinds.some((k) => k.name.toLowerCase() === p.name.toLowerCase()));
  const ok = s.kinds.every((k) => k.name.trim() && RATE.test(k.rate.trim()) && Number(k.rate) <= 50) && s.dates.every((d) => d.name.trim() && d.date);
  const changed = JSON.stringify(s) !== JSON.stringify(saved);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<TaxSettings>('/v1/tax-settings', { method: 'PUT', body: { kinds: s.kinds.map((k) => ({ name: k.name.trim(), rate: k.rate.trim(), categories: k.categories })), gstReturn: s.gstReturn, businessTax: s.businessTax, email: s.email, dates: s.dates.map((d) => ({ ...(d.id && { id: d.id }), name: d.name.trim(), repeats: d.repeats, date: d.date })) } });
      setSaved(r);
      setS(r);
      toast(t('Saved. The business tax worksheet is under Reports.'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" id="taxes">
      <div>
        <h2>{t('Business tax and dates to remember')}</h2>
        <p className="small muted">{t('Business tax is paid each month on what you took in, at a rate that depends on the kind of receipt. Say which kinds you have; Reports then works out the month for you, and the overview and a monthly email remind you what is due.')}</p>
      </div>
      <form className="stack tax-settings" onSubmit={(e) => void save(e)}>
        <strong>{t('Kinds of receipts')}</strong>
        {s.kinds.map((k, i) => (
          <div key={i} className="station">
            <div className="row">
              <Field label={t('Kind of receipt')} className="grow"><input required maxLength={60} value={k.name} onChange={(e) => kind(i, { name: e.target.value })} /></Field>
              <Field label={t('Rate (%)')}><input inputMode="decimal" className="rate-input" required value={k.rate} aria-invalid={!RATE.test(k.rate.trim()) || Number(k.rate) > 50 || undefined} onChange={(e) => kind(i, { rate: e.target.value })} /></Field>
              {s.kinds.length > 1 && i > 0 && <button type="button" className="link" onClick={() => setS({ ...s, kinds: s.kinds.filter((_, j) => j !== i) })}>{t('Remove')}</button>}
            </div>
            {i === 0 ? (s.kinds.length > 1 && <p className="small muted" style={{ margin: 0 }}>{t('Everything you sell that is not listed under another kind.')}</p>) : categories.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{t('Give your items categories under Items first; then choose here which ones are this kind of receipt.')}</p> : (
              <div className="station-categories" role="group" aria-label={t('Categories that are {kind}', { kind: k.name || t('this kind') })}>
                {categories.map((c) => <button key={c} type="button" className="chip-toggle" aria-pressed={has(k, c)} onClick={() => toggle(i, c)}>{c}</button>)}
              </div>
            )}
          </div>
        ))}
        {s.kinds.length < 6 && (
          <div className="row">
            {unused.map((p) => <button key={p.name} type="button" className="secondary small-button" onClick={() => setS({ ...s, kinds: [...s.kinds, { name: p.name, rate: p.rate, categories: [] }] })}>+ {t(p.name)} ({p.rate}%)</button>)}
            <button type="button" className="secondary small-button" onClick={() => setS({ ...s, kinds: [...s.kinds, { name: '', rate: '', categories: [] }] })}>+ {t('Another kind')}</button>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>{t('The rates filled in are the ones the Belize Tax Service publishes for a trade or business (1.75%), a profession (6%) and rents (3%). Other kinds have other rates: ask BTS or your accountant, and type yours.')}</p>

        <strong>{t('What you file each month')}</strong>
        <label className="row small"><input type="checkbox" checked={s.gstReturn} onChange={(e) => setS({ ...s, gstReturn: e.target.checked })} /> {t('A GST return, by the 15th (you are registered for GST)')}</label>
        <label className="row small"><input type="checkbox" checked={s.businessTax} onChange={(e) => setS({ ...s, businessTax: e.target.checked })} /> {t('A business tax return, by the 15th')}</label>

        <strong>{t('Dates of your own')}</strong>
        <p className="small muted" style={{ margin: 0 }}>{t('The trade licence, Social Security contributions, insurance, the land tax: anything you must not miss.')}</p>
        {s.dates.map((d, i) => (
          <div key={d.id ?? i} className="row own-date">
            <Field label={t('What')} className="grow"><input required maxLength={80} value={d.name} onChange={(e) => date(i, { name: e.target.value })} placeholder={t('e.g. Trade licence')} /></Field>
            <Field label={t('Date')}><input type="date" required value={d.date} onChange={(e) => date(i, { date: e.target.value })} /></Field>
            <Field label={t('Repeats')}>
              <Select value={d.repeats} onChange={(e) => date(i, { repeats: e.target.value as OwnDate['repeats'] })}>
                <option value="once">{t('Does not repeat')}</option>
                <option value="monthly">{t('Every month')}</option>
                <option value="yearly">{t('Every year')}</option>
              </Select>
            </Field>
            <button type="button" className="link" onClick={() => setS({ ...s, dates: s.dates.filter((_, j) => j !== i) })}>{t('Remove')}</button>
          </div>
        ))}
        {s.dates.length < 20 && <div><button type="button" className="secondary small-button" onClick={() => setS({ ...s, dates: [...s.dates, { name: '', repeats: 'yearly', date: '' }] })}>+ {t('Add a date')}</button></div>}

        <label className="row small"><input type="checkbox" checked={s.email} onChange={(e) => setS({ ...s, email: e.target.checked })} /> {t('Email owners and admins what is due, once a month (on the 8th)')}</label>
        <ErrorText error={error} />
        <div><button type="submit" disabled={busy || !changed || !ok}>{busy ? t('Saving…') : t('Save')}</button></div>
      </form>
    </section>
  );
}

// ---------- the overview: what is coming up ----------

export function dueName(t: T, lang: string, d: DueDate): string {
  if (d.kind === 'gst' && d.period) return t('GST return for {month}', { month: monthText(d.period.from, lang) });
  if (d.kind === 'business-tax' && d.period) return t('Business tax for {month}', { month: monthText(d.period.from, lang) });
  return d.name;
}

export function ComingUp() {
  const t = useT();
  const { lang } = useI18n();
  const [due, setDue] = useState<DueDate[] | null>(null);
  useEffect(() => void api<{ data: DueDate[] }>('/v1/reports/due-dates?days=30').then((r) => setDue(r.data)).catch(() => setDue([])), []);
  if (!due || due.length === 0) return null;
  return (
    <div className="coming-up">
      <h3>{t('Coming up')}</h3>
      <ul className="todo">
        {due.map((d) => {
          const to = d.kind === 'own' ? '/settings?tab=business#taxes' : d.period ? `/reports?view=${d.kind === 'gst' ? 'gst' : 'business-tax'}&from=${d.period.from}&to=${d.period.to}` : '/reports';
          const about = d.amount === undefined ? '' : toCents(d.amount) < 0n ? t('a credit of about {amount}', { amount: money(d.amount.replace('-', '')) }) : toCents(d.amount) === 0n ? t('nothing to pay so far') : t('about {amount}', { amount: money(d.amount) });
          return (
            <li key={d.key}>
              <Link to={to} viewTransition>
                <span className={`dot ${d.daysLeft <= 3 ? 'bad' : d.daysLeft <= 7 ? 'warn' : ''}`} aria-hidden="true" />
                <span><strong>{dueName(t, lang, d)}</strong>{about && <span className="muted"> · {about}</span>}</span>
                <span className="when">{dayText(d.dueOn, lang)} · {d.daysLeft === 0 ? t('today') : d.daysLeft === 1 ? t('tomorrow') : t('in {n} days', { n: d.daysLeft })}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
