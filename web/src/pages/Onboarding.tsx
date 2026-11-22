import { Navigate, useNavigate } from 'react-router';
import { AuthArt } from '../art';
import { LanguageToggle, useT } from '../i18n';
import { useSession } from '../session';
import { usePageTitle } from '../ui';
import { CertificateUpload } from './Settings';

/** Right after creating the business: install its BTS certificate (or do it later from Settings). */
export function Onboarding() {
  const t = useT();
  usePageTitle(t('Install your BTS certificate'));
  const { loading, session, me, can } = useSession();
  const navigate = useNavigate();
  if (loading) return <main className="muted">{t('Loading…')}</main>;
  if (!session) return <Navigate to="/login" replace />;
  if (!can('business.manage')) return <Navigate to="/" replace />;
  const done = () => navigate('/', { replace: true, viewTransition: true });

  return (
    <div className="auth-page">
      <AuthArt kicker={t('Almost there')} title={t('Your certificate is your signature.')} text={t('It signs every document and proves to BTS it came from you. We keep it encrypted, and it never leaves this service.')} />
      <div className="auth-form">
        <div className="auth-lang"><LanguageToggle /></div>
        <div className="card auth-card wide stack">
          <div>
            <span className="kicker">{t('Step 2 · Certificate')}</span>
            <h1>{t('Install your BTS certificate')}</h1>
            <p className="muted">{t('BTS gives each business a digital certificate (a .pfx or .p12 file and its password). It signs your invoices and identifies you to BTS. It is stored encrypted and never leaves this service.')}</p>
          </div>
          {me?.certificate ? (
            <div className="banner ok"><div><strong>{t('Certificate installed')}</strong>{t('Valid until {date}.', { date: me.certificate.validTo.slice(0, 10) })}</div></div>
          ) : (
            <CertificateUpload onDone={done} />
          )}
          <div className="row">
            <span className="spacer" />
            <button className={me?.certificate ? 'big' : 'secondary'} onClick={done}>
              {me?.certificate ? t('Go to the overview') : t('Do this later')}{me?.certificate && <span className="chip" aria-hidden="true">→</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
