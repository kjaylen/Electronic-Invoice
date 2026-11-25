/**
 * Menu: how a restaurant or bar offers what it sells. In the sidebar when Restaurant or Bar is on.
 *
 * The items are the business's products (one list: price, GST, stock and recipe stay under Products);
 * the menu arranges them in sections and says how each is served:
 *   - Items: sections in the business's order (made, renamed, removed, moved up or down), the items in
 *     each (moved one by one or many at once), and per item its course, choices, allergens, dietary
 *     tags, the stations that make it, how many are left and "86".
 *   - Menus and promotions: what is on and at what price by the clock.
 *   - Choices: cooking, sides, add-ons.
 *   - Stations: who makes what, and where its tickets print.
 * A section is an item category, so the counter's quick buttons, sales by category and the stations
 * follow the menu.
 */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, money, Segmented, Select, usePageTitle } from '../ui';
import { COURSES } from '../../../src/venue/check.ts';
import { ModifiersCard, PeriodsCard, StationsCard } from './Setup';
import type { MenuEntry, VenueData } from './store';
import './venue.css';

type View = 'items' | 'periods' | 'choices' | 'stations';
type Section = { name: string; items: number };
type MenuData = VenueData & { menuSections: Section[] };

/** "No section" in a list of sections. */
const NONE = '__none__';
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const price = (cents: number) => money((cents / 100).toFixed(2));

export function MenuPage() {
  const t = useT();
  usePageTitle(t('Menu'));
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View | null) ?? 'items';
  const [data, setData] = useState<MenuData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<MenuData>('/v1/venue').then(setData).catch(setError), []);
  useEffect(() => void load(), [load]);

  const service = data?.venue.restaurant || data?.venue.bar;
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Restaurant and bar')}</span><h1>{t('Menu')}</h1></div>
        <span className="spacer" />
        <Link className="button secondary" to="/products" viewTransition>{t('Prices and products')}</Link>
      </div>
      <p className="muted small">{t('The menu arranges your products and says how each is served. Prices, tax, stock and recipes stay under Products: a change there is on the menu at once.')}</p>
      <Segmented switches label={t('Menu')} value={view} onChange={(v) => setParams({ view: v }, { replace: true })}
        options={[['items', t('Items')], ['periods', t('Menus and promotions')], ['choices', t('Choices')], ['stations', t('Stations')]]} />
      <ErrorText error={error} />
      {!data && !error && <div className="skeleton" style={{ height: '16rem' }} />}
      {data && !service && (
        <section className="card stack">
          <p>{t('The menu is for restaurants and bars. Turn on Restaurant or Bar under Settings → Venue.')}</p>
          <div><Link className="button" to="/settings?tab=venue">{t('Open Settings → Venue')}</Link></div>
        </section>
      )}
      {data && service && (
        <div className="tab-panel stack">
          {view === 'items' && <MenuItems data={data} onChange={load} />}
          {view === 'periods' && <PeriodsCard periods={data.periods} items={data.items} onChange={load} />}
          {view === 'choices' && <ModifiersCard groups={data.modifierGroups} items={data.items} onChange={load} />}
          {view === 'stations' && <StationsCard stations={data.stations} categories={data.menuSections.map((s) => s.name)} onChange={load} />}
        </div>
      )}
    </div>
  );
}

// ---------- items, in their sections ----------

