/** Signing in to this business: log in, forgot password, set a password from a link, replace a temporary password. */

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError, type SessionInfo } from '../api';
import { AuthArt } from '../art';
import { BUSINESS } from '../business';
import { LanguageToggle, useT } from '../i18n';
import { useSession } from '../session';
import { CodeForm, isChallenge, RecoveryCodes, SetupSteps, type TwoFactorChallenge, type TwoFactorSetupInfo } from '../twofactor';
import { ErrorText, Field, usePageTitle } from '../ui';

/** The business's public name, for its sign-in pages. */
function useBusinessName(): { name: string | null; missing: boolean } {
  const [state, setState] = useState<{ name: string | null; missing: boolean }>({ name: null, missing: false });
  useEffect(() => {
    if (!BUSINESS) return;
    void api<{ name: string }>(`/v1/auth/business/${BUSINESS}`)
      .then((b) => setState({ name: b.name, missing: false }))
      .catch((e) => setState({ name: null, missing: e instanceof ApiError && e.status === 404 }));
  }, []);
  return state;
}

function AuthLayout(props: { art: { kicker: string; title: string; text: string }; children: ReactNode }) {
  return (
    <div className="auth-page">
      <AuthArt {...props.art} />
      <div className="auth-form">
        <div className="auth-lang"><LanguageToggle /></div>
        {props.children}
      </div>
    </div>
  );
}

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
    <AuthLayout art={{ kicker: t('Electronic tax documents'), title: t('Nothing at this address.'), text: t('Check the link with your administrator.') }}>
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
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const enter = (s: SessionInfo) => {
    setSession(s);
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from ?? '/', { replace: true, viewTransition: true });
  };
  const { submit, error, busy } = useSubmit(async () => {
    const r = await api<SessionInfo | TwoFactorChallenge>('/v1/auth/login', { method: 'POST', body: { business: BUSINESS, login, password } });
    if (isChallenge(r)) setChallenge(r);
    else enter(r);
  });
  if (missing) return <NoSuchBusiness />;
  if (session) return <Navigate to="/" replace />;
  if (challenge) {
    return (
      <AuthLayout art={{ kicker: name ?? t('Account'), title: t('One more step.'), text: t('Your account is protected with two-step sign-in. Open your authenticator app for the code.') }}>
        <div className="card auth-card stack">
          <div>
            <span className="kicker">{name ?? '…'}</span>
            <h1>{t('Enter your code')}</h1>
            <p className="muted">{t('Signing in as {login}.', { login })}</p>
          </div>
          <CodeForm
            submitLabel={t('Log in')}
            onBack={() => { setChallenge(null); setPassword(''); }}
            onSubmit={async (code) => enter(await api<SessionInfo>('/v1/auth/login/verify', { method: 'POST', body: { challenge: challenge.challenge, code } }))}
          />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout art={{ kicker: t('Electronic tax documents'), title: name ?? t('Issue it. Sign it. Get it authorized.'), text: t('Sign in with the email or username your administrator gave you.') }}>
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">{name ?? '…'}</span>
          <h1>{t('Log in')}</h1>
        </div>
        <Field label={t('Email or username')}><input autoComplete="username" autoCapitalize="none" spellCheck={false} required value={login} onChange={(e) => setLogin(e.target.value)} /></Field>
        <Field label={t('Password')}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <p className="small right"><Link to="/forgot-password" viewTransition>{t('Forgot your password?')}</Link></p>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? t('Logging in…') : t('Log in')}<span className="chip" aria-hidden="true">→</span></button>
        <p className="small muted">{t('Not this business?')} <a href="/?choose=1">{t('Find yours')}</a></p>
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
    <AuthLayout art={{ kicker: name ?? t('Account'), title: t('Locked out? It happens.'), text: t('We email you a link to choose a new password. It works once, for one hour. No email on your account? Ask your administrator to reset it.') }}>
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
      <AuthLayout art={{ kicker: info?.business.name ?? t('Account'), title: t('Password saved.'), text: t('Your account also uses two-step sign-in: enter the code from your authenticator app.') }}>
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
    <AuthLayout art={{ kicker: info?.business.name ?? t('Account'), title: welcome ? t('Welcome to the team.') : t('A fresh start.'), text: welcome ? t('Choose your password, then you are in.') : t('Choose a new password. You will be signed out on every other device.') }}>
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
    <AuthLayout art={{ kicker: session?.business.tradeName ?? session?.business.legalName ?? '', title: t('Make it yours.'), text: t('Your administrator gave you a temporary password. Choose your own to continue; only you will know it.') }}>
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
    <AuthLayout art={{ kicker: business, title: t('Lock the door.'), text: t('{business} requires two-step sign-in for owners and admins. After your password, you will also enter a code from your phone.', { business }) }}>
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
