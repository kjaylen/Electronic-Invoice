import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { Brand } from './art';
import { ErrorBoundary } from './ErrorBoundary';
import { I18nProvider, LanguageToggle, useI18n } from './i18n';
import { SessionProvider, useSession } from './session';
import { ToastProvider } from './toast';

// Each page is its own chunk, loaded when first visited.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Login = page(() => import('./pages/Auth'), 'Login');
const Signup = page(() => import('./pages/Auth'), 'Signup');
const ForgotPassword = page(() => import('./pages/Auth'), 'ForgotPassword');
const ResetPassword = page(() => import('./pages/Auth'), 'ResetPassword');
const AcceptInvite = page(() => import('./pages/Auth'), 'AcceptInvite');
const Onboarding = page(() => import('./pages/Onboarding'), 'Onboarding');
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard');
const Counter = page(() => import('./pages/Counter'), 'Counter');
const Documents = page(() => import('./pages/Documents'), 'Documents');
const DocumentDetail = page(() => import('./pages/DocumentDetail'), 'DocumentDetail');
const NewDocument = page(() => import('./pages/NewDocument'), 'NewDocument');
const Customers = page(() => import('./pages/Customers'), 'Customers');
const Items = page(() => import('./pages/Items'), 'Items');
const Reports = page(() => import('./pages/Reports'), 'Reports');
const Settings = page(() => import('./pages/Settings'), 'Settings');

function PageSkeleton() {
  return (
    <div className="stack" aria-busy="true">
      <div className="skeleton" style={{ width: '40%', height: '2.2rem' }} />
      <div className="skeleton" style={{ height: '7rem' }} />
      <div className="skeleton" style={{ height: '14rem' }} />
    </div>
  );
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function Layout() {
  const { session, me, logout, switchBusiness } = useSession();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  const close = () => setOpen(false);

  // Move focus to the new page after navigating, so keyboard and screen-reader users start at the top of it.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    // Leave focus alone when the new page put it somewhere on purpose (e.g. the counter's search box).
    const main = mainRef.current;
    const timer = setTimeout(() => {
      if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [location.pathname]);

  const links: Array<[string, string]> = [
    ['/', t('Overview')],
    ['/counter', t('Counter')],
    ['/documents/new?type=01', t('New invoice')],
    ['/documents', t('Documents')],
    ['/customers', t('Customers')],
    ['/items', t('Items')],
    ['/reports', t('Reports')],
    ['/settings', t('Settings')],
  ];
  return (
    <div className="shell">
      <a className="skip-link" href="#main">{t('Skip to content')}</a>
      <header className="topbar">
        <NavLink to="/" className="brand" onClick={close} viewTransition aria-label="eInvoicing"><Brand /></NavLink>
        <button className="menu-button secondary" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen(!open)}>{open ? t('Close') : t('Menu')}</button>
        <nav id="main-nav" className={open ? 'open' : ''} aria-label={t('Main')}>
          {links.map(([to, label]) => {
            const [path] = to.split('?');
            return (
              <NavLink
                key={to}
                to={to}
                end={to === '/' || to === '/documents'}
                onClick={close}
                viewTransition
                className={({ isActive }) => ((isActive && !(path === '/documents' && location.pathname === '/documents/new')) ? 'active' : '')}
              >
                {label}
              </NavLink>
            );
          })}
        </nav>
        <span className="spacer" />
        <div className={`row account ${open ? 'open' : ''}`}>
          {session && session.businesses.length > 1 ? (
            <select aria-label={t('Business')} value={session.currentBusinessId ?? ''} onChange={(e) => void switchBusiness(e.target.value).then(() => navigate('/', { viewTransition: true }))}>
              {session.businesses.map((b) => <option key={b.id} value={b.id}>{b.tradeName ?? b.legalName}</option>)}
            </select>
          ) : (
            <span className="who">{me?.tradeName ?? me?.legalName}</span>
          )}
          {me?.environment === 'test' && <span className="badge test" title={t('Documents sent to the BTS test environment have no fiscal value')}>{t('Test')}</span>}
          <LanguageToggle />
          <button className="secondary" onClick={() => void logout().then(() => navigate('/login', { viewTransition: true }))}>{t('Log out')}</button>
        </div>
      </header>
      {(!online || me?.contingency.active || (me && me.contingency.queued > 0)) && (
        <div className="statusbar" role="status">
          {!online ? (
            <span>{t('You are offline. Drafts are kept on this device; issuing needs a connection.')}</span>
          ) : me?.contingency.active ? (
            <span><strong>{t('BTS cannot be reached.')}</strong> {t('Keep issuing: documents are sent automatically when it is back.')} {me.contingency.queued > 0 && t('{n} waiting.', { n: me.contingency.queued })}</span>
          ) : (
            <span><span className="pulse" /> {t('BTS is back. Sending {n} queued documents…', { n: me!.contingency.queued })}</span>
          )}
        </div>
      )}
      <main id="main" ref={mainRef} tabIndex={-1}>
        {/* Keyed by route, so every page plays its entrance and a crash stays inside one page. */}
        <div className="page stack" key={location.pathname + location.search}>
          <ErrorBoundary>
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

/** Routes for signed-in people with a business; otherwise send them where they need to go. */
function RequireBusiness() {
  const { loading, session } = useSession();
  const location = useLocation();
  if (loading) return <main><PageSkeleton /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!session.currentBusinessId) return <Navigate to="/onboarding" replace />;
  return <Layout />;
}

/** Pages outside the signed-in layout (sign-in, onboarding). */
function Bare() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<main><PageSkeleton /></main>}>
        <Outlet />
      </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <Routes>
      <Route element={<Bare />}>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/invite" element={<AcceptInvite />} />
        <Route path="/onboarding" element={<Onboarding />} />
      </Route>
      <Route element={<RequireBusiness />}>
        <Route index element={<Dashboard />} />
        <Route path="/counter" element={<Counter />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/documents/new" element={<NewDocument />} />
        <Route path="/documents/:id" element={<DocumentDetail />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/items" element={<Items />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <ToastProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Installable app: cache the app shell so it opens fast and offline. Never in development (it would cache stale code).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
