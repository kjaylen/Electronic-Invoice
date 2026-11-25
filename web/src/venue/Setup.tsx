/**
 * Settings → Venue: switching the hospitality module on by kind of business,
 * its rules, the floor plans (drag and drop) and the tax values in force.
 * The menu (sections, items, menus and promotions by the clock, choices,
 * stations) has its own page, Menu (Menu.tsx), which uses the cards below.
 */

import { type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { Link } from 'react-router';
import { ErrorText, Field, Select } from '../ui';
import type { ModifierGroup, Period, PromoRule } from '../../../src/venue/pricing.ts';
import type { FloorItem, FloorPlan, MenuEntry, Station, VenueData, VenueSettings } from './store';
import './venue.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minutes = (s: string) => { const [h = '0', m = '0'] = s.split(':'); return Number(h) * 60 + Number(m); };
const price = (cents: number) => (cents / 100).toFixed(2);
const toCents = (s: string) => Math.round(Number(s) * 100);

export function VenueTab() {
  const t = useT();
  const { refreshMe } = useSession();
  const [data, setData] = useState<VenueData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<VenueData>('/v1/venue').then(setData).catch(setError), []);
  useEffect(() => void load(), [load]);
  if (error) return <ErrorText error={error} />;
  if (!data) return <div className="skeleton" style={{ height: '12rem' }} />;
  const service = data.venue.restaurant || data.venue.bar;
  return (
    <div className="stack">
      <KindsCard venue={data.venue} onSaved={() => { void load(); void refreshMe(); }} />
      {service && data.on && (
        <>
          <MenuLinkCard />
          <FloorCard plans={data.floor} layout={data.venue.layout} onChange={load} />
        </>
      )}
      {data.on && <TaxCard />}
      {!data.on && <p className="small muted">{t('A shop needs none of this: leave all three off and nothing changes for it.')}</p>}
    </div>
  );
}

