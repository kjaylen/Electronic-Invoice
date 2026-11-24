/**
 * The platform console at /admin, for our own staff: every business, its
 * readiness for BTS production, going live (and back), billing, and the staff log.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useOutletContext, useParams } from 'react-router';
import { api, ApiError, UNAUTHORIZED_EVENT } from '../api';
import { BrandMark } from '../art';
import { AuthPage } from '../scene/AuthShell';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { CodeForm, RecoveryCodes, SetupSteps, type TwoFactorChallenge } from '../twofactor';
import { type BillingInfo, type BillingInvoice, StatusPill } from './Billing';
import { ErrorText, Field, Modal, money, Pager, Segmented, Select, usePageTitle, usePages } from '../ui';
import { ConsoleEmail } from './Email';

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
  suspended?: boolean;
}

interface Person { id: string; name: string; login: string | null; role: string; hasEmail: boolean; twoFactor: boolean; lastLoginAt: string | null }

interface NoticeRow { id: string; message: string; messageEs: string | null; level: 'info' | 'warning'; startsAt: string; endsAt: string | null; createdAt: string; by: string | null; live: boolean }

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
  people: Person[];
  suspended: { at: string; reason: string | null } | null;
  queue: { pending: number; stuck: number; offline: number; outage: boolean };
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
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

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
  'tenant.suspended': 'Suspended the business',
  'tenant.reactivated': 'Reactivated the business',
  'tenant.retried': 'Sent documents waiting for BTS',
  'user.reset_link_sent': 'Emailed a password link',
  'user.two_factor_reset': 'Turned off two-step sign-in',
  'notice.created': 'Posted a notice',
  'notice.ended': 'Ended a notice',
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
        <Route index element={<Overview />} />
        <Route path="businesses" element={<Businesses />} />
        <Route path="businesses/:id" element={<Business />} />
        <Route path="billing" element={<ConsoleBilling />} />
        <Route path="email" element={<ConsoleEmail defaultTo={admin.email} />} />
        <Route path="activity" element={<Activity />} />
        <Route path="notices" element={<Notices />} />
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
      <div className="row console-head"><BrandMark /><span className="kicker">{t('Platform console')}</span></div>
      <h1>{title}</h1>
      {text && <p className="small muted">{text}</p>}
    </>
  );
  if (signedIn) {
    return (
      <AuthPage>
        <div className="card auth-card stack">
          {header(t('Two-step sign-in is on'))}
          <RecoveryCodes codes={signedIn.recoveryCodes} label={`${t('Platform console')}: ${signedIn.admin.email}`} onDone={() => onDone(signedIn.admin)} />
        </div>
      </AuthPage>
    );
  }
  if (challenge?.setup && challenge.secret && challenge.qr) {
    return (
      <AuthPage>
        <div className="card auth-card stack">
          {header(t('Set up two-step sign-in'), t('Staff accounts always use two-step sign-in. Set it up once; every sign-in then asks for a code.'))}
          <SetupSteps info={{ secret: challenge.secret, qr: challenge.qr, otpauthUrl: challenge.otpauthUrl ?? '' }} onConfirm={verify} />
          <button type="button" className="link small" onClick={back}>{t('Back')}</button>
        </div>
      </AuthPage>
    );
  }
  if (challenge) {
    return (
      <AuthPage>
        <div className="card auth-card stack">
          {header(t('Enter your code'), t('Open your authenticator app for the code.'))}
          <CodeForm submitLabel={t('Sign in')} onBack={back} onSubmit={verify} />
        </div>
      </AuthPage>
    );
  }
  return (
    <AuthPage>
      <form className="card auth-card stack" onSubmit={submit}>
        <div className="row console-head"><BrandMark /><span className="kicker">{t('Platform console')}</span></div>
        <h1>{t('Staff sign-in')}</h1>
        <p className="small muted">{t('For the team that runs this service. Businesses sign in at their own address.')}</p>
        <Field label={t('Email')}><input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('Password')}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}<span className="chip" aria-hidden="true">→</span></button>
      </form>
    </AuthPage>
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
          <NavLink to="/admin" end>{t('Overview')}</NavLink>
          <NavLink to="/admin/businesses">{t('Businesses')}</NavLink>
          <NavLink to="/admin/billing">{t('Billing')}</NavLink>
          <NavLink to="/admin/email">{t('Email')}</NavLink>
          <NavLink to="/admin/notices">{t('Notices')}</NavLink>
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

// ---------- overview ----------

type AttentionKind = 'certificate_expired' | 'certificate_expiring' | 'documents_stuck' | 'outage' | 'webhooks_failing' | 'invoice_overdue' | 'trial_ending';
interface AttentionItem { kind: AttentionKind; tenant: { id: string; name: string; slug: string }; severity: 'problem' | 'reminder'; n?: number; at?: string; days?: number; amount?: string }
interface PlatformOverview {
  asOf: string;
  health: {
    status: 'ok' | 'degraded';
    worker: { lastBeatAt: string | null; ageSeconds: number | null; stale: boolean };
    queue: { pending: number; stuckPending: number; contingencyPending: number; openOutages: number; oldestPendingMinutes: number | null };
    certificates: { expiringSoon: number; expired: number };
    problems: Array<{ key: string; message: string }>;
  };
  businesses: { total: number; production: number; new7: number; new30: number; active30: number; stores: number; signups: Array<{ week: string; count: number }> };
  documents: { today: number; last30: number; value30: string; test30: number; rejected30: number; change: number | null };
  store: { open: number; orders30: number; paid30: string };
  billing: { mrr: string; active: number; trialing: number; pastDue: number; suspended: number; openAmount: string; overdueAmount: string };
  top: Array<{ tenant: { id: string; name: string; slug: string }; documents: number; value: string }>;
  newest: Array<{ tenant: { id: string; name: string; slug: string }; environment: 'test' | 'production'; createdAt: string }>;
  attention: AttentionItem[];
}


function attentionLabel(t: ReturnType<typeof useT>, kind: AttentionKind): string {
  switch (kind) {
    case 'certificate_expired': return t('Certificate expired');
    case 'certificate_expiring': return t('Certificate expiring');
    case 'documents_stuck': return t('Stuck with BTS');
    case 'outage': return t('Issuing offline');
    case 'webhooks_failing': return t('Webhooks failing');
    case 'invoice_overdue': return t('Invoice overdue');
    case 'trial_ending': return t('Trial ending');
  }
}

function attentionText(t: ReturnType<typeof useT>, a: AttentionItem): string {
  switch (a.kind) {
    case 'certificate_expired': return t('Their BTS certificate expired on {date}; they cannot issue until a new one is installed', { date: date(a.at ?? null) });
    case 'certificate_expiring': return t('Their BTS certificate expires in {n} days ({date})', { n: a.days ?? 0, date: date(a.at ?? null) });
    case 'documents_stuck': return t('{n} documents waiting for BTS since {time}', { n: a.n ?? 0, time: when(a.at) });
    case 'outage': return t('Issuing offline since {time}; {n} documents still to send', { n: a.n ?? 0, time: when(a.at) });
    case 'webhooks_failing': return t('{n} webhook deliveries failed this week', { n: a.n ?? 0 });
    case 'invoice_overdue': return t('{amount} of your invoices overdue since {date}', { amount: money(a.amount ?? '0'), date: date(a.at ?? null) });
    case 'trial_ending': return t('Their trial ends on {date}', { date: date(a.at ?? null) });
  }
}

function healthProblem(t: ReturnType<typeof useT>, o: PlatformOverview, p: { key: string; message: string }): string {
  switch (p.key) {
    case 'worker_stale': return o.health.worker.lastBeatAt ? t('The background worker last reported at {time}: documents, emails and webhooks are not going out', { time: when(o.health.worker.lastBeatAt) }) : t('The background worker has never reported in: documents, emails and webhooks are not going out');
    case 'documents_stuck': return t('{n} documents have been waiting for BTS for more than 15 minutes', { n: o.health.queue.stuckPending });
    case 'contingency_queue': return t('{n} documents issued offline are waiting to be sent to BTS', { n: o.health.queue.contingencyPending });
    case 'certificates_expired': return t('{n} businesses have an expired BTS certificate', { n: o.health.certificates.expired });
    default: return p.message;
  }
}

function SignupBars({ weeks }: { weeks: PlatformOverview['businesses']['signups'] }) {
  const t = useT();
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const label = (w: { week: string; count: number }) => t('Week of {date}: {n} new', { date: date(w.week), n: w.count });
  return (
    <div>
      <div className="signup-bars" aria-hidden="true">
        {weeks.map((w) => (
          <div key={w.week} className={`sbar${w.count === 0 ? ' zero' : ''}`}>
            <span data-tip={label(w)} style={{ height: `${w.count === 0 ? 0 : Math.max(4, (w.count / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="signup-axis small muted" aria-hidden="true"><span>{date(weeks[0]?.week ?? null)}</span><span>{t('This week')}</span></div>
      <table className="sr-only">
        <caption>{t('New businesses per week')}</caption>
        <thead><tr><th>{t('Week of')}</th><th>{t('New businesses')}</th></tr></thead>
        <tbody>{weeks.map((w) => <tr key={w.week}><td>{date(w.week)}</td><td>{w.count}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Overview() {
  const t = useT();
  usePageTitle(t('Overview'));
  const [o, setO] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<PlatformOverview>('/v1/platform/overview').then(setO).catch(setError), []);
  useEffect(() => {
    void load();
    // Fresh numbers while the page stays open.
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!o) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '14rem' }} />;
  const change = o.documents.change;
  return (
    <div className="stack">
      <div><span className="kicker">{t('Platform console')}</span><h1>{t('Overview')}</h1></div>
      {o.health.status === 'ok' ? (
        <div className="banner ok"><div><strong>{t('Everything is running')}</strong>{t('The background worker is reporting in and nothing is stuck with BTS.')}</div></div>
      ) : (
        <div className="banner warn" role="status">
          <div>
            <strong>{t('The platform needs a look')}</strong>
            <ul className="health-problems">{o.health.problems.map((p) => <li key={p.key}>{healthProblem(t, o, p)}</li>)}</ul>
          </div>
        </div>
      )}
      <div className="kpis">
        <div className="card stat"><span className="label">{t('Businesses')}</span><span className="value">{o.businesses.total}</span><span className="small muted">{t('{n} new this month', { n: o.businesses.new30 })} · {t('{n} in production', { n: o.businesses.production })}</span></div>
        <div className="card stat"><span className="label">{t('Documents, last 30 days')}</span><span className="value">{o.documents.last30.toLocaleString()}</span><span className="small muted">{t('{n} today', { n: o.documents.today })}{change !== null && <> · {change >= 0 ? t('up {n}% on the month before', { n: change }) : t('down {n}% on the month before', { n: -change })}</>}</span></div>
        <div className="card stat"><span className="label">{t('Monthly revenue')}</span><span className="value">{money(o.billing.mrr)}</span><span className="small muted">{t('{n} paying', { n: o.billing.active + o.billing.pastDue })} · {t('{n} on trial', { n: o.billing.trialing })}</span></div>
        <div className="card stat"><span className="label">{t('Online stores')}</span><span className="value">{o.store.open}</span><span className="small muted">{t('{n} orders, {amount} paid in 30 days', { n: o.store.orders30, amount: money(o.store.paid30) })}</span></div>
      </div>
      <div className="grid two">
        <section className="card stack">
          <h2>{t('Needs attention')}</h2>
          {o.attention.length === 0 ? <p className="muted">{t('No business needs a person right now.')}</p> : (
            <ul className="attention-list">
              {o.attention.map((a, i) => (
                <li key={`${a.kind}-${a.tenant.id}-${i}`} className={a.severity}>
                  <div className="row">
                    <Link to={`/admin/businesses/${a.tenant.id}`}><strong>{a.tenant.name}</strong></Link>
                    <span className={`badge ${a.severity === 'problem' ? 'rejected' : 'pending'}`}>{attentionLabel(t, a.kind)}</span>
                  </div>
                  <span className="small">{attentionText(t, a)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card stack">
          <h2>{t('New businesses per week')}</h2>
          <SignupBars weeks={o.businesses.signups} />
          <p className="small muted">{t('{n} signed up this week; {active} of {total} issued a document in the last 30 days.', { n: o.businesses.new7, active: o.businesses.active30, total: o.businesses.total })}</p>
          <h3>{t('Newest')}</h3>
          <ul className="plain-list">
            {o.newest.map((n) => (
              <li key={n.tenant.id} className="row"><Link to={`/admin/businesses/${n.tenant.id}`}>{n.tenant.name}</Link><EnvBadge env={n.environment} /><span className="spacer" /><span className="small muted">{date(n.createdAt)}</span></li>
            ))}
          </ul>
        </section>
      </div>
      <div className="grid two">
        <section className="card stack">
          <h2>{t('Busiest this month')}</h2>
          {o.top.length === 0 ? <p className="muted">{t('No documents in production in the last 30 days yet.')}</p> : (
            <table>
              <thead><tr><th>{t('Business')}</th><th className="num">{t('Documents')}</th><th className="num">{t('Value')}</th></tr></thead>
              <tbody>
                {o.top.map((r) => (
                  <tr key={r.tenant.id}><td data-label={t('Business')}><Link to={`/admin/businesses/${r.tenant.id}`}>{r.tenant.name}</Link></td><td className="num" data-label={t('Documents')}>{r.documents.toLocaleString()}</td><td className="num" data-label={t('Value')}>{money(r.value)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card stack">
          <h2>{t('System')}</h2>
          <dl className="facts">
            <dt>{t('Background worker')}</dt><dd>{o.health.worker.stale ? <span className="badge rejected">{t('Not reporting')}</span> : <span className="badge authorized">{t('Running')}</span>} <span className="small muted">{o.health.worker.lastBeatAt ? when(o.health.worker.lastBeatAt) : t('never')}</span></dd>
            <dt>{t('Waiting for BTS')}</dt><dd>{o.health.queue.pending}{o.health.queue.oldestPendingMinutes !== null && <span className="small muted"> · {t('oldest {n} min', { n: o.health.queue.oldestPendingMinutes })}</span>}</dd>
            <dt>{t('Issued offline, to send')}</dt><dd>{o.health.queue.contingencyPending}{o.health.queue.openOutages > 0 && <span className="small muted"> · {t('{n} businesses offline', { n: o.health.queue.openOutages })}</span>}</dd>
            <dt>{t('Certificates')}</dt><dd>{t('{n} expiring this week', { n: o.health.certificates.expiringSoon })} · {t('{n} expired', { n: o.health.certificates.expired })}</dd>
            <dt>{t('Rejected by BTS, 30 days')}</dt><dd>{o.documents.rejected30}</dd>
            <dt>{t('Test documents, 30 days')}</dt><dd>{o.documents.test30.toLocaleString()}</dd>
            <dt>{t('Your open invoices')}</dt><dd>{money(o.billing.openAmount)} <span className="small muted">· {t('{amount} overdue', { amount: money(o.billing.overdueAmount) })}</span></dd>
          </dl>
          <p className="small muted">{t('Updated {time}', { time: when(o.asOf) })}</p>
        </section>
      </div>
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
                    <td data-label={t('Business')}><Link to={`/admin/businesses/${r.id}`} onClick={(e) => e.stopPropagation()}><strong>{r.name}</strong></Link>{r.suspended && <> <span className="badge rejected">{t('Suspended')}</span></>}<div className="small muted mono">/{r.slug} · {t('{n} users', { n: r.users })}</div></td>
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
  const [action, setAction] = useState<null | { kind: 'suspend' | 'reactivate' } | { kind: 'two-factor'; person: Person }>(null);
  const [retrying, setRetrying] = useState(false);
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
          <span className="kicker"><Link to="/admin/businesses" style={{ color: 'inherit' }}>{t('Businesses')}</Link> / TIN {d.tin}</span>
          <h1>{d.name}</h1>
          <p className="muted">{d.legalName} · <span className="mono">/{d.slug}</span> · {d.contact.city}</p>
        </div>
        <span className="spacer" />
        {d.suspended && <span className="badge rejected">{t('Suspended')}</span>}
        <EnvBadge env={d.environment} />
      </div>

      {d.suspended && (
        <div className="banner bad" role="status">
          <div>
            <strong>{t('Suspended since {date}', { date: when(d.suspended.at) })}</strong>
            {t('No one can sign in; its tills, API keys and online store are refused. Reason: {reason}', { reason: d.suspended.reason ?? '—' })}
          </div>
          <button className="secondary" onClick={() => setAction({ kind: 'reactivate' })}>{t('Reactivate')}</button>
        </div>
      )}

      {(d.queue.pending > 0 || d.queue.offline > 0 || d.queue.outage) && (
        <section className={`card row queue-card${d.queue.stuck > 0 ? ' stuck' : ''}`}>
          <div>
            <h2>{t('Waiting for BTS')}</h2>
            <p className="small muted">
              {t('{n} pending', { n: d.queue.pending })}{d.queue.stuck > 0 && <> · <strong>{t('{n} for more than 15 minutes', { n: d.queue.stuck })}</strong></>} · {t('{n} issued offline, to send', { n: d.queue.offline })}{d.queue.outage && <> · {t('issuing offline now')}</>}
            </p>
          </div>
          <span className="spacer" />
          <button
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void api<{ settled: number; stillPending: number; stillOffline: number; outageClosed: boolean }>(`/v1/platform/tenants/${d.id}/retry`, { method: 'POST' })
                .then((r) => toast(r.settled ? t('{n} documents settled with BTS', { n: r.settled }) : t('Nothing could be settled yet; BTS may still be unreachable.'), r.settled ? 'ok' : 'bad'))
                .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad'))
                .finally(() => { setRetrying(false); void load(); });
            }}
          >{retrying ? t('Sending…') : t('Send now')}</button>
        </section>
      )}

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

      <section className="card stack">
        <div>
          <h2>{t('People')}</h2>
          <p className="small muted">{t('For someone locked out. A password link only ever goes to the person’s own email; you never see it.')}</p>
        </div>
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Role')}</th><th scope="col">{t('Two-step')}</th><th scope="col">{t('Last sign-in')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.id}>
                  <td data-label={t('Name')}><strong>{p.name}</strong><div className="small muted mono">{p.login}</div></td>
                  <td data-label={t('Role')}>{p.role}</td>
                  <td data-label={t('Two-step')}>{p.twoFactor ? <span className="badge authorized">{t('On')}</span> : <span className="muted small">{t('Off')}</span>}</td>
                  <td data-label={t('Last sign-in')} className="small">{p.lastLoginAt ? when(p.lastLoginAt) : <span className="muted">{t('Never')}</span>}</td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: 'flex-end', gap: '0.4rem' }}>
                      <button
                        className="secondary small-button"
                        disabled={!p.hasEmail}
                        title={p.hasEmail ? undefined : t('No email on this account: an owner or admin of the business can set a temporary password')}
                        onClick={() => void api<{ emailed: string }>(`/v1/platform/tenants/${d.id}/users/${p.id}/reset-link`, { method: 'POST' })
                          .then((r) => { toast(t('Password link emailed to {email}', { email: r.emailed })); void load(); })
                          .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad'))}
                      >{t('Email a password link')}</button>
                      {p.twoFactor && <button className="secondary small-button" onClick={() => setAction({ kind: 'two-factor', person: p })}>{t('Turn off two-step')}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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

      {!d.suspended && (
        <section className="card row danger-zone">
          <div>
            <h2>{t('Suspend this business')}</h2>
            <p className="small muted">{t('For fraud, abuse or a legal order. No one can sign in, its tills, API keys and store stop, and its owners are told why. Documents already on their way to BTS still finish.')}</p>
          </div>
          <span className="spacer" />
          <button className="danger" onClick={() => setAction({ kind: 'suspend' })}>{t('Suspend')}</button>
        </section>
      )}

      {dialog && <EnvironmentDialog detail={d} target={dialog} onClose={() => setDialog(null)} onDone={(msg) => { setDialog(null); toast(msg); void load(); }} />}
      {action && <StaffActionDialog detail={d} action={action} onClose={() => setAction(null)} onDone={(msg) => { setAction(null); toast(msg); void load(); }} />}
    </div>
  );
}

/** Suspend, reactivate, or turn off someone's two-step sign-in: each with a reason, for the record. */
function StaffActionDialog({ detail, action, onClose, onDone }: { detail: TenantDetail; action: { kind: 'suspend' | 'reactivate' } | { kind: 'two-factor'; person: Person }; onClose: () => void; onDone: (message: string) => void }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [tin, setTin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const person = action.kind === 'two-factor' ? action.person : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (action.kind === 'suspend') {
        await api(`/v1/platform/tenants/${detail.id}/suspend`, { method: 'POST', body: { confirmTin: tin, reason } });
        onDone(t('{name} is suspended', { name: detail.name }));
      } else if (action.kind === 'reactivate') {
        await api(`/v1/platform/tenants/${detail.id}/reactivate`, { method: 'POST', body: { reason } });
        onDone(t('{name} is active again', { name: detail.name }));
      } else {
        await api(`/v1/platform/tenants/${detail.id}/users/${person!.id}/two-factor/reset`, { method: 'POST', body: { reason } });
        onDone(t('Two-step sign-in is off for {name}', { name: person!.name }));
      }
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'confirmation_mismatch' ? new Error(t('The TIN does not match this business.')) : err);
    } finally {
      setBusy(false);
    }
  };
  const title = action.kind === 'suspend' ? t('Suspend {name}?', { name: detail.name }) : action.kind === 'reactivate' ? t('Reactivate {name}?', { name: detail.name }) : t('Turn off two-step sign-in for {name}?', { name: person!.name });
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {action.kind === 'suspend' && <p className="small">{t('Its owners are emailed the reason, and it appears in the business’s own activity log.')}</p>}
        {action.kind === 'reactivate' && <p className="small">{t('Its people can sign in again and its tills, API keys and store work as before. Its owners are emailed.')}</p>}
        {action.kind === 'two-factor' && <p className="small">{t('Only once you are sure it is them (a lost or replaced phone). They are signed out everywhere, emailed, and set it up again after signing in with their password.')}</p>}
        <Field label={t('Reason')} hint={action.kind === 'two-factor' ? t('How you confirmed who they are.') : undefined}><input required minLength={3} maxLength={500} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {action.kind === 'suspend' && <Field label={t('Type the TIN to confirm: {tin}', { tin: detail.tin })}><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={tin} onChange={(e) => setTin(e.target.value)} /></Field>}
        <ErrorText error={error} />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className={action.kind === 'reactivate' ? '' : 'danger'} disabled={busy || reason.trim().length < 3 || (action.kind === 'suspend' && tin.length !== 6)}>
            {busy ? t('Saving…') : action.kind === 'suspend' ? t('Suspend') : action.kind === 'reactivate' ? t('Reactivate') : t('Turn off two-step')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Notices to every business: shown in their app while they last. */
function Notices() {
  const t = useT();
  const toast = useToast();
  usePageTitle(t('Notices'));
  const [rows, setRows] = useState<NoticeRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ message: '', messageEs: '', level: 'info' as 'info' | 'warning', endsAt: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ data: NoticeRow[] }>('/v1/platform/notices').then((r) => setRows(r.data)).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  const post = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/platform/notices', { method: 'POST', body: { message: form.message, messageEs: form.messageEs || null, level: form.level, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null } });
      setForm({ message: '', messageEs: '', level: 'info', endsAt: '' });
      toast(t('Notice posted to every business'));
      void load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const end = (id: string) => void api(`/v1/platform/notices/${id}/end`, { method: 'POST' }).then(() => { toast(t('Notice ended')); void load(); }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad'));
  return (
    <div className="stack">
      <div><span className="kicker">{t('Platform console')}</span><h1>{t('Notices')}</h1><p className="small muted">{t('A line at the top of every business’s app while it lasts: maintenance, a BTS outage, news. Each person can dismiss it.')}</p></div>
      <form className="card stack" onSubmit={post}>
        <h2>{t('Post a notice')}</h2>
        <Field label={t('Message')}><input required maxLength={500} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder={t('Maintenance tonight from 11 pm to midnight.')} /></Field>
        <Field label={t('In Spanish')} hint={t('Optional: shown to people using the app in Spanish.')}><input maxLength={500} value={form.messageEs} onChange={(e) => setForm({ ...form, messageEs: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label={t('Kind')}>
            <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as 'info' | 'warning' })}>
              <option value="info">{t('Information')}</option>
              <option value="warning">{t('Warning')}</option>
            </Select>
          </Field>
          <Field label={t('Ends')} hint={t('Optional: it stays until you end it.')}><input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></Field>
        </div>
        <ErrorText error={error} />
        <div className="row"><span className="spacer" /><button type="submit" disabled={busy || !form.message.trim()}>{busy ? t('Posting…') : t('Post to every business')}</button></div>
      </form>
      <section className="card stack">
        <h2>{t('Recent notices')}</h2>
        {rows === null ? <div className="skeleton" style={{ height: '6rem' }} /> : rows.length === 0 ? <p className="muted">{t('No notices yet.')}</p> : (
          <ul className="plain-list">
            {rows.map((n) => (
              <li key={n.id} className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{n.live ? <span className={`badge ${n.level === 'warning' ? 'pending' : 'authorized'}`}>{t('Showing')}</span> : <span className="badge cancelled">{t('Ended')}</span>} {n.message}</div>
                  {n.messageEs && <div className="small muted">{n.messageEs}</div>}
                  <div className="small muted">{t('{who}, {date}', { who: n.by ?? t('Someone'), date: when(n.createdAt) })}{n.endsAt && <> · {n.live ? t('until {date}', { date: when(n.endsAt) }) : t('ended {date}', { date: when(n.endsAt) })}</>}</div>
                </div>
                {n.live && <button className="secondary small-button" onClick={() => end(n.id)}>{t('End now')}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
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
  const pages = usePages<AuditRow>(async (cursor) => {
    const r = await api<{ data: AuditRow[]; nextBefore: number | null }>(`/v1/platform/audit${cursor ? `?before=${cursor}` : ''}`);
    return { data: r.data, next: r.nextBefore ? String(r.nextBefore) : null };
  }, 'all');
  const rows = pages.rows;
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
        <Pager pages={pages} newest />
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
        <Select aria-label={t('Plan')} value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)} style={{ maxWidth: 180 }}>
          <option value="starter">Starter</option>
          <option value="business">Business</option>
          <option value="pro">Pro</option>
        </Select>
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
