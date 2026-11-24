/**
 * "Are you sure?" in the app's own dialog, never the browser's box:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: t('Delete the page?'), body: t('…'), confirm: t('Delete page'), danger: true }))) return;
 *
 * The title asks the question, the body says what happens, and the button
 * names the action (not "OK"). Escape, the close button and a click outside
 * all mean no. One is asked at a time; it shows above a dialog already open.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useT } from './i18n';
import { Modal } from './ui';

export interface ConfirmOptions {
  /** The question. */
  title: string;
  /** What will happen, in a sentence or two. */
  body?: ReactNode;
  /** The button that goes ahead, named for what it does ("Delete page"). */
  confirm: string;
  /** The button that does not ("Cancel" when left out). */
  cancel?: string;
  /** Going ahead removes or replaces something: the button is red, and Cancel is the one in focus. */
  danger?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<Ask | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState<(ConfirmOptions & { answer: (yes: boolean) => void }) | null>(null);
  const current = useRef<((yes: boolean) => void) | null>(null);
  const ask = useCallback<Ask>((options) => new Promise<boolean>((resolve) => {
    // A second question while one is open: the first is answered "no".
    current.current?.(false);
    const answer = (yes: boolean) => {
      if (current.current !== answer) return;
      current.current = null;
      setAsking(null);
      resolve(yes);
    };
    current.current = answer;
    setAsking({ ...options, answer });
  }), []);
  return (
    <Ctx.Provider value={ask}>
      {children}
      {asking && <ConfirmDialog {...asking} />}
    </Ctx.Provider>
  );
}

function ConfirmDialog({ title, body, confirm, cancel, danger, answer }: ConfirmOptions & { answer: (yes: boolean) => void }) {
  const t = useT();
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The safe button for something that cannot be taken back lightly; otherwise the one that goes ahead.
    (danger ? no : yes).current?.focus();
    // Escape answers this question only, not a dialog that may be open underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      answer(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [danger, answer]);
  return (
    <Modal title={title} onClose={() => answer(false)}>
      {body && <div className="confirm-body">{body}</div>}
      <div className="row confirm-actions">
        <span className="spacer" />
        <button ref={no} type="button" className="secondary" onClick={() => answer(false)}>{cancel ?? t('Cancel')}</button>
        <button ref={yes} type="button" className={danger ? 'danger' : ''} onClick={() => answer(true)}>{confirm}</button>
      </div>
    </Modal>
  );
}

export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  if (!ask) throw new Error('useConfirm outside ConfirmProvider');
  return ask;
}
