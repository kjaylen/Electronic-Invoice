/**
 * Deleting a business, for its owners.
 *
 * In Settings → Business, an owner can delete the business: it is closed at
 * once and erased 30 days later. Until then, an owner who signs in sees only
 * the page below: when it will be erased, a way to reopen it, and its
 * records to download. Nobody else can sign in at all.
 */

import { type FormEvent, useState } from 'react';
import { api, type BusinessProfile, link } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, usePageTitle } from '../ui';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The records to take away: this year's and last year's, as the Reports page gives them. */
function RecordLinks() {
  const t = useT();
  const year = new Date().getFullYear();
  const periods: Array<[string, string, string]> = [
    [String(year), `${year}-01-01`, isoDay(new Date())],
    [String(year - 1), `${year - 1}-01-01`, `${year - 1}-12-31`],
  ];
  return (
    <ul className="closed-records">
      {periods.map(([label, from, to]) => (
        <li key={label}>
          <strong>{label}</strong>
          <a href={link(`/v1/reports/archive?from=${from}&to=${to}&pdf=true`)} download>{t('Every document, with its PDF (ZIP)')}</a>
          <a href={link(`/v1/reports/accountant-pack?from=${from}&to=${to}`)} download>{t('For your accountant (ZIP)')}</a>
          <a href={link(`/v1/reports/documents?from=${from}&to=${to}`)} download>{t('All documents (CSV)')}</a>
        </li>
      ))}
    </ul>
  );
}

/** What an owner sees when signing in to a business that has been closed. */
export function BusinessClosed() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { session, refresh, logout } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const name = session?.business.tradeName ?? session?.business.legalName ?? '';
  usePageTitle(t('{name} is closed', { name }));
  const closed = session?.business.closed;
  if (!closed) return null;
  const reopen = async () => {
    if (!(await confirm({ title: t('Reopen {name}?', { name }), body: t('Everyone can sign in again, and the tills, the online store and API keys work as before. Nothing was lost.'), confirm: t('Reopen the business') }))) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/business/reopen', { method: 'POST', body: {} });
      await refresh();
      toast(t('{name} is open again', { name }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="closed-page">
      <div className="card stack closed-card">
        <div>
          <span className="kicker">{session?.user.name}</span>
          <h1>{t('{name} is closed', { name })}</h1>
        </div>
        <div className="banner warn" role="status">
          <div>
            <strong>{t('It will be erased for good on {date}', { date: day(closed.eraseAfter) })}</strong>
            {t('Until then you can reopen it and nothing is lost. Only owners can sign in; the tills, the online store and API keys have stopped.')}
          </div>
        </div>
        <ErrorText error={error} />
        <div className="row">
          <button type="button" className="big" disabled={busy} onClick={() => void reopen()}>{busy ? t('Reopening…') : t('Reopen the business')}</button>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={() => void logout()}>{t('Sign out')}</button>
        </div>
        <section className="stack">
          <h2>{t('Take your records with you')}</h2>
          <p className="small muted" style={{ margin: 0 }}>{t('Once the business is erased these cannot be downloaded again. Documents authorized by the Belize Tax Service stay registered with BTS.')}</p>
          <RecordLinks />
        </section>
      </div>
    </main>
  );
}

/** Settings → Business, for owners: delete the business. Asked for on purpose: its name typed out, and the owner's password. */
export function DeleteBusinessCard({ profile }: { profile: BusinessProfile }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section className="card stack danger-zone">
      <h2>{t('Delete this business')}</h2>
      <p className="small muted" style={{ margin: 0 }}>{t('Closes the business at once and erases everything it holds after 30 days. Until then an owner can sign in and reopen it.')}</p>
      <div><button type="button" className="danger-outline secondary" onClick={() => setOpen(true)}>{t('Delete this business…')}</button></div>
      {open && <DeleteBusinessDialog profile={profile} onClose={() => setOpen(false)} />}
    </section>
  );
}

function DeleteBusinessDialog({ profile, onClose }: { profile: BusinessProfile; onClose: () => void }) {
  const t = useT();
  const { refresh } = useSession();
  const display = profile.tradeName ?? profile.legalName;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const matches = [profile.legalName, profile.tradeName ?? ''].some((n) => n.trim() && n.trim().toLowerCase() === name.trim().toLowerCase());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/business/close', { method: 'POST', body: { name: name.trim(), password } });
      // The session now says the business is closed: the app shows that page instead of this one.
      await refresh();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Delete {name}?', { name: display })} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <ul className="closed-steps">
          <li><strong>{t('Now:')}</strong> {t('the business is closed. Everyone but its owners is signed out; the tills, the online store and API keys stop; nothing new is issued, billed or emailed.')}</li>
          <li><strong>{t('For 30 days:')}</strong> {t('an owner can sign in, download its records and reopen it. Nothing is lost.')}</li>
          <li><strong>{t('After 30 days:')}</strong> {t('every document, customer, product, order and setting is erased for good, and this address is free for someone else.')}</li>
        </ul>
        {profile.environment === 'production' && (
          <div className="banner warn" role="note">
            <div>
              <strong>{t('This business issues real tax documents')}</strong>
              {t('Documents authorized by the Belize Tax Service stay registered with BTS, but your copies here are erased. Download your records first (Reports → Download archive), and keep them as long as the law asks.')}
            </div>
          </div>
        )}
        <Field label={t('Type the name of the business to go ahead')} hint={display}>
          <input autoFocus autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('Your password')}>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <div className="row confirm-actions">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="danger" disabled={busy || !matches || !password}>{busy ? t('Closing…') : t('Delete this business')}</button>
        </div>
      </form>
    </Modal>
  );
}
