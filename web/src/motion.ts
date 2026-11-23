/**
 * Motion that CSS cannot do alone:
 *   - the highlight that glides under the chosen tab and the current page in the sidebar;
 *   - tab switches as view transitions: a pure cross-fade, so whatever is the same before and
 *     after (titles, tab bars, filters) stays perfectly still, and only what changes fades;
 *   - numbers that count up;
 *   - dialogs and menus that animate out after React has removed them.
 * Everything gives way to prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- the gliding highlight ----------

const INDICATED = '.tabs, .sidebar nav, .till-tabs';

function place(el: HTMLElement) {
  const active = el.matches('.sidebar nav')
    ? el.querySelector<HTMLElement>('a.active')
    : el.querySelector<HTMLElement>(':scope > .active, :scope > [aria-pressed="true"], :scope > [aria-current="page"]');
  if (!active || !el.isConnected) {
    el.classList.remove('has-ind');
    return;
  }
  const box = el.getBoundingClientRect();
  const a = active.getBoundingClientRect();
  if (!a.width || !box.width) return;
  el.style.setProperty('--ind-x', `${a.left - box.left - el.clientLeft + el.scrollLeft}px`);
  el.style.setProperty('--ind-y', `${a.top - box.top - el.clientTop + el.scrollTop}px`);
  el.style.setProperty('--ind-w', `${a.width}px`);
  el.style.setProperty('--ind-h', `${a.height}px`);
  // The first placement jumps there; only later moves glide.
  if (!el.classList.contains('has-ind')) requestAnimationFrame(() => el.classList.add('has-ind'));
}

/** Watch the page for tab bars and the sidebar, and keep their highlight under the chosen item. */
export function installIndicators() {
  if (typeof MutationObserver === 'undefined') return;
  const pending = new Set<HTMLElement>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    pending.forEach(place);
    pending.clear();
  };
  const queue = (el: HTMLElement) => {
    pending.add(el);
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => entries.forEach((e) => queue(e.target as HTMLElement)));
  const watch = (el: HTMLElement) => {
    queue(el);
    resize?.observe(el);
  };
  const scan = () => document.querySelectorAll<HTMLElement>(INDICATED).forEach(watch);
  new MutationObserver((records) => {
    for (const r of records) {
      const target = r.target instanceof HTMLElement ? r.target : r.target.parentElement;
      const host = target?.closest<HTMLElement>(INDICATED);
      if (host) queue(host);
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches(INDICATED)) watch(n);
          n.querySelectorAll<HTMLElement>(INDICATED).forEach(watch);
        });
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-current'] });
  window.addEventListener('resize', scan);
  void document.fonts?.ready.then(scan);
  scan();
}

// ---------- view transitions ----------

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * Change what is on screen as a view transition. "tab": a same-page switch (tabs, filters): a pure
 * cross-fade, so unchanged parts never move. "page": a new page eases in.
 */
export function withTransition(update: () => void, kind: 'tab' | 'page' = 'tab') {
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') {
    update();
    return;
  }
  const root = document.documentElement;
  root.classList.add(`vt-${kind}`);
  try {
    void doc.startViewTransition(() => flushSync(update)).finished.finally(() => root.classList.remove(`vt-${kind}`));
  } catch {
    root.classList.remove(`vt-${kind}`);
    update();
  }
}

// ---------- numbers that count up ----------

/** A number that eases from where it was to its new value (and counts up from zero the first time). */
export function useCountUp(value: number, duration = 750): number {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const current = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) {
      current.current = value;
      setShown(value);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      const v = from + (value - from) * eased;
      current.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return shown;
}

// ---------- exits ----------

/**
 * Play an element's exit after React removes it: a frozen copy takes its place, gets `className`,
 * and is removed when its animation ends. For dialogs and menus, which unmount at once.
 */
export function animateOut(node: HTMLElement | null, className: string, ms = 220, options: { onlyIfRemoved?: boolean } = {}) {
  if (!node || !node.isConnected || reducedMotion()) return;
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.classList.add(className);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  (node.parentNode ?? document.body).appendChild(ghost);
  window.setTimeout(() => ghost.remove(), ms);
  // From an effect cleanup: if the original is still there next frame, it was not really removed (React's dev double run).
  if (options.onlyIfRemoved) {
    requestAnimationFrame(() => {
      if (node.isConnected) ghost.remove();
    });
  }
}
