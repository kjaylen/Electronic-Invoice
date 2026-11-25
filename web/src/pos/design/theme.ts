/**
 * The till's theme, per device: light, dark, or the device's own setting. Kept with the till's other
 * device settings (platform storage). Applied as html[data-theme] (tokens.css).
 */

import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'till.theme';
const listeners = new Set<(c: ThemeChoice) => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && Boolean(media?.matches));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // The browser's own parts (scrollbars, the address bar on phones) follow.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#07090c' : '#11141a');
}

let current: ThemeChoice = 'light';

/** At start, before the first paint. */
export function initTheme() {
  current = read();
  apply(current);
  media?.addEventListener?.('change', () => current === 'system' && apply(current));
}

export function setTheme(choice: ThemeChoice) {
  current = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* storage blocked: for this session only */
  }
  apply(choice);
  listeners.forEach((l) => l(choice));
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    return () => void listeners.delete(set);
  }, []);
  return [choice, setTheme];
}
