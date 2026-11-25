/**
 * The floor on a till (docs/design/DESIGN-SYSTEM.md, "Floor and tables"): the plan to scale, with each
 * table in its real shape and its seats, its state by colour, icon and word, and what a server needs at
 * arm's length. Pinch or scroll to zoom, drag the floor to pan, "Fit" to see it all. Tap a table to
 * open it; hold it for its actions; hold and drag it onto another table to move or join (with a
 * confirmation). Or see the tables as a list (the default on a phone). "My tables" and the state
 * filters dim (plan) or hide (list) the rest.
 *
 * Appearance only: every action is one the table screen already has (store ops), and the data is the
 * same as the web's floor.
 */

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TableState } from '../../../src/venue/check.ts';
import { useT } from '../i18n';
import { Badge, Button, CategoryTabs, Chip, EmptyState, Icon, ListRow, Sheet } from '../pos/design/components';
import { feedback } from '../pos/design/feedback';
import { STATE_LOOK, TABLE_STATES, TableShape } from '../pos/design/table';
import type { FloorItem, FloorPlan, NumberedCheck, Staff } from './store';

/** The plan's world: x and y are stored as tenths of a percent of a 16:10 room. */
const WORLD_W = 1600;
const WORLD_H = 1000;
const LONG_PRESS_MS = 450;
const MOVE_SLOP = 8;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export interface FloorTable {
  item: FloorItem;
  check: NumberedCheck | null;
  state: TableState;
  /** What the check comes to, as text ("BZ$45.00"); none when nothing is ordered. */
  total?: string;
  booking?: string;
  mine: boolean;
  idle: boolean;
  ready: boolean;
  server?: string;
  minutes?: number;
}

export type TableAction =
  | { kind: 'open' | 'seat' | 'split' | 'printBill' | 'clean'; table: FloorTable }
  | { kind: 'move'; table: FloorTable; to: FloorItem }
  | { kind: 'merge'; table: FloorTable; to: NumberedCheck }
  | { kind: 'transfer'; table: FloorTable; to: Staff };

type Filter = 'all' | 'mine' | 'free' | 'attention';
type View = 'plan' | 'list';
type Viewport = { x: number; y: number; s: number };

const needsAttention = (t: FloorTable) => t.idle || t.ready || t.state === 'bill' || t.state === 'paid';
const readView = (): View | null => {
  try {
    const v = localStorage.getItem('till.floorView');
    return v === 'plan' || v === 'list' ? v : null;
  } catch {
    return null;
  }
};

