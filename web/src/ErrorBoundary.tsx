/** Catches a crash in one page so the rest of the app keeps working, and offers a way out. */

import { Component, type ReactNode } from 'react';
import { useI18n } from './i18n';

interface State {
  error: Error | null;
}

class Boundary extends Component<{ children: ReactNode; labels: { title: string; text: string; reload: string; home: string } }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error(error);
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A new build was deployed and an old page chunk is gone: reloading fixes it.
    const { labels } = this.props;
    return (
      <div className="card stack crash" role="alert">
        <h1>{labels.title}</h1>
        <p className="muted">{labels.text}</p>
        <div className="row">
          <button onClick={() => window.location.reload()}>{labels.reload}</button>
          <a className="button secondary" href="/">{labels.home}</a>
        </div>
      </div>
    );
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Boundary
      labels={{
        title: t('Something went wrong on this page'),
        text: t('Your documents are safe. Reload the page; if it keeps happening, tell us what you were doing.'),
        reload: t('Reload'),
        home: t('Go to the overview'),
      }}
    >
      {children}
    </Boundary>
  );
}
