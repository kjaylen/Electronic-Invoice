/** The till app's entry: the same page runs in the iOS, Android and desktop apps and at /pos in a browser. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/geist-mono';
import '../styles.css';
import './pos.css';
import { ErrorBoundary } from '../ErrorBoundary';
import { I18nProvider } from '../i18n';
import { ConfirmProvider } from '../confirm';
import { ToastProvider } from '../toast';
import { TillApp } from './TillApp';
import { installIndicators } from '../motion';

document.body.classList.add('till-body');
installIndicators();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <ErrorBoundary>
            <TillApp />
          </ErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