export function TouchFloor({ plans, plan, onArea, tables, freeTables, openChecks, staff, onTap, onAction, toolbar }: {
  plans: FloorPlan[];
  plan: FloorPlan;
  onArea: (area: string) => void;
  /** The tables of this area, with what is happening at each. */
  tables: FloorTable[];
  /** Free tables in every area, to move a party to. */
  freeTables: Array<FloorItem & { area: string }>;
  openChecks: NumberedCheck[];
  staff: Staff[];
  onTap: (t: FloorTable) => void;
  onAction: (a: TableAction) => void;
  /** Tabs and Quick sale, beside the area tabs. */
  toolbar?: ReactNode;
}) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View | null>(readView);
  const [legend, setLegend] = useState(false);
  const [actions, setActions] = useState<FloorTable | null>(null);
  const [picking, setPicking] = useState<null | { kind: 'move' | 'merge' | 'transfer'; table: FloorTable }>(null);
  const [confirm, setConfirm] = useState<null | TableAction>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // A phone starts on the list; a tablet or till on the plan. A choice made here is kept.
  const shown: View = view ?? (size.w > 0 && size.w < 600 ? 'list' : 'plan');
  const choose = (v: View) => {
    setView(v);
    try { localStorage.setItem('till.floorView', v); } catch { /* this session only */ }
  };

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const matches = useCallback((x: FloorTable) => filter === 'all' || (filter === 'mine' ? x.mine : filter === 'free' ? x.state === 'free' : needsAttention(x)), [filter]);
  const counts = useMemo(() => ({ mine: tables.filter((x) => x.mine).length, free: tables.filter((x) => x.state === 'free').length, attention: tables.filter(needsAttention).length }), [tables]);
  const fixtures = plan.items.filter((i) => i.type === 'wall' || i.type === 'fixture');

  const act = (a: TableAction) => {
    setActions(null);
    setPicking(null);
    setConfirm(null);
    onAction(a);
  };

  return (
    <div className="floor-touch">
      <div className="floor-tools">
        {plans.length > 1 && <CategoryTabs label={t('Area')} value={plan.area} options={plans.map((p) => [p.area, p.area] as [string, string])} onChange={onArea} />}
        <div className="floor-tools-end">{toolbar}</div>
      </div>
      <div className="floor-tools">
        <div className="till-filters" role="group" aria-label={t('Show')}>
          <Chip pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('All tables')}</Chip>
          <Chip pressed={filter === 'mine'} icon="person" onClick={() => setFilter('mine')}>{t('My tables')}{counts.mine > 0 && <span className="count plain num">{counts.mine}</span>}</Chip>
          <Chip pressed={filter === 'free'} icon="check" onClick={() => setFilter('free')}>{t('Free')}<span className="count plain num">{counts.free}</span></Chip>
          <Chip pressed={filter === 'attention'} icon="alert" onClick={() => setFilter('attention')}>{t('Needs attention')}{counts.attention > 0 && <span className="count num">{counts.attention}</span>}</Chip>
        </div>
        <div className="floor-tools-end">
          <div className="floor-legend-wrap">
            <Button variant="quiet" icon="legend" aria-expanded={legend} onClick={() => setLegend((v) => !v)}>{t('Legend')}</Button>
            {legend && <Legend onClose={() => setLegend(false)} />}
          </div>
          <div className="pos-seg" role="group" aria-label={t('View')}>
            <button type="button" aria-pressed={shown === 'plan'} onClick={() => choose('plan')}><Icon name="plan" /><span>{t('Plan')}</span></button>
            <button type="button" aria-pressed={shown === 'list'} onClick={() => choose('list')}><Icon name="list" /><span>{t('List')}</span></button>
          </div>
        </div>
      </div>

      <div className="floor-frame" ref={frame}>
        {shown === 'plan'
          ? size.w > 0 && <PlanCanvas key={plan.id} plan={plan} tables={tables} fixtures={fixtures} size={size} matches={matches} onTap={onTap} onActions={setActions}
              onDrop={(from, to) => setConfirm(to.check && to.check.status === 'open' ? { kind: 'merge', table: from, to: to.check } : { kind: 'move', table: from, to: to.item })} />
          : <TableList tables={tables.filter(matches)} empty={tables.length > 0} onTap={onTap} onActions={setActions} />}
      </div>

      {actions && <ActionSheet table={actions} onClose={() => setActions(null)} onAct={act} onPick={(kind) => { setPicking({ kind, table: actions }); setActions(null); }} />}
      {picking && (
        <Sheet side title={picking.kind === 'move' ? t('Move {table} to', { table: picking.table.item.name }) : picking.kind === 'merge' ? t('Join {table} with', { table: picking.table.item.name }) : t('Give {table} to', { table: picking.table.item.name })} onClose={() => setPicking(null)}>
          {picking.kind === 'merge' && <p className="muted">{t('Everything on this check goes onto the other, and this one closes.')}</p>}
          <div className="pick-grid">
            {picking.kind === 'move' && (freeTables.length ? freeTables.map((f) => <Button key={f.id} size="lg" onClick={() => act({ kind: 'move', table: picking.table, to: f })}>{f.name}<span className="muted">{f.area}</span></Button>) : <p className="muted">{t('No free table right now.')}</p>)}
            {picking.kind === 'merge' && openChecks.filter((x) => x.id !== picking.table.check?.id).map((x) => <Button key={x.id} size="lg" onClick={() => act({ kind: 'merge', table: picking.table, to: x })}>{x.tableName ?? x.name ?? t('Tab')}</Button>)}
            {picking.kind === 'transfer' && staff.filter((s) => s.orders && s.name !== picking.table.server).map((s) => <Button key={s.id} size="lg" icon="person" onClick={() => act({ kind: 'transfer', table: picking.table, to: s })}>{s.name}</Button>)}
          </div>
        </Sheet>
      )}
      {confirm && (confirm.kind === 'move' || confirm.kind === 'merge') && (
        <Sheet title={confirm.kind === 'move' ? t('Move the party?') : t('Join the checks?')} onClose={() => setConfirm(null)}
          footer={<><Button variant="quiet" size="lg" onClick={() => setConfirm(null)}>{t('Cancel')}</Button><Button variant="primary" size="lg" icon={confirm.kind === 'move' ? 'move' : 'merge'} onClick={() => act(confirm)}>{confirm.kind === 'move' ? t('Move') : t('Join')}</Button></>}>
          <p className="confirm-text">{confirm.kind === 'move'
            ? t('{from} moves to {to}. The order and the bill go with them.', { from: confirm.table.item.name, to: confirm.to.name })
            : t('Everything on {from} goes onto {to}, and {from} closes.', { from: confirm.table.item.name, to: confirm.to.tableName ?? confirm.to.name ?? t('Tab') })}</p>
        </Sheet>
      )}
    </div>
  );
}

