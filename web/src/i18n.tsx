/**
 * English and Spanish. Strings are written in English in the code and looked
 * up in the Spanish dictionary; anything missing falls back to English.
 *
 *   const t = useT();
 *   t('Issued today')                         → "Emitidos hoy"
 *   t('{n} waiting.', { n: 3 })               → "3 en espera."
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ES } from './es';

export type Lang = 'en' | 'es';
type Vars = Record<string, string | number>;
export type T = (text: string, vars?: Vars) => string;

const STORAGE_KEY = 'etd.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'es') return saved;
  } catch {
    /* storage blocked */
  }
  return navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function translate(lang: Lang, text: string, vars?: Vars): string {
  const base = lang === 'es' ? (ES[text] ?? text) : text;
  return vars ? base.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : base;
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: T;
}

const Ctx = createContext<I18n>({ lang: 'en', setLang: () => {}, t: (s, v) => translate('en', s, v) });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage blocked */
    }
  }, []);
  const value = useMemo(() => ({ lang, setLang, t: ((s, v) => translate(lang, s, v)) as T }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;

/** Messages the server sends in English, shown in the person's language by error code where we know it. */
const ERROR_CODES: Record<string, string> = {
  invalid_credentials: 'Email or password is incorrect',
  too_many_attempts: 'Too many attempts; try again in 15 minutes',
  network: 'Cannot reach the server. Check your connection and try again.',
  email_unavailable: 'Email is not set up on this server',
  wrong_password: 'Your current password is incorrect',
  invalid_token: 'This link is invalid, already used or expired. Ask for a new one.',
  last_owner: 'A business needs at least one owner. Make someone else an owner first.',
  csrf: 'Please reload the page and try again.',
  invalid_code: 'That code is not right. Try the newest code from your app.',
  challenge_expired: 'This sign-in has expired. Enter your password again.',
  two_factor_required: 'Your business requires two-step sign-in for your role',
  two_factor_first: 'Turn on two-step sign-in for your own account first',
  already_enabled: 'Two-step sign-in is already on',
  two_factor_setup_required: 'Set up two-step sign-in first',
  credit_exceeds_original: 'This credit note is more than what is left to credit on the original',
  too_many_documents: 'Too many documents for one archive. Choose a shorter period.',
};

export function errorMessage(t: T, error: unknown): string {
  if (!error) return '';
  const e = error as { code?: string; message?: string };
  if (e.code && ERROR_CODES[e.code]) return t(ERROR_CODES[e.code]!);
  return e.message ? t(e.message) : String(error);
}

/** EN/ES switch for the top bar and sign-in pages. */
export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <button type="button" className="lang secondary" onClick={() => setLang(lang === 'en' ? 'es' : 'en')} aria-label={t('Change language')} title={t('Change language')}>
      {lang === 'en' ? 'ES' : 'EN'}
    </button>
  );
}
