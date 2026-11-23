/** Signing in to this business: log in, forgot password, set a password from a link, replace a temporary password. */

import { type FormEvent, type InputHTMLAttributes, type ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError, type SessionInfo } from '../api';
import { BrandMark } from '../art';
import { AuthPage, useBusinessName } from '../scene/AuthShell';
import { BUSINESS } from '../business';
import { useT } from '../i18n';
import { useSession } from '../session';
import { CodeForm, isChallenge, RecoveryCodes, SetupSteps, type TwoFactorChallenge, type TwoFactorSetupInfo } from '../twofactor';
import { ErrorText, Field, usePageTitle } from '../ui';

/** A sign-in page's card: inside the shared frame (the living panel is AuthShell's). */
function AuthLayout(props: { children: ReactNode }) {
  return <AuthPage>{props.children}</AuthPage>;
}

/** A text field whose label floats up when it has focus or a value. */
function FloatField({ id, label, trailing, invalid, ...input }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; trailing?: ReactNode; invalid?: boolean }) {
  return (
    <div className={`lux-field${trailing ? ' has-trailing' : ''}`}>
      <input id={id} placeholder=" " aria-invalid={invalid || undefined} {...input} />
      <label htmlFor={id}>{label}</label>
      {trailing}
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {!open && <path d="M4 20 20 4" />}
    </svg>
  );
}

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Submit handler with busy and error state. */
function useSubmit(fn: () => Promise<void>) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

function NoSuchBusiness() {
  const t = useT();
  return (
    <AuthLayout>
      <div className="card auth-card stack">
        <h1>{t('No business here')}</h1>
        <p className="muted">{t('There is no business at /{slug}.', { slug: BUSINESS ?? '' })}</p>
        <a className="button big" href="/?choose=1">{t('Find your business')}<span className="chip" aria-hidden="true">→</span></a>
      </div>
    </AuthLayout>
  );
}

