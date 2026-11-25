/**
 * The till's design system: components (docs/design/DESIGN-SYSTEM.md). Styling in components.css,
 * tokens in tokens.css. Every tappable part is at least 48px; selling actions 64px. Every press shows
 * within a frame (the :active state) and, for key actions, gives feedback (feedback.ts).
 */

import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { feedback } from './feedback';
import { PosIcon, type PosIconName } from './icons';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export function Icon({ name }: { name: PosIconName }) {
  const Draw = PosIcon[name];
  return <Draw />;
}

// ---------- buttons ----------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'md' | 'lg';
  icon?: PosIconName;
  loading?: boolean;
  selected?: boolean;
  error?: boolean;
  block?: boolean;
  /** A key action (pay, send): vibrate on press where the device can. */
  haptic?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', icon, loading, selected, error, block, haptic, className, children, onClick, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={selected === undefined ? rest['aria-pressed'] : selected}
      className={cx('pos-btn', variant, size === 'lg' && 'lg', block && 'block', !children && 'icon', loading && 'is-loading', error && 'is-error', className)}
      onClick={(e) => {
        if (haptic) feedback('tap');
        onClick?.(e);
      }}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// ---------- product tile ----------

export function ProductTile({ name, price, colour, stock, out, selected, loading, onPick, label }: {
  name: string;
  /** Already formatted (BZ$3.50). */
  price: string;
  colour?: string | null;
  /** Units left; null: not counted. */
  stock?: number | null;
  out?: boolean;
  selected?: boolean;
  loading?: boolean;
  onPick?: () => void;
  label?: string;
}) {
  const low = stock !== null && stock !== undefined && stock > 0 && stock <= 5;
  return (
    <button
      type="button"
      className={cx('pos-tile', out && 'is-out', selected && 'is-selected', loading && 'is-loading')}
      style={colour ? ({ '--tile-colour': colour } as CSSProperties) : undefined}
      disabled={out}
      aria-label={label ?? `${name}, ${price}${out ? ', sold out' : stock !== null && stock !== undefined ? `, ${stock} left` : ''}`}
      onClick={() => {
        feedback('tap');
        onPick?.();
      }}
    >
      <span className="name">{name}</span>
      <span className="price num">{price}</span>
      {(out || low) && <span className={cx('stock', low && 'low')}>{out ? 'Sold out' : `${stock} left`}</span>}
    </button>
  );
}

// ---------- category tabs ----------

