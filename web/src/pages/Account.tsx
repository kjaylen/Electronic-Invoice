/**
 * A customer's account page, opened from a private link: what they owe, paying online, their
 * invoices and receipts, and their statement. No sign-in; the link's token is the permission.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../api';
import { useT } from '../i18n';
import { ErrorText, money, TYPE_NAMES, usePageTitle } from '../ui';
import { PayShell } from './Pay';

interface AccountInfo {
  business: { name: string; email: string; telephone: string };
  customer: { name: string; tin: string | null };
  owed: { total: string; overdue: string };
  open: Array<{ id: string; type: string; number: string; issueDate: string; dueDate: string; total: string; balance: string; daysOverdue: number }>;
  recent: Array<{ id: string; type: string; number: string; issueDate: string; total: string }>;
  payOnline: boolean;
  instructions: string | null;
}

export function CustomerAccount() {
  const t = useT();
  const { token = '' } = useParams();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  usePageTitle(info ? t('{business}: your account', { business: info.business.name }) : t('Your account'));
  const load = useCallback(() => api<AccountInfo>(`/v1/account/${token}`).then(setInfo).catch(setError), [token]);
  useEffect(() => void load(), [load]);

  // Each document opens through its own short-lived link (the PDF, or the page to pay it).
  const open = async (id: string, what: 'pdf' | 'pay') => {
    setBusy(`${id}:${what}`);
    // Opened at once (before the request) so the browser does not block it as a pop-up.
    const win = what === 'pdf' ? window.open('', '_blank') : null;
    try {
      const r = await api<{ url: string; payUrl: string }>(`/v1/account/${token}/documents/${id}/link`, { method: 'POST' });
      if (what === 'pdf') {
        if (win) win.location.href = r.url;
        else window.location.href = r.url;
      } else window.location.href = r.payUrl;
    } catch (e) {
      win?.close();
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (!info) return <PayShell><section className="card pay-card"><ErrorText error={error} />{!error && <div className="skeleton" style={{ height: '16rem' }} />}</section></PayShell>;
  const owes = Number(info.owed.total) > 0;
  return (
    <PayShell>
      <section className="card stack pay-card account-card">
        <div>
          <span className="kicker">{info.business.name}</span>
          <h1>{info.customer.name}</h1>
          {info.customer.tin && <p className="small muted">TIN {info.customer.tin}</p>}
        </div>
        <div className="pay-amount">
          <span className="small muted">{t('You owe')}</span>
          <strong>{money(info.owed.total)}</strong>
          <span className={`small ${Number(info.owed.overdue) > 0 ? 'overdue-text' : 'muted'}`}>{owes ? (Number(info.owed.overdue) > 0 ? t('{amount} is past due', { amount: money(info.owed.overdue) }) : t('Nothing past due')) : t('Nothing to pay. Thank you.')}</span>
        </div>
        <ErrorText error={error} />

        {info.open.length > 0 && (
          <div className="stack">
            <h2>{t('To pay')}</h2>
            <ul className="account-list">
              {info.open.map((d) => (
                <li key={d.id}>
                  <div>
                    <strong>{t(TYPE_NAMES[d.type] ?? 'Invoice')} {d.number}</strong>
                    <span className={`small ${d.daysOverdue > 0 ? 'overdue-text' : 'muted'}`}>{d.daysOverdue > 0 ? t('Was due {date} ({n} days ago)', { date: d.dueDate, n: d.daysOverdue }) : t('Due {date}', { date: d.dueDate })}</span>
                  </div>
                  <span className="spacer" />
                  <strong className="num">{money(d.balance)}</strong>
                  <button type="button" className="secondary" disabled={busy !== null} onClick={() => void open(d.id, 'pdf')}>PDF</button>
                  <button type="button" disabled={busy !== null} onClick={() => void open(d.id, 'pay')}>{busy === `${d.id}:pay` ? t('Opening…') : info.payOnline ? t('Pay') : t('How to pay')}</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {info.instructions && owes && (
          <div className="pay-instructions">
            <h2>{t('Other ways to pay')}</h2>
            <p>{info.instructions}</p>
          </div>
        )}

        {info.recent.length > 0 && (
          <div className="stack">
            <div className="row"><h2>{t('Your documents')}</h2><span className="spacer" /><a className="button secondary" href={`/v1/account/${token}/statement.pdf`} target="_blank" rel="noreferrer">{t('Statement (PDF)')}</a></div>
            <ul className="account-list">
              {info.recent.map((d) => (
                <li key={d.id}>
                  <div>
                    <span>{t(TYPE_NAMES[d.type] ?? 'Document')} {d.number}</span>
                    <span className="small muted">{d.issueDate}</span>
                  </div>
                  <span className="spacer" />
                  <span className="num">{d.type === '04' ? '−' : ''}{money(d.total)}</span>
                  <button type="button" className="link" disabled={busy !== null} onClick={() => void open(d.id, 'pdf')}>PDF</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="small muted">{t('This page is personal: please do not share its link.')} {t('Questions? {email} · {phone}', { email: info.business.email, phone: info.business.telephone })}</p>
      </section>
    </PayShell>
  );
}
