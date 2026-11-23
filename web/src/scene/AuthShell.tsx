/**
 * The frame of the sign-in pages (find your business, create one, log in,
 * forgot or reset a password): the living panel on the left, the same on
 * every one of them, and the page's card on the right.
 *
 * As a layout route the panel is mounted once and keeps running while the
 * card on the right changes (the card fades out and the next one in). The
 * aurora is plain CSS, phase-locked to the clock so it carries on where it
 * was across a full page load (moving to a business is one); the fluid and
 * particles load separately and fade in.
 */

import { createContext, type CSSProperties, lazy, type ReactNode, type RefObject, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import { api } from '../api';
import { Brand } from '../art';
import { BUSINESS } from '../business';
import { LanguageToggle, useT } from '../i18n';

const LiveLayers = lazy(() => import('./AuthScene').then((m) => ({ default: m.LiveLayers })));

const InShell = createContext(false);

let businessName: Promise<{ name: string | null; missing: boolean }> | null = null;
/** The business's public name, for its sign-in pages (asked for once per page load). */
export function useBusinessName(): { name: string | null; missing: boolean } {
  const [state, setState] = useState<{ name: string | null; missing: boolean }>({ name: null, missing: false });
  useEffect(() => {
    if (!BUSINESS) return;
    businessName ??= api<{ name: string }>(`/v1/auth/business/${BUSINESS}`)
      .then((b) => ({ name: b.name, missing: false }))
      .catch((e: unknown) => ({ name: null, missing: (e as { status?: number }).status === 404 }));
    let live = true;
    void businessName.then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/**
 * Pointer parallax: sets --px and --py (-1..1, eased) on the element, for
 * layers to drift against; eases back when the pointer leaves. Off for
 * reduced motion and touch-only screens.
 */
function useParallax(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover)').matches) return;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    const tick = () => {
      x += (tx - x) * 0.08;
      y += (ty - y) * 0.08;
      el.style.setProperty('--px', x.toFixed(4));
      el.style.setProperty('--py', y.toFixed(4));
      frame = Math.abs(tx - x) + Math.abs(ty - y) > 0.001 ? requestAnimationFrame(tick) : 0;
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ty = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onLeave = () => {
      tx = 0;
      ty = 0;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(frame);
    };
  }, [ref]);
}

/** The left panel: the same on every sign-in page. */
export function AuthPanel() {
  const t = useT();
  const { name } = useBusinessName();
  const ref = useRef<HTMLElement>(null);
  useParallax(ref);
  // Where the aurora's slow drift is now, so a new page picks it up mid-movement.
  const phase = useMemo(() => ({ '--phase': `-${((Date.now() / 1000) % 100000).toFixed(1)}s` }) as CSSProperties, []);
  return (
    <aside className="auth-art lux-art" ref={ref}>
      <div className="lux-scene" aria-hidden="true">
        <div className="lux-aurora" style={phase}>
          <span className="blob b1" />
          <span className="blob b2" />
          <span className="blob b3" />
          <span className="blob b4" />
          <span className="blob b5" />
        </div>
        <Suspense fallback={null}><LiveLayers /></Suspense>
        <div className="lux-grain" />
        <div className="lux-vignette" />
      </div>
      <div className="brand"><Brand light /></div>
      <div className="headline">
        <span className="kicker">{name ?? t('Electronic tax documents')}</span>
        <h2>{t('Issue it. Sign it. Get it authorized.')}</h2>
        <p>{t('Every business has its own address, its own team and its own records.')}</p>
      </div>
      <div className="facts">
        <span>BTS e-invoicing</span>
        <span>Signed &amp; authorized</span>
        <span>Keeps working in outages</span>
      </div>
    </aside>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <AuthPanel />
      <div className="auth-form">
        <div className="auth-lang"><LanguageToggle /></div>
        {children}
      </div>
    </div>
  );
}

/** A layout route: the panel once, each page's card on the right. */
export function AuthShell() {
  return (
    <InShell.Provider value={true}>
      <Frame>
        <Suspense fallback={<div className="card auth-card auth-card-loading" aria-busy="true" />}>
          <Outlet />
        </Suspense>
      </Frame>
    </InShell.Provider>
  );
}

/** A sign-in page's content: inside the shell just the content; on its own (outside the routes), with the panel around it. */
export function AuthPage({ children }: { children: ReactNode }) {
  if (useContext(InShell)) return <>{children}</>;
  return <Frame>{children}</Frame>;
}
