/** Short confirmations ("Customer saved") that fade away; announced to screen readers. */

import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

type Tone = 'ok' | 'info' | 'bad';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});
let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((text: string, tone: Tone = 'ok') => {
    const id = ++nextId;
    setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast ${x.tone}`}>
            {x.text}
            <button className="link" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((y) => y.id !== x.id))}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