/** The states, their colours, icons and words; and the two flags. One tap from the floor. */
function Legend({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="floor-legend" role="dialog" aria-label={t('Legend')}>
      <ul>
        {TABLE_STATES.map((s) => {
          const Glyph = STATE_LOOK[s].icon;
          return <li key={s}><span className={`swatch tstate-${s}`} style={{ background: `var(--pos-t-${s})`, borderColor: `var(--pos-t-${s}-edge)`, color: `var(--pos-t-${s}-ink)` }}><Icon name={Glyph} /></span>{t(STATE_LOOK[s].label)}</li>;
        })}
        <li><span className="swatch flag idle"><Icon name="clock" /></span>{t('No activity for 20 minutes')}</li>
        <li><span className="swatch flag ready"><Icon name="bell" /></span>{t('Food is ready')}</li>
      </ul>
    </div>
  );
}

function ActionSheet({ table, onClose, onAct, onPick }: { table: FloorTable; onClose: () => void; onAct: (a: TableAction) => void; onPick: (k: 'move' | 'merge' | 'transfer') => void }) {
  const t = useT();
  const open = table.check && table.check.status === 'open';
  const ordered = Boolean(table.total);
  return (
    <Sheet title={table.item.name} onClose={onClose}>
      <p className="muted">{t(STATE_LOOK[table.state].label)}{table.check ? ` · ${t('{n} guests', { n: table.check.partySize })}${table.server ? ` · ${table.server}` : ''}` : ''}{table.total ? ` · ${table.total}` : ''}</p>
      <div className="action-grid">
        {table.check ? <Button size="lg" variant="primary" icon="note" onClick={() => onAct({ kind: 'open', table })}>{t('Open the table')}</Button> : <Button size="lg" variant="primary" icon="people" onClick={() => onAct({ kind: 'seat', table })}>{t('Seat a party')}</Button>}
        {open && <Button size="lg" icon="move" onClick={() => onPick('move')}>{t('Move to another table')}</Button>}
        {open && <Button size="lg" icon="merge" onClick={() => onPick('merge')}>{t('Join with another table')}</Button>}
        {open && <Button size="lg" icon="person" onClick={() => onPick('transfer')}>{t('Give to another server')}</Button>}
        {open && ordered && <Button size="lg" icon="split" onClick={() => onAct({ kind: 'split', table })}>{t('Split the bill')}</Button>}
        {open && ordered && <Button size="lg" icon="printer" onClick={() => onAct({ kind: 'printBill', table })}>{t('Print the guest check')}</Button>}
        {table.check?.status === 'paid' && <Button size="lg" icon="sparkle" onClick={() => onAct({ kind: 'clean', table })}>{t('Table is clean')}</Button>}
      </div>
    </Sheet>
  );
}

