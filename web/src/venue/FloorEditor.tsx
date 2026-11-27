/**
 * The floor plan editor (Settings → Venue): a drawing canvas for a room's tables, stools, walls, doors
 * and fixtures.
 *
 * - Add from the toolbar: a click puts the item in a free spot in view; dragging a tool onto the plan
 *   puts it where it is dropped.
 * - Drag an item to move it (the chosen ones move together). Guides show, and snap to, the edges and
 *   centres of the other items and the room; otherwise it snaps to the grid (unless snapping is off).
 * - Handles to fit the item: all sides and corners on a table, the two ends of a wall, the corners of
 *   something small. Shift keeps the proportions. The round handle turns it (15° steps; Alt for any).
 * - Drag on an empty part of the plan to choose everything in the box; Shift-click adds and removes.
 *   Right-click for duplicate, turn, front and back, remove.
 * - Zoom at the pointer (Ctrl + wheel, a trackpad pinch) or with the buttons; pan with Space + drag or
 *   the middle button.
 * - By touch: one finger moves an item (or, on an empty part, the view), two fingers pinch to zoom and
 *   pan, and a finger held on an item opens its menu. With "Select several" on, a finger draws a box.
 * - A panel beside the plan for the exact name, seats, shape, size and angle, checked when you leave
 *   the field (or press Enter); tables that overlap are marked.
 * - Every change is one step of undo, however many keys it took. Nothing is saved until "Save the
 *   plan", and leaving with changes asks first.
 *
 * Positions are kept as the API has them: x and width in thousandths of the room's width, y and depth
 * in thousandths of its depth, on a 16:10 room. Here everything is worked out in "world" units where
 * the room is 1600 × 1000, so a square looks square and a drag moves the same distance both ways.
 */

import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from '../pos/design/components';
import type { PosIconName } from '../pos/design/icons';
import { feedback } from '../pos/design/feedback';
import { seatPositions } from '../pos/design/table';
import type { FloorItem } from './store';

const RW = 1600;
const RH = 1000;
const SX = RW / 1000;
const GRID = 20;
const ZOOMS = [1, 1.25, 1.5, 2, 3];
type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
type Handle = { hx: -1 | 0 | 1; hy: -1 | 0 | 1; key: string; cursor: string };
const ALL_HANDLES: Handle[] = [
  { key: 'nw', hx: -1, hy: -1, cursor: 'nwse-resize' }, { key: 'n', hx: 0, hy: -1, cursor: 'ns-resize' }, { key: 'ne', hx: 1, hy: -1, cursor: 'nesw-resize' },
  { key: 'e', hx: 1, hy: 0, cursor: 'ew-resize' }, { key: 'se', hx: 1, hy: 1, cursor: 'nwse-resize' }, { key: 's', hx: 0, hy: 1, cursor: 'ns-resize' },
  { key: 'sw', hx: -1, hy: 1, cursor: 'nesw-resize' }, { key: 'w', hx: -1, hy: 0, cursor: 'ew-resize' },
];

const world = (i: FloorItem): Box => ({ x: i.x * SX, y: i.y, w: i.w * SX, h: i.h });
/** A width as shown: widths are kept in steps of 1.6, so they are shown to the nearest 2 (what is typed is what shows). */
const shownWidth = (w: number) => Math.round(w / 2) * 2;
/** Back to the API's units, rounded and kept inside the room and its limits. */
function place(i: FloorItem, b: Box): FloorItem {
  const w = Math.max(20, Math.min(1000, Math.round(b.w / SX)));
  const h = Math.max(10, Math.min(1000, Math.round(b.h)));
  return { ...i, w, h, x: Math.max(0, Math.min(1000 - w, Math.round(b.x / SX))), y: Math.max(0, Math.min(1000 - h, Math.round(b.y))) };
}
/**
 * An item as the server keeps it (fields in one order, the name trimmed), so "unsaved" compares what
 * would be saved and not how the object happens to be written.
 */
const stored = (i: FloorItem) => [i.id, i.type, i.name.trim().slice(0, 30), i.shape, i.type === 'table' ? i.seats : i.type === 'stool' ? 1 : 0, i.x, i.y, i.w, i.h, i.rotation];
const samePlan = (a: FloorItem[], b: FloorItem[]) => a.length === b.length && JSON.stringify(a.map(stored)) === JSON.stringify(b.map(stored));
/** The box an item covers on the floor, turned. */
function footprint(i: FloorItem): Box {
  const b = world(i);
  const th = (i.rotation * Math.PI) / 180;
  const w = Math.abs(b.w * Math.cos(th)) + Math.abs(b.h * Math.sin(th));
  const h = Math.abs(b.w * Math.sin(th)) + Math.abs(b.h * Math.cos(th));
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}
const union = (bs: Box[]): Box => {
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
};
const overlaps = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w - gap && b.x < a.x + a.w - gap && a.y < b.y + b.h - gap && b.y < a.y + a.h - gap;
const isSeated = (i: FloorItem) => i.type === 'table' || i.type === 'stool';
const isDoor = (i: FloorItem) => i.type === 'fixture' && /^(door|puerta)\b/i.test(i.name.trim());
const layer = (i: FloorItem) => (i.type === 'wall' ? 0 : i.type === 'fixture' ? 1 : 2);
/** Which handles an item gets: a wall its two ends, something small its corners, the rest all eight. */
function handlesFor(i: FloorItem, b: Box): Handle[] {
  if (i.type === 'wall') return ALL_HANDLES.filter((h) => h.key === 'e' || h.key === 'w');
  if (Math.min(b.w, b.h) < 56) return ALL_HANDLES.filter((h) => h.hx && h.hy);
  return ALL_HANDLES;
}

