/** Short confirmations ("Customer saved") that slide in, then ease away; announced to screen readers. */

import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

type Tone = 'ok' | 'info' | 'bad';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
  leaving?: boolean;
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});
let nextId = 0;
const ICON: Record<Tone, string> = { ok: '✓', info: 'i', bad: '!' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Leaving plays the exit, then the toast is gone.
  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 220);
  }, []);
  const show = useCallback((text: string, tone: Tone = 'ok') => {
    const id = ++nextId;
    setItems((xs) => [...xs.filter((x) => !x.leaving).slice(-2), { id, text, tone }]);
    setTimeout(() => dismiss(id), tone === 'bad' ? 6500 : 4200);
  }, [dismiss]);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast ${x.tone}${x.leaving ? ' leaving' : ''}`}>
            <span className="toast-icon" aria-hidden="true">{ICON[x.tone]}</span>
            <span className="toast-text">{x.text}</span>
            <button className="link" aria-label="Dismiss" onClick={() => dismiss(x.id)}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
