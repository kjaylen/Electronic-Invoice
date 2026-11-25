/** A check on the screen: the menu on one side, the order by course and seat on the other, and everything a server does to it. */

import { type FormEvent, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money } from '../ui';
import { billOfItems, billOneShare, type BillContext, type BillPart, centsText, documentLines, paymentOf, serviceApplies, wholeBill } from '../../../src/venue/bill.ts';
import { type Check, type CheckItem, COURSES, fullyPaid, needsApproval, type Op, type OpType, paidShares } from '../../../src/venue/check.ts';
import { defaultModifiers, type ModifierGroup, modifierProblem, onMenu, currentMenu, priceNow, runningPromotions } from '../../../src/venue/pricing.ts';
import { type PayLine, startPay } from './handoff';
import { dispatch, type MenuEntry, type NumberedCheck, ticketDid, useVenue, type VenueData } from './store';
import { guestCheck } from './tickets';
import type { Ticket as Printed } from '../pos/ticket';

const cents = (n: number) => money(centsText(n));
const belizeClock = (at: Date) => { const local = new Date(at.getTime() - 6 * 3600_000); return { minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday: local.getUTCDay() }; };

export function billContext(data: VenueData, check: Check): BillContext {
  return { servicePercent: serviceApplies(check, data.venue) ? data.venue.servicePercent : null, gstPercent: data.taxes.gstPercent, periods: data.periods, serviceUntaxed: data.taxes.serviceChargeGst === false ? { exemptionReasonCode: data.taxes.serviceChargeExemptionCode || 'SERVICE' } : null };
}

/** A supervisor's PIN, asked for only when the person at the screen cannot approve it themselves. */
function useApproval(data: VenueData | null) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const done = useRef<((who: { id: string; name: string } | null) => void) | null>(null);
  const ask = (): Promise<{ id: string; name: string } | null> => {
    if (data?.me.approves) return Promise.resolve({ id: data.me.id, name: '' });
    setPin(''); setError(null); setOpen(true);
    return new Promise((resolve) => { done.current = resolve; });
  };
  const close = (who: { id: string; name: string } | null) => { setOpen(false); done.current?.(who); done.current = null; };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { close(await api<{ id: string; name: string }>('/v1/venue/approve', { method: 'POST', body: { pin } })); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const dialog = open ? (
    <Modal title={t('A supervisor’s PIN')} onClose={() => close(null)}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="small muted">{t('This needs a supervisor or a manager. They type their till PIN here.')}</p>
        <Field label={t('PIN')}><input type="password" inputMode="numeric" autoComplete="off" autoFocus required minLength={4} maxLength={12} value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={() => close(null)}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || pin.length < 4}>{t('Approve')}</button></div>
      </form>
    </Modal>
  ) : null;
  return { ask, dialog };
}