export function Login() {
  const t = useT();
  const { name, missing } = useBusinessName();
  usePageTitle(name ? `${t('Log in')} · ${name}` : t('Log in'));
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [shakes, setShakes] = useState(0);
  const enter = (s: SessionInfo) => {
    setSession(s);
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from ?? '/', { replace: true, viewTransition: true });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPhase('busy');
    setError(null);
    try {
      const r = await api<SessionInfo | TwoFactorChallenge>('/v1/auth/login', { method: 'POST', body: { business: BUSINESS, login, password, remember } });
      if (isChallenge(r)) {
        setPhase('idle');
        setChallenge(r);
        return;
      }
      // A beat of success before the app opens.
      setPhase('done');
      await new Promise((done) => setTimeout(done, reduceMotion() ? 0 : 480));
      enter(r);
    } catch (err) {
      setError(err);
      setPhase('error');
      setShakes((n) => n + 1);
    }
  };
  const edited = () => {
    if (phase === 'error') setPhase('idle');
  };
  if (missing) return <NoSuchBusiness />;
  if (session) return <Navigate to="/" replace />;
  if (challenge) {
    return (
      <AuthLayout>
        <div className="card auth-card stack">
          <div>
            <span className="kicker">{name ?? '…'}</span>
            <h1>{t('Enter your code')}</h1>
            <p className="muted">{t('Signing in as {login}.', { login })}</p>
          </div>
          <CodeForm
            submitLabel={t('Log in')}
            onBack={() => { setChallenge(null); setPassword(''); }}
            onSubmit={async (code) => enter(await api<SessionInfo>('/v1/auth/login/verify', { method: 'POST', body: { challenge: challenge.challenge, code, remember } }))}
          />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form className={`card auth-card lux-login stack${shakes ? ` shake-${shakes % 2 ? 'a' : 'b'}` : ''}`} onSubmit={submit} aria-busy={phase === 'busy'}>
        <div className="lux-card-head">
          <span className="lux-mark" aria-hidden="true"><BrandMark /></span>
          <h1>{t('Welcome back')}</h1>
          <p className="muted">{name ? t('Sign in to continue to {name}.', { name }) : t('Sign in to continue.')}</p>
        </div>
        <FloatField id="lux-login" label={t('Email or username')} autoComplete="username" autoCapitalize="none" spellCheck={false} required value={login} invalid={phase === 'error'} onChange={(e) => { setLogin(e.target.value); edited(); }} />
        <FloatField
          id="lux-password"
          label={t('Password')}
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          required
          value={password}
          invalid={phase === 'error'}
          onChange={(e) => { setPassword(e.target.value); edited(); }}
          trailing={
            <button type="button" className="lux-eye" aria-label={showPassword ? t('Hide password') : t('Show password')} aria-pressed={showPassword} aria-controls="lux-password" onClick={() => setShowPassword((v) => !v)}>
              <EyeIcon open={!showPassword} />
            </button>
          }
        />
        <div className="lux-options">
          <label className="lux-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>{t('Keep me signed in')}</span></label>
          <Link to="/forgot-password" viewTransition>{t('Forgot your password?')}</Link>
        </div>
        <ErrorText error={error} />
        <button type="submit" className={`lux-submit ${phase}`} disabled={phase === 'busy' || phase === 'done'}>
          <span className="lux-submit-label">{phase === 'busy' ? t('Logging in…') : phase === 'done' ? t('Signed in') : t('Log in')}</span>
          <span className="lux-submit-icon" aria-hidden="true">
            {phase === 'busy' ? <span className="lux-spinner" /> : phase === 'done' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path className="lux-check-path" d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            ) : (
              <svg className="lux-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
            )}
          </span>
        </button>
        <span className="sr-only" role="status">{phase === 'busy' ? t('Logging in…') : phase === 'done' ? t('Signed in') : ''}</span>
        <p className="small lux-alt">
          <span>{t('Not this business?')} <a href="/?choose=1">{t('Find yours')}</a></span>
          <span>{t('New here?')} <a href="/signup">{t('Create a business')}</a></span>
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const t = useT();
  const { name } = useBusinessName();
  usePageTitle(t('Reset your password'));
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { submit, error, busy } = useSubmit(async () => {
    await api('/v1/auth/password/forgot', { method: 'POST', body: { business: BUSINESS, email } });
    setSent(true);
  });
  return (
    <AuthLayout>
      <div className="card auth-card stack">
        <div>
          <span className="kicker">{name ?? t('Account')}</span>
          <h1>{t('Reset your password')}</h1>
        </div>
        {sent ? (
          <div className="banner ok" role="status"><div><strong>{t('Check your email')}</strong>{t('If an account uses {email}, a link to reset the password is on its way. It works for one hour.', { email })}</div></div>
        ) : (
          <form className="stack" onSubmit={submit}>
            <Field label={t('Email')}><input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <ErrorText error={error} />
            <button type="submit" className="big" disabled={busy}>{busy ? t('Sending…') : t('Email me a link')}<span className="chip" aria-hidden="true">→</span></button>
          </form>
        )}
        <p className="small"><Link to="/login" viewTransition>{t('Back to log in')}</Link></p>
      </div>
    </AuthLayout>
  );
}

interface LinkInfo {
  purpose: 'reset' | 'welcome';
  name: string;
  login: string | null;
  business: { slug: string; name: string };
}

