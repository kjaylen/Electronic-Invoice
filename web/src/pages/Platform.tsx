/**
 * The platform console at /admin, for our own staff: every business, its
 * readiness for BTS production, going live (and back), billing, and the staff log.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useOutletContext, useParams } from 'react-router';
import { api, ApiError, UNAUTHORIZED_EVENT } from '../api';
import { BrandMark, FlowField } from '../art';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { CodeForm, RecoveryCodes, SetupSteps, type TwoFactorChallenge } from '../twofactor';
import { type BillingInfo, type BillingInvoice, StatusPill } from './Billing';
import { ErrorText, Field, Modal, money, Segmented, usePageTitle } from '../ui';

interface StaffAdmin {
  id: string;
  email: string;
  name: string;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  tin: string;
  environment: 'test' | 'production';
  users: number;
  testAuthorized: number;
  productionDocuments: number;
  certificateValidTo: string | null;
  createdAt: string;
  productionSince: string | null;
}

interface TenantDetail {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  tin: string;
  environment: 'test' | 'production';
  contact: { email: string; telephone: string; city: string };
  createdAt: string;
  productionSince: string | null;
  approvalReference: string | null;
  users: number;
  admins: Array<{ name: string; login: string | null; role: string; lastLoginAt: string | null }>;
  certificate: { tin: string; validTo: string; daysLeft: number } | null;
  readiness: { ready: boolean; checks: Array<{ key: string; ok: boolean; required: boolean; detail: string }> };
  documents: { testAuthorized: number; testRejected: number; production: number };
  history: Array<{ action: string; details: Record<string, unknown> | null; at: string; admin: string | null }>;
  billing: Omit<BillingInfo, 'plans' | 'paymentInstructions'>;
}

interface AuditRow {
  id: number;
  action: string;
  details: Record<string, unknown> | null;
  ip: string | null;
  at: string;
  admin: string | null;
  tenant: { id: string; name: string } | null;
}

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const CHECK_LABEL: Record<string, string> = {
  certificate: 'BTS certificate installed and valid',
  nothing_in_flight: 'Nothing waiting for BTS test',
  tested: 'Has authorized test documents',
};

const ACTION_LABEL: Record<string, string> = {
  login: 'Signed in',
  'login.failed': 'Failed staff sign-in',
  'tenant.went_live': 'Moved to production',
  'tenant.back_to_test': 'Moved back to test',
  'invoice.paid': 'Recorded a payment',
  'invoice.voided': 'Voided an invoice',
  'invoice.issued': 'Issued an invoice',
  'subscription.changed': 'Changed a plan',
};

function EnvBadge({ env }: { env: 'test' | 'production' }) {
  const t = useT();
  return <span className={`badge ${env === 'production' ? 'authorized' : 'test'}`}>{env === 'production' ? t('Production') : t('Test')}</span>;
}

/** /admin: sign-in, then the console. */
export function PlatformConsole() {
  const [admin, setAdmin] = useState<StaffAdmin | null | undefined>(undefined);
  const load = useCallback(() => api<{ admin: StaffAdmin }>('/v1/platform/auth/session').then((r) => setAdmin(r.admin)).catch(() => setAdmin(null)), []);
  useEffect(() => {
    void load();
    const signedOut = () => setAdmin(null);
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  }, [load]);
  if (admin === undefined) return <main><div className="skeleton" style={{ height: '10rem' }} /></main>;
  if (!admin) return <StaffLogin onDone={setAdmin} />;
  return (
    <Routes>
      <Route element={<ConsoleLayout admin={admin} onSignOut={() => setAdmin(null)} />}>
        <Route index element={<Businesses />} />
        <Route path="businesses/:id" element={<Business />} />
        <Route path="billing" element={<ConsoleBilling />} />
        <Route path="activity" element={<Activity />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

function StaffLogin({ onDone }: { onDone: (a: StaffAdmin) => void }) {
  const t = useT();
  usePageTitle(t('Platform console'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [signedIn, setSignedIn] = useState<{ admin: StaffAdmin; recoveryCodes: string[] } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setChallenge(await api<TwoFactorChallenge>('/v1/platform/auth/login', { method: 'POST', body: { email, password } }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (code: string) => {
    const r = await api<{ admin: StaffAdmin; recoveryCodes?: string[] }>('/v1/platform/auth/login/verify', { method: 'POST', body: { challenge: challenge!.challenge, code } });
    if (r.recoveryCodes) setSignedIn({ admin: r.admin, recoveryCodes: r.recoveryCodes });
    else onDone(r.admin);
  };
  const back = () => {
    setChallenge(null);
    setPassword('');
  };
  const header = (title: string, text?: string) => (
    <>
      <div className="row"><BrandMark /><span className="kicker">{t('Platform console')}</span></div>
      <h1>{title}</h1>
      {text && <p className="small muted">{text}</p>}
    </>
  );
  if (signedIn) {
    return (
      <div className="console-login">
        <FlowField />
        <div className="card auth-card stack">
          {header(t('Two-step sign-in is on'))}
          <RecoveryCodes codes={signedIn.recoveryCodes} label={`${t('Platform console')}: ${signedIn.admin.email}`} onDone={() => onDone(signedIn.admin)} />
        </div>
      </div>
    );
  }
  if (challenge?.setup && challenge.secret && challenge.qr) {
    return (
      <div className="console-login">
        <FlowField />
        <div className="card auth-card stack">
          {header(t('Set up two-step sign-in'), t('Staff accounts always use two-step sign-in. Set it up once; every sign-in then asks for a code.'))}
          <SetupSteps info={{ secret: challenge.secret, qr: challenge.qr, otpauthUrl: challenge.otpauthUrl ?? '' }} onConfirm={verify} />
          <button type="button" className="link small" onClick={back}>{t('Back')}</button>
        </div>
      </div>
    );
  }
  if (challenge) {
    return (
      <div className="console-login">
        <FlowField />
        <div className="card auth-card stack">
          {header(t('Enter your code'), t('Open your authenticator app for the code.'))}
          <CodeForm submitLabel={t('Sign in')} onBack={back} onSubmit={verify} />
        </div>
      </div>
    );
  }
  return (
    <div className="console-login">
      <FlowField />
      <form className="card auth-card stack" onSubmit={submit}>
        <div className="row"><BrandMark /><span className="kicker">{t('Platform console')}</span></div>
        <h1>{t('Staff sign-in')}</h1>
        <p className="small muted">{t('For the team that runs this service. Businesses sign in at their own address.')}</p>
        <Field label={t('Email')}><input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('Password')}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}<span className="chip" aria-hidden="true">→</span></button>
      </form>
    </div>
  );
}

function ConsoleLayout({ admin, onSignOut }: { admin: StaffAdmin; onSignOut: () => void }) {
  const t = useT();
  const signOut = async () => {
    await api('/v1/platform/auth/logout', { method: 'POST' }).catch(() => {});
    onSignOut();
  };
  return (
    <div className="shell console">
      <header className="topbar console-bar">
        <Link to="/admin" className="brand"><BrandMark /><span>{t('Platform console')}</span></Link>
        <nav aria-label={t('Console')}>
          <NavLink to="/admin" end>{t('Businesses')}</NavLink>
          <NavLink to="/admin/billing">{t('Billing')}</NavLink>
          <NavLink to="/admin/activity">{t('Staff log')}</NavLink>
        </nav>
        <span className="spacer" />
        <span className="who">{admin.name}</span>
        <button className="secondary" onClick={() => void signOut()}>{t('Sign out')}</button>
      </header>
      <main id="main"><div className="page stack"><Outlet context={admin} /></div></main>
    </div>
  );
}

function Businesses() {
  const t = useT();
  usePageTitle(t('Businesses'));
  const navigate = useNavigate();
  const [env, setEnv] = useState<'' | 'test' | 'production'>('test');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const p = new URLSearchParams();
      if (env) p.set('environment', env);
      if (q.trim()) p.set('q', q.trim());
      void api<{ data: TenantRow[] }>(`/v1/platform/tenants?${p}`).then((r) => setRows(r.data)).catch(setError);
    }, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [env, q]);
  return (
    <div className="stack">
      <div><span className="kicker">{t('Platform console')}</span><h1>{t('Businesses')}</h1></div>
      <div className="row">
        <Segmented label={t('Environment')} value={env} onChange={setEnv} options={[['test', t('In test')], ['production', t('In production')], ['', t('All')]]} />
        <span className="spacer" />
        <input type="search" placeholder={t('Name, TIN or address')} aria-label={t('Search businesses')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      <ErrorText error={error} />
      <section className="card">
        {rows === null ? <div className="skeleton" style={{ height: '8rem' }} /> : rows.length === 0 ? <div className="empty">{t('No businesses here.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Business')}</th><th scope="col">TIN</th><th scope="col">{t('Environment')}</th><th scope="col" className="right">{t('Test documents')}</th><th scope="col">{t('Certificate')}</th><th scope="col">{t('Created')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/admin/businesses/${r.id}`)}>
                    <td data-label={t('Business')}><Link to={`/admin/businesses/${r.id}`} onClick={(e) => e.stopPropagation()}><strong>{r.name}</strong></Link><div className="small muted mono">/{r.slug} · {t('{n} users', { n: r.users })}</div></td>
                    <td data-label="TIN" className="mono">{r.tin}</td>
                    <td data-label={t('Environment')}><EnvBadge env={r.environment} />{r.productionSince && <div className="small muted">{t('since {date}', { date: date(r.productionSince) })}</div>}</td>
                    <td data-label={t('Test documents')} className="right">{r.testAuthorized}</td>
                    <td data-label={t('Certificate')} className="small">{r.certificateValidTo ? t('until {date}', { date: date(r.certificateValidTo) }) : <span className="muted">{t('None')}</span>}</td>
                    <td data-label={t('Created')} className="small">{date(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Business() {
  const t = useT();
  const toast = useToast();
  const { id } = useParams();
  useOutletContext<StaffAdmin>();
  const [d, setD] = useState<TenantDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<'live' | 'test' | null>(null);
  usePageTitle(d?.name ?? t('Business'));
  const load = useCallback(() => api<TenantDetail>(`/v1/platform/tenants/${id}`).then(setD).catch(setError), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!d) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '14rem' }} />;
  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker"><Link to="/admin" style={{ color: 'inherit' }}>{t('Businesses')}</Link> / TIN {d.tin}</span>
          <h1>{d.name}</h1>
          <p className="muted">{d.legalName} · <span className="mono">/{d.slug}</span> · {d.contact.city}</p>
        </div>
        <span className="spacer" />
        <EnvBadge env={d.environment} />
      </div>

      {d.environment === 'test' ? (
        <section className={`card stack golive ${d.readiness.ready ? 'ready' : ''}`}>
          <div className="row">
            <div>
              <h2>{t('Move to BTS production')}</h2>
              <p className="small muted">{t('Once BTS has approved this business. Its documents become real tax documents; numbering starts again at 000000001.')}</p>
            </div>
            <span className="spacer" />
            <button className="lime" disabled={!d.readiness.ready} onClick={() => setDialog('live')}>{t('Move to production')}<span className="chip" aria-hidden="true">→</span></button>
          </div>
          <ul className="checks">
            {d.readiness.checks.map((c) => (
              <li key={c.key} className={c.ok ? 'ok' : c.required ? 'bad' : 'warn'}>
                <span className="mark" aria-hidden="true">{c.ok ? '✓' : c.required ? '×' : '!'}</span>
                <span><strong>{t(CHECK_LABEL[c.key] ?? c.key)}</strong>{!c.required && !c.ok && <span className="small muted"> · {t('recommended')}</span>}<div className="small muted">{c.detail}</div></span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="card stack golive live">
          <div className="row">
            <div>
              <h2>{t('In production since {date}', { date: date(d.productionSince) })}</h2>
              <p className="small muted">{t('BTS approval: {ref}', { ref: d.approvalReference ?? '—' })} · {t('{n} production documents', { n: d.documents.production })}</p>
            </div>
            <span className="spacer" />
            {d.documents.production === 0 && <button className="secondary" onClick={() => setDialog('test')}>{t('Move back to test')}</button>}
          </div>
        </section>
      )}

      <PlanSection tenantId={d.id} billing={d.billing} onChanged={() => void load()} />

      <div className="grid two">
        <section className="card stack">
          <h2>{t('Business')}</h2>
          <dl className="facts">
            <dt>{t('Email')}</dt><dd>{d.contact.email}</dd>
            <dt>{t('Telephone')}</dt><dd>{d.contact.telephone}</dd>
            <dt>{t('Created')}</dt><dd>{date(d.createdAt)}</dd>
            <dt>{t('Users')}</dt><dd>{d.users}</dd>
            <dt>{t('Certificate')}</dt><dd>{d.certificate ? t('TIN {tin}, valid until {date}', { tin: d.certificate.tin, date: date(d.certificate.validTo) }) : t('None')}</dd>
            <dt>{t('Test documents')}</dt><dd>{t('{ok} authorized, {bad} rejected', { ok: d.documents.testAuthorized, bad: d.documents.testRejected })}</dd>
          </dl>
        </section>
        <section className="card stack">
          <h2>{t('Owners and admins')}</h2>
          <ul className="plain-list">
            {d.admins.map((a) => <li key={`${a.login}`}><strong>{a.name}</strong> <span className="muted small">· {a.role} · {a.login}</span><div className="small muted">{a.lastLoginAt ? t('Last sign-in {date}', { date: when(a.lastLoginAt) }) : t('Never signed in')}</div></li>)}
          </ul>
        </section>
      </div>

      {d.history.length > 0 && (
        <section className="card stack">
          <h2>{t('Staff actions')}</h2>
          <ol className="activity">
            {d.history.map((h, i) => (
              <li key={i}>
                <time className="mono small muted">{when(h.at)}</time>
                <div><strong>{h.admin ?? t('Someone')}</strong> · {t(ACTION_LABEL[h.action] ?? h.action)}{h.details && <div className="small muted">{Object.entries(h.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>}</div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {dialog && <EnvironmentDialog detail={d} target={dialog} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); toast(msg); void load(); }} />}
    </div>
  );
}

function EnvironmentDialog({ detail, target, onClose, onDone }: { detail: TenantDetail; target: 'live' | 'test'; onClose: () => void; onDone: (message: string) => void }) {
  const t = useT();
  const [approval, setApproval] = useState('');
  const [reason, setReason] = useState('');
  const [retire, setRetire] = useState(false);
  const [tin, setTin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (target === 'live') {
        await api(`/v1/platform/tenants/${detail.id}/go-live`, { method: 'POST', body: { confirmTin: tin, approvalReference: approval, retireCertificate: retire } });
        onDone(t('{name} is in production', { name: detail.name }));
      } else {
        await api(`/v1/platform/tenants/${detail.id}/back-to-test`, { method: 'POST', body: { confirmTin: tin, reason } });
        onDone(t('{name} is back in test', { name: detail.name }));
      }
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'confirmation_mismatch' ? new Error(t('The TIN does not match this business.')) : err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={target === 'live' ? t('Move {name} to production?', { name: detail.name }) : t('Move {name} back to test?', { name: detail.name })} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {target === 'live' ? (
          <>
            <ul className="small">
              <li>{t('From now on its documents go to BTS production and are real tax documents.')}</li>
              <li>{t('Numbering starts again at 000000001 with a new chain. Test documents stay in its records, marked as test.')}</li>
              <li>{t('Its owners are emailed, and the change appears in its activity log.')}</li>
            </ul>
            <Field label={t('BTS approval reference')} hint={t('The reference on BTS’s approval, for the record.')}><input required minLength={3} autoFocus value={approval} onChange={(e) => setApproval(e.target.value)} /></Field>
            <label className="row small"><input type="checkbox" checked={retire} onChange={(e) => setRetire(e.target.checked)} /> {t('Retire the current certificate (BTS issued a separate production certificate; the business installs it before issuing)')}</label>
          </>
        ) : (
          <>
            <p className="small">{t('Allowed only because nothing was issued in production yet.')}</p>
            <Field label={t('Reason')}><input required minLength={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </>
        )}
        <Field label={t('Type the TIN to confirm: {tin}', { tin: detail.tin })}><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={tin} onChange={(e) => setTin(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className={target === 'live' ? 'lime' : 'danger'} disabled={busy || tin.length !== 6}>{busy ? t('Saving…') : target === 'live' ? t('Move to production') : t('Move back to test')}</button>
        </div>
      </form>
    </Modal>
  );
}

function Activity() {
  const t = useT();
  usePageTitle(t('Staff log'));
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const load = async (before?: number) => {
    const r = await api<{ data: AuditRow[]; nextBefore: number | null }>(`/v1/platform/audit${before ? `?before=${before}` : ''}`);
    setRows((prev) => (before ? [...(prev ?? []), ...r.data] : r.data));
    setNext(r.nextBefore);
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="stack">
      <div><span className="kicker">{t('Platform console')}</span><h1>{t('Staff log')}</h1><p className="small muted">{t('Every staff sign-in and change. It cannot be edited or deleted.')}</p></div>
      <section className="card">
        {rows === null ? <div className="skeleton" style={{ height: '8rem' }} /> : (
          <ol className="activity">
            {rows.map((r) => (
              <li key={r.id} className={r.action === 'login.failed' ? 'warn' : ''}>
                <time className="mono small muted">{when(r.at)}</time>
                <div>
                  <strong>{r.admin ?? t('Someone')}</strong> · {t(ACTION_LABEL[r.action] ?? r.action)}
                  {r.tenant && <> · <Link to={`/admin/businesses/${r.tenant.id}`}>{r.tenant.name}</Link></>}
                  {r.details && <div className="small muted">{Object.entries(r.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>}
                </div>
                {r.ip && <span className="mono small muted ip">{r.ip}</span>}
              </li>
            ))}
          </ol>
        )}
        {next && <button className="secondary" onClick={() => void load(next)}>{t('Load more')}</button>}
      </section>
    </div>
  );
}

// ---------- billing ----------

interface ConsoleInvoice extends BillingInvoice {
  tenant: { id: string; name: string; slug: string };
}

interface BillingOverview {
  summary: { mrr: string; trialing: number; active: number; pastDue: number; suspended: number; byPlan: Record<string, number>; openAmount: string; overdueAmount: string };
  invoices: ConsoleInvoice[];
  billingBusinessConfigured: boolean;
}

function InvoiceActions({ invoice, onDone }: { invoice: BillingInvoice; onDone: (message: string) => void }) {
  const t = useT();
  const [dialog, setDialog] = useState<'paid' | 'void' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDialog(null);
      setText('');
      onDone(message);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (invoice.status !== 'open') return null;
  return (
    <>
      <button className="link" onClick={() => setDialog('paid')}>{t('Mark paid')}</button>
      {!invoice.documentId && <button className="link" disabled={busy} onClick={() => void run(() => api(`/v1/platform/invoices/${invoice.id}/issue`, { method: 'POST' }), t('E-invoice issued'))}>{t('Issue e-invoice')}</button>}
      <button className="link danger-link" onClick={() => setDialog('void')}>{t('Void')}</button>
      <ErrorText error={!dialog ? error : null} />
      {dialog && (
        <Modal title={dialog === 'paid' ? t('Record a payment of {amount}', { amount: money(invoice.total) }) : t('Void this invoice?')} onClose={() => setDialog(null)}>
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            void (dialog === 'paid'
              ? run(() => api(`/v1/platform/invoices/${invoice.id}/paid`, { method: 'POST', body: { reference: text } }), t('Payment recorded'))
              : run(() => api(`/v1/platform/invoices/${invoice.id}/void`, { method: 'POST', body: { reason: text } }), t('Invoice voided')));
          }}>
            <Field label={dialog === 'paid' ? t('Payment reference') : t('Reason')} hint={dialog === 'paid' ? t('For example: Belize Bank transfer 8812, received 22 Nov') : undefined}>
              <input required autoFocus value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            {dialog === 'void' && <p className="small muted">{t('A voided invoice is not owed. If an e-invoice was issued for it, issue a credit note for it from the billing business.')}</p>}
            <ErrorText error={error} />
            <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={() => setDialog(null)}>{t('Cancel')}</button><button type="submit" className={dialog === 'void' ? 'danger' : ''} disabled={busy}>{dialog === 'paid' ? t('Record payment') : t('Void')}</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function InvoiceStatus({ i }: { i: BillingInvoice }) {
  const t = useT();
  return i.status === 'paid' ? <span className="badge authorized">{t('Paid')}</span> : i.status === 'void' ? <span className="badge cancelled">{t('Void')}</span> : i.overdue ? <span className="badge rejected">{t('Overdue')}</span> : <span className="badge pending">{t('Open')}</span>;
}

function ConsoleBilling() {
  const t = useT();
  const toast = useToast();
  usePageTitle(t('Billing'));
  const [data, setData] = useState<BillingOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<'open' | 'all'>('open');
  const load = useCallback(() => api<BillingOverview>('/v1/platform/billing').then(setData).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '14rem' }} />;
  const s = data.summary;
  const rows = view === 'open' ? data.invoices.filter((i) => i.status === 'open') : data.invoices;
  return (
    <div className="stack">
      <div><span className="kicker">{t('Platform console')}</span><h1>{t('Billing')}</h1></div>
      {!data.billingBusinessConfigured && <div className="banner warn"><div><strong>{t('No billing business set up')}</strong>{t('Invoices are recorded but not issued as e-invoices. Set PLATFORM_BILLING_TENANT to the address of the platform\'s own business.')}</div></div>}
      <div className="kpis">
        <div className="card stat"><span className="label">{t('Monthly revenue')}</span><span className="value">{money(s.mrr)}</span><span className="small muted">{t('before GST')}</span></div>
        <div className="card stat"><span className="label">{t('Paying businesses')}</span><span className="value">{s.active + s.pastDue}</span><span className="small muted">{t('{n} on trial', { n: s.trialing })}</span></div>
        <div className="card stat"><span className="label">{t('Open invoices')}</span><span className="value">{money(s.openAmount)}</span><span className="small muted">{t('{amount} overdue', { amount: money(s.overdueAmount) })}</span></div>
        <div className="card stat"><span className="label">{t('Paused')}</span><span className="value">{s.suspended}</span><span className="small muted">{t('{n} past due', { n: s.pastDue })}</span></div>
      </div>
      <section className="card stack">
        <div className="row">
          <h2>{t('Invoices')}</h2>
          <span className="spacer" />
          <Segmented label={t('Invoices')} value={view} onChange={setView} options={[['open', t('Open')], ['all', t('All')]]} />
        </div>
        {rows.length === 0 ? <div className="empty">{view === 'open' ? t('Nothing waiting for payment.') : t('No invoices yet.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Business')}</th><th scope="col">{t('Period')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Due')}</th><th scope="col">{t('Status')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td data-label={t('Business')}><Link to={`/admin/businesses/${i.tenant.id}`}>{i.tenant.name}</Link><div className="small muted">{i.planName}{!i.documentId && i.status === 'open' && ` · ${t('no e-invoice')}`}</div></td>
                    <td data-label={t('Period')} className="small">{date(i.periodStart)}</td>
                    <td data-label={t('Total')} className="right">{money(i.total)}</td>
                    <td data-label={t('Due')} className="small">{date(i.dueAt)}</td>
                    <td data-label={t('Status')}><InvoiceStatus i={i} />{i.paidReference && <div className="small muted">{i.paidReference}</div>}</td>
                    <td className="right actions"><InvoiceActions invoice={i} onDone={(m) => { toast(m); void load(); }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PlanSection({ tenantId, billing, onChanged }: { tenantId: string; billing: TenantDetail['billing']; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [plan, setPlan] = useState(billing.plan);
  const [trialDays, setTrialDays] = useState('14');
  const [error, setError] = useState<unknown>(null);
  const save = async (body: Record<string, unknown>, message: string) => {
    setError(null);
    try {
      await api(`/v1/platform/tenants/${tenantId}/subscription`, { method: 'PUT', body });
      toast(message);
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card stack">
      <div className="row">
        <h2>{t('Plan')}: {billing.planName}</h2>
        <span className="spacer" />
        <StatusPill status={billing.status} daysLeft={billing.trialDaysLeft} />
      </div>
      <p className="small muted">
        {t('{docs} production documents this month', { docs: billing.usage.documents })}{billing.usage.documentsLimit !== null && ` / ${billing.usage.documentsLimit}`} · {t('{n} accounts', { n: billing.usage.users })}
        {billing.amountDue !== '0.00' && <> · <strong>{t('{amount} due', { amount: money(billing.amountDue) })}</strong></>}
      </p>
      <div className="row">
        <select aria-label={t('Plan')} value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)} style={{ maxWidth: 180 }}>
          <option value="starter">Starter</option>
          <option value="business">Business</option>
          <option value="pro">Pro</option>
        </select>
        <button className="secondary" disabled={plan === billing.plan} onClick={() => void save({ plan }, t('Plan changed'))}>{t('Set plan')}</button>
        <span className="spacer" />
        <input aria-label={t('Trial days')} type="number" min={1} max={365} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} style={{ width: '5rem' }} />
        <button className="secondary" onClick={() => void save({ trialEndsAt: new Date(Date.now() + Number(trialDays) * 86_400_000).toISOString() }, t('Trial extended'))}>{t('Give a trial')}</button>
      </div>
      {billing.invoices.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <tbody>
              {billing.invoices.slice(0, 6).map((i) => (
                <tr key={i.id}>
                  <td data-label={t('Period')} className="small">{date(i.periodStart)}</td>
                  <td data-label={t('Total')} className="right">{money(i.total)}</td>
                  <td data-label={t('Status')}><InvoiceStatus i={i} /></td>
                  <td className="right actions"><InvoiceActions invoice={i} onDone={(m) => { toast(m); onChanged(); }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={error} />
    </section>
  );
}
