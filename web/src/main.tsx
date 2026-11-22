import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { api, type Permission } from './api';
import { Brand } from './art';
import { BUSINESS, STORE_DOMAIN } from './business';
import { ErrorBoundary } from './ErrorBoundary';
import { Icons } from './icons';
import { I18nProvider, LanguageToggle, useI18n } from './i18n';
import { ROLE_LABEL } from './permissions';
import { SessionProvider, useSession } from './session';
import { ToastProvider } from './toast';

// Each page is its own chunk, loaded when first visited.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Start = page(() => import('./pages/Start'), 'Start');
const PlatformConsole = page(() => import('./pages/Platform'), 'PlatformConsole');
const CreateBusiness = page(() => import('./pages/Start'), 'CreateBusiness');
const Login = page(() => import('./pages/Auth'), 'Login');
const ForgotPassword = page(() => import('./pages/Auth'), 'ForgotPassword');
const ResetPassword = page(() => import('./pages/Auth'), 'ResetPassword');
const ChangePasswordRequired = page(() => import('./pages/Auth'), 'ChangePasswordRequired');
const Docs = page(() => import('./pages/Docs'), 'Docs');
const Pricing = page(() => import('./pages/Legal'), 'Pricing');
const Terms = page(() => import('./pages/Legal'), 'Terms');
const Privacy = page(() => import('./pages/Legal'), 'Privacy');
const TwoFactorRequired = page(() => import('./pages/Auth'), 'TwoFactorRequired');
const Onboarding = page(() => import('./pages/Onboarding'), 'Onboarding');
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard');
const Counter = page(() => import('./pages/Counter'), 'Counter');
const Documents = page(() => import('./pages/Documents'), 'Documents');
const DocumentDetail = page(() => import('./pages/DocumentDetail'), 'DocumentDetail');
const NewDocument = page(() => import('./pages/NewDocument'), 'NewDocument');
const Customers = page(() => import('./pages/Customers'), 'Customers');
const Products = page(() => import('./pages/Products'), 'Products');
const ProductEditor = page(() => import('./pages/Products'), 'ProductEditor');
const Orders = page(() => import('./pages/Orders'), 'Orders');
const OrderDetail = page(() => import('./pages/Orders'), 'OrderDetail');
const ShopLayout = page(() => import('./pages/Shop'), 'ShopLayout');
const ShopHome = page(() => import('./pages/Shop'), 'ShopHome');
const ShopProduct = page(() => import('./pages/Shop'), 'ShopProduct');
const ShopCart = page(() => import('./pages/Shop'), 'ShopCart');
const ShopCheckout = page(() => import('./pages/Shop'), 'ShopCheckout');
const ShopOrder = page(() => import('./pages/Shop'), 'ShopOrder');
const ShopTestPayment = page(() => import('./pages/Shop'), 'ShopTestPayment');
const Reports = page(() => import('./pages/Reports'), 'Reports');
const Receivables = page(() => import('./pages/Receivables'), 'Receivables');
const Expenses = page(() => import('./pages/Expenses'), 'Expenses');
const ExpenseEditor = page(() => import('./pages/Expenses'), 'ExpenseEditor');
const PayInvoice = page(() => import('./pages/Pay'), 'PayInvoice');
const Quotes = page(() => import('./pages/Quotes'), 'Quotes');
const QuoteDetail = page(() => import('./pages/Quotes'), 'QuoteDetail');
const RecurringList = page(() => import('./pages/Quotes'), 'RecurringList');
const RecurringDetail = page(() => import('./pages/Quotes'), 'RecurringDetail');
const QuoteView = page(() => import('./pages/QuoteView'), 'QuoteView');
const QuoteEditor = page(() => import('./pages/NewDocument'), 'QuoteEditor');
const RecurringEditor = page(() => import('./pages/NewDocument'), 'RecurringEditor');
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

type NavItem = { to: string; label: string; icon: () => React.JSX.Element; permission?: Permission; badge?: number };

