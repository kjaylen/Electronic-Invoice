/** Small shared pieces: formatting, labels, status badges, fields, modal, combobox. */

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocStatus } from './api';
import { errorMessage, type T, useT } from './i18n';

export const DISTRICTS: Array<[string, string]> = [
  ['1', 'Belize'],
  ['2', 'Cayo'],
  ['3', 'Corozal'],
  ['4', 'Orange Walk'],
  ['5', 'Stann Creek'],
  ['6', 'Toledo'],
];

/** UN/ECE Rec 20 unit codes, with names people recognise. */
export const UNITS: Array<[string, string]> = [
  ['H87', 'Piece'],
  ['EA', 'Each'],
  ['BX', 'Box'],
  ['PK', 'Pack'],
  ['KGM', 'Kilogram'],
  ['LBR', 'Pound'],
  ['LTR', 'Litre'],
  ['GLL', 'US gallon'],
  ['GLI', 'Imperial gallon'],
  ['MTR', 'Metre'],
  ['FOT', 'Foot'],
  ['HUR', 'Hour'],
  ['DAY', 'Day'],
  ['MON', 'Month'],
];

export const GST_CATEGORIES: Array<[string, string]> = [
  ['S', 'GST 12.5%'],
  ['Z', 'Zero-rated (0%)'],
  ['E', 'Exempt'],
];

export const PAYMENT_MEANS: Array<[string, string]> = [
  ['10', 'Cash'],
  ['48', 'Card'],
  ['30', 'Bank transfer'],
  ['20', 'Cheque'],
];

export const unitName = (t: T, code: string) => t(UNITS.find(([c]) => c === code)?.[1] ?? code);

export const STATUS_TEXT: Record<DocStatus, string> = {
  authorized: 'Authorized',
  authorized_with_alert: 'Authorized (with notes)',
  rejected: 'Rejected by BTS',
  pending: 'Sending to BTS',
  contingency_pending: 'Pending BTS (outage)',
  superseded: 'Replaced',
  cancelled: 'Cancelled',
};

export const TYPE_NAMES: Record<string, string> = { '01': 'Tax invoice', '02': 'Tax receipt', '03': 'Debit note', '04': 'Credit note' };

export function StatusBadge({ status }: { status: DocStatus }) {
  const t = useT();
  return <span className={`badge ${status}`}>{t(STATUS_TEXT[status])}</span>;
}

/** "17206.2" -> "BZ$17,206.20" */
export function money(value: string | undefined | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  return `${negative ? '-' : ''}BZ$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(fraction + '00').slice(0, 2)}`;
}

/** "61.85" -> 6185n, exactly (no floating point). */
export function toCents(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Today's date in Belize (UTC-6, no daylight saving). */
export function belizeToday(): string {
  return belizeDate(0);
}

export function belizeDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000 - 6 * 3_600_000).toISOString().slice(0, 10);
}

/** Sets the browser tab title for the page. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · eInvoicing` : 'eInvoicing';
  }, [title]);
}

export function Field(props: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${props.className ?? ''}`}>
      {props.label}
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return <p className="form-error" role="alert">{errorMessage(t, error)}</p>;
}

/** Value that only changes after `ms` without further changes. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A dialog: traps focus, closes on Escape or a click outside, and returns focus where it was. */
export function Modal(props: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  // Remember what had focus before opening, during the first render: by the time effects run,
  // an autoFocus field inside the dialog has already taken it.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const box = ref.current!;
    const focusables = () => [...box.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    (box.querySelector<HTMLElement>('[autofocus]') ?? focusables()[0] ?? box).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose.current();
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);
  // Rendered at the end of <body>, above everything (pages animate, which would otherwise trap it under the top bar).
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className={`card modal stack ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

/** A row of toggle buttons where one is chosen (document type, filters). */
export function Segmented<V extends string>(props: { label: string; value: V; options: Array<[V, string]>; onChange: (v: V) => void }) {
  return (
    <div className="tabs" role="group" aria-label={props.label}>
      {props.options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={props.value === v} className={props.value === v ? 'active' : ''} onClick={() => props.onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

/**
 * Type-ahead with keyboard support (arrow keys, Enter, Escape), built as an
 * ARIA combobox. `onEnter` handles Enter when nothing is highlighted (e.g. a
 * barcode scanner, which types the code and presses Enter).
 */
export function Combobox<T extends { id: string }>(props: {
  label?: string;
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  render: (t: T) => ReactNode;
  onPick: (t: T) => void;
  value?: string;
  /** Called as the person types. Return true to consume the text (the box is cleared). */
  onText?: (v: string) => void | boolean;
  onEnter?: (text: string) => void | Promise<void>;
  inputRef?: React.Ref<HTMLInputElement>;
  autoFocus?: boolean;
  clearOnPick?: boolean;
  minLength?: number;
}) {
  const [text, setText] = useState(props.value ?? '');
  const [results, setResults] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = useDebounced(text, 200);
  const listId = useId();
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => setText(props.value ?? ''), [props.value]);
  useEffect(() => {
    if (!open || q.trim().length < (props.minLength ?? 1)) {
      setResults([]);
      return;
    }
    let live = true;
    void props.search(q.trim()).then((r) => {
      // Ignore answers for text that has since changed (e.g. cleared after a scan).
      if (!live || textRef.current.trim() !== q.trim()) return;
      setResults(r);
      setActive(-1);
    }).catch(() => live && setResults([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);

  const pick = (item: T) => {
    props.onPick(item);
    setOpen(false);
    setResults([]);
    if (props.clearOnPick) setText('');
  };
  const showList = open && results.length > 0;
  return (
    <div className="relative">
      <input
        ref={props.inputRef}
        role="combobox"
        aria-label={props.label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        value={text}
        onChange={(e) => {
          if (props.onText?.(e.target.value) === true) {
            setText('');
            setResults([]);
            return;
          }
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && results.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === 'ArrowUp' && results.length) {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            if (showList && active >= 0) {
              e.preventDefault();
              pick(results[active]!);
            } else if (props.onEnter && text.trim()) {
              e.preventDefault();
              const value = text.trim();
              void Promise.resolve(props.onEnter(value)).then(() => {
                if (props.clearOnPick) setText('');
                setResults([]);
              });
            }
          } else if (e.key === 'Escape' && showList) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {showList && (
        <ul className="suggestions" role="listbox" id={listId}>
          {results.map((r, i) => (
            <li
              key={r.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {props.render(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { store } from './storage';

/** Belize phone numbers to the international form WhatsApp wants: "+501 622-1234" / "622 1234" -> "5016221234". */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 7) return `501${digits}`;
  if (digits.length >= 10) return digits;
  return null;
}
