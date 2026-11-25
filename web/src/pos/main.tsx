/** The till app's entry: the same page runs in the iOS, Android and desktop apps and at /pos in a browser. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import '../styles.css';
import './pos.css';
import './design/tokens.css';
import './design/components.css';
import './design/floor.css';
import './design/sell.css';
import './design/screens.css';
import './design/order.css';
import { initTheme } from './design/theme';
import { ErrorBoundary } from '../ErrorBoundary';
import { I18nProvider } from '../i18n';
import { ConfirmProvider } from '../confirm';
import { ToastProvider } from '../toast';
import { TillApp } from './TillApp';
import { lazy, Suspense } from 'react';
import { installIndicators } from '../motion';

/**
 * In a browser, the till opens without the server too: the service worker (public/sw.js) serves
 * the till's page and files from its caches, which this fills once the page has loaded. The
 * desktop and mobile apps carry the till inside them and need none of this.
 */
function keepForOffline() {
  const native = Boolean(window.tillDesktop) || Boolean((window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
  if (native || !import.meta.env.PROD || !('serviceWorker' in navigator) || !window.location.protocol.startsWith('http')) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then(async () => {
      const files = performance.getEntriesByType('resource')
        .map((e) => new URL(e.name))
        .filter((u) => u.origin === window.location.origin && u.pathname.startsWith('/assets/'))
        .map((u) => u.pathname);
      const [shell, assets] = await Promise.all([caches.open('shell-v3'), caches.open('assets-v3')]);
      await Promise.all([shell.add('/pos'), assets.addAll([...new Set(files)])]);
    }).catch(() => {});
  });
}

/** The component gallery: development builds only (/pos.html?gallery), never in a built till. */
const GALLERY = import.meta.env.DEV && new URLSearchParams(window.location.search).has('gallery');
const Gallery = lazy(() => Promise.all([import('./design/Gallery'), import('./design/gallery.css')]).then(([m]) => ({ default: m.Gallery })));

document.body.classList.add('till-body');
// The device's theme, before the first paint.
initTheme();
installIndicators();
keepForOffline();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <ErrorBoundary>
            {GALLERY ? <Suspense fallback={null}><Gallery /></Suspense> : <TillApp />}
          </ErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