function KindsCard({ venue, onSaved }: { venue: VenueSettings; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [v, setV] = useState(venue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setV(venue), [venue]);
  const set = (patch: Partial<VenueSettings>) => setV({ ...v, ...patch });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/venue/settings', { method: 'PUT', body: { restaurant: v.restaurant, bar: v.bar, hotel: v.hotel, serviceCharge: v.serviceCharge, servicePercent: v.servicePercent, servicePartySize: v.servicePartySize, dayEndsHour: v.dayEndsHour, discountLimitPercent: v.discountLimitPercent, usdRateCents: v.usdRateCents, tipPool: v.tipPool, layout: v.layout } });
      toast(t('Saved'));
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const on = v.restaurant || v.bar || v.hotel;
  return (
    <section className="card stack">
      <div><h2>{t('Restaurant, bar, hotel')}</h2><p className="small muted">{t('Say what kind of place this is. Table service, the kitchen screen, reservations and the hotel desk appear for what you turn on; a shop leaves all three off.')}</p></div>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <div className="venue-pick">
          <label className="row"><input type="checkbox" checked={v.restaurant} onChange={(e) => set({ restaurant: e.target.checked })} /> {t('Restaurant: tables, courses, a kitchen')}</label>
          <label className="row"><input type="checkbox" checked={v.bar} onChange={(e) => set({ bar: e.target.checked })} /> {t('Bar: tabs, quick sales, happy hour')}</label>
          <label className="row"><input type="checkbox" checked={v.hotel} onChange={(e) => set({ hotel: e.target.checked })} /> {t('Hotel: rooms, bookings, folios')}</label>
        </div>
        {on && (
          <div className="form-grid">
            <Field label={t('Service charge')}>
              <Select value={v.serviceCharge} onChange={(e) => set({ serviceCharge: e.target.value as VenueSettings['serviceCharge'] })}>
                <option value="off">{t('None')}</option><option value="all">{t('On every bill')}</option><option value="party">{t('For large parties')}</option>
              </Select>
            </Field>
            {v.serviceCharge !== 'off' && <Field label={t('Service charge (%)')}><input inputMode="decimal" value={v.servicePercent} onChange={(e) => set({ servicePercent: e.target.value.trim() })} /></Field>}
            {v.serviceCharge === 'party' && <Field label={t('From how many guests')}><input type="number" min={2} max={50} value={v.servicePartySize} onChange={(e) => set({ servicePartySize: Number(e.target.value) })} /></Field>}
            <Field label={t('A discount over this needs a supervisor (%)')}><input type="number" min={0} max={100} value={v.discountLimitPercent} onChange={(e) => set({ discountLimitPercent: Number(e.target.value) })} /></Field>
            <Field label={t('The business day ends at')} hint={t('Sales after midnight and before this hour stay on the evening before.')}>
              <Select value={String(v.dayEndsHour)} onChange={(e) => set({ dayEndsHour: Number(e.target.value) })}>{Array.from({ length: 9 }, (_, n) => <option key={n} value={n}>{n === 0 ? t('Midnight') : `${n}:00 am`}</option>)}</Select>
            </Field>
            <Field label={t('BZ$ for one US$')}><input inputMode="decimal" value={price(v.usdRateCents)} onChange={(e) => set({ usdRateCents: toCents(e.target.value) || v.usdRateCents })} /></Field>
            <Field label={t('Tips are shared')} hint={t('For the tip report only: paying staff is not done here.')}>
              <Select value={v.tipPool.method} onChange={(e) => set({ tipPool: { ...v.tipPool, method: e.target.value as VenueSettings['tipPool']['method'] } })}>
                <option value="none">{t('Not pooled: each keeps their own')}</option><option value="hours">{t('By hours worked')}</option><option value="role">{t('By role, in percent')}</option><option value="points">{t('By points per hour, by role')}</option>
              </Select>
            </Field>
            {(v.tipPool.method === 'role' || v.tipPool.method === 'points') && ['server', 'bartender', 'kitchen', 'host', 'supervisor'].map((role) => (
              <Field key={role} label={`${t(role)} ${v.tipPool.method === 'role' ? '(%)' : t('(points)')}`}><input type="number" min={0} max={1000} value={v.tipPool.weights[role] ?? 0} onChange={(e) => set({ tipPool: { ...v.tipPool, weights: { ...v.tipPool.weights, [role]: Number(e.target.value) } } })} /></Field>
            ))}
          </div>
        )}
        <ErrorText error={error} />
        <div><button disabled={busy}>{busy ? t('Saving…') : t('Save')}</button></div>
      </form>
    </section>
  );
}

// ---------- floor plans ----------

function FloorCard({ plans, layout, onChange }: { plans: FloorPlan[]; layout: string; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const plan = plans.find((p) => p.id === planId) ?? plans[0];
  const [items, setItems] = useState<FloorItem[]>(plan?.items ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  const [area, setArea] = useState('');
  const [newLayout, setNewLayout] = useState('');
  const [error, setError] = useState<unknown>(null);
  const board = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  useEffect(() => { setItems(plan?.items ?? []); setSelected(null); }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(items) !== JSON.stringify(plan?.items ?? []);
  const sel = items.find((i) => i.id === selected);
  const patch = (id: string, p: Partial<FloorItem>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const snap = (n: number) => Math.round(n / 10) * 10;
  // Drag with a finger or a mouse: the item follows, on a grid, and stays on the plan.
  const down = (e: ReactPointerEvent, item: FloorItem) => {
    const box = board.current!.getBoundingClientRect();
    drag.current = { id: item.id, dx: ((e.clientX - box.left) / box.width) * 1000 - item.x, dy: ((e.clientY - box.top) / box.height) * 1000 - item.y };
    setSelected(item.id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const box = board.current!.getBoundingClientRect();
    const item = items.find((i) => i.id === d.id);
    if (!item) return;
    patch(d.id, { x: Math.max(0, Math.min(1000 - item.w, snap(((e.clientX - box.left) / box.width) * 1000 - d.dx))), y: Math.max(0, Math.min(1000 - item.h, snap(((e.clientY - box.top) / box.height) * 1000 - d.dy))) });
  };
  const add = (type: FloorItem['type']) => {
    const n = items.filter((i) => i.type === type).length + 1;
    const id = `${type[0]}${Date.now().toString(36)}`;
    const base = { id, type, rotation: 0, x: 420, y: 420 };
    const item: FloorItem = type === 'table' ? { ...base, name: `${t('Table')} ${n}`, shape: 'square', seats: 4, w: 120, h: 160 }
      : type === 'stool' ? { ...base, name: `${t('Bar')} ${n}`, shape: 'round', seats: 1, w: 60, h: 90 }
      : type === 'wall' ? { ...base, name: '', shape: 'rect', seats: 0, w: 400, h: 20 } : { ...base, name: t('Bar'), shape: 'rect', seats: 0, w: 300, h: 100 };
    setItems([...items, item]);
    setSelected(id);
  };
  const run = async (fn: () => Promise<unknown>, done?: string) => { setError(null); try { await fn(); if (done) toast(done); onChange(); } catch (e) { setError(e); } };
  const save = () => run(() => api(`/v1/venue/floor/${plan!.id}`, { method: 'PUT', body: { items } }), t('Floor plan saved. Every device shows it within seconds.'));
  return (
    <section className="card stack">
      <div><h2>{t('Floor plans')}</h2><p className="small muted">{t('One plan for each area: dining room, patio, bar. Drag tables where they stand. An area can have other layouts (weekday, event) with the same tables in other places.')}</p></div>
      {plans.length > 0 && (
        <div className="row venue-bar">
          <div className="tabs" role="group" aria-label={t('Floor plan')}>
            {plans.map((p) => <button key={p.id} type="button" aria-pressed={plan?.id === p.id} className={plan?.id === p.id ? 'active' : ''} onClick={() => setPlanId(p.id)}>{p.area}{p.layout !== 'Standard' && ` · ${p.layout}`}</button>)}
          </div>
          <span className="spacer" />
          <Field label={t('Layout in use')}>
            <Select value={layout} onChange={(e) => void run(() => api('/v1/venue/settings', { method: 'PUT', body: { layout: e.target.value } }), t('Saved'))}>{[...new Set(['Standard', ...plans.map((p) => p.layout)])].map((l) => <option key={l} value={l}>{l}</option>)}</Select>
          </Field>
        </div>
      )}
      {plan && (
        <>
          <div className="venue-pick">
            <button type="button" className="secondary" onClick={() => add('table')}>+ {t('Table')}</button>
            <button type="button" className="secondary" onClick={() => add('stool')}>+ {t('Bar stool')}</button>
            <button type="button" className="secondary" onClick={() => add('wall')}>+ {t('Wall')}</button>
            <button type="button" className="secondary" onClick={() => add('fixture')}>+ {t('Fixture')}</button>
            <span className="spacer" />
            <button type="button" disabled={!changed} onClick={() => void save()}>{t('Save the plan')}</button>
          </div>
          <div className="floor-editor" ref={board} onPointerMove={move} onPointerUp={() => { drag.current = null; }} aria-label={t('Floor plan editor')}>
            {items.map((item) => {
              const style = { left: `${item.x / 10}%`, top: `${item.y / 10}%`, width: `${item.w / 10}%`, height: `${item.h / 10}%`, transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined };
              const cls = item.type === 'wall' || item.type === 'fixture' ? `venue-fixture ${item.type}` : `venue-table ${item.shape} state-free`;
              return <div key={item.id} role="button" tabIndex={0} aria-label={item.name || t(item.type)} className={`${cls} ${selected === item.id ? 'selected' : ''}`} style={style} onPointerDown={(e) => down(e, item)}
                onKeyDown={(e) => { const step = e.shiftKey ? 50 : 10; if (e.key === 'ArrowLeft') patch(item.id, { x: Math.max(0, item.x - step) }); else if (e.key === 'ArrowRight') patch(item.id, { x: Math.min(1000 - item.w, item.x + step) }); else if (e.key === 'ArrowUp') patch(item.id, { y: Math.max(0, item.y - step) }); else if (e.key === 'ArrowDown') patch(item.id, { y: Math.min(1000 - item.h, item.y + step) }); else return; e.preventDefault(); setSelected(item.id); }}>
                {item.type !== 'wall' && <strong>{item.name}</strong>}{(item.type === 'table') && <span className="small">{item.seats}</span>}
              </div>;
            })}
          </div>
          {sel && (
            <div className="form-grid">
              {sel.type !== 'wall' && <Field label={t('Name')}><input maxLength={30} value={sel.name} onChange={(e) => patch(sel.id, { name: e.target.value })} /></Field>}
              {sel.type === 'table' && <Field label={t('Seats')}><input type="number" min={1} max={40} value={sel.seats} onChange={(e) => patch(sel.id, { seats: Number(e.target.value) })} /></Field>}
              {sel.type === 'table' && <Field label={t('Shape')}><Select value={sel.shape} onChange={(e) => patch(sel.id, { shape: e.target.value as FloorItem['shape'] })}><option value="square">{t('Square')}</option><option value="rect">{t('Rectangle')}</option><option value="round">{t('Round')}</option></Select></Field>}
              <Field label={t('Width')}><input type="range" min={20} max={600} step={10} value={sel.w} onChange={(e) => patch(sel.id, { w: Number(e.target.value) })} /></Field>
              <Field label={t('Depth')}><input type="range" min={10} max={600} step={10} value={sel.h} onChange={(e) => patch(sel.id, { h: Number(e.target.value) })} /></Field>
              <Field label={t('Turned')}><input type="range" min={0} max={315} step={45} value={sel.rotation} onChange={(e) => patch(sel.id, { rotation: Number(e.target.value) })} /></Field>
              <div><button type="button" className="link danger-link" onClick={() => { setItems(items.filter((i) => i.id !== sel.id)); setSelected(null); }}>{t('Remove from the plan')}</button></div>
            </div>
          )}
          <div className="row">
            <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api('/v1/venue/floor', { method: 'POST', body: { area: plan.area, layout: newLayout.trim(), copyFrom: plan.id } }).then(() => setNewLayout('')), t('Layout added, with the same tables.')); }}>
              <Field label={t('Another layout of {area}', { area: plan.area })}><input value={newLayout} maxLength={40} placeholder={t('Weekday, Event…')} onChange={(e) => setNewLayout(e.target.value)} /></Field>
              <button className="secondary" disabled={!newLayout.trim()}>{t('Copy as a layout')}</button>
            </form>
            <span className="spacer" />
            <button type="button" className="link danger-link" onClick={async () => { if (await confirm({ title: t('Delete this plan?'), body: t('{area}, {layout}. Its tables go with it.', { area: plan.area, layout: plan.layout }), confirm: t('Delete the plan'), danger: true })) void run(() => api(`/v1/venue/floor/${plan.id}`, { method: 'DELETE' })); }}>{t('Delete this plan')}</button>
          </div>
        </>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api<{ id: string }>('/v1/venue/floor', { method: 'POST', body: { area: area.trim() } }).then((r) => { setArea(''); setPlanId(r.id); }), t('Area added. Put its tables on the plan.')); }}>
        <Field label={t('New area')}><input value={area} maxLength={40} placeholder={t('Dining room, Patio, Bar, Poolside…')} onChange={(e) => setArea(e.target.value)} /></Field>
        <button className="secondary" disabled={!area.trim()}>{t('Add the area')}</button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}

// ---------- stations ----------

export function StationsCard({ stations, categories, onChange }: { stations: Station[]; categories: string[]; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const [tills, setTills] = useState<Array<{ id: string; name: string }>>([]);
  const [list, setList] = useState<Array<Partial<Station> & { name: string }>>(stations);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setList(stations), [stations]);
  useEffect(() => void api<{ data: Array<{ id: string; name: string }> }>('/v1/pos/devices').then((r) => setTills(r.data)).catch(() => {}), []);
  const patch = (n: number, p: Partial<Station>) => setList((all) => all.map((s, i) => (i === n ? { ...s, ...p } : s)));
  const save = async (s: Partial<Station> & { name: string }, n: number) => {
    setError(null);
    try {
      const body = { name: s.name.trim(), categories: s.categories ?? [], deviceId: s.deviceId ?? null, screen: s.screen ?? false, fallbackId: s.fallbackId ?? null, targetMin: s.targetMin ?? 12, position: n };
      await api(s.id ? `/v1/venue/stations/${s.id}` : '/v1/venue/stations', { method: s.id ? 'PUT' : 'POST', body });
      toast(t('Station saved'));
      onChange();
    } catch (e) { setError(e); }
  };
  return (
    <section className="card stack">
      <div><h2>{t('Stations and where orders go')}</h2><p className="small muted">{t('Hot kitchen, cold kitchen, grill, bar, pastry. Each makes some categories. Its tickets print on a till’s printer, show on a kitchen screen, or both; with no till chosen they print where the order is sent from. If its printer fails, the fallback station’s prints instead.')}</p></div>
      <ul className="plain venue-setup-list">
        {list.map((s, n) => (
          <li key={s.id ?? `new-${n}`} className="stack">
            <div className="form-grid">
              <Field label={t('Station')}><input required maxLength={40} value={s.name} onChange={(e) => patch(n, { name: e.target.value })} /></Field>
              <Field label={t('Prints on')}><Select value={s.deviceId ?? ''} onChange={(e) => patch(n, { deviceId: e.target.value || null })}><option value="">{t('The till that sends the order')}</option>{tills.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
              <Field label={t('If its printer fails')}><Select value={s.fallbackId ?? ''} onChange={(e) => patch(n, { fallbackId: e.target.value || null })}><option value="">{t('The till of whoever re-routes it')}</option>{stations.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
              <Field label={t('Late after (minutes)')}><input type="number" min={1} max={240} value={s.targetMin ?? 12} onChange={(e) => patch(n, { targetMin: Number(e.target.value) })} /></Field>
            </div>
            <label className="row small"><input type="checkbox" checked={Boolean(s.screen)} onChange={(e) => patch(n, { screen: e.target.checked })} /> {t('Shows on a kitchen screen')}</label>
            <div className="station-categories" role="group" aria-label={t('What {station} makes', { station: s.name || t('this station') })}>
              {categories.map((c) => { const has = (s.categories ?? []).some((x) => x.toLowerCase() === c.toLowerCase()); return <button key={c} type="button" className="chip-toggle" aria-pressed={has} onClick={() => patch(n, { categories: has ? (s.categories ?? []).filter((x) => x.toLowerCase() !== c.toLowerCase()) : [...(s.categories ?? []), c] })}>{c}</button>; })}
            </div>
            <div className="row">
              <button type="button" className="secondary" disabled={!s.name.trim()} onClick={() => void save(s, n)}>{t('Save')}</button>
              {s.id && <button type="button" className="link danger-link" onClick={() => void api(`/v1/venue/stations/${s.id}`, { method: 'DELETE' }).then(onChange).catch(setError)}>{t('Remove')}</button>}
            </div>
          </li>
        ))}
      </ul>
      <div><button type="button" className="secondary" onClick={() => setList([...list, { name: '', categories: [], screen: false, targetMin: 12 }])}>+ {t('Add a station')}</button></div>
      <ErrorText error={error} />
    </section>
  );
}

// ---------- menus and promotions by the clock ----------

type PeriodForm = Omit<Period, 'id'> & { id?: string };
const emptyPeriod = (kind: Period['kind']): PeriodForm => ({ kind, name: '', days: [0, 1, 2, 3, 4, 5, 6], startsMin: kind === 'menu' ? 11 * 60 : 16 * 60, endsMin: kind === 'menu' ? 15 * 60 : 18 * 60, categories: [], prices: {}, rules: [], active: true, position: 0 });

export function PeriodsCard({ periods, items, onChange }: { periods: Period[]; items: MenuEntry[]; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const [editing, setEditing] = useState<PeriodForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const categories = [...new Set(items.map((i) => i.category).filter((x): x is string => Boolean(x)))].sort();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      const { id, ...body } = editing;
      await api(id ? `/v1/venue/periods/${id}` : '/v1/venue/periods', { method: id ? 'PUT' : 'POST', body: { ...body, name: body.name.trim() } });
      toast(t('Saved. It starts and stops by itself on every device.'));
      setEditing(null);
      onChange();
    } catch (err) { setError(err); }
  };
  const set = (p: Partial<PeriodForm>) => setEditing((cur) => (cur ? { ...cur, ...p } : cur));
  const rule = (n: number, p: Partial<PromoRule>) => set({ rules: editing!.rules.map((r, i) => (i === n ? ({ ...r, ...p } as PromoRule) : r)) });
  const toggle = (list: string[], c: string) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  return (
    <section className="card stack">
      <div><h2>{t('Menus and promotions by the clock')}</h2><p className="small muted">{t('Breakfast, lunch, dinner, late night: each with its hours, what is on it and its prices. Happy hour and other promotions start and stop by themselves. A supervisor can put another menu on for the rest of the day from the floor.')}</p></div>
      <ul className="plain venue-setup-list">
        {periods.map((p) => (
          <li key={p.id} className="row">
            <strong>{p.name}</strong><span className="badge pay-credit">{p.kind === 'menu' ? t('Menu') : t('Promotion')}</span>
            <span className="small muted">{hhmm(p.startsMin)} – {hhmm(p.endsMin)} · {p.days.length === 7 ? t('every day') : p.days.map((d) => t(DAYS[d]!)).join(' ')}{!p.active && ` · ${t('off')}`}</span>
            <span className="spacer" />
            <button type="button" className="link" onClick={() => setEditing(p)}>{t('Edit')}</button>
            <button type="button" className="link danger-link" onClick={() => void api(`/v1/venue/periods/${p.id}`, { method: 'DELETE' }).then(onChange).catch(setError)}>{t('Remove')}</button>
          </li>
        ))}
      </ul>
      {!editing && <div className="row"><button type="button" className="secondary" onClick={() => setEditing(emptyPeriod('menu'))}>+ {t('A menu for a time of day')}</button><button type="button" className="secondary" onClick={() => setEditing({ ...emptyPeriod('promotion'), name: 'Happy hour', rules: [{ kind: 'percent', percent: 25, categories: [], itemIds: [] }] })}>+ {t('A promotion')}</button></div>}
      {editing && (
        <form className="stack venue-group" onSubmit={(e) => void save(e)}>
          <div className="form-grid">
            <Field label={t('Name')}><input required maxLength={60} value={editing.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label={t('From')}><input type="time" required value={hhmm(editing.startsMin)} onChange={(e) => set({ startsMin: minutes(e.target.value) })} /></Field>
            <Field label={t('Until')} hint={t('Before the start means past midnight.')}><input type="time" required value={hhmm(editing.endsMin)} onChange={(e) => set({ endsMin: minutes(e.target.value) })} /></Field>
          </div>
          <div className="station-categories" role="group" aria-label={t('Days')}>{DAYS.map((d, n) => <button key={d} type="button" className="chip-toggle" aria-pressed={editing.days.includes(n)} onClick={() => set({ days: editing.days.includes(n) ? editing.days.filter((x) => x !== n) : [...editing.days, n].sort() })}>{t(d)}</button>)}</div>
          {editing.kind === 'menu' ? (
            <>
              <strong>{t('What is on it')}</strong>
              <div className="station-categories" role="group" aria-label={t('Categories on this menu')}>{categories.map((c) => <button key={c} type="button" className="chip-toggle" aria-pressed={editing.categories.includes(c)} onClick={() => set({ categories: toggle(editing.categories, c) })}>{c}</button>)}</div>
              <p className="small muted">{t('None chosen: everything is on it.')}</p>
              <strong>{t('Prices that differ on this menu')}</strong>
              {Object.entries(editing.prices).map(([id, cents]) => (
                <div key={id} className="row"><span className="grow">{items.find((i) => i.id === id)?.name ?? id}</span><input inputMode="decimal" style={{ width: '7rem' }} aria-label={t('Price')} defaultValue={price(cents)} onBlur={(e) => set({ prices: { ...editing.prices, [id]: toCents(e.target.value) } })} /><button type="button" className="link" onClick={() => { const { [id]: _gone, ...rest } = editing.prices; set({ prices: rest }); }}>{t('Remove')}</button></div>
              ))}
              <Field label={t('Add an item with its own price here')}><Select value="" onChange={(e) => { const i = items.find((x) => x.id === e.target.value); if (i) set({ prices: { ...editing.prices, [i.id]: i.priceCents } }); }}><option value="">{t('Choose…')}</option>{items.filter((i) => !(i.id in editing.prices)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
            </>
          ) : (
            <>
              <strong>{t('Rules')}</strong>
              {editing.rules.map((r, n) => (
                <div key={n} className="venue-group stack">
                  <div className="form-grid">
                    <Field label={t('Rule')}>
                      <Select value={r.kind} onChange={(e) => { const k = e.target.value as PromoRule['kind']; rule(n, k === 'percent' ? { kind: k, percent: 25, categories: [], itemIds: [] } : k === 'twoForOne' ? { kind: k, categories: [], itemIds: [] } : k === 'price' ? { kind: k, itemId: items[0]?.id ?? '', priceCents: 0 } : { kind: k, name: '', itemIds: [], priceCents: 0 }); }}>
                        <option value="percent">{t('A percentage off')}</option><option value="twoForOne">{t('Two for one')}</option><option value="price">{t('A special price for one item')}</option><option value="bundle">{t('Items together for one price')}</option>
                      </Select>
                    </Field>
                    {r.kind === 'percent' && <Field label={t('Percent off')}><input type="number" min={1} max={100} value={r.percent} onChange={(e) => rule(n, { percent: Number(e.target.value) })} /></Field>}
                    {r.kind === 'price' && <Field label={t('Item')}><Select value={r.itemId} onChange={(e) => rule(n, { itemId: e.target.value })}>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>}
                    {(r.kind === 'price' || r.kind === 'bundle') && <Field label={t('Price (BZ$)')}><input inputMode="decimal" defaultValue={price(r.priceCents)} onBlur={(e) => rule(n, { priceCents: toCents(e.target.value) })} /></Field>}
                    {r.kind === 'bundle' && <Field label={t('Name on the bill')}><input maxLength={60} value={r.name} onChange={(e) => rule(n, { name: e.target.value })} /></Field>}
                  </div>
                  {(r.kind === 'percent' || r.kind === 'twoForOne') && <div className="station-categories" role="group" aria-label={t('Categories')}>{categories.map((c) => <button key={c} type="button" className="chip-toggle" aria-pressed={r.categories.includes(c)} onClick={() => rule(n, { categories: toggle(r.categories, c) })}>{c}</button>)}</div>}
                  {r.kind === 'bundle' && <div className="station-categories" role="group" aria-label={t('Items')}>{items.slice(0, 200).map((i) => <button key={i.id} type="button" className="chip-toggle" aria-pressed={r.itemIds.includes(i.id)} onClick={() => rule(n, { itemIds: toggle(r.itemIds, i.id) })}>{i.name}</button>)}</div>}
                  <div><button type="button" className="link" onClick={() => set({ rules: editing.rules.filter((_, i) => i !== n) })}>{t('Remove this rule')}</button></div>
                </div>
              ))}
              <div><button type="button" className="secondary small-button" onClick={() => set({ rules: [...editing.rules, { kind: 'percent', percent: 10, categories: [], itemIds: [] }] })}>+ {t('Another rule')}</button></div>
            </>
          )}
          <label className="row small"><input type="checkbox" checked={editing.active} onChange={(e) => set({ active: e.target.checked })} /> {t('On')}</label>
          <ErrorText error={error} />
          <div className="row"><button type="button" className="secondary" onClick={() => setEditing(null)}>{t('Cancel')}</button><span className="spacer" /><button disabled={!editing.name.trim()}>{t('Save')}</button></div>
        </form>
      )}
    </section>
  );
}

// ---------- modifiers ----------

type GroupForm = { id?: string; name: string; minChoices: number; maxChoices: number; options: Array<{ id?: string; name: string; priceCents: number; isDefault: boolean; itemId?: string | null }> };

export function ModifiersCard({ groups, items, onChange }: { groups: ModifierGroup[]; items: MenuEntry[]; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const [editing, setEditing] = useState<GroupForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      const body = { name: editing.name.trim(), minChoices: editing.minChoices, maxChoices: editing.maxChoices, options: editing.options.filter((o) => o.name.trim()).map((o) => ({ ...(o.id && { id: o.id }), name: o.name.trim(), priceCents: o.priceCents, isDefault: o.isDefault, itemId: o.itemId || null })) };
      await api(editing.id ? `/v1/venue/modifier-groups/${editing.id}` : '/v1/venue/modifier-groups', { method: editing.id ? 'PUT' : 'POST', body });
      toast(t('Choices saved'));
      setEditing(null);
      onChange();
    } catch (err) { setError(err); }
  };
  const opt = (n: number, p: Partial<GroupForm['options'][number]>) => setEditing((g) => (g ? { ...g, options: g.options.map((o, i) => (i === n ? { ...o, ...p } : o)) } : g));
  return (
    <section className="card stack">
      <div><h2>{t('Choices on dishes and drinks')}</h2><p className="small muted">{t('Cooking temperature, sides, add-ons, "no onions". A group can be required, with at least and at most so many choices, defaults, and a price for each. A set menu is a dish whose groups are its courses.')}</p></div>
      <ul className="plain venue-setup-list">
        {groups.map((g) => (
          <li key={g.id} className="row">
            <strong>{g.name}</strong><span className="small muted">{g.minChoices > 0 ? t('required') : t('optional')} · {g.minChoices}–{g.maxChoices} · {g.options.map((o) => o.name).join(', ')}</span>
            <span className="spacer" />
            <button type="button" className="link" onClick={() => setEditing({ id: g.id, name: g.name, minChoices: g.minChoices, maxChoices: g.maxChoices, options: g.options })}>{t('Edit')}</button>
            <button type="button" className="link danger-link" onClick={() => void api(`/v1/venue/modifier-groups/${g.id}`, { method: 'DELETE' }).then(onChange).catch(setError)}>{t('Remove')}</button>
          </li>
        ))}
      </ul>
      {!editing && <div><button type="button" className="secondary" onClick={() => setEditing({ name: '', minChoices: 0, maxChoices: 1, options: [{ name: '', priceCents: 0, isDefault: false }] })}>+ {t('A group of choices')}</button></div>}
      {editing && (
        <form className="stack venue-group" onSubmit={(e) => void save(e)}>
          <div className="form-grid">
            <Field label={t('Group')}><input required maxLength={60} value={editing.name} placeholder={t('Cooking, Sides, Add-ons…')} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label={t('At least')} hint={t('0: optional. 1 or more: required.')}><input type="number" min={0} max={20} value={editing.minChoices} onChange={(e) => setEditing({ ...editing, minChoices: Number(e.target.value) })} /></Field>
            <Field label={t('At most')}><input type="number" min={1} max={20} value={editing.maxChoices} onChange={(e) => setEditing({ ...editing, maxChoices: Number(e.target.value) })} /></Field>
          </div>
          {editing.options.map((o, n) => (
            <div key={n} className="row">
              <Field label={t('Choice {n}', { n: n + 1 })} className="grow"><input maxLength={60} value={o.name} onChange={(e) => opt(n, { name: e.target.value })} /></Field>
              <Field label={t('Adds (BZ$)')}><input inputMode="decimal" style={{ width: '6rem' }} defaultValue={price(o.priceCents)} onBlur={(e) => opt(n, { priceCents: toCents(e.target.value) || 0 })} /></Field>
              <Field label={t('Takes from stock')}><Select value={o.itemId ?? ''} onChange={(e) => opt(n, { itemId: e.target.value || null })}><option value="">{t('Nothing')}</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
              <label className="row small"><input type="checkbox" checked={o.isDefault} onChange={(e) => opt(n, { isDefault: e.target.checked })} /> {t('Default')}</label>
              <button type="button" className="link" onClick={() => setEditing({ ...editing, options: editing.options.filter((_, i) => i !== n) })}>{t('Remove')}</button>
            </div>
          ))}
          <div><button type="button" className="secondary small-button" onClick={() => setEditing({ ...editing, options: [...editing.options, { name: '', priceCents: 0, isDefault: false }] })}>+ {t('Another choice')}</button></div>
          <ErrorText error={error} />
          <div className="row"><button type="button" className="secondary" onClick={() => setEditing(null)}>{t('Cancel')}</button><span className="spacer" /><button disabled={!editing.name.trim() || !editing.options.some((o) => o.name.trim())}>{t('Save')}</button></div>
        </form>
      )}
    </section>
  );
}

// ---------- the menu moved to its own page ----------

function MenuLinkCard() {
  const t = useT();
  const { can } = useSession();
  if (!can('catalog.manage')) return null;
  return (
    <section className="card row">
      <div className="grow"><h2>{t('The menu')}</h2><p className="small muted">{t('Sections, items, menus by the clock, promotions, choices and stations are on the Menu page.')}</p></div>
      <Link className="button secondary" to="/menu">{t('Open the menu')}</Link>
    </section>
  );
}

// ---------- tax rules ----------

interface TaxRule { key: string; value: string; from: string; source: string; verified: boolean; custom: boolean; label: string }

function TaxCard() {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const [rules, setRules] = useState<TaxRule[] | null>(null);
  const [editing, setEditing] = useState<{ key: string; value: string; from: string; note: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ data: TaxRule[] }>('/v1/venue/tax-rules').then((r) => setRules(r.data)).catch(setError), []);
  useEffect(() => void load(), [load]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try { await api('/v1/venue/tax-rules', { method: 'POST', body: { key: editing.key, value: editing.value.trim(), from: editing.from, ...(editing.note.trim() && { note: editing.note.trim() }) } }); toast(t('Saved. Documents already issued are not changed.')); setEditing(null); void load(); } catch (err) { setError(err); }
  };
  return (
    <section className="card stack">
      <div><h2>{t('Taxes and charges in force')}</h2><p className="small muted">{t('Each value has the day it starts and where it comes from. What could not be checked against an official source is marked: confirm it with the Belize Tax Service, the Belize Tourism Board or your accountant, and set your own value from a date.')}</p></div>
      {!rules ? <div className="skeleton" style={{ height: '6rem' }} /> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th scope="col">{t('Rule')}</th><th scope="col">{t('Value')}</th><th scope="col">{t('From')}</th><th scope="col">{t('Where it comes from')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.key}>
                  <td data-label={t('Rule')}>{t(r.label)}</td>
                  <td data-label={t('Value')}><strong>{r.value}</strong> {!r.verified && <span className="badge pay-overdue">{t('Not verified')}</span>}{r.custom && <span className="badge pay-paid">{t('Yours')}</span>}</td>
                  <td data-label={t('From')}>{r.from}</td>
                  <td data-label={t('Where it comes from')} className="small">{r.source}</td>
                  <td className="right">{can('business.manage') && <button type="button" className="link" onClick={() => setEditing({ key: r.key, value: r.value, from: new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10), note: '' })}>{t('Change')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <form className="row venue-group" onSubmit={(e) => void save(e)}>
          <Field label={t(rules?.find((r) => r.key === editing.key)?.label ?? 'Value')}><input required value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} /></Field>
          <Field label={t('From')}><input type="date" required value={editing.from} onChange={(e) => setEditing({ ...editing, from: e.target.value })} /></Field>
          <Field label={t('Where it comes from')} className="grow"><input maxLength={300} value={editing.note} placeholder={t('The notice, ruling or advice it follows')} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>
          <button>{t('Save')}</button><button type="button" className="secondary" onClick={() => setEditing(null)}>{t('Cancel')}</button>
        </form>
      )}
      <ErrorText error={error} />
    </section>
  );
}
