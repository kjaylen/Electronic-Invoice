/** The start page (no business in the address): find your business, or create a new one. */

import { type FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError, type SessionInfo } from '../api';
import { AuthPage } from '../scene/AuthShell';
import { forgetBusiness, goToBusiness, recentBusinesses } from '../business';
import { useT } from '../i18n';
import { DISTRICTS, ErrorText, Field, Segmented, Select, useDebounced, usePageTitle } from '../ui';

/** The page's card, in the shared sign-in frame (the living panel is AuthShell's). */
function Layout(props: { children: React.ReactNode; wide?: boolean }) {
  return (
    <AuthPage>
      <div className={`card auth-card stack ${props.wide ? 'wide' : ''}`}>{props.children}</div>
    </AuthPage>
  );
}

/** "corner-store", "app.example.bz/corner-store" or a pasted link -> "corner-store" */
function slugFrom(input: string): string {
  const s = input.trim().toLowerCase();
  try {
    const url = new URL(s.includes('://') ? s : `https://${s}`);
    const first = url.pathname.split('/').filter(Boolean)[0];
    if (first && s.includes('/')) return first;
  } catch {
    /* not a link */
  }
  return s.replace(/^\/+|\/+$/g, '');
}

export function Start() {
  const t = useT();
  usePageTitle(t('Find your business'));
  const [params] = useSearchParams();
  const [recent, setRecent] = useState(recentBusinesses);
  const [address, setAddress] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Opening the app goes straight to the business used last, unless someone asked to choose.
  useEffect(() => {
    if (!params.get('choose') && recent[0]) goToBusiness(recent[0].slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const slug = slugFrom(address);
    try {
      await api(`/v1/auth/business/${encodeURIComponent(slug)}`);
      goToBusiness(slug, '/login');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? new Error(t('There is no business at this address. Check the link with your administrator.')) : err);
      setBusy(false);
    }
  };

  return (
    <Layout>
      <div>
        <span className="kicker">{t('Welcome')}</span>
        <h1>{t('Find your business')}</h1>
        <p className="lead">{recent.length ? t('Pick a business you have used on this device, or enter another address.') : t('Enter the address your administrator gave you.')}</p>
      </div>
      {recent.length > 0 && (
        <ul className="recent">
          {recent.map((b) => (
            <li key={b.slug}>
              <a className="recent-link" href={`/${b.slug}`}>
                <strong>{b.name}</strong>
                <span className="mono muted">/{b.slug}</span>
              </a>
              <button className="link" aria-label={t('Forget {name} on this device', { name: b.name })} onClick={() => { forgetBusiness(b.slug); setRecent(recentBusinesses()); }}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form className="stack" onSubmit={submit}>
        <Field label={t('Business address')} hint={t('The name after the slash in the link your administrator gave you, e.g. corner-store.')}>
          <input required autoFocus={!recent.length} autoCapitalize="none" spellCheck={false} placeholder="corner-store" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="big" disabled={busy}>{t('Continue')}<span className="chip" aria-hidden="true">→</span></button>
      </form>
      <div className="auth-foot">
        <p>{t('New to Floreo?')} <Link to="/signup" viewTransition>{t('Create a business')}</Link></p>
        <p className="auth-foot-links"><Link to="/pricing">{t('Pricing')}</Link><a href="/docs">{t('API')}</a><Link to="/terms">{t('Terms')}</Link><Link to="/privacy">{t('Privacy')}</Link></p>
      </div>
    </Layout>
  );
}

export function CreateBusiness() {
  const t = useT();
  usePageTitle(t('Create a business'));
  const [form, setForm] = useState({ legalName: '', tradeName: '', tin: '', street: '', city: '', districtCode: '1', telephone: '', email: '', slug: '', name: '', ownerEmail: '', password: '' });
  const [sells, setSells] = useState<'products' | 'services' | 'both'>('both');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // The address the business will get, made from its name (the server makes the final one).
  const nameForSlug = useDebounced(form.tradeName || form.legalName, 400);
  useEffect(() => {
    if (!nameForSlug.trim()) return;
    void api<{ slug: string }>(`/v1/auth/slug?name=${encodeURIComponent(nameForSlug)}`).then((r) => setForm((f) => ({ ...f, slug: r.slug }))).catch(() => {});
  }, [nameForSlug]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<SessionInfo>('/v1/auth/signup', {
        method: 'POST',
        body: {
          business: {
            legalName: form.legalName,
            ...(form.tradeName && { tradeName: form.tradeName }),
            tin: form.tin,
            address: { street: form.street, city: form.city, districtCode: form.districtCode },
            contact: { telephone: form.telephone, email: form.email },
          },
          owner: { name: form.name, email: form.ownerEmail || form.email, password: form.password },
          sells,
        },
      });
      goToBusiness(s.business.slug, '/setup');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const origin = window.location.host;
  return (
    <Layout wide>
      <div>
        <span className="kicker">{t('New business')}</span>
        <h1>{t('Create a business')}</h1>
        <p className="lead">{t('Register the business and create the owner account. You add your team afterwards, each with their own login and role.')}</p>
      </div>
      <form className="stack" onSubmit={submit}>
        <fieldset className="stack">
          <legend>{t('What do you sell?')}</legend>
          <Segmented label={t('What do you sell?')} value={sells} onChange={setSells} options={[['products', t('Products')], ['services', t('Services')], ['both', t('Both')]]} />
          <p className="small muted">{sells === 'services' ? t('For consultants, repairs, salons, clinics and the like: invoice by the hour or the job, without stock.') : sells === 'products' ? t('For shops: stock, the counter and an online store.') : t('Everything: products with stock, and services by the hour or the job.')}</p>
        </fieldset>
        <fieldset className="stack">
          <legend>{t('Business')}</legend>
          <div className="form-grid">
            <Field label={t('Registered name')}><input required value={form.legalName} onChange={set('legalName')} /></Field>
            <Field label={t('Trade name')} hint={t('If different.')}><input value={form.tradeName} onChange={set('tradeName')} /></Field>
            <Field label="TIN" hint={t('6 digits.')}><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={form.tin} onChange={set('tin')} /></Field>
          </div>
          <div className="form-grid">
            <Field label={t('Street')}><input required value={form.street} onChange={set('street')} /></Field>
            <Field label={t('City or town')}><input required value={form.city} onChange={set('city')} /></Field>
            <Field label={t('District')}>
              <Select value={form.districtCode} onChange={set('districtCode')}>{DISTRICTS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</Select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label={t('Telephone')}><input required type="tel" value={form.telephone} onChange={set('telephone')} /></Field>
            <Field label={t('Billing email')}><input required type="email" value={form.email} onChange={set('email')} /></Field>
          </div>
          <div className="address-preview" aria-live="polite">
            <span className="small muted">{t('Your team signs in at')}</span>
            <span className="mono">{origin}/{form.slug || '…'}</span>
            <span className="small muted">{t('Made from your business name.')}</span>
          </div>
        </fieldset>
        <fieldset className="stack">
          <legend>{t('Owner account')}</legend>
          <div className="form-grid">
            <Field label={t('Your name')}><input required autoComplete="name" value={form.name} onChange={set('name')} /></Field>
            <Field label={t('Your email')} hint={t('Defaults to the billing email.')}><input type="email" autoComplete="email" placeholder={form.email} value={form.ownerEmail} onChange={set('ownerEmail')} /></Field>
            <Field label={t('Password')} hint={t('At least 10 characters.')}><input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} /></Field>
          </div>
        </fieldset>
        <p className="small muted">{t('New businesses start in the BTS test environment, so nothing counts until you are ready.')}</p>
        <ErrorText error={error} />
        <p className="small muted">{t('By creating a business you agree to the')} <Link to="/terms" target="_blank">{t('Terms of service')}</Link> {t('and the')} <Link to="/privacy" target="_blank">{t('Privacy policy')}</Link>.</p>
        <button type="submit" className="big" disabled={busy}>{busy ? t('Creating…') : t('Create business')}<span className="chip" aria-hidden="true">→</span></button>
        <div className="auth-foot"><p>{t('Already have one?')} <Link to="/?choose=1" viewTransition>{t('Find your business')}</Link></p></div>
      </form>
    </Layout>
  );
}