export function CategoryTabs<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: Array<[V, string]>; onChange: (v: V) => void }) {
  return (
    <div className="pos-tabs" role="group" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

// ---------- list row ----------

export function ListRow({ lead, title, meta, end, amount, selected, error, onClick, disabled }: {
  lead?: ReactNode; title: ReactNode; meta?: ReactNode; end?: ReactNode; amount?: ReactNode;
  selected?: boolean; error?: boolean; disabled?: boolean; onClick?: () => void;
}) {
  return (
    <button type="button" className={cx('pos-row', selected && 'is-selected', error && 'is-error')} aria-current={selected || undefined} disabled={disabled} onClick={onClick}>
      <span className="lead">{lead}</span>
      <span className="main"><span className="title">{title}</span>{meta && <span className="meta">{meta}</span>}</span>
      <span className="end">{amount && <span className="amount num">{amount}</span>}{end}</span>
    </button>
  );
}

// ---------- number pad ----------

/** Digits, a decimal point and delete; quick amounts above it where given. */
export function NumPad({ onKey, decimal = true, label = 'Number pad', quick, onQuick, disabled }: {
  onKey: (key: string) => void;
  decimal?: boolean;
  label?: string;
  /** [value, text] pairs, e.g. [["20.00", "BZ$20"]]. */
  quick?: Array<[string, string]>;
  onQuick?: (value: string) => void;
  disabled?: boolean;
}) {
  const press = (k: string) => {
    feedback('tap');
    onKey(k);
  };
  return (
    <div className="pos-numpad-wrap">
      {quick && quick.length > 0 && (
        <div className="pos-quick-cash" role="group" aria-label="Quick amounts">
          {quick.map(([v, text]) => <button key={v} type="button" className="pos-chip" disabled={disabled} onClick={() => { feedback('tap'); onQuick?.(v); }}>{text}</button>)}
        </div>
      )}
      <div className="pos-numpad" role="group" aria-label={label}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" disabled={disabled} onClick={() => press(d)}>{d}</button>)}
        {decimal ? <button type="button" className="soft" disabled={disabled} onClick={() => press('.')} aria-label="Decimal point">.</button> : <span />}
        <button type="button" disabled={disabled} onClick={() => press('0')}>0</button>
        <button type="button" className="soft" disabled={disabled} onClick={() => press('back')} aria-label="Delete a digit"><Icon name="backspace" /></button>
      </div>
    </div>
  );
}

/** What a number pad does to a typed amount (at most 2 decimals, no leading zeros). */
export function typeAmount(current: string, key: string): string {
  if (key === 'back') return current.slice(0, -1);
  if (key === 'clear') return '';
  if (key === '.') return current.includes('.') ? current : `${current || '0'}.`;
  const [, frac] = current.split('.');
  if (frac !== undefined && frac.length >= 2) return current;
  if (current === '0') return key;
  return (current + key).slice(0, 10);
}

// ---------- quantity stepper ----------

export function Stepper({ value, onChange, min = 1, max = 999, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  return (
    <div className="pos-stepper" role="group" aria-label={label}>
      <button type="button" aria-label="One less" disabled={value <= min} onClick={() => { feedback('tap'); onChange(value - 1); }}><Icon name="minus" /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label="One more" disabled={value >= max} onClick={() => { feedback('tap'); onChange(value + 1); }}><Icon name="plus" /></button>
    </div>
  );
}

// ---------- search field ----------

export function SearchField({ value, onChange, placeholder, label, inputRef }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <label className="pos-search">
      <Icon name="search" />
      <input ref={inputRef} type="search" inputMode="search" enterKeyHint="search" value={value} placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// ---------- toggle and chip ----------

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return <label className="pos-toggle"><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>;
}

export function Chip({ pressed, onClick, icon, children, disabled }: { pressed?: boolean; onClick?: () => void; icon?: PosIconName; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className="pos-chip" aria-pressed={pressed} disabled={disabled} onClick={onClick}>{icon && <Icon name={icon} />}{children}</button>;
}

// ---------- badge, banner, empty, skeleton ----------

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';
const TONE_ICON: Partial<Record<Tone, PosIconName>> = { success: 'done', warning: 'alert', danger: 'error', info: 'info' };

export function Badge({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: PosIconName | false; children: ReactNode }) {
  const name = icon === false ? undefined : icon ?? TONE_ICON[tone];
  return <span className={cx('pos-badge', tone)}>{name && <Icon name={name} />}{children}</span>;
}

export function Banner({ tone = 'info', title, children, action }: { tone?: Exclude<Tone, 'neutral' | 'brand'>; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('pos-banner', tone)} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <Icon name={TONE_ICON[tone] ?? 'info'} />
      <div>{title && <strong>{title}</strong>}{children}</div>
      {action ?? <span />}
    </div>
  );
}

export function EmptyState({ icon = 'receipt', title, children, action }: { icon?: PosIconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="pos-empty"><Icon name={icon} /><strong>{title}</strong>{children && <span>{children}</span>}{action}</div>;
}

export function Skeleton({ height = '1rem', width = '100%', style }: { height?: string; width?: string; style?: CSSProperties }) {
  return <div className="pos-skeleton" style={{ height, width, ...style }} aria-hidden="true" />;
}

// ---------- sheet (bottom sheet on phones, dialog or side panel on larger screens) ----------

export function Sheet({ title, onClose, children, side, full, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; side?: boolean; full?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, select, [tabindex]')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <div className={cx('pos-scrim', side && 'side')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('pos-sheet', full && 'full')} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <header><h2>{title}</h2><Button variant="quiet" icon="close" aria-label="Close" onClick={onClose} /></header>
        <div className="pos-sheet-body">{children}</div>
        {footer && <footer className="pos-sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------- the clock in the status bar ----------

export function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** "BZ$3.50"; with US dollars too where the business shows them. */
export function bz(amount: string | number): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  return `BZ$${(Number.isFinite(n) ? n : 0).toLocaleString('en-BZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Day-month-year, as Belize writes it. */
export function dmy(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
}
