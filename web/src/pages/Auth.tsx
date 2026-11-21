import { type FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { api, type SessionInfo } from '../api';
import { useSession } from '../session';
import { AuthArt } from '../art';
import { ErrorText, Field } from '../ui';

export function Login() {
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<SessionInfo>('/v1/auth/login', { method: 'POST', body: { email, password } });
      setSession(s);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(s.currentBusinessId ? (from ?? '/') : '/onboarding', { replace: true, viewTransition: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <AuthArt kicker="Electronic tax documents" title="Issue it. Sign it. Get it authorized." text="Electronic tax documents for Belize: signed, sent to BTS and printed in seconds, with the legal record kept for you." />
      <div className="auth-form">
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">Welcome back</span>
          <h1>Log in</h1>
        </div>
        <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}<span className="chip">→</span></button>
        <p className="small">New here? <Link to="/signup" viewTransition>Create an account</Link></p>
      </form>
      </div>
    </div>
  );
}

export function Signup() {
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await api<SessionInfo>('/v1/auth/signup', { method: 'POST', body: { name, email, password } }));
      navigate('/onboarding', { replace: true, viewTransition: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <AuthArt kicker="Get started" title="E-invoicing for Belize, without the paperwork." text="Create your account, add your business, install your BTS certificate. You can issue your first invoice in minutes." />
      <div className="auth-form">
      <form className="card auth-card stack" onSubmit={submit}>
        <div>
          <span className="kicker">Step 1 · Account</span>
          <h1>Create your account</h1>
        </div>
        <Field label="Your name"><input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password" hint="At least 10 characters."><input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{busy ? 'Creating…' : 'Create account'}<span className="chip">→</span></button>
        <p className="small">Already have an account? <Link to="/login" viewTransition>Log in</Link></p>
      </form>
      </div>
    </div>
  );
}
