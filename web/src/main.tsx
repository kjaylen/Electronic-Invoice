import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { Brand } from './art';
import { SessionProvider, useSession } from './session';
import { Login, Signup } from './pages/Auth';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Documents } from './pages/Documents';
import { DocumentDetail } from './pages/DocumentDetail';
import { NewDocument } from './pages/NewDocument';
import { Customers } from './pages/Customers';
import { Items } from './pages/Items';
import { Settings } from './pages/Settings';

function Layout() {
  const { session, me, logout, switchBusiness } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const links: Array<[string, string]> = [
    ['/', 'Overview'],
    ['/documents/new?type=01', 'New invoice'],
    ['/documents/new?type=02', 'New receipt'],
    ['/documents', 'Documents'],
    ['/customers', 'Customers'],
    ['/items', 'Items'],
    ['/settings', 'Settings'],
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand" onClick={close} viewTransition><Brand /></NavLink>
        <button className="menu-button secondary" aria-expanded={open} aria-label="Menu" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Menu'}</button>
        <nav className={open ? 'open' : ''} aria-label="Main">
          {links.map(([to, label]) => {
            // "New invoice" and "New receipt" share a path; tell them apart by ?type=.
            const [path, query] = to.split('?');
            const active = query
              ? location.pathname === path && new URLSearchParams(location.search).get('type') === new URLSearchParams(query).get('type')
              : undefined;
            return (
              <NavLink
                key={to}
                to={to}
                end={to === '/' || to === '/documents'}
                onClick={close}
                viewTransition
                className={({ isActive }) => ((active ?? (isActive && !(path === '/documents' && location.pathname === '/documents/new'))) ? 'active' : '')}
              >
                {label}
              </NavLink>
            );
          })}
        </nav>
        <span className="spacer" />
        <div className={`row account ${open ? 'open' : ''}`}>
          {session && session.businesses.length > 1 ? (
            <select aria-label="Business" value={session.currentBusinessId ?? ''} onChange={(e) => void switchBusiness(e.target.value).then(() => navigate('/', { viewTransition: true }))}>
              {session.businesses.map((b) => <option key={b.id} value={b.id}>{b.tradeName ?? b.legalName}</option>)}
            </select>
          ) : (
            <span className="who">{me?.tradeName ?? me?.legalName}</span>
          )}
          {me?.environment === 'test' && <span className="badge test" title="Documents sent to the BTS test environment have no fiscal value">Test</span>}
          <button className="secondary" onClick={() => void logout().then(() => navigate('/login', { viewTransition: true }))}>Log out</button>
        </div>
      </header>
      <main>
        {/* Keyed by route, so every page plays its entrance. */}
        <div className="page stack" key={location.pathname + location.search}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** Routes for signed-in people with a business; otherwise send them where they need to go. */
function RequireBusiness() {
  const { loading, session } = useSession();
  const location = useLocation();
  if (loading) {
    return (
      <main className="stack" aria-busy="true">
        <div className="skeleton" style={{ width: '40%', height: '2.2rem' }} />
        <div className="skeleton" style={{ height: '7rem' }} />
        <div className="skeleton" style={{ height: '14rem' }} />
      </main>
    );
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!session.currentBusinessId) return <Navigate to="/onboarding" replace />;
  return <Layout />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route element={<RequireBusiness />}>
        <Route index element={<Dashboard />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/documents/new" element={<NewDocument />} />
        <Route path="/documents/:id" element={<DocumentDetail />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/items" element={<Items />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
