/**
 * The floor plan editor (Settings → Venue): a drawing canvas for a room's tables, stools, walls, doors
 * and fixtures.
 *
 * - Drag an item to move it (the chosen ones move together). Guides show, and snap to, the edges and
 *   centres of the other items and the room; otherwise it snaps to the grid (unless snapping is off).
 * - Drag any side or corner handle to resize (Shift keeps the proportions); drag the round handle
 *   above to turn it (in 15° steps; Alt for any angle).
 * - Drag on an empty part of the plan to choose everything in the box; Shift-click (or "Select
 *   several") adds and removes.
 * - Undo and redo, zoom, and a panel beside the plan for the exact name, seats, shape, size and angle.
 * - Keyboard: arrows nudge (Shift for more), R turns, Delete removes, Ctrl+Z / Ctrl+Shift+Z, Ctrl+D,
 *   Ctrl+A, Escape.
 *
 * Positions are kept as the API has them: x and width in thousandths of the room's width, y and depth
 * in thousandths of its depth, on a 16:10 room. Here everything is worked out in "world" units where
 * the room is 1600 × 1000, so a square looks square and a drag moves the same distance both ways.
 */

import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from '../pos/design/components';
import { seatPositions } from '../pos/design/table';
import type { FloorItem } from './store';

const RW = 1600;
const RH = 1000;
const SX = RW / 1000;
const GRID = 20;
const ZOOMS = [1, 1.5, 2, 3];
type Box = { x: number; y: number; w: number; h: number };
type Handle = { hx: -1 | 0 | 1; hy: -1 | 0 | 1 };
const HANDLES: Array<Handle & { key: string; cursor: string }> = [
  { key: 'nw', hx: -1, hy: -1, cursor: 'nwse-resize' }, { key: 'n', hx: 0, hy: -1, cursor: 'ns-resize' }, { key: 'ne', hx: 1, hy: -1, cursor: 'nesw-resize' },
  { key: 'e', hx: 1, hy: 0, cursor: 'ew-resize' }, { key: 'se', hx: 1, hy: 1, cursor: 'nwse-resize' }, { key: 's', hx: 0, hy: 1, cursor: 'ns-resize' },
  { key: 'sw', hx: -1, hy: 1, cursor: 'nesw-resize' }, { key: 'w', hx: -1, hy: 0, cursor: 'ew-resize' },
];

const world = (i: FloorItem): Box => ({ x: i.x * SX, y: i.y, w: i.w * SX, h: i.h });
/** Back to the API's units, rounded and kept inside the room and its limits. */
function place(i: FloorItem, b: Box): FloorItem {
  const w = Math.max(20, Math.min(1000, Math.round(b.w / SX)));
  const h = Math.max(10, Math.min(1000, Math.round(b.h)));
  return { ...i, w, h, x: Math.max(0, Math.min(1000 - w, Math.round(b.x / SX))), y: Math.max(0, Math.min(1000 - h, Math.round(b.y))) };
}
const union = (bs: Box[]): Box => {
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
};
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const isSeated = (i: FloorItem) => i.type === 'table' || i.type === 'stool';
const isDoor = (i: FloorItem) => i.type === 'fixture' && /door|puerta/i.test(i.name);

type Gesture =
  | { kind: 'move'; start: { x: number; y: number }; before: FloorItem[]; ids: string[]; moved: boolean }
  | { kind: 'resize'; start: { x: number; y: number }; before: FloorItem[]; id: string; handle: Handle; moved: boolean }
  | { kind: 'rotate'; before: FloorItem[]; id: string; moved: boolean }
  | { kind: 'marquee'; start: { x: number; y: number }; base: string[]; moved: boolean };