/** From an emailed or shared link: a welcome (new account) or a reset. */
export function ResetPassword() {
  const t = useT();
  const { setSession } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [linkError, setLinkError] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  useEffect(() => {
    if (!token) return setLinkError(new ApiError(400, 'invalid_token', ''));
    void api<LinkInfo>(`/v1/auth/password/link/${encodeURIComponent(token)}`).then(setInfo).catch(setLinkError);
  }, [token]);
  const welcome = info?.purpose === 'welcome';
  usePageTitle(welcome ? t('Welcome') : t('Choose a new password'));
  const { submit, error, busy } = useSubmit(async () => {
    if (password !== confirm) throw new Error(t('The two passwords do not match'));
    const r = await api<SessionInfo | TwoFactorChallenge>('/v1/auth/password/reset', { method: 'POST', body: { token, password } });
    if (isChallenge(r)) return setChallenge(r);
    setSession(r);
    navigate('/', { replace: true, viewTransition: true });
  });
  if (challenge) {
    return (
      <AuthLayout>
        <div className="card auth-card stack">
          <div><span className="kicker">{info?.business.name ?? t('Account')}</span><h1>{t('Enter your code')}</h1></div>
          <CodeForm submitLabel={t('Log in')} onSubmit={async (code) => {
            setSession(await api<SessionInfo>('/v1/auth/login/verify', { method: 'POST', body: { challenge: challenge.challenge, code } }));
            navigate('/', { replace: true, viewTransition: true });
          }} />
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">{info?.business.name ?? t('Account')}</span>
          <h1>{welcome ? t('Welcome, {name}', { name: info!.name }) : t('Choose a new password')}</h1>
          {info?.login && <p className="muted">{t('You sign in as {login}.', { login: info.login })}</p>}
        </div>
        {linkError ? (
          <>
            <ErrorText error={linkError} />
            <p className="small"><Link to="/forgot-password" viewTransition>{t('Ask for a new link')}</Link></p>
          </>
        ) : (
          <>
            <Field label={t('New password')} hint={t('At least 10 characters.')}><input type="password" autoComplete="new-password" required minLength={10} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label={t('Repeat the new password')}><input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <ErrorText error={error} />
            <button type="submit" className="big" disabled={busy || !info}>{busy ? t('Saving…') : t('Save and log in')}<span className="chip" aria-hidden="true">→</span></button>
          </>
        )}
      </form>
    </AuthLayout>
  );
}

/** Signed in with a temporary password an administrator set: choose your own before anything else. */
export function ChangePasswordRequired() {
  const t = useT();
  usePageTitle(t('Choose your password'));
  const { session, refresh, logout } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { submit, error, busy } = useSubmit(async () => {
    if (next !== confirm) throw new Error(t('The two passwords do not match'));
    await api('/v1/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    await refresh();
  });
  return (
    <AuthLayout>
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">{session?.user.name}</span>
          <h1>{t('Choose your password')}</h1>
        </div>
        <Field label={t('Temporary password')}><input type="password" autoComplete="current-password" required autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label={t('New password')} hint={t('At least 10 characters.')}><input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label={t('Repeat the new password')}><input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? t('Saving…') : t('Save and continue')}<span className="chip" aria-hidden="true">→</span></button>
        <button type="button" className="link" onClick={() => void logout()}>{t('Log out')}</button>
      </form>
    </AuthLayout>
  );
}

/** The business requires two-step sign-in for owners and admins: set it up before anything else. */
export function TwoFactorRequired() {
  const t = useT();
  usePageTitle(t('Set up two-step sign-in'));
  const { session, refresh, logout } = useSession();
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState<TwoFactorSetupInfo | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { submit, error, busy } = useSubmit(async () => {
    setInfo(await api<TwoFactorSetupInfo>('/v1/auth/two-factor/setup', { method: 'POST', body: { password } }));
  });
  const business = session?.business.tradeName ?? session?.business.legalName ?? '';
  return (
    <AuthLayout>
      <div className="card auth-card stack">
        <div>
          <span className="kicker">{session?.user.name}</span>
          <h1>{t('Set up two-step sign-in')}</h1>
        </div>
        {codes ? (
          <RecoveryCodes codes={codes} label={`${business}: ${session?.user.email ?? session?.user.username ?? ''}`} onDone={() => void refresh()} />
        ) : info ? (
          <SetupSteps info={info} onConfirm={async (code) => setCodes((await api<{ recoveryCodes: string[] }>('/v1/auth/two-factor/confirm', { method: 'POST', body: { code } })).recoveryCodes)} />
        ) : (
          <form className="stack" onSubmit={submit}>
            <Field label={t('Your password')}><input type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <ErrorText error={error} />
            <button type="submit" className="big" disabled={busy}>{busy ? t('Checking…') : t('Start')}<span className="chip" aria-hidden="true">→</span></button>
          </form>
        )}
        <button type="button" className="link" onClick={() => void logout()}>{t('Log out')}</button>
      </div>
    </AuthLayout>
  );
}
