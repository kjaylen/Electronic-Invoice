import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api, type SessionInfo } from '../api';
import { AuthArt } from '../art';
import { LanguageToggle, useT } from '../i18n';
import { useSession } from '../session';
import { DISTRICTS, ErrorText, Field, usePageTitle } from '../ui';
import { CertificateUpload } from './Settings';

/** Step 1: the business. Step 2: its BTS certificate (can be done later). */
export function Onboarding() {
  const t = useT();
  usePageTitle(t('Your business'));
  const { loading, session, me, setSession } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ legalName: '', tradeName: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (loading) return <main className="muted">{t('Loading…')}</main>;
  if (!session) return <Navigate to="/login" replace />;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<SessionInfo>('/v1/auth/businesses', {
        method: 'POST',
        body: {
          legalName: form.legalName,
          ...(form.tradeName && { tradeName: form.tradeName }),
          tin: form.tin,
          address: { street: form.street, city: form.city, districtCode: form.districtCode },
          contact: { telephone: form.telephone, email: form.email },
        },
      });
      setSession(s);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // Step 2, once the business exists.
  if (session.currentBusinessId && me) {
    return (
      <div className="auth-page">
        <AuthArt kicker={t('Almost there')} title={t('Your certificate is your signature.')} text={t('It signs every document and proves to BTS it came from you. We keep it encrypted, and it never leaves this service.')} />
        <div className="auth-form">
          <div className="auth-lang"><LanguageToggle /></div>
          <div className="card auth-card wide stack">
            <div>
              <span className="kicker">{t('Step 3 · Certificate')}</span>
              <h1>{t('Install your BTS certificate')}</h1>
              <p className="muted">{t('BTS gives each business a digital certificate (a .pfx or .p12 file and its password). It signs your invoices and identifies you to BTS. It is stored encrypted and never leaves this service.')}</p>
            </div>
            {me.certificate ? (
              <div className="banner ok"><div><strong>{t('Certificate installed')}</strong>{t('Valid until {date}.', { date: me.certificate.validTo.slice(0, 10) })}</div></div>
            ) : (
              <CertificateUpload onDone={() => navigate('/', { replace: true, viewTransition: true })} />
            )}
            <div className="row">
              <span className="spacer" />
              <button className={me.certificate ? 'big' : 'secondary'} onClick={() => navigate('/', { replace: true, viewTransition: true })}>
                {me.certificate ? t('Go to the overview') : t('Do this later')}{me.certificate && <span className="chip" aria-hidden="true">→</span>}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <AuthArt kicker={t('Your business')} title={t('Tell us who is issuing.')} text={t('Exactly as registered with the Belize Tax Service. You start in the BTS test environment, so nothing counts until you are ready.')} />
      <div className="auth-form">
        <div className="auth-lang"><LanguageToggle /></div>
        <form className="card auth-card wide stack" onSubmit={submit}>
          <div>
            <span className="kicker">{t('Step 2 · Business')}</span>
            <h1>{t('Your business')}</h1>
          </div>
          <div className="form-grid">
            <Field label={t('Registered name')}><input required value={form.legalName} onChange={set('legalName')} /></Field>
            <Field label={t('Trade name')} hint={t('If different.')}><input value={form.tradeName} onChange={set('tradeName')} /></Field>
            <Field label="TIN" hint={t('6 digits.')}><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={form.tin} onChange={set('tin')} /></Field>
          </div>
          <div className="form-grid">
            <Field label={t('Street')}><input required value={form.street} onChange={set('street')} /></Field>
            <Field label={t('City or town')}><input required value={form.city} onChange={set('city')} /></Field>
            <Field label={t('District')}>
              <select value={form.districtCode} onChange={set('districtCode')}>
                {DISTRICTS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label={t('Telephone')}><input required type="tel" value={form.telephone} onChange={set('telephone')} /></Field>
            <Field label={t('Billing email')}><input required type="email" value={form.email} onChange={set('email')} /></Field>
          </div>
          <ErrorText error={error} />
          <button type="submit" className="big" disabled={busy}>{busy ? t('Saving…') : t('Continue')}<span className="chip" aria-hidden="true">→</span></button>
        </form>
      </div>
    </div>
  );
}
