import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError, type SessionInfo } from '../api';
import { AuthArt } from '../art';
import { LanguageToggle, useT } from '../i18n';
import { useSession } from '../session';
import { ErrorText, Field, usePageTitle } from '../ui';

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

export function Login() {
  const t = useT();
  usePageTitle(t('Log in'));
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(async () => {
    const s = await api<SessionInfo>('/v1/auth/login', { method: 'POST', body: { email, password } });
    setSession(s);
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from?.startsWith('/invite') ? from : s.currentBusinessId ? (from ?? '/') : '/onboarding', { replace: true, viewTransition: true });
  });
  if (session) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from?.startsWith('/invite') ? from : '/'} replace />;
  }

  return (
    <AuthLayout art={{ kicker: t('Electronic tax documents'), title: t('Issue it. Sign it. Get it authorized.'), text: t('Electronic tax documents for Belize: signed, sent to BTS and printed in seconds, with the legal record kept for you.') }}>
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">{t('Welcome back')}</span>
          <h1>{t('Log in')}</h1>
        </div>
        <Field label={t('Email')}><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('Password')}><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <p className="small right"><Link to="/forgot-password" viewTransition>{t('Forgot your password?')}</Link></p>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? t('Logging in…') : t('Log in')}<span className="chip" aria-hidden="true">→</span></button>
        <p className="small">{t('New here?')} <Link to="/signup" viewTransition>{t('Create an account')}</Link></p>
      </form>
    </AuthLayout>
  );
}

export function Signup() {
  const t = useT();
  usePageTitle(t('Create your account'));
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(async () => {
    setSession(await api<SessionInfo>('/v1/auth/signup', { method: 'POST', body: { name, email, password } }));
    navigate('/onboarding', { replace: true, viewTransition: true });
  });
  if (session) return <Navigate to="/" replace />;

  return (
    <AuthLayout art={{ kicker: t('Get started'), title: t('E-invoicing for Belize, without the paperwork.'), text: t('Create your account, add your business, install your BTS certificate. You can issue your first invoice in minutes.') }}>
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">{t('Step 1 · Account')}</span>
          <h1>{t('Create your account')}</h1>
        </div>
        <Field label={t('Your name')}><input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Email')}><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('Password')} hint={t('At least 10 characters.')}><input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? t('Creating…') : t('Create account')}<span className="chip" aria-hidden="true">→</span></button>
        <p className="small">{t('Already have an account?')} <Link to="/login" viewTransition>{t('Log in')}</Link></p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const t = useT();
  usePageTitle(t('Reset your password'));
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { submit, error, busy } = useSubmit(async () => {
    await api('/v1/auth/password/forgot', { method: 'POST', body: { email } });
    setSent(true);
  });
  return (
    <AuthLayout art={{ kicker: t('Account'), title: t('Locked out? It happens.'), text: t('We email you a link to choose a new password. It works once, for one hour.') }}>
      <div className="card auth-card stack">
        <div>
          <span className="kicker">{t('Account')}</span>
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

export function ResetPassword() {
  const t = useT();
  usePageTitle(t('Choose a new password'));
  const { setSession } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { submit, error, busy } = useSubmit(async () => {
    if (password !== confirm) throw new Error(t('The two passwords do not match'));
    const s = await api<SessionInfo>('/v1/auth/password/reset', { method: 'POST', body: { token, password } });
    setSession(s);
    navigate(s.currentBusinessId ? '/' : '/onboarding', { replace: true, viewTransition: true });
  });
  return (
    <AuthLayout art={{ kicker: t('Account'), title: t('A fresh start.'), text: t('Choose a new password. You will be signed out on every other device.') }}>
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">{t('Account')}</span>
          <h1>{t('Choose a new password')}</h1>
        </div>
        {!token && <div className="banner bad"><div>{t('This link is incomplete. Open the link from the email again.')}</div></div>}
        <Field label={t('New password')} hint={t('At least 10 characters.')}><input type="password" autoComplete="new-password" required minLength={10} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label={t('Repeat the new password')}><input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy || !token}>{busy ? t('Saving…') : t('Save and log in')}<span className="chip" aria-hidden="true">→</span></button>
        <p className="small"><Link to="/forgot-password" viewTransition>{t('Ask for a new link')}</Link></p>
      </form>
    </AuthLayout>
  );
}

interface InvitationInfo {
  businessName: string;
  invitedByName: string;
  email: string;
  role: 'owner' | 'member';
  accountExists: boolean;
}

export function AcceptInvite() {
  const t = useT();
  usePageTitle(t('Join the team'));
  const { session, setSession, logout } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!token) return setLoadError(new ApiError(404, 'invalid_token', 'This invitation is invalid, already used or expired. Ask for a new one.'));
    void api<InvitationInfo>(`/v1/auth/invitations/${encodeURIComponent(token)}`).then(setInfo).catch(setLoadError);
  }, [token]);
  const { submit, error, busy } = useSubmit(async () => {
    const s = await api<SessionInfo>('/v1/auth/invitations/accept', { method: 'POST', body: { token, ...(!session && { name, password }) } });
    setSession(s);
    navigate('/', { replace: true, viewTransition: true });
  });

  const role = info?.role === 'owner' ? t('an owner') : t('a team member');
  const wrongAccount = session && info && session.user.email !== info.email;
  return (
    <AuthLayout art={{ kicker: t('Invitation'), title: info ? t('Join {business}', { business: info.businessName }) : t('Join the team'), text: t('Issue invoices and receipts together, each with your own login.') }}>
      <div className="card auth-card stack">
        <div>
          <span className="kicker">{t('Invitation')}</span>
          <h1>{info ? t('Join {business}', { business: info.businessName }) : t('Join the team')}</h1>
        </div>
        {loadError ? <ErrorText error={loadError} /> : !info ? <div className="skeleton" /> : (
          <>
            <p>{t('{name} invited {email} to join as {role}.', { name: info.invitedByName, email: info.email, role })}</p>
            {wrongAccount ? (
              <>
                <div className="banner warn"><div>{t('You are logged in as {email}. Log out, then open the link again.', { email: session.user.email })}</div></div>
                <button className="secondary" onClick={() => void logout()}>{t('Log out')}</button>
              </>
            ) : session ? (
              <form className="stack" onSubmit={submit}>
                <ErrorText error={error} />
                <button type="submit" className="big" disabled={busy}>{busy ? t('Joining…') : t('Accept and join')}<span className="chip" aria-hidden="true">→</span></button>
              </form>
            ) : info.accountExists ? (
              <>
                <p className="muted">{t('You already have an account. Log in as {email} to accept.', { email: info.email })}</p>
                <Link className="button big" to="/login" state={{ from: `/invite?token=${token}` }}>{t('Log in')}<span className="chip" aria-hidden="true">→</span></Link>
              </>
            ) : (
              <form className="stack" onSubmit={submit}>
                <Field label={t('Email')}><input value={info.email} disabled /></Field>
                <Field label={t('Your name')}><input autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label={t('Choose a password')} hint={t('At least 10 characters.')}><input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                <ErrorText error={error} />
                <button type="submit" className="big" disabled={busy}>{busy ? t('Joining…') : t('Create account and join')}<span className="chip" aria-hidden="true">→</span></button>
              </form>
            )}
          </>
        )}
      </div>
    </AuthLayout>
  );
}