export function OrderScreen({ checkId, onBack, onPay, print }: { checkId: string; onBack: () => void; onPay: () => void; print: (ticket: Printed, title: string) => Promise<void> | void }) {
  const t = useT();
  const toast = useToast();
  const { data, check, checks, tickets } = useVenue();
  const c = check(checkId) as NumberedCheck | undefined;
  const [seat, setSeat] = useState(1);
  const [course, setCourse] = useState<number | null>(null);
  const [category, setCategory] = useState<string>('');
  const [q, setQ] = useState('');
  const [choosing, setChoosing] = useState<MenuEntry | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'pay' | 'more' | 'move' | 'merge' | 'transfer' | null>(null);
  const approval = useApproval(data);
  const clock = belizeClock(new Date());
  const override = data?.venue.menuOverride?.businessDate === data?.businessDate ? data?.venue.menuOverride?.periodId : null;
  const menu = data ? currentMenu(data.periods, clock.minutes, clock.weekday, override) : null;
  const promos = data ? runningPromotions(data.periods, clock.minutes, clock.weekday) : [];
  const items = useMemo(() => (data?.items ?? []).filter((i) => onMenu(menu, { id: i.id, category: i.category, priceCents: i.priceCents })), [data, menu]);
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter((x): x is string => Boolean(x)))].sort(), [items]);

  if (!data || !c) return <div className="card"><p>{t('This check is no longer open.')}</p><button type="button" onClick={onBack}>{t('Back to the floor')}</button></div>;
  const ctx = billContext(data, c);
  const bill = wholeBill(c, ctx);
  const closed = c.status !== 'open' && c.status !== 'paid';
  const label = c.tableName ?? c.name ?? (c.kind === 'quick' ? t('Quick sale') : t('Tab'));

  /** Run an operation; ask for a supervisor first when it needs one; say why when it cannot be done. */
  const run = async (type: OpType, payload: Record<string, unknown> = {}): Promise<boolean> => {
    const op: Op = { id: '', checkId, type, at: '', by: { id: '', name: '' }, payload };
    let approvedBy: { id: string; name: string } | null = null;
    if (needsApproval(c, op, data.venue.discountLimitPercent)) {
      approvedBy = await approval.ask();
      if (!approvedBy) return false;
    }
    const done = dispatch(checkId, type, { ...payload, ...(approvedBy && { approvedBy }) });
    if (!done.ok) toast(t(done.reason ?? 'That cannot be done'), 'bad');
    return done.ok;
  };

  const addItem = (entry: MenuEntry, modifiers: Array<{ groupId: string; optionId: string; name: string; priceCents: number; itemId?: string | null }>, quantity: number, note: string) => {
    const price = priceNow({ id: entry.id, category: entry.category, priceCents: entry.priceCents }, data.periods, clock.minutes, clock.weekday, override);
    const at = { seat: Math.min(seat, c.partySize), course: course ?? entry.course ?? 2 };
    // The same thing again for the same guest, not yet sent: one line, one more.
    const same = !modifiers.length && !note.trim() ? c.items.find((i) => i.status === 'held' && i.itemId === entry.id && i.seat === at.seat && i.course === at.course && !i.modifiers.length && !i.note && i.unitCents === price.priceCents) : undefined;
    if (same) return void run('edit', { itemId: same.id, quantity: same.quantity + quantity });
    void run('add', { items: [{
      id: crypto.randomUUID(), itemId: entry.id, name: entry.name, category: entry.category, unitCode: entry.unitCode, gst: entry.gst, ...(entry.exemptionReasonCode && { exemptionReasonCode: entry.exemptionReasonCode }),
      unitCents: price.priceCents, ...(price.promo && { promo: price.promo }), tags: price.tags, quantity, modifiers, ...(note.trim() && { note: note.trim() }), allergens: entry.allergens,
      seat: at.seat, course: at.course, stationIds: entry.stationIds,
    }] });
  };
  const tap = (entry: MenuEntry) => {
    if (entry.soldOut) return toast(t('{name} is sold out', { name: entry.name }), 'bad');
    const groups = data.modifierGroups.filter((g) => entry.modifierGroupIds.includes(g.id));
    if (groups.length) setChoosing(entry);
    else addItem(entry, [], 1, '');
  };
  const send = async () => {
    const before = c.items.filter((i) => i.status === 'held' && !c.heldCourses.includes(i.course)).length;
    if (await run('fire') && before) toast(t('Sent: {n} items', { n: before }));
  };
  /** The last round again: everything sent in the most recent send that is a drink. */
  const repeatRound = () => {
    const sent = c.items.filter((i) => i.sentAt && i.course === 0 && i.status !== 'void');
    const last = sent.reduce((a, i) => (i.sentAt! > a ? i.sentAt! : a), '');
    const round = sent.filter((i) => i.sentAt === last);
    if (!round.length) return toast(t('No round of drinks to repeat yet'), 'bad');
    const again = round.flatMap((i) => {
      const entry = data.items.find((m) => m.id === i.itemId);
      if (!entry || entry.soldOut) return [];
      const price = priceNow({ id: entry.id, category: entry.category, priceCents: entry.priceCents }, data.periods, clock.minutes, clock.weekday, override);
      return [{ ...i, id: crypto.randomUUID(), unitCents: price.priceCents, promo: price.promo, tags: price.tags, status: undefined, paid: undefined, voided: undefined, comp: undefined, discount: undefined }];
    });
    if (again.length) void run('add', { items: again });
  };
  const preBill = () => void print(guestCheck({ business: '', label, server: c.server.name, partySize: c.partySize, part: bill, servicePercent: ctx.servicePercent, usdRateCents: data.venue.usdRateCents, at: new Date() }), t('Guest check'));

  const shown = items.filter((i) => (q.trim() ? i.name.toLowerCase().includes(q.trim().toLowerCase()) || i.barcode === q.trim() : category ? i.category === category : i.favorite || !categories.length));
  const live = c.items.filter((i) => i.status !== 'void');
  const held = live.filter((i) => i.status === 'held');
  const failed = tickets.filter((k) => k.checkId === c.id && (k.status === 'failed' || (k.status === 'queued' && Date.now() - new Date(k.createdAt).getTime() > 45_000)) && !k.bumpedAt);
  const editingItem = editing ? c.items.find((i) => i.id === editing) : undefined;

  return (
    <div className="venue-order">
      <header className="venue-order-head">
        <button type="button" className="secondary" onClick={onBack}>← {t('Floor')}</button>
        <div className="grow">
          <h1>{label}{c.number ? <span className="muted small"> · #{c.number}</span> : null}</h1>
          <p className="small muted">{t('{n} guests', { n: c.partySize })} · {c.server.name}{menu ? ` · ${menu.name}` : ''}{promos.map((p) => ` · ${p.name}`).join('')}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setDialog('more')} disabled={closed}>{t('More')}</button>
      </header>
      {c.allergy && <div className="banner bad venue-allergy" role="alert"><strong>{t('Allergy')}:</strong> {c.allergy}</div>}
      {failed.length > 0 && <TicketProblems failed={failed} />}

      <div className="venue-order-body">
        <section className="venue-menu" aria-label={t('Menu')}>
          <input type="search" className="search-input" placeholder={t('Search the menu')} aria-label={t('Search the menu')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="venue-chips" role="group" aria-label={t('Categories')}>
            <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>★</button>
            {categories.map((k) => <button key={k} type="button" aria-pressed={category === k} onClick={() => setCategory(k)}>{k}</button>)}
          </div>
          <div className="venue-items">
            {shown.map((i) => {
              const price = priceNow({ id: i.id, category: i.category, priceCents: i.priceCents }, data.periods, clock.minutes, clock.weekday, override);
              return (
                <button key={i.id} type="button" className={`venue-item ${i.soldOut ? 'out' : ''} ${price.promo ? 'promo' : ''}`} onClick={() => tap(i)} aria-disabled={i.soldOut || undefined} disabled={closed}>
                  <strong>{i.name}</strong>
                  <span className="num">{cents(price.priceCents)}{price.promo && <s className="muted"> {cents(i.priceCents)}</s>}</span>
                  {i.soldOut ? <span className="badge pay-overdue">{t('Sold out')}</span> : i.remaining !== null ? <span className="badge pay-credit">{t('{n} left', { n: i.remaining })}</span> : null}
                  {c.allergy && i.allergens.length > 0 && <span className="venue-allergens">{i.allergens.join(', ')}</span>}
                </button>
              );
            })}
            {shown.length === 0 && <p className="muted small">{t('Nothing on the menu here.')}</p>}
          </div>
        </section>

        <section className="venue-check card ticket" aria-label={t('The order')}>
          <div className="venue-seats" role="group" aria-label={t('Seat')}>
            <button type="button" aria-pressed={seat === 0} onClick={() => setSeat(0)}>{t('Table')}</button>
            {Array.from({ length: Math.min(c.partySize, 24) }, (_, n) => <button key={n} type="button" aria-pressed={seat === n + 1} onClick={() => setSeat(n + 1)}>{n + 1}</button>)}
          </div>
          <div className="venue-seats" role="group" aria-label={t('Course')}>
            <button type="button" aria-pressed={course === null} onClick={() => setCourse(null)}>{t('Auto')}</button>
            {COURSES.map((name, n) => <button key={name} type="button" aria-pressed={course === n} onClick={() => setCourse(n)}>{t(name)}</button>)}
          </div>
          <div className="venue-lines">
            {COURSES.map((name, n) => {
              const mine = c.items.filter((i) => i.course === n);
              if (!mine.length) return null;
              const onHold = c.heldCourses.includes(n);
              const waiting = mine.some((i) => i.status === 'held');
              return (
                <div key={name} className="venue-course">
                  <div className="row">
                    <strong>{t(name)}</strong>{onHold && <span className="badge pay-credit">{t('On hold')}</span>}
                    <span className="spacer" />
                    {waiting && !closed && (onHold
                      ? <button type="button" className="small-button lime" onClick={() => void run('fire', { course: n })}>{t('Fire')}</button>
                      : <button type="button" className="link on-dark small" onClick={() => void run('holdCourse', { course: n })}>{t('Hold')}</button>)}
                    {mine.some((i) => i.status === 'ready' || i.status === 'sent') && !closed && <button type="button" className="link on-dark small" onClick={() => void run('served', { course: n })}>{t('Served')}</button>}
                  </div>
                  <ul>
                    {mine.map((i) => (
                      <li key={i.id} className={`status-${i.status}`}>
                        <button type="button" onClick={() => setEditing(i.id)} disabled={closed}>
                          <span className="q">{i.quantity}</span>
                          <span className="what">
                            {i.name}{i.seat > 0 && <span className="seat"> S{i.seat}</span>}
                            {i.modifiers.length > 0 && <span className="mods">{i.modifiers.map((m) => m.name).join(', ')}</span>}
                            {i.note && <span className="mods">** {i.note}</span>}
                            {(i.comp || i.discount || i.promo || i.shares > 1) && <span className="mods">{[i.comp && t('On the house'), i.discount && t('Discount'), i.promo, i.shares > 1 && t('Shared by {n}', { n: i.shares })].filter(Boolean).join(' · ')}</span>}
                          </span>
                          <span className={`state state-${i.status}`}>{fullyPaid(i) && i.status !== 'void' ? t('paid') : t(i.status === 'held' ? 'not sent' : i.status === 'void' ? 'void' : i.status)}</span>
                          <span className="num">{cents((i.unitCents + i.modifiers.reduce((a, m) => a + m.priceCents, 0)) * i.quantity)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {c.items.length === 0 && <p className="muted">{t('Tap items to order. They go to the kitchen when you press Send.')}</p>}
          </div>
          <div className="totals venue-totals">
            <div><span>{t('Subtotal')}</span><span>{cents(bill.subtotalCents - bill.allowCents)}</span></div>
            {bill.serviceCents > 0 && <div><span>{t('Service charge ({n}%)', { n: ctx.servicePercent ?? '' })}</span><span>{cents(bill.serviceCents)}</span></div>}
            <div><span>GST</span><span>{cents(bill.gstCents)}</span></div>
            <div className="grand"><span>{t('To pay')}</span><span>{cents(bill.totalCents)}</span></div>
            <div className="grand-usd"><span>{t('In US dollars')}</span><span>US${centsText(Math.ceil((bill.totalCents * 100) / data.venue.usdRateCents))}</span></div>
          </div>
          {!closed && (
            <div className="venue-actions">
              <button type="button" className="big lime" disabled={!held.some((i) => !c.heldCourses.includes(i.course))} onClick={() => void send()}>{t('Send')}{held.length > 0 && <span className="chip">{held.length}</span>}</button>
              <button type="button" className="secondary" onClick={repeatRound}>{t('Repeat round')}</button>
              <button type="button" className="secondary" disabled={!live.length} onClick={() => { preBill(); void run('requestBill'); }}>{t('Guest check')}</button>
              <button type="button" disabled={!live.some((i) => !fullyPaid(i))} onClick={() => setDialog('pay')}>{t('Pay')}</button>
              {c.status === 'paid' && <button type="button" className="secondary" onClick={() => { void run('clean'); onBack(); }}>{t('Table is clean')}</button>}
              {c.status === 'open' && live.every((i) => fullyPaid(i) || i.comp) && <button type="button" className="secondary" onClick={async () => { if (await run('close')) onBack(); }}>{c.kind === 'table' ? t('Close the table') : t('Close')}</button>}
            </div>
          )}
        </section>
      </div>

      {choosing && <ModifierDialog entry={choosing} groups={data.modifierGroups.filter((g) => choosing.modifierGroupIds.includes(g.id))} allergy={c.allergy} onClose={() => setChoosing(null)} onAdd={(m, n, note) => { addItem(choosing, m, n, note); setChoosing(null); }} />}
      {editingItem && <ItemDialog item={editingItem} check={c} others={checks.filter((x) => x.id !== c.id && x.status === 'open')} onClose={() => setEditing(null)} run={run} />}
      {dialog === 'pay' && <PayDialog check={c} ctx={ctx} hotel={data.venue.hotel} label={label} onClose={() => setDialog(null)} run={run} onPay={() => { setDialog(null); onPay(); }} />}
      {dialog === 'more' && <MoreDialog check={c} data={data} onClose={() => setDialog(null)} run={run} open={(d) => setDialog(d)} />}
      {dialog === 'transfer' && (
        <Modal title={t('Give this check to')} onClose={() => setDialog(null)}>
          <div className="venue-pick">{data.staff.filter((s) => s.orders && s.id !== c.server.id).map((s) => <button key={s.id} type="button" className="secondary" onClick={async () => { if (await run('transfer', { server: { id: s.id, name: s.name } })) setDialog(null); }}>{s.name}</button>)}</div>
        </Modal>
      )}
      {dialog === 'move' && (
        <Modal title={t('Move to a table')} onClose={() => setDialog(null)}>
          <div className="venue-pick">
            {data.floor.filter((p) => p.layout === data.venue.layout || !data.floor.some((x) => x.area === p.area && x.layout === data.venue.layout)).flatMap((p) => p.items.filter((i) => i.type !== 'wall' && i.type !== 'fixture').map((i) => ({ ...i, area: p.area })))
              .filter((i) => !checks.some((x) => x.tableId === i.id && (x.status === 'open' || x.status === 'paid')))
              .map((i) => <button key={i.id} type="button" className="secondary" onClick={async () => { if (await run('move', { tableId: i.id, tableName: i.name })) setDialog(null); }}>{i.name}<span className="small muted"> {i.area}</span></button>)}
          </div>
        </Modal>
      )}
      {dialog === 'merge' && (
        <Modal title={t('Join with another check')} onClose={() => setDialog(null)}>
          <p className="small muted">{t('Everything on this check goes onto the other, and this one closes.')}</p>
          <div className="venue-pick">{checks.filter((x) => x.id !== c.id && x.status === 'open').map((x) => <button key={x.id} type="button" className="secondary" onClick={async () => { if (await run('merge', { toCheckId: x.id })) { setDialog(null); onBack(); } }}>{x.tableName ?? x.name ?? t('Tab')}</button>)}</div>
        </Modal>
      )}
      {approval.dialog}
    </div>
  );
}

function TicketProblems({ failed }: { failed: Array<{ id: string; stationId: string; error: string | null; status: string }> }) {
  const t = useT();
  const { data } = useVenue();
  return (
    <div className="banner bad" role="alert">
      <div>
        <strong>{t('An order did not print.')}</strong>
        <ul className="plain small">
          {failed.map((k) => (
            <li key={k.id} className="row">
              <span>{data?.stations.find((s) => s.id === k.stationId)?.name ?? t('Station')}: {k.error ?? t('still waiting for its printer')}</span>
              <span className="spacer" />
              <button type="button" className="small-button secondary" onClick={() => void ticketDid(k.id, 'retry')}>{t('Try again')}</button>
              <button type="button" className="small-button secondary" onClick={() => void ticketDid(k.id, 'reroute')}>{t('Print elsewhere')}</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ModifierDialog({ entry, groups, allergy, onClose, onAdd }: { entry: MenuEntry; groups: ModifierGroup[]; allergy: string | null; onClose: () => void; onAdd: (m: ReturnType<typeof defaultModifiers>, quantity: number, note: string) => void }) {
  const t = useT();
  const [chosen, setChosen] = useState(() => defaultModifiers(groups));
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const problem = modifierProblem(groups, chosen);
  const toggle = (g: ModifierGroup, o: ModifierGroup['options'][number]) => setChosen((cur) => {
    const has = cur.some((x) => x.groupId === g.id && x.optionId === o.id);
    if (has) return cur.filter((x) => !(x.groupId === g.id && x.optionId === o.id));
    const mine = cur.filter((x) => x.groupId === g.id);
    // One choice only: the new one replaces the old. Several: the oldest gives way once the group is full.
    const keep = mine.length >= g.maxChoices ? cur.filter((x) => x.groupId !== g.id || x !== mine[0]) : cur;
    return [...keep, { groupId: g.id, optionId: o.id, name: o.name, priceCents: o.priceCents, ...(o.itemId && { itemId: o.itemId }) }];
  });
  return (
    <Modal title={entry.name} onClose={onClose} wide>
      <div className="stack">
        {allergy && entry.allergens.length > 0 && <div className="banner bad"><strong>{t('Contains')}: {entry.allergens.join(', ')}.</strong> {t('The guest’s allergy')}: {allergy}</div>}
        {entry.dietary.length > 0 && <p className="small muted">{entry.dietary.join(' · ')}</p>}
        {groups.map((g) => (
          <fieldset key={g.id} className="venue-group">
            <legend>{g.name} <span className="small muted">{g.minChoices > 0 ? (g.maxChoices === 1 ? t('choose one') : t('choose {min} to {max}', { min: g.minChoices, max: g.maxChoices })) : g.maxChoices === 1 ? t('optional') : t('up to {max}', { max: g.maxChoices })}</span></legend>
            <div className="venue-pick">
              {g.options.map((o) => <button key={o.id} type="button" className="chip-toggle" aria-pressed={chosen.some((x) => x.groupId === g.id && x.optionId === o.id)} onClick={() => toggle(g, o)}>{o.name}{o.priceCents !== 0 && <span className="num"> {o.priceCents > 0 ? '+' : ''}{centsText(o.priceCents)}</span>}</button>)}
            </div>
          </fieldset>
        ))}
        <Field label={t('Note for the kitchen or bar')}><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('No onions, extra ice…')} /></Field>
        <div className="row">
          <div className="qty-stepper"><button type="button" className="secondary" onClick={() => setQuantity(Math.max(1, quantity - 1))} aria-label={t('One less')}>−</button><output>{quantity}</output><button type="button" className="secondary" onClick={() => setQuantity(Math.min(99, quantity + 1))} aria-label={t('One more')}>+</button></div>
          <span className="spacer" />
          {problem && <span className="small late">{problem}</span>}
          <button type="button" className="big" disabled={Boolean(problem)} onClick={() => onAdd(chosen, quantity, note)}>{t('Add to the order')}</button>
        </div>
      </div>
    </Modal>
  );
}

type Run = (type: OpType, payload?: Record<string, unknown>) => Promise<boolean>;

function ItemDialog({ item, check, others, onClose, run }: { item: CheckItem; check: Check; others: NumberedCheck[]; onClose: () => void; run: Run }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [percent, setPercent] = useState('');
  const [mode, setMode] = useState<'main' | 'void' | 'comp' | 'discount' | 'move'>('main');
  const sent = item.status !== 'held';
  const paid = paidShares(item) > 0;
  const act = async (type: OpType, payload: Record<string, unknown>) => { if (await run(type, payload)) onClose(); };
  if (item.status === 'void') return <Modal title={item.name} onClose={onClose}><p>{t('Voided by {name}: {reason}', { name: item.voided?.by.name ?? '', reason: item.voided?.reason ?? '' })}</p></Modal>;
  return (
    <Modal title={`${item.quantity} × ${item.name}`} onClose={onClose}>
      {mode === 'main' && (
        <div className="stack">
          {!sent && (
            <div className="row">
              <div className="qty-stepper"><button type="button" className="secondary" disabled={item.quantity <= 1} onClick={() => void run('edit', { itemId: item.id, quantity: item.quantity - 1 })}>−</button><output>{item.quantity}</output><button type="button" className="secondary" onClick={() => void run('edit', { itemId: item.id, quantity: item.quantity + 1 })}>+</button></div>
              <span className="spacer" />
              <button type="button" className="secondary" onClick={() => void act('remove', { itemIds: [item.id] })}>{t('Take off')}</button>
            </div>
          )}
          <Field label={t('Seat')}>
            <div className="venue-seats light"><button type="button" aria-pressed={item.seat === 0} onClick={() => void run('edit', { itemId: item.id, seat: 0 })}>{t('Table')}</button>{Array.from({ length: Math.min(check.partySize, 24) }, (_, n) => <button key={n} type="button" aria-pressed={item.seat === n + 1} onClick={() => void run('edit', { itemId: item.id, seat: n + 1 })}>{n + 1}</button>)}</div>
          </Field>
          {!sent && <Field label={t('Course')}><div className="venue-seats light">{COURSES.map((name, n) => <button key={name} type="button" aria-pressed={item.course === n} onClick={() => void run('edit', { itemId: item.id, course: n })}>{t(name)}</button>)}</div></Field>}
          {!paid && (
            <div className="venue-pick">
              {sent && <button type="button" className="secondary" onClick={() => setMode('void')}>{t('Void')}</button>}
              <button type="button" className="secondary" onClick={() => setMode('comp')}>{item.comp ? t('Not on the house') : t('On the house')}</button>
              <button type="button" className="secondary" onClick={() => setMode('discount')}>{t('Discount')}</button>
              {others.length > 0 && <button type="button" className="secondary" onClick={() => setMode('move')}>{t('Move to another check')}</button>}
              {[2, 3, 4].map((n) => <button key={n} type="button" className="chip-toggle" aria-pressed={item.shares === n} onClick={() => void run('share', { itemIds: [item.id], ways: item.shares === n ? 1 : n })}>{t('Share by {n}', { n })}</button>)}
            </div>
          )}
        </div>
      )}
      {(mode === 'void' || mode === 'comp' || mode === 'discount') && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void act(mode === 'void' ? 'void' : mode, mode === 'discount' ? { itemIds: [item.id], percent: Number(percent || 0), reason } : mode === 'comp' ? { itemIds: [item.id], reason: reason || 'Removed', ...(item.comp && { undo: true }) } : { itemIds: [item.id], reason }); }}>
          {mode === 'discount' && <Field label={t('Percent off')} hint={t('0 takes the discount off.')}><input inputMode="decimal" autoFocus required value={percent} onChange={(e) => setPercent(e.target.value.trim())} /></Field>}
          {!(mode === 'comp' && item.comp) && <Field label={t('Why?')}><input autoFocus={mode !== 'discount'} required={!(mode === 'discount' && Number(percent) === 0)} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === 'void' ? t('Dropped, wrong dish, guest changed their mind…') : mode === 'comp' ? t('Birthday, long wait, the manager’s guest…') : t('Regular, staff, complaint…')} /></Field>}
          <div className="row"><button type="button" className="secondary" onClick={() => setMode('main')}>{t('Back')}</button><span className="spacer" /><button>{mode === 'void' ? t('Void it') : mode === 'comp' ? (item.comp ? t('Charge it again') : t('Make it on the house')) : t('Apply')}</button></div>
        </form>
      )}
      {mode === 'move' && <div className="venue-pick">{others.map((x) => <button key={x.id} type="button" className="secondary" onClick={() => void act('moveItems', { itemIds: [item.id], toCheckId: x.id })}>{x.tableName ?? x.name ?? t('Tab')}</button>)}</div>}
    </Modal>
  );
}

function MoreDialog({ check, data, onClose, run, open }: { check: Check; data: VenueData; onClose: () => void; run: Run; open: (d: 'move' | 'merge' | 'transfer') => void }) {
  const t = useT();
  const [party, setParty] = useState(check.partySize);
  const [allergy, setAllergy] = useState(check.allergy ?? '');
  const service = serviceApplies(check, data.venue);
  return (
    <Modal title={t('This check')} onClose={onClose}>
      <div className="stack">
        <div className="venue-pick">
          <button type="button" className="secondary" onClick={() => open('move')}>{t('Move to a table')}</button>
          <button type="button" className="secondary" onClick={() => open('merge')}>{t('Join with another check')}</button>
          <button type="button" className="secondary" onClick={() => open('transfer')}>{t('Give to another server')}</button>
          {data.venue.serviceCharge !== 'off' && <button type="button" className="secondary" onClick={async () => { if (await run('service', { on: !service })) onClose(); }}>{service ? t('Take off the service charge') : t('Add the service charge')}</button>}
        </div>
        <div className="row">
          <Field label={t('Guests')}><div className="qty-stepper"><button type="button" className="secondary" onClick={() => setParty(Math.max(1, party - 1))}>−</button><output>{party}</output><button type="button" className="secondary" onClick={() => setParty(Math.min(200, party + 1))}>+</button></div></Field>
          {party !== check.partySize && <button type="button" onClick={() => void run('party', { partySize: party })}>{t('Save')}</button>}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run('allergy', { allergy }); }}>
          <Field label={t('Allergy')} hint={t('Printed on every ticket for this table.')} className="grow"><input maxLength={200} value={allergy} onChange={(e) => setAllergy(e.target.value)} placeholder={t('Seat 2: peanuts')} /></Field>
          {allergy.trim() !== (check.allergy ?? '') && <button>{t('Save')}</button>}
        </form>
        <details className="small"><summary>{t('History')}</summary><ul className="plain">{check.events.slice(-30).reverse().map((e, n) => <li key={n}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {t(e.type)}{e.note ? `: ${e.note}` : ''}{e.by.name ? ` · ${e.by.name}` : ''}{e.approvedBy?.name ? ` (${e.approvedBy.name})` : ''}</li>)}</ul></details>
      </div>
    </Modal>
  );
}

/** What to pay, and how it is split; then it goes to the counter to be paid. */
function PayDialog({ check, ctx, hotel, label, onClose, run, onPay }: { check: Check; ctx: BillContext; hotel: boolean; label: string; onClose: () => void; run: Run; onPay: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<'whole' | 'seat' | 'even' | 'items'>('whole');
  const [ways, setWays] = useState(2);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [roomName, setRoomName] = useState('');
  const [room, setRoom] = useState<{ bookingId: string; guest: string; room: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const unpaid = check.items.filter((i) => i.status !== 'void' && !fullyPaid(i));
  const seats = [...new Set(unpaid.map((i) => i.seat))].sort((a, b) => a - b);
  // Already being paid in shares: carry on, one share at a time.
  const sharing = unpaid.length > 0 && unpaid.every((i) => i.shares > 1) ? Math.max(...unpaid.map((i) => i.shares - paidShares(i))) : 0;
  const whole = wholeBill(check, ctx);
  const go = (part: BillPart, what: string) => {
    if (!part.lines.length) return;
    startPay({ checkId: check.id, label: `${label}${what ? `, ${what}` : ''}`, lines: documentLines(part, ctx.servicePercent, ctx.serviceUntaxed) as unknown as PayLine[], items: paymentOf(part), ...(room && { room }) });
    onPay();
  };
  const findRoom = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ data: Array<{ bookingId: string; guest: string; room: string }> }>(`/v1/hotel/in-house?room=${encodeURIComponent(roomName.trim())}`);
      if (!r.data.length) throw new Error(t('Nobody is checked in to room {room}', { room: roomName.trim() }));
      setRoom(r.data[0]!);
    } catch (err) { setError(err); }
  };
  return (
    <Modal title={t('Pay {label}', { label })} onClose={onClose} wide>
      <div className="stack">
        {sharing > 0 ? (
          <>
            <p>{t('This bill is being paid in equal parts: {n} left.', { n: sharing })}</p>
            <button type="button" className="big" onClick={() => go(billOneShare(check, ctx), t('1 of {n} left', { n: sharing }))}>{t('Pay the next part: {amount}', { amount: cents(billOneShare(check, ctx).totalCents) })}</button>
          </>
        ) : (
          <>
            <div className="tabs" role="group" aria-label={t('How it is split')}>
              {([['whole', t('The whole bill')], ['seat', t('By seat')], ['even', t('Evenly')], ['items', t('By item')]] as const).map(([k, name]) => <button key={k} type="button" aria-pressed={mode === k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>{name}</button>)}
            </div>
            {mode === 'whole' && <button type="button" className="big" onClick={() => go(whole, '')}>{t('Pay {amount}', { amount: cents(whole.totalCents) })}</button>}
            {mode === 'seat' && (
              <div className="venue-pick">
                {seats.map((s) => {
                  const part = billOfItems(check, ctx, unpaid.filter((i) => i.seat === s).map((i) => ({ itemId: i.id, shares: i.shares - paidShares(i) })), s === 0 ? t('Table') : t('Seat {n}', { n: s }));
                  return <button key={s} type="button" className="secondary" onClick={() => go(part, part.label)}>{part.label}<strong className="num"> {cents(part.totalCents)}</strong></button>;
                })}
                <p className="small muted">{t('What was ordered for the table is its own part; share an item between guests from the item itself.')}</p>
              </div>
            )}
            {mode === 'even' && (
              <div className="row">
                <Field label={t('Between how many?')}><div className="qty-stepper"><button type="button" className="secondary" onClick={() => setWays(Math.max(2, ways - 1))}>−</button><output>{ways}</output><button type="button" className="secondary" onClick={() => setWays(Math.min(20, ways + 1))}>+</button></div></Field>
                <span className="spacer" />
                <button type="button" className="big" onClick={async () => { if (await run('share', { itemIds: unpaid.map((i) => i.id), ways })) onClose(); }}>{t('Split in {n}: about {amount} each', { n: ways, amount: cents(Math.round(whole.totalCents / ways)) })}</button>
              </div>
            )}
            {mode === 'items' && (
              <>
                <ul className="plain venue-pay-items">{unpaid.map((i) => <li key={i.id}><label className="row"><input type="checkbox" checked={Boolean(picked[i.id])} onChange={(e) => setPicked({ ...picked, [i.id]: e.target.checked })} /> {i.quantity} × {i.name}{i.seat > 0 && <span className="muted small"> S{i.seat}</span>}{i.shares > 1 && <span className="muted small"> · {t('1 of {n} shares', { n: i.shares - paidShares(i) })}</span>}</label></li>)}</ul>
                {(() => { const part = billOfItems(check, ctx, unpaid.filter((i) => picked[i.id]).map((i) => ({ itemId: i.id, shares: i.shares > 1 ? 1 : 1 })), t('Selected items')); return <button type="button" className="big" disabled={!part.lines.length} onClick={() => go(part, t('{n} items', { n: part.lines.length }))}>{t('Pay {amount}', { amount: cents(part.totalCents) })}</button>; })()}
              </>
            )}
          </>
        )}
        {hotel && (
          <form className="row venue-room" onSubmit={(e) => void findRoom(e)}>
            {room ? (
              <div className="banner ok grow"><div><strong>{t('Charge to room {room}: {guest}', { room: room.room, guest: room.guest })}</strong>{t('Confirm the name with the guest. The part you choose above goes on their room bill.')}</div><button type="button" className="link" onClick={() => setRoom(null)}>{t('Not to a room')}</button></div>
            ) : (
              <>
                <Field label={t('Charge to a room')} hint={t('The room number: the guest’s name is shown to confirm.')} className="grow"><input value={roomName} maxLength={20} onChange={(e) => setRoomName(e.target.value)} /></Field>
                <button className="secondary" disabled={!roomName.trim()}>{t('Find the guest')}</button>
              </>
            )}
          </form>
        )}
        <ErrorText error={error} />
      </div>
    </Modal>
  );
}

