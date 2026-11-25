/**
 * A table on the floor plan: its real shape (round, square, rectangle, a bar stool) with its seats
 * drawn around it, its state in a colour, an icon and a word (colour is never the only sign), and what
 * a server needs at arm's length: the number large in the middle, then guests, server, minutes seated
 * and the running total. Text scales with the table's size on screen (container query units).
 */

import type { CSSProperties } from 'react';
import type { TableState } from '../../../../src/venue/check.ts';
import { PosIcon, type PosIconName } from './icons';

export const TABLE_STATES: TableState[] = ['free', 'reserved', 'seated', 'ordered', 'sent', 'mains', 'bill', 'paid'];

/** Each state: its word and icon. The colours are tokens (--pos-t-<state>). */
export const STATE_LOOK: Record<TableState, { label: string; icon: PosIconName }> = {
  free: { label: 'Free', icon: 'check' },
  reserved: { label: 'Reserved', icon: 'clock' },
  seated: { label: 'Seated', icon: 'people' },
  ordered: { label: 'Ordered', icon: 'note' },
  sent: { label: 'Food sent', icon: 'flame' },
  mains: { label: 'Mains served', icon: 'plate' },
  bill: { label: 'Bill requested', icon: 'receipt' },
  // Paid and waiting to be cleared: the table needs cleaning before the next party.
  paid: { label: 'Needs cleaning', icon: 'sparkle' },
};

export interface TableShapeProps {
  shape: 'round' | 'square' | 'rect' | 'stool';
  state: TableState;
  name: string;
  seats: number;
  party?: number;
  server?: string;
  minutes?: number;
  total?: string;
  /** No activity for a while: a warning ring and icon. */
  idle?: boolean;
  /** Food is ready to be carried out. */
  ready?: boolean;
  selected?: boolean;
  /** A reservation coming: "Diaz · 19:30". */
  booking?: string;
  /** Size in plan units, for drawing the seats. */
  w: number;
  h: number;
  rotation?: number;
  t?: (s: string) => string;
}

/** Seats around a table: evenly round a round one, along the long sides of a rectangle. */
function seatPositions(shape: TableShapeProps['shape'], seats: number, w: number, h: number): Array<{ x: number; y: number }> {
  const n = Math.max(0, Math.min(seats, 16));
  if (shape === 'stool' || n === 0) return [];
  if (shape === 'round') return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + Math.cos(a) * 58, y: 50 + Math.sin(a) * 58 };
  });
  const out: Array<{ x: number; y: number }> = [];
  const long = w >= h;
  const ends = n >= 6 && n % 2 === 0 ? 2 : n % 2;
  const perSide = Math.floor((n - ends) / 2);
  for (let i = 0; i < perSide; i++) {
    const along = ((i + 1) / (perSide + 1)) * 100;
    out.push(long ? { x: along, y: -9 } : { x: -9, y: along }, long ? { x: along, y: 109 } : { x: 109, y: along });
  }
  if (ends >= 1) out.push(long ? { x: -9, y: 50 } : { x: 50, y: -9 });
  if (ends >= 2) out.push(long ? { x: 109, y: 50 } : { x: 50, y: 109 });
  return out;
}

export function TableShape(p: TableShapeProps) {
  const t = p.t ?? ((s: string) => s);
  const look = STATE_LOOK[p.state];
  const Glyph = PosIcon[look.icon];
  const seats = seatPositions(p.shape, p.seats, p.w, p.h);
  const style = { '--table-bg': `var(--pos-t-${p.state})`, '--table-ink': `var(--pos-t-${p.state}-ink)`, '--table-edge': `var(--pos-t-${p.state}-edge)` } as CSSProperties;
  return (
    <span className={`pos-table shape-${p.shape} tstate-${p.state}${p.idle ? ' is-idle' : ''}${p.ready ? ' is-ready' : ''}${p.selected ? ' is-selected' : ''}`} style={style}>
      {seats.map((s, i) => <span key={i} className={`pos-seat${p.party !== undefined && i < p.party ? ' taken' : ''}`} style={{ left: `${s.x}%`, top: `${s.y}%` }} aria-hidden="true" />)}
      <span className="pos-table-top">
        {/* Upright text whatever way the table is turned. */}
        <span className="pos-table-info" style={p.rotation ? { transform: `rotate(${-p.rotation}deg)` } : undefined}>
          <span className="pos-table-state"><Glyph /><span>{t(look.label)}</span></span>
          <strong className="pos-table-name">{p.name}</strong>
          {p.party !== undefined && (
            <span className="pos-table-meta"><span>{p.party}<PosIcon.person /></span>{p.server && <span>{p.server}</span>}{p.minutes !== undefined && <span>{p.minutes}′</span>}</span>
          )}
          {p.total && <span className="pos-table-total num">{p.total}</span>}
          {!p.party && p.booking && <span className="pos-table-booking">{p.booking}</span>}
          {!p.party && !p.booking && p.state === 'free' && <span className="pos-table-meta"><span>{p.seats}<PosIcon.person /></span></span>}
        </span>
      </span>
      {p.idle && <span className="pos-table-flag idle" title={t('No activity for a while')}><PosIcon.clock /></span>}
      {p.ready && <span className="pos-table-flag ready" title={t('Food is ready')}><PosIcon.bell /></span>}
    </span>
  );
}
