/** Small shared pieces: formatting, labels, status badges, fields. */

import { type ReactNode, useEffect, useState } from 'react';
import type { DocumentInfo } from './api';

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

const STATUS_TEXT: Record<DocumentInfo['status'], string> = {
  authorized: 'Authorized',
  authorized_with_alert: 'Authorized (with notes)',
  rejected: 'Rejected by BTS',
  pending: 'Sending to BTS',
  contingency_pending: 'Pending BTS (outage)',
  superseded: 'Replaced',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status }: { status: DocumentInfo['status'] }) {
  return <span className={`badge ${status}`}>{STATUS_TEXT[status]}</span>;
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
  return new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      {props.label}
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="form-error" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
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

export function Modal(props: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="card modal stack" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
