/**
 * The page a customer opens from an invoice email: what is owed, the PDF, and
 * paying it online. No sign-in; the link's token is the permission.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { Brand } from '../art';
import { LanguageToggle, useT } from '../i18n';
import { ErrorText, money, PaymentBadge, TYPE_NAMES, usePageTitle } from '../ui';
import type { InvoiceStatus } from '../api';
import { PROVIDER_BUTTON, PROVIDER_NOTE, WalletPay, type WalletInfo } from '../wallet';

interface PayInfo {
  business: { name: string; email: string; telephone: string };
  document: { type: string; number: string; issueDate: string; valid: boolean };
  invoice: { customer: string; dueDate: string; total: string; paid: string; credited: string; balance: string; status: InvoiceStatus; daysOverdue: number } | null;
  pdfUrl: string;
  online: { provider: string; providers: string[] } | null;
  instructions: string | null;
}

export function PayInvoice() {
  const t = useT();
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const testId = params.get('test');
  const paymentId = params.get('payment');
  const cancelled = params.get('cancelled') === '1';
  const [info, setInfo] = useState<PayInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; problem: string | null; wallet?: WalletInfo | null } | null>(null);
  usePageTitle(info ? `${t(TYPE_NAMES[info.document.type] ?? 'Invoice')} ${info.document.number}` : t('Pay an invoice'));

  const load = useCallback(() => api<PayInfo>(`/v1/pay/${token}`).then(setInfo).catch(setError), [token]);
  useEffect(() => void load(), [load]);

  // Back from the payment provider: ask whether it was paid (a few times while it is still pending).
  const tries = useRef(0);
  useEffect(() => {
    if (!paymentId) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await api<{ status: string; problem: string | null; wallet?: WalletInfo | null }>(`/v1/pay/${token}/payments/${paymentId}/confirm`, { method: 'POST' });
        if (stop) return;
        setOutcome(r);
        if (r.status === 'paid') void load();
        // A wallet payment waits for the customer to accept it in the app: keep asking for a while.
        if (r.status === 'pending' && tries.current++ < (r.wallet ? 200 : 10)) setTimeout(() => void check(), 3000);
      } catch (e) {
        if (!stop) setError(e);
      }
    };
    void check();
    return () => {
      stop = true;
    };
  }, [paymentId, token, load]);

  const pay = async (provider: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirectUrl: string }>(`/v1/pay/${token}/start`, { method: 'POST', body: { provider } });
      if (r.redirectUrl.startsWith('/')) navigate(r.redirectUrl);
      else window.location.assign(r.redirectUrl);
      setBusy(false);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (error instanceof ApiError && error.status === 404) {
    return <PayShell><section className="card stack pay-card"><h1>{t('This link is not available')}</h1><p className="muted">{t('It may have expired. Ask the business to send it again.')}</p></section></PayShell>;
  }
  if (!info) return <PayShell><section className="card pay-card"><ErrorText error={error} />{!error && <div className="skeleton" style={{ height: '16rem' }} />}</section></PayShell>;
  if (testId) return <PayShell><TestCard token={token} paymentId={testId} business={info.business.name} /></PayShell>;

  const inv = info.invoice;
  const owed = Boolean(inv && Number(inv.balance) > 0);
  return (
    <PayShell>
      <section className="card stack pay-card">
        <div className="row">
          <div>
            <span className="kicker">{info.business.name}</span>
            <h1>{t(TYPE_NAMES[info.document.type] ?? 'Invoice')} <span className="mono">{info.document.number}</span></h1>
          </div>
          <span className="spacer" />
          {inv && <PaymentBadge status={inv.status} />}
        </div>

        {outcome?.status === 'paid' && <div className="banner ok"><div><strong>{t('Thank you, your payment was received.')}</strong>{t('{business} has been notified. You can close this page.', { business: info.business.name })}</div></div>}
        {outcome?.status === 'pending' && !outcome.wallet && <div className="banner info"><div><strong>{t('Checking your payment…')}</strong>{t('This can take a moment.')}</div></div>}
        {outcome?.status === 'failed' && <div className="banner bad"><div><strong>{t('The payment did not go through.')}</strong>{outcome.problem ?? t('No money was taken. You can try again.')}</div></div>}
        {cancelled && !outcome && <div className="banner warn"><div><strong>{t('Payment cancelled')}</strong>{t('Nothing was charged. You can try again when you are ready.')}</div></div>}

        {!info.document.valid && <div className="banner warn"><div>{t('This document is no longer valid (it was cancelled or replaced). Contact {business}.', { business: info.business.name })}</div></div>}

        {inv ? (
          <>
            <div className="pay-amount">
              <span className="small muted">{owed ? t('Amount due') : t('Balance')}</span>
              <strong>{money(inv.balance)}</strong>
              <span className="small muted">{owed ? (inv.daysOverdue > 0 ? t('Was due {date} ({n} days ago)', { date: inv.dueDate, n: inv.daysOverdue }) : t('Due {date}', { date: inv.dueDate })) : t('Nothing left to pay. Thank you.')}</span>
            </div>
            <dl className="pay-facts">
              <div><dt>{t('Billed to')}</dt><dd>{inv.customer}</dd></div>
              <div><dt>{t('Issued')}</dt><dd>{info.document.issueDate}</dd></div>
              <div><dt>{t('Invoice total')}</dt><dd>{money(inv.total)}</dd></div>
              {Number(inv.paid) + Number(inv.credited) > 0 && <div><dt>{t('Paid or credited')}</dt><dd>{money((Number(inv.paid) + Number(inv.credited)).toFixed(2))}</dd></div>}
            </dl>
          </>
        ) : (
          <p className="muted">{t('Issued {date}.', { date: info.document.issueDate })}</p>
        )}

        {outcome?.status === 'pending' && outcome.wallet && inv && <WalletPay wallet={outcome.wallet} amount={inv.balance} />}

        <ErrorText error={error} />
        {owed && info.online && outcome?.status !== 'paid' && !(outcome?.status === 'pending' && outcome.wallet) && (
          <div className="pay-methods">
            {info.online.providers.map((p, i) => (
              <button key={p} className={i === 0 ? 'lime big' : 'secondary big'} disabled={busy} onClick={() => void pay(p)}>
                <span>{busy ? t('Opening…') : info.online!.providers.length === 1 ? t('Pay {amount} online', { amount: money(inv!.balance) }) : t(PROVIDER_BUTTON[p] ?? 'Pay online')}</span>
                <span className="small pay-method-note">{t(PROVIDER_NOTE[p] ?? '')}</span>
              </button>
            ))}
          </div>
        )}
        <div className="action-grid">
          <a className="button secondary" href={info.pdfUrl} target="_blank" rel="noreferrer">{t('View the invoice (PDF)')}</a>
        </div>

        {info.instructions && owed && (
          <div className="pay-instructions">
            <h2>{t('Other ways to pay')}</h2>
            <p>{info.instructions}</p>
          </div>
        )}
        <p className="small muted">{t('Questions? {email} · {phone}', { email: info.business.email, phone: info.business.telephone })}</p>
      </section>
    </PayShell>
  );
}

export function PayShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="pay-page">
      <header className="row pay-top"><span className="brand"><Brand /></span><span className="spacer" /><LanguageToggle /></header>
      {children}
    </main>
  );
}

/** The test gateway's pretend card (BTS test environment only). */
function TestCard({ token, paymentId, business }: { token: string; paymentId: string; business: string }) {
  const t = useT();
  const navigate = useNavigate();
  const [p, setP] = useState<{ amount: string; status: string; decided: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<NonNullable<typeof p>>(`/v1/pay/${token}/test/${paymentId}`).then(setP).catch(setError), [token, paymentId]);
  const decide = async (decision: 'approved' | 'declined') => {
    setBusy(true);
    try {
      await api(`/v1/pay/${token}/test/${paymentId}`, { method: 'POST', body: { decision } });
      navigate(`/pay/${token}?payment=${paymentId}`, { replace: true });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  if (!p) return <section className="card pay-card"><ErrorText error={error} />{!error && <div className="skeleton" style={{ height: '12rem' }} />}</section>;
  return (
    <div className="stack test-pay">
      <div className="banner warn"><div><strong>{t('Test payment')}</strong>{t('This business is in the BTS test environment. No card is charged and no money moves.')}</div></div>
      <section className="card stack fake-card">
        <span className="kicker">{business}</span>
        <div className="fake-card-amount">{money(p.amount)}</div>
        <div className="fake-card-number mono">4242 4242 4242 4242</div>
        <div className="row small muted"><span>12 / 34</span><span className="spacer" /><span>CVC 123</span></div>
        <ErrorText error={error} />
        <div className="row">
          <button className="secondary" disabled={busy || p.decided} onClick={() => void decide('declined')}>{t('Decline')}</button>
          <span className="spacer" />
          <button className="lime" disabled={busy || p.decided} onClick={() => void decide('approved')}>{t('Pay {amount}', { amount: money(p.amount) })}</button>
        </div>
      </section>
    </div>
  );
}
