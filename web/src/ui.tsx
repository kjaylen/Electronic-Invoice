/** Small shared pieces: formatting, labels, status badges, fields, modal, select menus, combobox. */

import { Children, Fragment, isValidElement, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { animateOut, useCountUp, withTransition } from './motion';
import type { DocStatus, InvoicePaymentMethod, InvoiceStatus } from './api';
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

export const PAYMENT_STATUS_TEXT: Record<InvoiceStatus, string> = { paid: 'Paid', partial: 'Part paid', unpaid: 'Unpaid', overdue: 'Overdue', credit: 'In credit' };
export const PAYMENT_METHOD_TEXT: Record<InvoicePaymentMethod, string> = { cash: 'Cash', cheque: 'Cheque', bank_transfer: 'Bank transfer', card: 'Card', online: 'Online', refund: 'Refund', other: 'Other' };

/** Whether an invoice is paid, part paid, owed or late. */
export function PaymentBadge({ status }: { status: InvoiceStatus }) {
  const t = useT();
  return <span className={`badge pay-${status}`}>{t(PAYMENT_STATUS_TEXT[status])}</span>;
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
      <span className="field-label">{props.label}</span>
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

/** A dialog: traps focus, closes on Escape or a click outside, and returns focus where it was. It eases in and out. */
export function Modal(props: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  // However it closes (Escape, a button, the page moving on), it plays its exit.
  useLayoutEffect(() => {
    const node = backdrop.current;
    return () => animateOut(node, 'closing', 200, { onlyIfRemoved: true });
  }, []);
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
    <div ref={backdrop} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className={`card modal stack ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId} className="modal-title">{props.title}</h2>
        {props.children}
        <button type="button" className="icon-button modal-close" aria-label={t('Close')} onClick={props.onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A row of toggle buttons where one is chosen (document type, filters). With `switches`, it
 * changes what the page shows (tabs, list filters): the change plays as a cross-fade in which
 * everything that stays the same stays still.
 */
export function Segmented<V extends string>(props: { label: string; value: V; options: Array<[V, string]>; onChange: (v: V) => void; switches?: boolean }) {
  const pick = (v: V) => {
    if (v === props.value) return;
    if (props.switches) withTransition(() => props.onChange(v));
    else props.onChange(v);
  };
  return (
    <div className="tabs" role="group" aria-label={props.label}>
      {props.options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={props.value === v} className={props.value === v ? 'active' : ''} onClick={() => pick(v)}>{text}</button>
      ))}
    </div>
  );
}

/** A money amount (or any number) that counts up to its value. */
export function CountUp({ value, format, duration }: { value: number; format: (n: number) => string; duration?: number }) {
  const shown = useCountUp(value, duration);
  // One number: it settles on the value within a moment, which is what assistive technology reads.
  return <span className="count-up">{format(Math.abs(shown - value) < 0.5 ? value : shown)}</span>;
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
  useEffect(() => {
    setText(props.value ?? '');
  }, [props.value]);
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


// ---------- select menus ----------

interface MenuOption { value: string; label: ReactNode; text: string; disabled: boolean; group?: string }

const textOf = (n: ReactNode): string => {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(n)) return textOf(n.props.children);
  return '';
};

function readOptions(children: ReactNode, group?: string): MenuOption[] {
  const out: MenuOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean; label?: string }>(child)) return;
    if (child.type === Fragment) out.push(...readOptions(child.props.children, group));
    else if (child.type === 'optgroup') out.push(...readOptions(child.props.children, child.props.label));
    else if (child.type === 'option') {
      const text = textOf(child.props.children);
      out.push({ value: child.props.value !== undefined ? String(child.props.value) : text, label: child.props.children, text, disabled: Boolean(child.props.disabled), group });
    }
  });
  return out;
}

export type SelectChange = { target: { value: string; name?: string }; currentTarget: { value: string } };
type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'defaultValue'> & {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: SelectChange) => void;
};

/**
 * A select menu that looks and moves like the rest of the app: the same props and <option>
 * children as a native <select>. Keyboard: arrows, Home/End, Enter or Space, Escape, and
 * typing the first letters. A hidden native select carries the value for forms and validation.
 */
export function Select({ children, value, defaultValue, onChange, disabled, required, name, id, className, autoFocus, ...rest }: SelectProps) {
  const options = readOptions(children);
  const [inner, setInner] = useState(() => String(defaultValue ?? options[0]?.value ?? ''));
  const current = value !== undefined ? String(value) : inner;
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const listId = useId();
  const autoId = useId();
  const triggerId = id ?? autoId;
  const ariaLabel = rest['aria-label'];

  const measure = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = Math.min(320, options.length * 38 + 10);
    const up = below < Math.min(want, 220) && above > below;
    setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8)), top: up ? r.top - 6 : r.bottom + 6, width: r.width, maxHeight: Math.max(120, Math.min(320, up ? above : below)), up });
  }, [options.length]);

  const show = (index: number) => {
    measure();
    setActive(index);
    setOpen(true);
  };
  const close = useCallback((refocus = true) => {
    animateOut(menu.current, 'closing', 160);
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const choose = (o: MenuOption) => {
    if (o.disabled) return;
    if (value === undefined) setInner(o.value);
    if (o.value !== current) onChange?.({ target: { value: o.value, ...(name && { name }) }, currentTarget: { value: o.value } });
    close();
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i]!.disabled) return i;
    return from;
  };
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === current));

  // Keep the menu attached while the page scrolls or resizes; close it on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) close(false);
    };
    const onMove = () => measure();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, close, measure]);
  useEffect(() => {
    if (open && active >= 0) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        show(selectedIndex);
        return;
      }
    } else if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => step(a < 0 ? selectedIndex : a, k === 'ArrowDown' ? 1 : -1));
      return;
    } else if (k === 'Home' || k === 'End') {
      e.preventDefault();
      setActive(k === 'Home' ? step(-1, 1) : step(options.length, -1));
      return;
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      if (options[active]) choose(options[active]!);
      return;
    } else if (k === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    } else if (k === 'Tab') {
      close(false);
      return;
    }
    // Type to find: the first letters of an option.
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + k.toLowerCase(), at: now };
      const start = open ? active : selectedIndex;
      const order = [...options.keys()].map((i) => (i + start + (typed.current.text.length === 1 ? 1 : 0)) % options.length);
      const hit = order.find((i) => !options[i]!.disabled && options[i]!.text.toLowerCase().startsWith(typed.current.text));
      if (hit !== undefined) {
        if (open) setActive(hit);
        else choose(options[hit]!);
      }
    }
  };

  let lastGroup: string | undefined;
  return (
    <span className={`select ${open ? 'open' : ''} ${className ?? ''}`}>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        role="combobox"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-required={required || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => (open ? close() : show(selectedIndex))}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value ${selected ? '' : 'placeholder'}`}>{selected?.label ?? ' '}</span>
        <svg className="select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <select className="select-native" tabIndex={-1} aria-hidden="true" aria-labelledby={triggerId} name={name} required={required} disabled={disabled} value={current} onChange={() => {}}>
        {children}
      </select>
      {open && place && createPortal(
        <ul
          ref={menu}
          id={listId}
          role="listbox"
          className={`select-menu ${place.up ? 'up' : ''}`}
          style={{ left: place.left, minWidth: place.width, maxHeight: place.maxHeight, ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((o, i) => {
            const head = o.group !== lastGroup && o.group ? <li key={`g-${o.group}`} className="select-group" role="presentation">{o.group}</li> : null;
            lastGroup = o.group;
            return (
              <Fragment key={`${o.value}-${i}`}>
                {head}
                <li
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === current}
                  aria-disabled={o.disabled || undefined}
                  className={`${i === active ? 'active' : ''} ${o.value === current ? 'chosen' : ''} ${o.disabled ? 'disabled' : ''}`}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={() => choose(o)}
                >
                  <span className="select-option-label">{o.label}</span>
                  {o.value === current && <svg className="select-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </li>
              </Fragment>
            );
          })}
        </ul>,
        document.body,
      )}
    </span>
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