function MenuItems({ data, onChange }: { data: MenuData; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'sold'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = useState('');
  const [newSection, setNewSection] = useState('');
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [removing, setRemoving] = useState<{ name: string; moveTo: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sections = data.menuSections;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      if (done) toast(done);
      onChange();
    } catch (e) {
      setError(e);
    }
  };

  const text = q.trim().toLowerCase();
  const visible = (i: MenuEntry) => (!text || i.name.toLowerCase().includes(text) || i.barcode === q.trim()) && (only === 'all' || i.soldOut);
  const groups = useMemo(() => {
    const named = sections.map((s) => ({ name: s.name as string | null, items: data.items.filter((i) => same(i.category, s.name)) }));
    const loose = data.items.filter((i) => !i.category || !sections.some((s) => same(s.name, i.category)));
    return [...named, ...(loose.length ? [{ name: null, items: loose }] : [])];
  }, [data.items, sections]);
  const filtering = Boolean(text) || only !== 'all';

  const order = (from: number, to: number) => {
    const names = sections.map((s) => s.name);
    const [moved] = names.splice(from, 1);
    names.splice(to, 0, moved!);
    void run(() => api('/v1/venue/menu-sections', { method: 'PUT', body: { order: names } }));
  };
  const move = (itemIds: string[], section: string | null) =>
    run(() => api<{ moved: number }>('/v1/venue/items/move', { method: 'POST', body: { itemIds, section } }).then((r) => {
      toast(section ? t('{n} moved to {section}', { n: r.moved, section }) : t('{n} taken out of their section', { n: r.moved }));
      setSelected(new Set());
      setMoveTo('');
    }));
  const toggleSelect = (id: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const addSection = (e: FormEvent) => {
    e.preventDefault();
    const name = newSection.trim();
    if (!name) return;
    void run(() => api('/v1/venue/menu-sections', { method: 'POST', body: { name } }).then(() => setNewSection('')), t('Section {name} added. Move items into it.', { name }));
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming?.value.trim()) return;
    const { name, value } = renaming;
    const joins = sections.find((s) => same(s.name, value.trim()) && !same(s.name, name));
    void run(() => api('/v1/venue/menu-sections/rename', { method: 'POST', body: { from: name, to: value.trim() } }).then(() => setRenaming(null)),
      joins ? t('{from} joined {to}', { from: name, to: joins.name }) : t('Renamed everywhere: items, stations, menus and promotions'));
  };
  const remove = async (name: string, items: number, target: string) => {
    if (items === 0 && !(await confirm({ title: t('Remove {name}?', { name }), body: t('Nothing is in it.'), confirm: t('Remove the section') }))) return;
    void run(() => api('/v1/venue/menu-sections/remove', { method: 'POST', body: { name, moveTo: target || null } }).then(() => setRemoving(null)), t('Section {name} removed', { name }));
  };
  const toggle = (list: string[], c: string) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  const put = (id: string, body: Record<string, unknown>) => run(() => api(`/v1/venue/items/${id}`, { method: 'PUT', body }));
  const soldOut = (i: MenuEntry) => run(
    () => api(`/v1/venue/items/${i.id}/availability`, { method: 'POST', body: { soldOut: !i.soldOut } }),
    i.soldOut ? t('{name} is back on', { name: i.name }) : t('{name} is sold out on every device', { name: i.name }),
  );

  return (
    <div className="stack menu-items">
      <div className="card row menu-toolbar">
        <input type="search" className="search-input grow" placeholder={t('Search the menu')} aria-label={t('Search the menu')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Segmented label={t('Show')} value={only} onChange={setOnly} options={[['all', t('Everything')], ['sold', t('Sold out')]]} />
        <span className="spacer" />
        <form className="row" onSubmit={addSection}>
          <input aria-label={t('New section')} placeholder={t('New section: Starters, Mains, Drinks…')} maxLength={80} value={newSection} onChange={(e) => setNewSection(e.target.value)} />
          <button className="secondary" disabled={!newSection.trim()}>+ {t('Section')}</button>
        </form>
      </div>

      {selected.size > 0 && (
        <div className="card row menu-bulk" role="region" aria-label={t('Selected items')}>
          <strong>{t('{n} selected', { n: selected.size })}</strong>
          <Select aria-label={t('Move to section')} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">{t('Move to…')}</option>
            {sections.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            <option value={NONE}>{t('No section')}</option>
          </Select>
          <button type="button" disabled={!moveTo} onClick={() => void move([...selected], moveTo === NONE ? null : moveTo)}>{t('Move')}</button>
          <span className="spacer" />
          <button type="button" className="link" onClick={() => setSelected(new Set())}>{t('Clear')}</button>
        </div>
      )}
      <ErrorText error={error} />

      {groups.length === 0 && <p className="muted">{t('No products yet. Add what you sell under Products, then arrange it here.')}</p>}
      {groups.map((g, n) => {
        const shown = g.items.filter(visible);
        if (filtering && shown.length === 0) return null;
        const allPicked = shown.length > 0 && shown.every((i) => selected.has(i.id));
        return (
          <section key={g.name ?? NONE} className="card stack menu-section" aria-label={g.name ?? t('Not in a section')}>
            {renaming && g.name && same(renaming.name, g.name) ? (
              <form className="row" onSubmit={rename}>
                <Field label={t('Section')} className="grow"><input autoFocus maxLength={80} value={renaming.value} onChange={(e) => setRenaming({ ...renaming, value: e.target.value })} /></Field>
                <button disabled={!renaming.value.trim()}>{t('Rename')}</button>
                <button type="button" className="secondary" onClick={() => setRenaming(null)}>{t('Cancel')}</button>
              </form>
            ) : (
              <div className="row menu-section-head">
                {shown.length > 0 && <input type="checkbox" aria-label={t('Select everything in {section}', { section: g.name ?? t('Not in a section') })} checked={allPicked}
                  onChange={() => setSelected((cur) => { const next = new Set(cur); for (const i of shown) { if (allPicked) next.delete(i.id); else next.add(i.id); } return next; })} />}
                <h2>{g.name ?? t('Not in a section')}</h2>
                <span className="small muted">{g.items.length === 1 ? t('1 item') : t('{n} items', { n: g.items.length })}</span>
                <span className="spacer" />
                {g.name && (
                  <span className="row menu-section-actions">
                    <button type="button" className="icon-button" aria-label={t('Move {section} up', { section: g.name })} disabled={n === 0} onClick={() => order(n, n - 1)}>↑</button>
                    <button type="button" className="icon-button" aria-label={t('Move {section} down', { section: g.name })} disabled={n >= sections.length - 1} onClick={() => order(n, n + 1)}>↓</button>
                    <button type="button" className="link" onClick={() => setRenaming({ name: g.name!, value: g.name! })}>{t('Rename')}</button>
                    <button type="button" className="link danger-link" onClick={() => (g.items.length ? setRemoving({ name: g.name!, moveTo: '' }) : void remove(g.name!, 0, ''))}>{t('Remove')}</button>
                  </span>
                )}
              </div>
            )}
            {removing && g.name && same(removing.name, g.name) && (
              <div className="venue-group row">
                <Field label={t('Its {n} items go to', { n: g.items.length })}>
                  <Select value={removing.moveTo} onChange={(e) => setRemoving({ ...removing, moveTo: e.target.value })}>
                    <option value="">{t('No section')}</option>
                    {sections.filter((s) => !same(s.name, g.name)).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </Select>
                </Field>
                <button type="button" className="danger" onClick={() => void remove(g.name!, g.items.length, removing.moveTo)}>{t('Remove the section')}</button>
                <button type="button" className="secondary" onClick={() => setRemoving(null)}>{t('Cancel')}</button>
              </div>
            )}
            {g.items.length === 0 && <p className="small muted">{t('Nothing in it yet: tick items in another section and move them here, or choose this section on an item.')}</p>}
            {shown.length > 0 && (
              <ul className="plain menu-list">
                {shown.map((i) => (
                  <li key={i.id} className={`stack${i.soldOut ? ' sold-out' : ''}`}>
                    <div className="row menu-row">
                      <input type="checkbox" aria-label={t('Select {name}', { name: i.name })} checked={selected.has(i.id)} onChange={() => toggleSelect(i.id)} />
                      <button type="button" className="link menu-name" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? null : i.id)}>{i.name}</button>
                      <span className="small muted menu-facts">
                        {[
                          i.course !== null ? t(COURSES[i.course]!) : null,
                          i.modifierGroupIds.length ? t('{n} groups of choices', { n: i.modifierGroupIds.length }) : null,
                          i.allergens.length ? i.allergens.map((a) => t(a)).join(', ') : null,
                          i.remaining !== null ? t('{n} left', { n: i.remaining }) : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                      <strong className="num menu-price">{price(i.priceCents)}</strong>
                      <button type="button" className={`chip-toggle ${i.soldOut ? 'on' : ''}`} aria-pressed={i.soldOut} aria-label={i.soldOut ? t('{name} is sold out: put it back on', { name: i.name }) : t('Mark {name} sold out', { name: i.name })} onClick={() => void soldOut(i)}>{i.soldOut ? t('Sold out') : '86'}</button>
                    </div>
                    {open === i.id && (
                      <div className="stack menu-detail">
                        <div className="form-grid">
                          <Field label={t('Section')}>
                            <Select value={sections.find((s) => same(s.name, i.category))?.name ?? ''} onChange={(e) => void move([i.id], e.target.value || null)}>
                              <option value="">{t('No section')}</option>
                              {sections.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                            </Select>
                          </Field>
                          <Field label={t('How many are left')} hint={t('Counts down as they are ordered; at zero it is sold out everywhere. Empty: no count.')}>
                            <input type="number" min={0} defaultValue={i.remaining ?? ''} onBlur={(e) => void run(() => api(`/v1/venue/items/${i.id}/availability`, { method: 'POST', body: e.target.value === '' ? { soldOut: false } : { remaining: Number(e.target.value) } }))} />
                          </Field>
                        </div>
                        <div><span className="small muted">{t('Course')}</span><div className="station-categories">{COURSES.map((name, c) => <button key={name} type="button" className="chip-toggle" aria-pressed={i.course === c} onClick={() => void put(i.id, { course: i.course === c ? null : c })}>{t(name)}</button>)}</div></div>
                        {data.modifierGroups.length > 0 && <div><span className="small muted">{t('Choices')}</span><div className="station-categories">{data.modifierGroups.map((m) => <button key={m.id} type="button" className="chip-toggle" aria-pressed={i.modifierGroupIds.includes(m.id)} onClick={() => void put(i.id, { modifierGroupIds: toggle(i.modifierGroupIds, m.id) })}>{m.name}</button>)}</div></div>}
                        <div><span className="small muted">{t('Allergens')}</span><div className="station-categories">{data.allergens.map((a) => <button key={a} type="button" className="chip-toggle" aria-pressed={i.allergens.includes(a)} onClick={() => void put(i.id, { allergens: toggle(i.allergens, a) })}>{t(a)}</button>)}</div></div>
                        <div><span className="small muted">{t('Dietary')}</span><div className="station-categories">{data.dietary.map((a) => <button key={a} type="button" className="chip-toggle" aria-pressed={i.dietary.includes(a)} onClick={() => void put(i.id, { dietary: toggle(i.dietary, a) })}>{t(a)}</button>)}</div></div>
                        {data.stations.length > 0 && <div><span className="small muted">{t('Made at (when its section does not say)')}</span><div className="station-categories">{data.stations.map((s) => <button key={s.id} type="button" className="chip-toggle" aria-pressed={i.stationIds.includes(s.id)} onClick={() => void put(i.id, { stationIds: toggle(i.stationIds, s.id) })}>{s.name}</button>)}</div></div>}
                        <div><Link to={`/items/${i.id}`} className="small">{t('Price, tax, stock and recipe: open in Products')} →</Link></div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