/** The tables as a list: on a phone, or for anyone who prefers it. */
function TableList({ tables, empty, onTap, onActions }: { tables: FloorTable[]; empty: boolean; onTap: (t: FloorTable) => void; onActions: (t: FloorTable) => void }) {
  const t = useT();
  if (!tables.length) return <EmptyState icon="table" title={empty ? t('No table matches') : t('No tables in this area')}>{empty ? t('Show all tables to see the rest.') : null}</EmptyState>;
  return (
    <ul className="pos-list floor-list" role="group" aria-label={t('Tables')}>
      {[...tables].sort((a, b) => a.item.name.localeCompare(b.item.name, undefined, { numeric: true })).map((x) => {
        const look = STATE_LOOK[x.state];
        return (
          <li key={x.item.id} onContextMenu={(e) => { e.preventDefault(); onActions(x); }}>
            <ListRow
              lead={<span className="state-swatch" style={{ background: `var(--pos-t-${x.state})`, borderColor: `var(--pos-t-${x.state}-edge)`, color: `var(--pos-t-${x.state}-ink)` }}><Icon name={look.icon} /></span>}
              title={<>{x.item.name}<span className="list-state"> · {t(look.label)}</span></>}
              meta={x.check ? <>{t('{n} guests', { n: x.check.partySize })}{x.server ? ` · ${x.server}` : ''}{x.minutes !== undefined ? ` · ${x.minutes}′` : ''}</> : x.booking ?? t('{n} seats', { n: x.item.seats })}
              amount={x.total}
              end={<>{x.ready && <Badge tone="danger" icon="bell">{t('Food ready')}</Badge>}{x.idle && <Badge tone="warning" icon="clock">{t('Idle')}</Badge>}</>}
              onClick={() => onTap(x)}
            />
            <Button variant="quiet" icon="more" aria-label={t('Actions for {table}', { table: x.item.name })} onClick={() => onActions(x)} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The plan: positions in screen pixels from the viewport (so each table's text adapts to its size on
 * screen), with zoom and pan by pointer, pinch, wheel and buttons.
 */
function PlanCanvas({ plan, tables, fixtures, size, matches, onTap, onActions, onDrop }: {
  plan: FloorPlan; tables: FloorTable[]; fixtures: FloorItem[]; size: { w: number; h: number };
  matches: (t: FloorTable) => boolean; onTap: (t: FloorTable) => void; onActions: (t: FloorTable) => void; onDrop: (from: FloorTable, to: FloorTable) => void;
}) {
  const t = useT();
  const fit = useCallback((): Viewport => {
    const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(size.w / WORLD_W, size.h / WORLD_H) * 0.96));
    return { s, x: (size.w - WORLD_W * s) / 2, y: (size.h - WORLD_H * s) / 2 };
  }, [size.w, size.h]);
  const [vp, setVp] = useState<Viewport>(fit);
  const fitted = useRef(true);
  // Fitted until someone zooms or pans; refitted when the screen changes size.
  useEffect(() => { if (fitted.current) setVp(fit()); }, [fit]);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    fitted.current = false;
    setVp((v) => {
      const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.s * factor));
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };

  // Pointers: one on the floor pans; two pinch; one held on a table opens its actions, or drags it.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<null | { kind: 'pan' | 'press' | 'drag' | 'pinch'; id: number; startX: number; startY: number; table?: FloorTable; timer?: ReturnType<typeof setTimeout>; dist?: number }>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<null | { table: FloorTable; dx: number; dy: number; over: string | null }>(null);
  const tableAt = (x: number, y: number) => {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).closest<HTMLElement>('[data-table-id]')?.dataset.tableId;
      if (id && id !== drag?.table.item.id && id !== gesture.current?.table?.item.id) return id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-table-id]');
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    suppressClick.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      clearTimeout(gesture.current?.timer);
      gesture.current = { kind: 'pinch', id: e.pointerId, startX: 0, startY: 0, dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
      setDrag(null);
      return;
    }
    const table = el ? tables.find((x) => x.item.id === el.dataset.tableId) : undefined;
    // No pointer capture yet: a plain tap must reach the table as a click. Captured once it pans or drags.
    if (table) {
      const timer = setTimeout(() => {
        if (gesture.current?.kind !== 'press') return;
        feedback('tap');
        suppressClick.current = true;
        // Held: a party at the table can be dragged; otherwise its actions open on release.
        gesture.current = { ...gesture.current, kind: table.check?.status === 'open' ? 'drag' : 'press', timer: undefined };
        if (table.check?.status === 'open') setDrag({ table, dx: 0, dy: 0, over: null });
        else onActions(table);
      }, LONG_PRESS_MS);
      gesture.current = { kind: 'press', id: e.pointerId, startX: e.clientX, startY: e.clientY, table, timer };
    } else {
      gesture.current = { kind: 'pan', id: e.pointerId, startX: e.clientX, startY: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (g.dist) zoomAt(dist / g.dist, (a!.x + b!.x) / 2 - box.left, (a!.y + b!.y) / 2 - box.top);
      g.dist = dist;
      return;
    }
    if (e.pointerId !== g.id) return;
    const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    if (g.kind === 'press' && moved > MOVE_SLOP && !suppressClick.current) {
      // Moved before the hold: it is a pan.
      clearTimeout(g.timer);
      gesture.current = { kind: 'pan', id: g.id, startX: g.startX, startY: g.startY };
    }
    if (gesture.current?.kind === 'pan' || gesture.current?.kind === 'drag') {
      const el = e.currentTarget as HTMLElement;
      if (!el.hasPointerCapture?.(e.pointerId)) el.setPointerCapture?.(e.pointerId);
    }
    if (gesture.current?.kind === 'pan') {
      if (moved > MOVE_SLOP) suppressClick.current = true;
      fitted.current = false;
      setVp((v) => ({ ...v, x: v.x + e.clientX - last.x, y: v.y + e.clientY - last.y }));
    } else if (gesture.current?.kind === 'drag' && g.table) {
      setDrag({ table: g.table, dx: e.clientX - g.startX, dy: e.clientY - g.startY, over: tableAt(e.clientX, e.clientY) });
    }
  };

  const end = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.kind === 'pinch') {
      if (pointers.current.size === 0) gesture.current = null;
      suppressClick.current = true;
      return;
    }
    if (e.pointerId !== g.id) return;
    gesture.current = null;
    if (g.kind === 'drag' && g.table) {
      const overId = drag?.over;
      const target = overId ? tables.find((x) => x.item.id === overId) : undefined;
      setDrag(null);
      if (target && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > MOVE_SLOP) onDrop(g.table, target);
      else onActions(g.table);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - box.left, e.clientY - box.top);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '+' || e.key === '=') zoomAt(1.2, size.w / 2, size.h / 2);
    else if (e.key === '-') zoomAt(1 / 1.2, size.w / 2, size.h / 2);
    else if (e.key === '0') { fitted.current = true; setVp(fit()); }
  };

  const place = (i: FloorItem) => ({ left: vp.x + (i.x / 1000) * WORLD_W * vp.s, top: vp.y + (i.y / 1000) * WORLD_H * vp.s, width: (i.w / 1000) * WORLD_W * vp.s, height: (i.h / 1000) * WORLD_H * vp.s });

  return (
    <div className="floor-canvas" role="group" aria-label={t('Floor plan of {area}', { area: plan.area })} tabIndex={-1}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onWheel={onWheel} onKeyDown={onKeyDown}>
      <div className="floor-room" style={{ left: vp.x, top: vp.y, width: WORLD_W * vp.s, height: WORLD_H * vp.s, backgroundSize: `${50 * vp.s}px ${50 * vp.s}px` }} aria-hidden="true" />
      {fixtures.map((f) => {
        const door = f.type === 'fixture' && /door|puerta|entrance|entrada/i.test(f.name);
        return (
          <div key={f.id} className={`floor-fixture ${f.type}${door ? ' door' : ''}`} style={{ ...place(f), transform: f.rotation ? `rotate(${f.rotation}deg)` : undefined }} aria-hidden="true">
            {f.type === 'fixture' && <span>{door && <Icon name="door" />}{f.name}</span>}
          </div>
        );
      })}
      {tables.map((x) => {
        const box = place(x.item);
        const dragging = drag?.table.item.id === x.item.id;
        const look = STATE_LOOK[x.state];
        const label = `${x.item.name}: ${t(look.label)}${x.check ? `, ${x.check.partySize}, ${x.server ?? ''}` : ''}${x.booking ? `, ${x.booking}` : ''}${x.idle ? `, ${t('no activity for 20 minutes')}` : ''}${x.ready ? `, ${t('food is ready')}` : ''}`;
        return (
          <button key={x.item.id} type="button" data-table-id={x.item.id} aria-label={label}
            className={`floor-table${matches(x) ? '' : ' is-dimmed'}${dragging ? ' is-dragging' : ''}${drag?.over === x.item.id ? ' is-target' : ''}`}
            style={{ ...box, transform: `${dragging ? `translate(${drag!.dx}px, ${drag!.dy}px) ` : ''}${x.item.rotation ? `rotate(${x.item.rotation}deg)` : ''}` || undefined }}
            onClick={(e) => { if (suppressClick.current) { suppressClick.current = false; e.preventDefault(); return; } onTap(x); }}
            onContextMenu={(e) => { e.preventDefault(); onActions(x); }}
            onKeyDown={(e) => { if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') { e.preventDefault(); onActions(x); } }}>
            <TableShape shape={x.item.type === 'stool' ? 'stool' : x.item.shape} state={x.state} name={x.item.name} seats={x.item.type === 'stool' ? 1 : x.item.seats}
              party={x.check?.partySize} server={x.server} minutes={x.minutes} total={x.total} booking={x.booking} idle={x.idle} ready={x.ready}
              selected={drag?.over === x.item.id} w={x.item.w * 1.6} h={x.item.h} rotation={x.item.rotation} t={t} />
          </button>
        );
      })}
      <div className="floor-zoom" role="group" aria-label={t('Zoom')} onPointerDown={(e) => e.stopPropagation()}>
        <Button variant="secondary" icon="zoomIn" aria-label={t('Zoom in')} onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} />
        <Button variant="secondary" icon="zoomOut" aria-label={t('Zoom out')} onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)} />
        <Button variant="secondary" icon="fit" onClick={() => { fitted.current = true; setVp(fit()); }}>{t('Fit')}</Button>
      </div>
      {drag && <div className="floor-drag-hint" role="status">{drag.over ? t('Let go to move or join') : t('Drag onto another table')}</div>}
    </div>
  );
}