type Tool = { type: FloorItem['type']; shape?: FloorItem['shape']; door?: boolean; icon: PosIconName; label: string };
type Gesture =
  | { kind: 'move'; start: Pt; before: FloorItem[]; ids: string[]; moved: boolean; only: string | null }
  | { kind: 'resize'; start: Pt; before: FloorItem[]; id: string; handle: Handle; moved: boolean }
  | { kind: 'rotate'; before: FloorItem[]; id: string; moved: boolean }
  | { kind: 'marquee'; start: Pt; base: string[]; moved: boolean }
  | { kind: 'pan'; x: number; y: number; left: number; top: number; tap?: boolean; moved?: boolean }
  // Two fingers: the point of the plan under them at the start stays under them, at the new size.
  | { kind: 'pinch'; dist: number; zoom: number; fx: number; fy: number };

/** A finger held this long on an item, without moving, opens its menu. */
const HOLD_MS = 500;

export function FloorEditor({ items: saved, onSave, onDirty }: { items: FloorItem[]; onSave: (items: FloorItem[]) => void; onDirty?: (dirty: boolean) => void }) {
  const t = useT();
  const [items, setItems] = useState<FloorItem[]>(saved);
  const [selected, setSelected] = useState<string[]>([]);
  const [several, setSeveral] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [readout, setReadout] = useState<{ x: number; y: number; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ tool: Tool; at: Pt | null } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [, rerender] = useState(0);
  const history = useRef<{ past: FloorItem[][]; future: FloorItem[][]; key: string; at: number }>({ past: [], future: [], key: '', at: 0 });
  const gesture = useRef<Gesture | null>(null);
  const clipboard = useRef<{ items: FloorItem[]; pastes: number }>({ items: [], pastes: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ fx: number; fy: number; vx: number; vy: number } | null>(null);
  // Touch: the fingers on the plan, the one that leads a one-finger gesture, and the hold timer.
  const pointers = useRef(new Map<number, Pt>());
  const lead = useRef<number | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [touch, setTouch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const changed = !samePlan(items, saved);
  const chosen = items.filter((i) => selected.includes(i.id));
  const one = chosen.length === 1 ? chosen[0]! : null;

  useEffect(() => onDirty?.(changed), [changed, onDirty]);
  useEffect(() => () => clearTimeout(hold.current), []);
  // One world unit in pixels, for things drawn to scale (the chairs): kept on the canvas as --u.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(([e]) => c.style.setProperty('--u', `${e!.contentRect.width / RW}px`));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  // Closing or reloading the page with changes not saved asks first.
  useEffect(() => {
    if (!changed) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);

  // ---------- history: one step per change; typing in one field, or nudging, is one step ----------
  const commit = (next: FloorItem[], key = '') => {
    const h = history.current;
    const now = Date.now();
    if (!(key && key === h.key && now - h.at < 1500)) {
      h.past.push(items);
      if (h.past.length > 100) h.past.shift();
    }
    h.future = [];
    h.key = key;
    h.at = now;
    setItems(next);
  };
  const undo = () => { const h = history.current; const p = h.past.pop(); if (!p) return; h.future.push(items); h.key = ''; setItems(p); };
  const redo = () => { const h = history.current; const f = h.future.pop(); if (!f) return; h.past.push(items); h.key = ''; setItems(f); };
  const patch = (id: string, p: Partial<FloorItem>, key = '') => commit(items.map((i) => (i.id === id ? place({ ...i, ...p }, world({ ...i, ...p })) : i)), key);
  const patchWorld = (id: string, b: Partial<Box>) => commit(items.map((i) => (i.id === id ? place(i, { ...world(i), ...b }) : i)));

  // ---------- geometry helpers ----------
  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * RW, y: ((e.clientY - r.top) / r.height) * RH, px: RW / r.width };
  };
  const snap = (v: number) => (snapOn ? Math.round(v / GRID) * GRID : v);
  /** The middle of what is on screen, in world units. */
  const inView = (): Pt => {
    const f = frame.current;
    const c = canvas.current;
    if (!f || !c) return { x: RW / 2, y: RH / 2 };
    const fr = f.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const cx = (Math.max(fr.left, cr.left) + Math.min(fr.right, cr.right)) / 2;
    const cy = (Math.max(fr.top, cr.top) + Math.min(fr.bottom, cr.bottom)) / 2;
    return { x: ((cx - cr.left) / cr.width) * RW, y: ((cy - cr.top) / cr.height) * RH };
  };
  /** A place for a new item near a point that covers nothing else, on the grid. */
  const freeSpot = (size: { w: number; h: number }, near: Pt): Pt => {
    const taken = items.map(footprint);
    // Room for the chairs all round (about a grid square and a half), and inside the walls.
    const fits = (x: number, y: number) => x >= 24 && y >= 24 && x + size.w <= RW - 24 && y + size.h <= RH - 24 && !taken.some((b) => overlaps({ x: x - 56, y: y - 56, w: size.w + 112, h: size.h + 112 }, b));
    const sx = Math.round((near.x - size.w / 2) / GRID) * GRID;
    const sy = Math.round((near.y - size.h / 2) / GRID) * GRID;
    for (let ring = 0; ring < 40; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = sx + dx * GRID * 2;
        const y = sy + dy * GRID * 2;
        if (fits(x, y)) return { x, y };
      }
    }
    return { x: Math.max(0, Math.min(RW - size.w, sx)), y: Math.max(0, Math.min(RH - size.h, sy)) };
  };

  // ---------- adding ----------
  const TOOLS: Tool[] = [
    { type: 'table', shape: 'round', icon: 'roundTable', label: t('Round table') },
    { type: 'table', shape: 'square', icon: 'table', label: t('Square table') },
    { type: 'table', shape: 'rect', icon: 'table', label: t('Long table') },
    { type: 'stool', icon: 'stool', label: t('Bar stool') },
    { type: 'wall', icon: 'wall', label: t('Wall') },
    { type: 'fixture', door: true, icon: 'door', label: t('Door') },
    { type: 'fixture', icon: 'plan', label: t('Fixture') },
  ];
  const sizeOf = (tool: Tool) => (tool.type === 'table' ? (tool.shape === 'rect' ? { w: 240, h: 120 } : { w: 120, h: 120 })
    : tool.type === 'stool' ? { w: 48, h: 48 } : tool.type === 'wall' ? { w: 320, h: 16 } : tool.door ? { w: 64, h: 64 } : { w: 200, h: 80 });
  const make = (tool: Tool, topLeft: Pt): FloorItem => {
    const tables = items.filter((i) => i.type === 'table').length;
    const stools = items.filter((i) => i.type === 'stool').length;
    const s = sizeOf(tool);
    const base = { id: `${tool.type[0]}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, type: tool.type, rotation: 0, x: 0, y: 0, w: 0, h: 0 };
    const item: FloorItem = tool.type === 'table' ? { ...base, name: `${t('Table')} ${tables + 1}`, shape: tool.shape ?? 'square', seats: tool.shape === 'rect' ? 6 : 4 }
      : tool.type === 'stool' ? { ...base, name: `${t('Bar')} ${stools + 1}`, shape: 'round', seats: 1 }
        : tool.type === 'wall' ? { ...base, name: '', shape: 'rect', seats: 0 }
          : { ...base, name: tool.door ? t('Door') : t('Bar'), shape: 'rect', seats: 0 };
    return place(item, { x: topLeft.x, y: topLeft.y, ...s });
  };
  const addAt = (tool: Tool, centre: Pt | null) => {
    const s = sizeOf(tool);
    const spot = centre ? { x: snap(centre.x - s.w / 2), y: snap(centre.y - s.h / 2) } : freeSpot(s, inView());
    const item = make(tool, spot);
    commit([...items, item]);
    setSelected([item.id]);
    canvas.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  };
  // A tool dragged onto the plan: a ghost follows the pointer; let go over the plan to place it.
  const toolDown = (e: ReactPointerEvent, tool: Tool) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const over = (ev: PointerEvent) => {
      const r = canvas.current?.getBoundingClientRect();
      return r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom ? at(ev) : null;
    };
    const moveTool = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      dragging = true;
      setGhost({ tool, at: over(ev) });
    };
    const upTool = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', moveTool);
      window.removeEventListener('pointerup', upTool);
      setGhost(null);
      if (!dragging) return addAt(tool, null);
      const p = over(ev);
      if (p) addAt(tool, p);
    };
    window.addEventListener('pointermove', moveTool);
    window.addEventListener('pointerup', upTool);
  };

  // ---------- pointer on the plan ----------
  const openMenu = (item: FloorItem, e: { clientX: number; clientY: number }) => {
    if (!selected.includes(item.id)) setSelected([item.id]);
    const r = canvas.current!.getBoundingClientRect();
    setMenu({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
  };
  const startPan = (e: ReactPointerEvent, tap = false) => {
    const f = frame.current!;
    gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, left: f.scrollLeft, top: f.scrollTop, tap, moved: false };
  };
  const down = (e: ReactPointerEvent, item: FloorItem | null, kind: 'move' | 'resize' | 'rotate' = 'move', handle?: Handle) => {
    const finger = e.pointerType === 'touch';
    if (finger !== touch) setTouch(finger);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger: whatever the first one started is put back, and the two pinch (and pan) the plan.
    if (finger && pointers.current.size >= 2) {
      e.stopPropagation();
      e.preventDefault();
      clearTimeout(hold.current);
      const g = gesture.current;
      if (pointers.current.size > 2 || g?.kind === 'pinch') return;
      if (g && 'before' in g && g.moved) setItems(g.before);
      if (g?.kind === 'marquee') setSelected(g.base);
      setGuides({ v: [], h: [] });
      setMarquee(null);
      setReadout(null);
      const [a, b] = [...pointers.current.values()];
      const r = canvas.current!.getBoundingClientRect();
      gesture.current = { kind: 'pinch', dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), zoom, fx: ((a!.x + b!.x) / 2 - r.left) / r.width, fy: ((a!.y + b!.y) / 2 - r.top) / r.height };
      lead.current = null;
      return;
    }
    lead.current = e.pointerId;
    setMenu(null);
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      startPan(e);
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* not tracked */ }
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    canvas.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    const p = at(e);
    const additive = several || e.shiftKey || e.ctrlKey || e.metaKey;
    if (!item) {
      // A finger on an empty part of the plan moves the view (a tap there clears the choice); with
      // "Select several" on, it draws a box instead, as the mouse does.
      if (finger && !several) return startPan(e, true);
      gesture.current = { kind: 'marquee', start: p, base: additive ? selected : [], moved: false };
      return;
    }
    if (kind === 'move') {
      const was = selected.includes(item.id);
      const next = additive ? (was ? selected.filter((x) => x !== item.id) : [...selected, item.id]) : was ? selected : [item.id];
      setSelected(next);
      // A click (no drag) on one of several chosen items chooses just that one, on release.
      gesture.current = { kind: 'move', start: p, before: items, ids: next.includes(item.id) ? next : [], moved: false, only: !additive && was && selected.length > 1 ? item.id : null };
      // A finger held still on it opens its menu (there is no right button on a touch screen).
      if (e.pointerType !== 'mouse') {
        const g = gesture.current;
        const point = { clientX: e.clientX, clientY: e.clientY };
        clearTimeout(hold.current);
        hold.current = setTimeout(() => {
          if (gesture.current !== g || g.moved) return;
          gesture.current = null;
          feedback('tap');
          if (!next.includes(item.id)) setSelected([item.id]);
          const r = canvas.current!.getBoundingClientRect();
          setMenu({ x: ((point.clientX - r.left) / r.width) * 100, y: ((point.clientY - r.top) / r.height) * 100 });
        }, HOLD_MS);
      }
    } else if (kind === 'resize' && handle) {
      gesture.current = { kind: 'resize', start: p, before: items, id: item.id, handle, moved: false };
    } else {
      gesture.current = { kind: 'rotate', before: items, id: item.id, moved: false };
    }
  };

  const move = (e: ReactPointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const f = frame.current!;
      const fr = f.getBoundingClientRect();
      const next = Math.max(ZOOMS[0]!, Math.min(ZOOMS.at(-1)!, g.zoom * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / g.dist)));
      const anchor = { fx: g.fx, fy: g.fy, vx: (a!.x + b!.x) / 2 - fr.left, vy: (a!.y + b!.y) / 2 - fr.top };
      // The same size (at a limit): only the view moves with the fingers.
      if (Math.abs(next - zoom) < 0.005) scrollTo(anchor);
      else { zoomAnchor.current = anchor; setZoom(next); }
      return;
    }
    if (lead.current !== null && e.pointerId !== lead.current) return;
    if (g.kind === 'pan') {
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
      g.moved = true;
      frame.current!.scrollLeft = g.left - (e.clientX - g.x);
      frame.current!.scrollTop = g.top - (e.clientY - g.y);
      return;
    }
    const p = at(e);
    const r = canvas.current!.getBoundingClientRect();
    const show = (text: string) => setReadout({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, text });

    if (g.kind === 'marquee') {
      const box = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) };
      if (!g.moved && box.w + box.h < 6 * p.px) return;
      g.moved = true;
      setMarquee(box);
      setSelected([...new Set([...g.base, ...items.filter((i) => overlaps(footprint(i), box)).map((i) => i.id)])]);
      return;
    }

    if (g.kind === 'move') {
      let dx = p.x - g.start.x;
      let dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < 4 * p.px) return;
      g.moved = true;
      const moving = g.before.filter((i) => g.ids.includes(i.id));
      if (!moving.length) return;
      const group = union(moving.map(footprint));
      // Guides: the group's edges and centre against the other items' and the room's.
      const others = g.before.filter((i) => !g.ids.includes(i.id)).map(footprint);
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
      const gx = e.altKey ? null : near([group.x + dx, group.x + group.w / 2 + dx, group.x + group.w + dx], xs);
      const gy = e.altKey ? null : near([group.y + dy, group.y + group.h / 2 + dy, group.y + group.h + dy], ys);
      dx = gx ? dx + gx.d : e.altKey ? dx : snap(group.x + dx) - group.x;
      dy = gy ? dy + gy.d : e.altKey ? dy : snap(group.y + dy) - group.y;
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
    } else if (snapOn && !e.altKey) {
      if (hx) w = Math.max(GRID, snap(w));
      if (hy) h = Math.max(GRID / 2, snap(h));
    }
    const ox = (hx * (w - b0.w)) / 2;
    const oy = (hy * (h - b0.h)) / 2;
    const cx = cx0 + ox * Math.cos(th) - oy * Math.sin(th);
    const cy = cy0 + ox * Math.sin(th) + oy * Math.cos(th);
    setItems(g.before.map((i) => (i.id === g.id ? place(i, { x: cx - w / 2, y: cy - h / 2, w, h }) : i)));
    show(item.type === 'wall' ? `${shownWidth(w)}` : `${shownWidth(w)} × ${Math.round(h)}`);
  };

  const up = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    clearTimeout(hold.current);
    const g = gesture.current;
    // A pinch lasts until the last finger is lifted; one left behind does not start anything.
    if (g?.kind === 'pinch') {
      if (!pointers.current.size) gesture.current = null;
      return;
    }
    if (lead.current !== null && e.pointerId !== lead.current) return;
    lead.current = null;
    gesture.current = null;
    setGuides({ v: [], h: [] });
    setMarquee(null);
    setReadout(null);
    if (g?.kind === 'pan') {
      if (g.tap && !g.moved) setSelected([]);
      return;
    }
    if (!g) return;
    if (g.kind === 'marquee') {
      if (!g.moved && !g.base.length) setSelected([]);
      return;
    }
    if (g.kind === 'move' && !g.moved && g.only) setSelected([g.only]);
    if (g.moved) { history.current.past.push(g.before); history.current.future = []; history.current.key = ''; rerender((n) => n + 1); }
  };

  // ---------- commands ----------
  // A table or stool left without a name would be dropped by the server: it is given one first.
  const save = () => {
    let n = 0;
    const used = new Set(items.map((x) => x.name.trim()));
    const named = items.map((i) => {
      if (!isSeated(i) || i.name.trim()) return i;
      n += 1;
      const kind = i.type === 'table' ? t('Table') : t('Bar');
      let k = items.filter((x) => x.type === i.type).indexOf(i) + 1;
      while (used.has(`${kind} ${k}`)) k += 1;
      used.add(`${kind} ${k}`);
      return { ...i, name: `${kind} ${k}` };
    });
    if (n) commit(named);
    onSave(named);
  };
  const duplicate = (from = chosen, offset = 40) => {
    if (!from.length) return;
    const copies = from.map((i, n) => place({ ...i, id: `${i.type[0]}${(Date.now() + n).toString(36)}${Math.random().toString(36).slice(2, 4)}`, name: isSeated(i) ? `${i.name} (2)` : i.name }, { ...world(i), x: world(i).x + offset, y: world(i).y + offset }));
    commit([...items, ...copies]);
    setSelected(copies.map((c) => c.id));
  };
  const remove = () => { commit(items.filter((i) => !selected.includes(i.id))); setSelected([]); };
  const turn = (by: number) => commit(items.map((i) => (selected.includes(i.id) ? { ...i, rotation: (((i.rotation + by) % 360) + 360) % 360 } : i)), `turn:${selected.join()}`);
  const restack = (front: boolean) => {
    const mine = items.filter((i) => selected.includes(i.id));
    const rest = items.filter((i) => !selected.includes(i.id));
    commit(front ? [...rest, ...mine] : [...mine, ...rest]);
  };
  const autoNumber = () => {
    const order = (type: FloorItem['type']) => items.filter((i) => i.type === type).sort((a, b) => (Math.abs(a.y - b.y) < 60 ? a.x - b.x : a.y - b.y)).map((i) => i.id);
    const tables = order('table');
    const stools = order('stool');
    commit(items.map((i) => (i.type === 'table' ? { ...i, name: `${t('Table')} ${tables.indexOf(i.id) + 1}` } : i.type === 'stool' ? { ...i, name: `${t('Bar')} ${stools.indexOf(i.id) + 1}` } : i)));
  };
  const align = (how: 'left' | 'top' | 'centre' | 'middle' | 'hspace' | 'vspace' | 'size') => {
    if (chosen.length < 2) return;
    const boxes = new Map(chosen.map((i) => [i.id, world(i)]));
    const g = union([...boxes.values()]);
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

  const keys = (e: ReactKeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); setSpaceDown(true); return; }
    if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && k === 'y') { e.preventDefault(); return redo(); }
    if (mod && k === 'a') { e.preventDefault(); return setSelected(items.map((i) => i.id)); }
    if (mod && k === 'v') { e.preventDefault(); const c = clipboard.current; if (c.items.length) { c.pastes += 1; duplicate(c.items, 40 * c.pastes); } return; }
    if (e.key === 'Escape') { setMenu(null); return setSelected([]); }
    if (!selected.length) return;
    if (mod && (k === 'c' || k === 'x')) {
      e.preventDefault();
      clipboard.current = { items: chosen, pastes: 0 };
      if (k === 'x') remove();
      return;
    }
    if (mod && k === 'd') { e.preventDefault(); return duplicate(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return remove(); }
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const b = union(chosen.map(footprint));
      return setMenu({ x: ((b.x + b.w / 2) / RW) * 100, y: ((b.y + b.h / 2) / RH) * 100 });
    }
    if (k === 'r' && !mod) { e.preventDefault(); return turn(e.shiftKey ? -15 : 15); }
    const step = e.shiftKey ? GRID * 5 : e.altKey ? 2 : GRID;
    const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    commit(items.map((i) => (selected.includes(i.id) ? place(i, { ...world(i), x: world(i).x + d[0]!, y: world(i).y + d[1]! }) : i)), `nudge:${selected.join()}`);
  };

  // ---------- zoom: at the pointer (Ctrl + wheel) or the middle of the view (buttons) ----------
  const zoomTo = (next: number, anchor?: { clientX: number; clientY: number }) => {
    const f = frame.current;
    const c = canvas.current;
    if (!f || !c || Math.abs(next - zoom) < 0.001) return;
    const fr = f.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const ax = anchor?.clientX ?? fr.left + fr.width / 2;
    const ay = anchor?.clientY ?? fr.top + fr.height / 2;
    zoomAnchor.current = { fx: (ax - cr.left) / cr.width, fy: (ay - cr.top) / cr.height, vx: ax - fr.left, vy: ay - fr.top };
    setZoom(next);
  };
  /** Scrolls so the point fx, fy of the plan (fractions) is at vx, vy in the frame. */
  function scrollTo(a: { fx: number; fy: number; vx: number; vy: number }) {
    const f = frame.current;
    const c = canvas.current;
    if (!f || !c) return;
    const cs = getComputedStyle(f);
    f.scrollLeft = a.fx * c.offsetWidth + parseFloat(cs.paddingLeft) - a.vx;
    f.scrollTop = a.fy * c.offsetHeight + parseFloat(cs.paddingTop) - a.vy;
  }
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a) return;
    zoomAnchor.current = null;
    scrollTo(a);
  }, [zoom]);
  // The next level up or down (after a pinch the zoom can be between two levels).
  const step = (dir: 1 | -1) => (dir > 0 ? ZOOMS.find((z) => z > zoom + 0.01) ?? ZOOMS.at(-1)! : [...ZOOMS].reverse().find((z) => z < zoom - 0.01) ?? ZOOMS[0]!);
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  const stepRef = useRef(step);
  stepRef.current = step;
  const zoomLevel = useRef(zoom);
  zoomLevel.current = zoom;
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // A mouse wheel's notch goes to the next level; a trackpad pinch (many small steps) zooms smoothly.
      if (e.deltaMode === 0 && Math.abs(e.deltaY) < 40) {
        const z = zoomLevel.current;
        zoomRef.current(Math.max(ZOOMS[0]!, Math.min(ZOOMS.at(-1)!, z * Math.exp(-e.deltaY * 0.01))), e);
      } else zoomRef.current(stepRef.current(e.deltaY < 0 ? 1 : -1), e);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  // ---------- what is drawn ----------
  const clashes = useMemo(() => {
    const seated = items.filter(isSeated);
    const out = new Map<string, string[]>();
    for (const a of seated) for (const b of seated) {
      if (a.id >= b.id || !overlaps(footprint(a), footprint(b), 2)) continue;
      out.set(a.id, [...(out.get(a.id) ?? []), b.name]);
      out.set(b.id, [...(out.get(b.id) ?? []), a.name]);
    }
    return out;
  }, [items]);
  const counts = useMemo(() => ({ tables: items.filter((i) => i.type === 'table').length, seats: items.reduce((s, i) => s + (isSeated(i) ? i.seats : 0), 0) }), [items]);
  const pct = (b: Box) => ({ left: `${(b.x / RW) * 100}%`, top: `${(b.y / RH) * 100}%`, width: `${(b.w / RW) * 100}%`, height: `${(b.h / RH) * 100}%` });
  const drawn = [...items].sort((a, b) => layer(a) - layer(b));
  const label = (i: FloorItem) => (isDoor(i) ? t('Door') : i.name || t(i.type === 'wall' ? 'Wall' : 'Fixture'));

  return (
    <div className="fe">
      <div className="fe-toolbar" role="toolbar" aria-label={t('Add to the plan')}>
        <span className="fe-group-label">{t('Add')}</span>
        {TOOLS.map((tool) => (
          <button key={tool.label} type="button" className="fe-tool" title={t('Click to add, or drag onto the plan')}
            onPointerDown={(e) => toolDown(e, tool)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addAt(tool, null); } }}>
            <Icon name={tool.icon} />{tool.label}
          </button>
        ))}
      </div>
      <div className="fe-toolbar" role="toolbar" aria-label={t('Arrange')}>
        <button type="button" className="fe-tool" onClick={undo} disabled={!history.current.past.length} aria-keyshortcuts="Control+Z" title="Ctrl+Z"><Icon name="undo" />{t('Undo')}</button>
        <button type="button" className="fe-tool" onClick={redo} disabled={!history.current.future.length} aria-keyshortcuts="Control+Shift+Z" title="Ctrl+Shift+Z"><Icon name="redo" />{t('Redo')}</button>
        <span className="fe-sep" />
        <button type="button" className="fe-tool" aria-pressed={several} onClick={() => setSeveral((v) => !v)} title={t('Each tap adds to the choice (or Shift-click)')}><Icon name="check" />{t('Select several')}</button>
        <button type="button" className="fe-tool" onClick={autoNumber} disabled={!counts.tables} title={t('Top to bottom, left to right')}><span aria-hidden="true">#</span>{t('Number the tables')}</button>
        <label className="fe-check"><input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> {t('Snap to the grid')}</label>
        <span className="fe-sep" />
        <div className="fe-zoom" role="group" aria-label={t('Zoom')}>
          <button type="button" className="fe-tool icon" aria-label={t('Zoom out')} title={t('Zoom out')} disabled={zoom <= ZOOMS[0]! + 0.001} onClick={() => zoomTo(step(-1))}><Icon name="zoomOut" /></button>
          <button type="button" className="fe-zoom-level num" title={t('Back to 100%')} onClick={() => zoomTo(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="fe-tool icon" aria-label={t('Zoom in')} title={t('Zoom in')} disabled={zoom >= ZOOMS.at(-1)! - 0.001} onClick={() => zoomTo(step(1))}><Icon name="zoomIn" /></button>
        </div>
        <span className="spacer" />
        {changed && <span className="fe-unsaved"><span className="dot" aria-hidden="true" />{t('Unsaved changes')}</span>}
        <button type="button" className="fe-save" disabled={!changed} onClick={save}>{t('Save the plan')}</button>
      </div>

      <div className="fe-body">
        <div className={`fe-frame${spaceDown ? ' is-panning' : ''}`} ref={frame}>
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
            onKeyUp={(e) => e.key === ' ' && setSpaceDown(false)}
            onBlur={() => setSpaceDown(false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {!items.length && <p className="fe-empty">{t('An empty room. Add tables from the toolbar above: click to put one in a free spot, or drag it to where it stands.')}</p>}
            {drawn.map((item) => {
              const b = world(item);
              const on = selected.includes(item.id);
              const seats = item.type === 'table' ? seatPositions(item.shape, item.seats, b.w, b.h) : [];
              const clash = clashes.has(item.id);
              const door = isDoor(item);
              const cls = item.type === 'wall' ? 'fe-item wall' : item.type === 'fixture' ? `fe-item fixture${door ? ' door' : ''}` : `fe-item seat-${item.type} shape-${item.type === 'stool' ? 'round' : item.shape}`;
              return (
                <div key={item.id} role="button" tabIndex={0} aria-pressed={on} aria-label={label(item)}
                  aria-description={clash ? t('Overlaps {names}', { names: clashes.get(item.id)!.join(', ') }) : undefined}
                  className={`${cls}${on ? ' selected' : ''}${clash ? ' clash' : ''}`} style={{ ...pct(b), transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined }}
                  onPointerDown={(e) => down(e, item)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(item, e); }}
                  onFocus={() => !selected.includes(item.id) && setSelected([item.id])}>
                  {seats.map((s, n) => <span key={n} className="fe-seat" style={{ left: `${s.x}%`, top: `${s.y}%` }} aria-hidden="true" />)}
                  {door && (
                    <svg className="fe-door" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                      <path d="M4 96 V4" className="leaf" />
                      <path d="M4 4 A92 92 0 0 1 96 96" className="swing" />
                      <path d="M4 96 H96" className="sill" />
                    </svg>
                  )}
                  {item.type !== 'wall' && !door && (
                    <span className="fe-label" style={item.rotation ? { transform: `rotate(${-item.rotation}deg)` } : undefined}>
                      {/* Small on the plan (a stool): just its number, the full name is in the panel and on hover. */}
                      <strong title={item.name}>{Math.min(b.w, b.h) < 70 && /\d+$/.test(item.name) ? item.name.match(/\d+$/)![0] : item.name}</strong>
                      {item.type === 'table' && <span>{t('{n} seats', { n: item.seats })}</span>}
                    </span>
                  )}
                  {one?.id === item.id && (
                    <>
                      {handlesFor(item, b).map((h) => (
                        <span key={h.key} className={`fe-handle h-${h.key}`} style={{ cursor: h.cursor }} role="presentation" title={t('Drag to resize')}
                          onPointerDown={(e) => down(e, item, 'resize', h)} />
                      ))}
                      <span className="fe-rotate" role="presentation" title={t('Drag to turn')} onPointerDown={(e) => down(e, item, 'rotate')}><Icon name="rotate" /></span>
                    </>
                  )}
                </div>
              );
            })}
            {ghost?.at && (() => {
              const s = sizeOf(ghost.tool);
              const b = { x: snap(ghost.at.x - s.w / 2), y: snap(ghost.at.y - s.h / 2), ...s };
              return <span className={`fe-ghost${ghost.tool.type === 'table' && ghost.tool.shape === 'round' ? ' round' : ''}${ghost.tool.type === 'wall' ? ' wall' : ''}`} style={pct(b)} aria-hidden="true" />;
            })()}
            {guides.v.map((x) => <span key={`v${x}`} className="fe-guide v" style={{ left: `${(x / RW) * 100}%` }} />)}
            {guides.h.map((y) => <span key={`h${y}`} className="fe-guide h" style={{ top: `${(y / RH) * 100}%` }} />)}
            {marquee && <span className="fe-marquee" style={pct(marquee)} />}
            {readout && <span className="fe-readout num" style={{ left: `${readout.x}%`, top: `${readout.y}%` }}>{readout.text}</span>}
            {menu && chosen.length > 0 && (
              <div className={`fe-menu${menu.x > 70 ? ' to-left' : ''}${menu.y > 60 ? ' to-top' : ''}`} role="menu" style={{ left: `${menu.x}%`, top: `${menu.y}%` }} onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); duplicate(); }}><Icon name="copy" />{t('Duplicate')}<kbd>Ctrl+D</kbd></button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); turn(90); }}><Icon name="rotate" />{t('Turn 90°')}</button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); restack(true); }}>{t('Bring to the front')}</button>
                <button type="button" role="menuitem" onClick={() => { setMenu(null); restack(false); }}>{t('Send to the back')}</button>
                <button type="button" role="menuitem" className="danger-text" onClick={() => { setMenu(null); remove(); }}><Icon name="trash" />{t('Remove')}<kbd>Del</kbd></button>
              </div>
            )}
          </div>
        </div>

        <aside className="fe-panel" aria-label={t('The chosen item')}>
          {!chosen.length && (
            <>
              <h3>{t('{n} tables, {s} seats', { n: counts.tables, s: counts.seats })}</h3>
              {clashes.size > 0 && <p className="fe-warn">{t('{n} tables overlap. They are marked in red.', { n: clashes.size })}</p>}
              {touch ? (
                <>
                  <p className="small muted">{t('Tap an item to change it. Drag a side or a corner to resize it, the round handle to turn it.')}</p>
                  <dl className="fe-keys small">
                    <div><dt>{t('Move')}</dt><dd>{t('Drag it with one finger')}</dd></div>
                    <div><dt>{t('Menu')}</dt><dd>{t('Hold a finger on it')}</dd></div>
                    <div><dt>{t('Pan')}</dt><dd>{t('One finger on an empty part, or two fingers')}</dd></div>
                    <div><dt>{t('Zoom')}</dt><dd>{t('Pinch with two fingers')}</dd></div>
                    <div><dt>{t('Several')}</dt><dd>{t('Turn on Select several, then tap them or draw a box')}</dd></div>
                  </dl>
                </>
              ) : (
              <>
              <p className="small muted">{t('Choose an item to change it, or drag across the plan to choose several. Drag a side or a corner to resize it (Shift keeps its shape), the round handle to turn it.')}</p>
              <dl className="fe-keys small">
                <div><dt>{t('Move')}</dt><dd>{t('Drag, or the arrow keys (Shift for more, Alt for a little)')}</dd></div>
                <div><dt>{t('Turn')}</dt><dd>R, Shift+R</dd></div>
                <div><dt>{t('Copy')}</dt><dd>Ctrl+C, Ctrl+V, Ctrl+D</dd></div>
                <div><dt>{t('Undo')}</dt><dd>Ctrl+Z, Ctrl+Shift+Z</dd></div>
                <div><dt>{t('Pan')}</dt><dd>{t('Space + drag, or the middle button')}</dd></div>
                <div><dt>{t('Zoom')}</dt><dd>Ctrl + {t('wheel')}</dd></div>
              </dl>
              </>
              )}
            </>
          )}
          {one && (
            <>
              <h3>{label(one)}</h3>
              {clashes.has(one.id) && <p className="fe-warn">{t('Overlaps {names}', { names: clashes.get(one.id)!.join(', ') })}</p>}
              {one.type !== 'wall' && !isDoor(one) && <label className="field"><span className="field-label">{t('Name')}</span><input maxLength={30} value={one.name} onChange={(e) => patch(one.id, { name: e.target.value }, `name:${one.id}`)} /></label>}
              {one.type === 'table' && (
                <>
                  <div className="field"><span className="field-label" id="fe-seats">{t('Seats')}</span>
                    <div className="fe-stepper">
                      <button type="button" aria-label={t('One less')} disabled={one.seats <= 1} onClick={() => patch(one.id, { seats: one.seats - 1 }, `seats:${one.id}`)}>−</button>
                      <NumField label={t('Seats')} value={one.seats} min={1} max={40} onCommit={(v) => patch(one.id, { seats: v })} />
                      <button type="button" aria-label={t('One more')} disabled={one.seats >= 40} onClick={() => patch(one.id, { seats: one.seats + 1 }, `seats:${one.id}`)}>+</button>
                    </div>
                  </div>
                  <div className="field"><span className="field-label">{t('Shape')}</span>
                    <div className="fe-seg" role="group" aria-label={t('Shape')}>
                      {([['round', t('Round')], ['square', t('Square')], ['rect', t('Rectangle')]] as const).map(([v, text]) => <button key={v} type="button" aria-pressed={one.shape === v} onClick={() => patch(one.id, { shape: v })}>{text}</button>)}
                    </div>
                  </div>
                </>
              )}
              <div className="fe-grid2">
                <label className="field"><span className="field-label">{one.type === 'wall' ? t('Length') : t('Width')}</span>
                  <NumField label={one.type === 'wall' ? t('Length') : t('Width')} value={shownWidth(world(one).w)} min={32} max={RW} step={GRID} onCommit={(v) => patchWorld(one.id, { w: v })} /></label>
                <label className="field"><span className="field-label">{one.type === 'wall' ? t('Thickness') : t('Depth')}</span>
                  <NumField label={one.type === 'wall' ? t('Thickness') : t('Depth')} value={Math.round(world(one).h)} min={10} max={RH} step={one.type === 'wall' ? 2 : GRID} onCommit={(v) => patchWorld(one.id, { h: v })} /></label>
              </div>
              <div className="field"><span className="field-label">{t('Turned (degrees)')}</span>
                <div className="fe-stepper wide">
                  <button type="button" aria-label={t('Turn left 15°')} onClick={() => turn(-15)}>↺</button>
                  <NumField label={t('Turned')} value={one.rotation} min={0} max={359} wrap onCommit={(v) => patch(one.id, { rotation: v })} />
                  <button type="button" aria-label={t('Turn right 15°')} onClick={() => turn(15)}>↻</button>
                </div>
              </div>
              <div className="fe-actions">
                <button type="button" className="secondary" onClick={() => duplicate()}><Icon name="copy" />{t('Duplicate')}</button>
                <button type="button" className="secondary danger-text" onClick={remove}><Icon name="trash" />{t('Remove')}</button>
              </div>
            </>
          )}
          {chosen.length > 1 && (
            <>
              <h3>{t('{n} chosen', { n: chosen.length })}</h3>
              <div className="fe-align" role="group" aria-label={t('Line up')}>
                <button type="button" className="secondary" onClick={() => align('left')}><Icon name="alignLeft" />{t('Line up left')}</button>
                <button type="button" className="secondary" onClick={() => align('top')}><Icon name="alignTop" />{t('Line up top')}</button>
                <button type="button" className="secondary" onClick={() => align('centre')}><Icon name="alignLeft" />{t('Line up centres across')}</button>
                <button type="button" className="secondary" onClick={() => align('middle')}><Icon name="alignTop" />{t('Line up centres down')}</button>
                <button type="button" className="secondary" disabled={chosen.length < 3} onClick={() => align('hspace')}><Icon name="distribute" />{t('Space evenly across')}</button>
                <button type="button" className="secondary" disabled={chosen.length < 3} onClick={() => align('vspace')}><Icon name="distribute" />{t('Space evenly down')}</button>
                <button type="button" className="secondary" onClick={() => align('size')}><Icon name="fit" />{t('Same size as the first')}</button>
              </div>
              <div className="fe-actions">
                <button type="button" className="secondary" onClick={() => duplicate()}><Icon name="copy" />{t('Duplicate')}</button>
                <button type="button" className="secondary danger-text" onClick={remove}><Icon name="trash" />{t('Remove them from the plan')}</button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * A number typed in freely and only checked (and applied) when you leave the field or press Enter, so
 * "1" on the way to "120" never jumps the item about. Escape puts the value back; the arrow keys step.
 */
function NumField({ label, value, min, max, step = 1, suffix, wrap, onCommit }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; wrap?: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  // Typed in and not yet applied: the field keeps what was typed; otherwise it follows the item (undo, a drag).
  const typed = useRef(false);
  useEffect(() => { if (!typed.current) setDraft(String(value)); }, [value]);
  const apply = (raw: string) => {
    typed.current = false;
    const n = Math.round(Number(raw));
    if (!raw.trim() || !Number.isFinite(n)) return setDraft(String(value));
    const v = wrap ? ((n % (max + 1)) + (max + 1)) % (max + 1) : Math.max(min, Math.min(max, n));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <span className={`fe-num${suffix ? ' has-suffix' : ''}`}>
      <input type="text" inputMode="numeric" aria-label={label} value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => { typed.current = true; setDraft(e.target.value.replace(/[^\d-]/g, '')); }}
        onBlur={(e) => { if (typed.current) apply(e.currentTarget.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); apply(e.currentTarget.value); }
          else if (e.key === 'Escape') { e.preventDefault(); typed.current = false; setDraft(String(value)); e.currentTarget.blur(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const n = (Number(draft) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 5 : 1);
            apply(String(n));
          }
        }} />
      {suffix && <span className="suffix" aria-hidden="true">{suffix}</span>}
    </span>
  );
}