function Layout() {
  const { session, me, logout, can } = useSession();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [ordersToDo, setOrdersToDo] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  const close = () => setOpen(false);

  // Move focus to the new page after navigating, so keyboard and screen-reader users start at the top of it.
  useEffect(() => {
    setOpen(false);
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

  // How many online orders need doing, for the badge in the menu; refreshed as people move around.
  useEffect(() => {
    void api<{ counts: { unpaid: number; unfulfilled: number } }>('/v1/orders?view=to_do&q=%23000000000')
      .then((r) => setOrdersToDo(Math.max(r.counts.unpaid, r.counts.unfulfilled)))
      .catch(() => {});
  }, [location.pathname]);

  // The phone drawer: Escape closes it; opening it moves focus into it.
  useEffect(() => {
    if (!open) return;
    navRef.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const groups: Array<[string, NavItem[]]> = [
    [t('Sell'), [
      { to: '/', label: t('Overview'), icon: Icons.overview },
      { to: '/counter', label: t('Counter'), icon: Icons.counter, permission: 'documents.issue' },
      { to: '/documents/new?type=01', label: t('New invoice'), icon: Icons.invoice, permission: 'documents.issue' },
      { to: '/quotes', label: t('Quotes'), icon: Icons.quote, permission: 'documents.issue' },
      { to: '/orders', label: t('Orders'), icon: Icons.orders, badge: ordersToDo },
    ]],
    [t('Records'), [
      { to: '/documents', label: t('Documents'), icon: Icons.documents },
      { to: '/recurring', label: t('Recurring'), icon: Icons.repeat, permission: 'documents.issue' },
      { to: '/receivables', label: t('Getting paid'), icon: Icons.wallet, permission: 'payments.record' },
      { to: '/expenses', label: t('Expenses'), icon: Icons.expense, permission: 'expenses.manage' },
      { to: '/customers', label: t('Customers'), icon: Icons.customers },
      { to: '/products', label: t('Products'), icon: Icons.products },
      { to: '/reports', label: t('Reports'), icon: Icons.reports, permission: 'reports.view' },
    ]],
    [t('Business'), [
      { to: '/settings', label: t('Settings'), icon: Icons.settings },
    ]],
  ];
  const user = session!.user;
  const business = me?.tradeName ?? me?.legalName ?? session!.business.tradeName ?? session!.business.legalName;
  const initials = user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const isActive = (to: string) => {
    const [path, query] = to.split('?');
    if (path === '/') return location.pathname === '/';
    if (query) return location.pathname === path && location.search.includes(query);
    if (path === '/documents') return location.pathname === '/documents' || (location.pathname.startsWith('/documents/') && location.pathname !== '/documents/new');
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  return (
    <div className={`app ${open ? 'drawer-open' : ''}`}>
      <a className="skip-link" href="#main">{t('Skip to content')}</a>
      <aside className="sidebar" aria-label={t('Sidebar')}>
        <div className="sidebar-head">
          <NavLink to="/" className="brand" viewTransition aria-label="eInvoicing"><Brand /></NavLink>
          <button className="icon-button sidebar-close" aria-label={t('Close menu')} onClick={close}><Icons.close /></button>
        </div>
        <div className="biz-card">
          <span className="biz-name" title={business}>{business}</span>
          <span className="biz-meta">
            {session!.business.environment === 'test'
              ? <span className="badge test" title={t('Documents sent to the BTS test environment have no fiscal value')}>{t('Test')}</span>
              : <span className="badge authorized">{t('Production')}</span>}
            <span className="mono small muted">TIN {me?.tin ?? ''}</span>
          </span>
        </div>
        <nav id="main-nav" ref={navRef} aria-label={t('Main')}>
          {groups.map(([group, items]) => {
            const visible = items.filter((i) => !i.permission || can(i.permission));
            if (!visible.length) return null;
            return (
              <div className="nav-group" key={group}>
                <span className="nav-label">{group}</span>
                {visible.map((i) => (
                  <NavLink key={i.to} to={i.to} viewTransition className={isActive(i.to) ? 'active' : ''} aria-current={isActive(i.to) ? 'page' : undefined}>
                    <i.icon />
                    <span className="nav-text">{i.label}</span>
                    {i.badge ? <span className="nav-badge" aria-label={t('{n} to do', { n: i.badge })}>{i.badge}</span> : null}
                  </NavLink>
                ))}
                {group === t('Business') && (
                  <a href={`/${session!.business.slug}/shop`} target="_blank" rel="noreferrer">
                    <Icons.store />
                    <span className="nav-text">{t('View store')}</span>
                    <span className="nav-ext"><Icons.external /></span>
                  </a>
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="me">
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span className="me-text">
              <strong title={user.name}>{user.name}</strong>
              <span className="small muted">{t(ROLE_LABEL[user.role])}</span>
            </span>
          </div>
          <div className="foot-actions">
            <LanguageToggle />
            <a className="icon-button" href="/?choose=1" title={t('Switch business')} aria-label={t('Switch business')}><Icons.swap /></a>
            <button className="icon-button" title={t('Log out')} aria-label={t('Log out')} onClick={() => void logout().then(() => navigate('/login', { viewTransition: true }))}><Icons.logout /></button>
          </div>
        </div>
      </aside>
      <div className="scrim" onClick={close} aria-hidden="true" />

      <div className="workspace">
        <header className="mobilebar">
          <button className="icon-button" aria-expanded={open} aria-controls="main-nav" aria-label={t('Open menu')} onClick={() => setOpen(true)}><Icons.menu /></button>
          <NavLink to="/" className="brand" viewTransition aria-label="eInvoicing"><Brand /></NavLink>
          <span className="spacer" />
          {session!.business.environment === 'test' && <span className="badge test">{t('Test')}</span>}
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
        {me?.billing && (me.billing.status === 'suspended' || me.billing.status === 'past_due' || (me.billing.status === 'trialing' && (me.billing.trialDaysLeft ?? 99) <= 7)) && can('business.manage') && (
          <div className={`statusbar billing-bar ${me.billing.status}`} role="status">
            <span>
              {me.billing.status === 'suspended' ? <><strong>{t('Issuing is paused.')}</strong> {t('An invoice for your plan is overdue.')}</>
                : me.billing.status === 'past_due' ? <><strong>{t('An invoice is overdue.')}</strong> {t('Please pay it to avoid a pause in issuing.')}</>
                  : <><strong>{me.billing.trialDaysLeft === 1 ? t('Your free trial ends tomorrow.') : t('Your free trial ends in {n} days.', { n: me.billing.trialDaysLeft ?? 0 })}</strong> {t('Choose the plan that fits.')}</>}
              {' '}<NavLink to="/settings?tab=plan" viewTransition>{t('See your plan')} →</NavLink>
            </span>
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
    </div>
  );
}

/** The business's pages, for someone signed in to it. */
function RequireSession() {
  const { loading, session } = useSession();
  const location = useLocation();
  if (loading) return <main><PageSkeleton /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (session.user.mustChangePassword) return <Suspense fallback={<main><PageSkeleton /></main>}><ChangePasswordRequired /></Suspense>;
  if (session.twoFactor?.setupRequired) return <Suspense fallback={<main><PageSkeleton /></main>}><TwoFactorRequired /></Suspense>;
  return <Layout />;
}

/** A page with a permission requirement: others go to the overview. */
function Allowed({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { can } = useSession();
  return can(permission) ? <>{children}</> : <Navigate to="/" replace />;
}

/** Pages outside the signed-in layout (sign-in, setup, the start page). */
function Bare() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<main><PageSkeleton /></main>}>
        <Outlet />
      </Suspense>
    </ErrorBoundary>
  );
}

/** One business's instance, at /<slug>/... */
function BusinessApp() {
  return (
    <Routes>
      <Route element={<Bare />}>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/setup" element={<Onboarding />} />
        {/* The public online store: no sign-in. */}
        <Route path="/shop" element={<ShopLayout />}>
          <Route index element={<ShopHome />} />
          <Route path="products/:handle" element={<ShopProduct />} />
          <Route path="cart" element={<ShopCart />} />
          <Route path="checkout" element={<ShopCheckout />} />
          <Route path="orders/:number" element={<ShopOrder />} />
          <Route path="pay/:paymentId" element={<ShopTestPayment />} />
        </Route>
      </Route>
      <Route element={<RequireSession />}>
        <Route index element={<Dashboard />} />
        <Route path="/counter" element={<Allowed permission="documents.issue"><Counter /></Allowed>} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/documents/new" element={<NewDocument />} />
        <Route path="/documents/:id" element={<DocumentDetail />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/new" element={<ProductEditor />} />
        <Route path="/products/:id" element={<ProductEditor />} />
        <Route path="/items" element={<Navigate to="/products?tab=items" replace />} />
        <Route path="/reports" element={<Allowed permission="reports.view"><Reports /></Allowed>} />
        <Route path="/receivables" element={<Allowed permission="payments.record"><Receivables /></Allowed>} />
        <Route path="/expenses" element={<Allowed permission="expenses.manage"><Expenses /></Allowed>} />
        <Route path="/expenses/:id" element={<Allowed permission="expenses.manage"><ExpenseEditor /></Allowed>} />
        <Route path="/quotes" element={<Allowed permission="documents.issue"><Quotes /></Allowed>} />
        <Route path="/quotes/new" element={<QuoteEditor />} />
        <Route path="/quotes/:id" element={<Allowed permission="documents.issue"><QuoteDetail /></Allowed>} />
        <Route path="/quotes/:id/edit" element={<QuoteEditor />} />
        <Route path="/recurring" element={<Allowed permission="documents.issue"><RecurringList /></Allowed>} />
        <Route path="/recurring/new" element={<RecurringEditor />} />
        <Route path="/recurring/:id" element={<Allowed permission="documents.issue"><RecurringDetail /></Allowed>} />
        <Route path="/recurring/:id/edit" element={<RecurringEditor />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The start page: find your business, or create one. */
/** A store on its own domain: only the shop. */
function StoreDomainApp() {
  return (
    <Routes>
      <Route element={<Bare />}>
        <Route path="/shop" element={<ShopLayout />}>
          <Route index element={<ShopHome />} />
          <Route path="products/:handle" element={<ShopProduct />} />
          <Route path="cart" element={<ShopCart />} />
          <Route path="checkout" element={<ShopCheckout />} />
          <Route path="orders/:number" element={<ShopOrder />} />
          <Route path="pay/:paymentId" element={<ShopTestPayment />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/shop" replace />} />
    </Routes>
  );
}

function PublicApp() {
  return (
    <Routes>
      <Route element={<Bare />}>
        <Route index element={<Start />} />
        <Route path="/signup" element={<CreateBusiness />} />
        {/* A customer paying an invoice from its email. */}
        <Route path="/pay/:token" element={<PayInvoice />} />
        {/* A customer looking at a quote, to accept or decline it. */}
        <Route path="/q/:token" element={<QuoteView />} />
        {/* Our own staff: move businesses to BTS production. */}
        <Route path="/admin/*" element={<PlatformConsole />} />
      </Route>
      <Route path="/docs" element={<Suspense fallback={<main><PageSkeleton /></main>}><Docs /></Suspense>} />
      <Route path="/pricing" element={<Suspense fallback={<main><PageSkeleton /></main>}><Pricing /></Suspense>} />
      <Route path="/terms" element={<Suspense fallback={<main><PageSkeleton /></main>}><Terms /></Suspense>} />
      <Route path="/privacy" element={<Suspense fallback={<main><PageSkeleton /></main>}><Privacy /></Suspense>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter {...(BUSINESS && !STORE_DOMAIN && { basename: `/${BUSINESS}` })}>
      <I18nProvider>
        <ToastProvider>
          <SessionProvider>
            {STORE_DOMAIN ? <StoreDomainApp /> : BUSINESS ? <BusinessApp /> : <PublicApp />}
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