export function FloorEditor({ items: saved, onSave }: { items: FloorItem[]; onSave: (items: FloorItem[]) => void }) {
  const t = useT();
  const [items, setItems] = useState<FloorItem[]>(saved);
  const [selected, setSelected] = useState<string[]>([]);
  const [several, setSeveral] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [readout, setReadout] = useState<{ x: number; y: number; text: string } | null>(null);
  const history = useRef<{ past: FloorItem[][]; future: FloorItem[][] }>({ past: [], future: [] });
  const gesture = useRef<Gesture | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const changed = JSON.stringify(items) !== JSON.stringify(saved);
  const chosen = items.filter((i) => selected.includes(i.id));
  const one = chosen.length === 1 ? chosen[0]! : null;

  const commit = (next: FloorItem[]) => {
    history.current.past.push(items);
    if (history.current.past.length > 100) history.current.past.shift();
    history.current.future = [];
    setItems(next);
  };
  const undo = () => { const p = history.current.past.pop(); if (!p) return; history.current.future.push(items); setItems(p); };
  const redo = () => { const f = history.current.future.pop(); if (!f) return; history.current.past.push(items); setItems(f); };
  const patch = (id: string, p: Partial<FloorItem>) => commit(items.map((i) => (i.id === id ? place({ ...i, ...p }, world({ ...i, ...p })) : i)));
  const patchWorld = (id: string, b: Partial<Box>) => commit(items.map((i) => (i.id === id ? place(i, { ...world(i), ...b }) : i)));

  // Pointer to world units, and screen pixels to world units (for snapping distances).
  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * RW, y: ((e.clientY - r.top) / r.height) * RH, px: RW / r.width };
  };
  const snap = (v: number) => (snapOn ? Math.round(v / GRID) * GRID : v);

  const down = (e: ReactPointerEvent, item: FloorItem | null, kind: 'move' | 'resize' | 'rotate' = 'move', handle?: Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    canvas.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    const p = at(e);
    const additive = several || e.shiftKey || e.ctrlKey || e.metaKey;
    if (!item) {
      gesture.current = { kind: 'marquee', start: p, base: additive ? selected : [], moved: false };
      return;
    }
    if (kind === 'move') {
      const next = additive ? (selected.includes(item.id) ? selected.filter((x) => x !== item.id) : [...selected, item.id]) : selected.includes(item.id) ? selected : [item.id];
      setSelected(next);
      gesture.current = { kind: 'move', start: p, before: items, ids: next.includes(item.id) ? next : [], moved: false };
    } else if (kind === 'resize' && handle) {
      gesture.current = { kind: 'resize', start: p, before: items, id: item.id, handle, moved: false };
    } else {
      gesture.current = { kind: 'rotate', before: items, id: item.id, moved: false };
    }
  };

  const move = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const p = at(e);
    const r = canvas.current!.getBoundingClientRect();
    const show = (text: string) => setReadout({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, text });

    if (g.kind === 'marquee') {
      const box = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) };
      if (!g.moved && box.w + box.h < 6 * p.px) return;
      g.moved = true;
      setMarquee(box);
      setSelected([...new Set([...g.base, ...items.filter((i) => overlaps(world(i), box)).map((i) => i.id)])]);
      return;
    }

    if (g.kind === 'move') {
      let dx = p.x - g.start.x;
      let dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < 4 * p.px) return;
      g.moved = true;
      const moving = g.before.filter((i) => g.ids.includes(i.id));
      if (!moving.length) return;
      const group = union(moving.map(world));
      // Guides: the group's edges and centre against the other items' and the room's.
      const others = g.before.filter((i) => !g.ids.includes(i.id)).map(world);
      const xs = [0, RW / 2, RW, ...others.flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w])];
      const ys = [0, RH / 2, RH, ...others.flatMap((b) => [b.y, b.y + b.h / 2, b.y + b.h])];
      const near = (edges: number[], lines: number[]) => {
        let best: { d: number; line: number } | null = null;
        for (const edge of edges) for (const line of lines) {
          const d = line - edge;
          if (Math.abs(d) <= 7 * p.px && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line };
        }
        return best;
      };
      const gx = near([group.x + dx, group.x + group.w / 2 + dx, group.x + group.w + dx], xs);
      const gy = near([group.y + dy, group.y + group.h / 2 + dy, group.y + group.h + dy], ys);
      dx = gx ? dx + gx.d : snap(group.x + dx) - group.x;
      dy = gy ? dy + gy.d : snap(group.y + dy) - group.y;
      dx = Math.max(-group.x, Math.min(RW - group.x - group.w, dx));
      dy = Math.max(-group.y, Math.min(RH - group.y - group.h, dy));
      setGuides({ v: gx ? [gx.line] : [], h: gy ? [gy.line] : [] });
      setItems(g.before.map((i) => (g.ids.includes(i.id) ? place(i, { ...world(i), x: world(i).x + dx, y: world(i).y + dy }) : i)));
      return;
    }

    const item = g.before.find((i) => i.id === g.id);
    if (!item) return;
    const b0 = world(item);
    const cx0 = b0.x + b0.w / 2;
    const cy0 = b0.y + b0.h / 2;

    if (g.kind === 'rotate') {
      g.moved = true;
      let a = (Math.atan2(p.y - cy0, p.x - cx0) * 180) / Math.PI + 90;
      a = ((a % 360) + 360) % 360;
      if (!e.altKey) a = Math.round(a / 15) * 15;
      a = Math.round(a) % 360;
      setItems(g.before.map((i) => (i.id === g.id ? { ...i, rotation: a } : i)));
      show(`${a}°`);
      return;
    }

    // Resize from a side or a corner, in the item's own (turned) frame; the opposite side stays put.
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < 3 * p.px) return;
    g.moved = true;
    const th = (item.rotation * Math.PI) / 180;
    const ldx = dx * Math.cos(th) + dy * Math.sin(th);
    const ldy = -dx * Math.sin(th) + dy * Math.cos(th);
    const { hx, hy } = g.handle;
    let w = hx ? Math.max(20 * SX, b0.w + hx * ldx) : b0.w;
    let h = hy ? Math.max(10, b0.h + hy * ldy) : b0.h;
    if (e.shiftKey && hx && hy) {
      const s = Math.max(w / b0.w, h / b0.h);
      w = b0.w * s;
      h = b0.h * s;
    } else if (snapOn) {
      if (hx) w = Math.max(GRID, snap(w));
      if (hy) h = Math.max(GRID / 2, snap(h));
    }
    const ox = (hx * (w - b0.w)) / 2;
    const oy = (hy * (h - b0.h)) / 2;
    const cx = cx0 + ox * Math.cos(th) - oy * Math.sin(th);
    const cy = cy0 + ox * Math.sin(th) + oy * Math.cos(th);
    setItems(g.before.map((i) => (i.id === g.id ? place(i, { x: cx - w / 2, y: cy - h / 2, w, h }) : i)));
    show(`${Math.round(w)} × ${Math.round(h)}`);
  };

  const up = () => {
    const g = gesture.current;
    gesture.current = null;
    setGuides({ v: [], h: [] });
    setMarquee(null);
    setReadout(null);
    if (!g) return;
    if (g.kind === 'marquee') {
      if (!g.moved && !g.base.length) setSelected([]);
      return;
    }
    if (g.moved) { history.current.past.push(g.before); history.current.future = []; }
  };

  // Adding: in the middle of what is on screen, a little apart from the last one added.
  const add = (type: FloorItem['type'], shape: FloorItem['shape'] = 'square', name?: string) => {
    const tables = items.filter((i) => i.type === 'table').length;
    const id = `${type[0]}${Date.now().toString(36)}`;
    const nth = items.length % 6;
    const base = { id, type, rotation: 0, x: 400 + nth * 30, y: 380 + nth * 30 };
    const item: FloorItem = type === 'table'
      ? { ...base, name: `${t('Table')} ${tables + 1}`, shape, seats: shape === 'rect' ? 6 : shape === 'round' ? 4 : 4, w: shape === 'rect' ? 140 : 75, h: shape === 'rect' ? 120 : 120 }
      : type === 'stool' ? { ...base, name: `${t('Bar')} ${items.filter((i) => i.type === 'stool').length + 1}`, shape: 'round', seats: 1, w: 30, h: 48 }
        : type === 'wall' ? { ...base, name: '', shape: 'rect', seats: 0, w: 300, h: 16 }
          : { ...base, name: name ?? t('Bar'), shape: 'rect', seats: 0, w: name ? 60 : 200, h: name ? 24 : 80 };
    commit([...items, place(item, world(item))]);
    setSelected([id]);
  };
  const duplicate = () => {
    if (!chosen.length) return;
    const copies = chosen.map((i, n) => place({ ...i, id: `${i.type[0]}${(Date.now() + n).toString(36)}`, name: isSeated(i) ? `${i.name} (2)` : i.name }, { ...world(i), x: world(i).x + 40, y: world(i).y + 40 }));
    commit([...items, ...copies]);
    setSelected(copies.map((c) => c.id));
  };
  const remove = () => { commit(items.filter((i) => !selected.includes(i.id))); setSelected([]); };
  const turn = (by: number) => commit(items.map((i) => (selected.includes(i.id) ? { ...i, rotation: (((i.rotation + by) % 360) + 360) % 360 } : i)));
  const autoNumber = () => {
    const order = (type: FloorItem['type']) => items.filter((i) => i.type === type).sort((a, b) => (Math.abs(a.y - b.y) < 60 ? a.x - b.x : a.y - b.y)).map((i) => i.id);
    const tables = order('table');
    const stools = order('stool');
    commit(items.map((i) => (i.type === 'table' ? { ...i, name: `${t('Table')} ${tables.indexOf(i.id) + 1}` } : i.type === 'stool' ? { ...i, name: `${t('Bar')} ${stools.indexOf(i.id) + 1}` } : i)));
  };
  const align = (how: 'left' | 'top' | 'centre' | 'middle' | 'hspace' | 'vspace' | 'size') => {
    if (chosen.length < 2) return;
    const boxes = new Map(chosen.map((i) => [i.id, world(i)]));
    const all = [...boxes.values()];
    const g = union(all);
    if (how === 'size') {
      const first = boxes.get(selected[0]!)!;
      return commit(items.map((i) => (boxes.has(i.id) ? place(i, { ...boxes.get(i.id)!, w: first.w, h: first.h }) : i)));
    }
    if (how === 'hspace' || how === 'vspace') {
      const across = how === 'hspace';
      const row = [...chosen].sort((a, b) => (across ? world(a).x - world(b).x : world(a).y - world(b).y));
      const total = row.reduce((s, i) => s + (across ? world(i).w : world(i).h), 0);
      const gap = ((across ? g.w : g.h) - total) / (row.length - 1);
      let pos = across ? g.x : g.y;
      const to = new Map(row.map((i) => { const v = pos; pos += (across ? world(i).w : world(i).h) + gap; return [i.id, v]; }));
      return commit(items.map((i) => (to.has(i.id) ? place(i, { ...world(i), ...(across ? { x: to.get(i.id)! } : { y: to.get(i.id)! }) }) : i)));
    }
    commit(items.map((i) => {
      const b = boxes.get(i.id);
      if (!b) return i;
      const next = how === 'left' ? { x: g.x } : how === 'top' ? { y: g.y } : how === 'centre' ? { x: g.x + g.w / 2 - b.w / 2 } : { y: g.y + g.h / 2 - b.h / 2 };
      return place(i, { ...b, ...next });
    }));
  };

  const keys = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && k === 'y') { e.preventDefault(); return redo(); }
    if (mod && k === 'd') { e.preventDefault(); return duplicate(); }
    if (mod && k === 'a') { e.preventDefault(); return setSelected(items.map((i) => i.id)); }
    if (e.key === 'Escape') return setSelected([]);
    if (!selected.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return remove(); }
    if (k === 'r' && !mod) { e.preventDefault(); return turn(e.shiftKey ? -15 : 15); }
    const step = e.shiftKey ? GRID * 5 : GRID;
    const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    commit(items.map((i) => (selected.includes(i.id) ? place(i, { ...world(i), x: world(i).x + d[0]!, y: world(i).y + d[1]! }) : i)));
  };

  // Ctrl + wheel zooms (a plain wheel scrolls the page as usual).
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + (e.deltaY < 0 ? 1 : -1)))]!);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const counts = useMemo(() => ({ tables: items.filter((i) => i.type === 'table').length, seats: items.reduce((s, i) => s + (isSeated(i) ? i.seats : 0), 0) }), [items]);
  const pct = (b: Box) => ({ left: `${(b.x / RW) * 100}%`, top: `${(b.y / RH) * 100}%`, width: `${(b.w / RW) * 100}%`, height: `${(b.h / RH) * 100}%` });

  return (
    <div className="fe">
      <div className="fe-toolbar" role="toolbar" aria-label={t('Add to the plan')}>
        <span className="fe-group-label">{t('Add')}</span>
        <button type="button" className="fe-tool" onClick={() => add('table', 'round')}><Icon name="roundTable" />{t('Round table')}</button>
        <button type="button" className="fe-tool" onClick={() => add('table', 'square')}><Icon name="table" />{t('Square table')}</button>
        <button type="button" className="fe-tool" onClick={() => add('table', 'rect')}><Icon name="table" />{t('Long table')}</button>
        <button type="button" className="fe-tool" onClick={() => add('stool')}><Icon name="stool" />{t('Bar stool')}</button>
        <button type="button" className="fe-tool" onClick={() => add('wall')}><Icon name="wall" />{t('Wall')}</button>
        <button type="button" className="fe-tool" onClick={() => add('fixture', 'rect', t('Door'))}><Icon name="door" />{t('Door')}</button>
        <button type="button" className="fe-tool" onClick={() => add('fixture')}><Icon name="plan" />{t('Fixture')}</button>
      </div>
      <div className="fe-toolbar" role="toolbar" aria-label={t('Arrange')}>
        <button type="button" className="fe-tool" onClick={undo} disabled={!history.current.past.length} aria-keyshortcuts="Control+Z"><Icon name="undo" />{t('Undo')}</button>
        <button type="button" className="fe-tool" onClick={redo} disabled={!history.current.future.length} aria-keyshortcuts="Control+Shift+Z"><Icon name="redo" />{t('Redo')}</button>
        <span className="fe-sep" />
        <button type="button" className="fe-tool" aria-pressed={several} onClick={() => setSeveral((v) => !v)}><Icon name="check" />{t('Select several')}</button>
        <button type="button" className="fe-tool" onClick={autoNumber} disabled={!counts.tables}>#&nbsp;{t('Number the tables')}</button>
        <label className="fe-check"><input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> {t('Snap to the grid')}</label>
        <span className="fe-sep" />
        <div className="fe-zoom" role="group" aria-label={t('Zoom')}>
          <button type="button" className="fe-tool icon" aria-label={t('Zoom out')} disabled={zoom === ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}><Icon name="zoomOut" /></button>
          <span className="num">{Math.round(zoom * 100)}%</span>
          <button type="button" className="fe-tool icon" aria-label={t('Zoom in')} disabled={zoom === ZOOMS.at(-1)} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}><Icon name="zoomIn" /></button>
        </div>
        <span className="spacer" />
        {changed && <span className="fe-unsaved">{t('Unsaved changes')}</span>}
        <button type="button" disabled={!changed} onClick={() => onSave(items)}>{t('Save the plan')}</button>
      </div>

      <div className="fe-body">
        <div className="fe-frame" ref={frame}>
          <div
            ref={canvas}
            className="fe-canvas"
            style={{ width: `${zoom * 100}%` }}
            tabIndex={0}
            aria-label={t('Floor plan editor')}
            onPointerDown={(e) => down(e, null)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={keys}
          >
            {items.map((item) => {
              const b = world(item);
              const on = selected.includes(item.id);
              const seats = item.type === 'table' ? seatPositions(item.shape, item.seats, b.w, b.h) : [];
              const cls = item.type === 'wall' ? 'fe-item wall' : item.type === 'fixture' ? `fe-item fixture${isDoor(item) ? ' door' : ''}` : `fe-item seat-${item.type} shape-${item.type === 'stool' ? 'round' : item.shape}`;
              return (
                <div key={item.id} role="button" tabIndex={0} aria-pressed={on} aria-label={item.name || t(item.type === 'wall' ? 'Wall' : 'Fixture')}
                  className={`${cls}${on ? ' selected' : ''}`} style={{ ...pct(b), transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined }}
                  onPointerDown={(e) => down(e, item)} onFocus={() => !selected.includes(item.id) && setSelected([item.id])}>
                  {seats.map((s, n) => <span key={n} className="fe-seat" style={{ left: `${s.x}%`, top: `${s.y}%` }} aria-hidden="true" />)}
                  {item.type !== 'wall' && (
                    <span className="fe-label" style={item.rotation ? { transform: `rotate(${-item.rotation}deg)` } : undefined}>
                      {isDoor(item) && <Icon name="door" />}
                      <strong>{item.name}</strong>
                      {item.type === 'table' && <span>{t('{n} seats', { n: item.seats })}</span>}
                    </span>
                  )}
                  {one?.id === item.id && (
                    <>
                      {HANDLES.map((h) => (
                        <span key={h.key} className={`fe-handle h-${h.key}`} style={{ cursor: h.cursor }} role="presentation" title={t('Drag to resize')}
                          onPointerDown={(e) => down(e, item, 'resize', h)} />
                      ))}
                      <span className="fe-rotate" role="presentation" title={t('Drag to turn')} onPointerDown={(e) => down(e, item, 'rotate')}><Icon name="rotate" /></span>
                    </>
                  )}
                </div>
              );
            })}
            {guides.v.map((x) => <span key={`v${x}`} className="fe-guide v" style={{ left: `${(x / RW) * 100}%` }} />)}
            {guides.h.map((y) => <span key={`h${y}`} className="fe-guide h" style={{ top: `${(y / RH) * 100}%` }} />)}
            {marquee && <span className="fe-marquee" style={pct(marquee)} />}
            {readout && <span className="fe-readout num" style={{ left: `${readout.x}%`, top: `${readout.y}%` }}>{readout.text}</span>}
          </div>
        </div>

        <aside className="fe-panel" aria-label={t('The chosen item')}>
          {!chosen.length && (
            <>
              <h3>{t('{n} tables, {s} seats', { n: counts.tables, s: counts.seats })}</h3>
              <p className="small muted">{t('Choose an item to change it, or drag across the plan to choose several. Drag a side or a corner to resize it (Shift keeps its shape), the round handle to turn it.')}</p>
              <p className="small muted">{t('Keys: arrows move (Shift for more), R turns, Delete removes, Ctrl+Z undoes, Ctrl+D duplicates, Ctrl+A chooses all.')}</p>
            </>
          )}
          {one && (
            <>
              <h3>{one.name || t(one.type === 'wall' ? 'Wall' : 'Fixture')}</h3>
              {one.type !== 'wall' && <label className="field"><span className="field-label">{t('Name')}</span><input maxLength={30} value={one.name} onChange={(e) => patch(one.id, { name: e.target.value })} /></label>}
              {one.type === 'table' && (
                <>
                  <div className="field"><span className="field-label">{t('Seats')}</span>
                    <div className="fe-stepper">
                      <button type="button" aria-label={t('One less')} disabled={one.seats <= 1} onClick={() => patch(one.id, { seats: one.seats - 1 })}>−</button>
                      <input type="number" inputMode="numeric" min={1} max={40} aria-label={t('Seats')} value={one.seats} onChange={(e) => patch(one.id, { seats: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} />
                      <button type="button" aria-label={t('One more')} disabled={one.seats >= 40} onClick={() => patch(one.id, { seats: one.seats + 1 })}>+</button>
                    </div>
                  </div>
                  <div className="field"><span className="field-label">{t('Shape')}</span>
                    <div className="fe-seg" role="group" aria-label={t('Shape')}>
                      {([['round', t('Round')], ['square', t('Square')], ['rect', t('Rectangle')]] as const).map(([v, label]) => <button key={v} type="button" aria-pressed={one.shape === v} onClick={() => patch(one.id, { shape: v })}>{label}</button>)}
                    </div>
                  </div>
                </>
              )}
              <div className="fe-grid2">
                <label className="field"><span className="field-label">{t('Width')}</span><input type="number" inputMode="numeric" step={GRID} value={Math.round(world(one).w)} onChange={(e) => patchWorld(one.id, { w: Number(e.target.value) || 0 })} /></label>
                <label className="field"><span className="field-label">{t('Depth')}</span><input type="number" inputMode="numeric" step={GRID} value={Math.round(world(one).h)} onChange={(e) => patchWorld(one.id, { h: Number(e.target.value) || 0 })} /></label>
              </div>
              <div className="field"><span className="field-label">{t('Turned')}</span>
                <div className="fe-stepper wide">
                  <button type="button" aria-label={t('Turn left 15°')} onClick={() => turn(-15)}>↺</button>
                  <input type="number" inputMode="numeric" min={0} max={359} aria-label={t('Turned')} value={one.rotation} onChange={(e) => patch(one.id, { rotation: ((Math.round(Number(e.target.value) || 0) % 360) + 360) % 360 })} />
                  <button type="button" aria-label={t('Turn right 15°')} onClick={() => turn(15)}>↻</button>
                </div>
              </div>
              <div className="fe-actions">
                <button type="button" className="secondary" onClick={duplicate}><Icon name="copy" />{t('Duplicate')}</button>
                <button type="button" className="secondary danger-text" onClick={remove}><Icon name="trash" />{t('Remove')}</button>
              </div>
            </>
          )}
          {chosen.length > 1 && (
            <>
              <h3>{t('{n} chosen', { n: chosen.length })}</h3>
              <div className="fe-align">
                <button type="button" className="secondary" onClick={() => align('left')}><Icon name="alignLeft" />{t('Line up left')}</button>
                <button type="button" className="secondary" onClick={() => align('top')}><Icon name="alignTop" />{t('Line up top')}</button>
                <button type="button" className="secondary" onClick={() => align('centre')}>{t('Line up centres across')}</button>
                <button type="button" className="secondary" onClick={() => align('middle')}>{t('Line up centres down')}</button>
                <button type="button" className="secondary" disabled={chosen.length < 3} onClick={() => align('hspace')}><Icon name="distribute" />{t('Space evenly across')}</button>
                <button type="button" className="secondary" disabled={chosen.length < 3} onClick={() => align('vspace')}>{t('Space evenly down')}</button>
                <button type="button" className="secondary" onClick={() => align('size')}>{t('Same size as the first')}</button>
              </div>
              <div className="fe-actions">
                <button type="button" className="secondary" onClick={duplicate}><Icon name="copy" />{t('Duplicate')}</button>
                <button type="button" className="secondary danger-text" onClick={remove}><Icon name="trash" />{t('Remove them from the plan')}</button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
