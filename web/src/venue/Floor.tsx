/**
 * Table service: the floor plan is the home screen. Each table shows where
 * its party is (free, seated, ordered, sent, mains, bill, paid), who serves
 * it, how long they have been there and what they owe. Bar tabs and quick
 * sales live beside it. The same screen runs in the web app and on the tills.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { Field, Modal, money, Select } from '../ui';
import { centsText, wholeBill } from '../../../src/venue/bill.ts';
import { hasReady, type TableState, tableState } from '../../../src/venue/check.ts';
import type { Ticket as Printed } from '../pos/ticket';
import { PAID_EVENT, peekPay } from './handoff';
import { billContext, OrderScreen } from './Order';
import { dismissProblem, dispatch, type FloorItem, type NumberedCheck, poll, setActor, setPrinter, useVenue, watch } from './store';
import { stationTicket } from './tickets';
import './venue.css';

const STATE_TEXT: Record<TableState, string> = { free: 'Free', reserved: 'Reserved', seated: 'Seated', ordered: 'Ordered', sent: 'Food sent', mains: 'Mains served', bill: 'Bill requested', paid: 'Paid: clean it' };
const minutes = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

interface Arrival { id: string; kind: 'reservation' | 'waitlist'; name: string; partySize: number; at: string; allergy: string | null; tableIds: string[] }

export function VenueFloor({ counter, print }: {
  /** The screen that takes the payment: the counter in the web app, Sell on a till. */
  counter: ReactNode;
  print: (ticket: Printed, title: string) => Promise<void> | void;
}) {
  const t = useT();
  const toast = useToast();
  const { session, can } = useSession();
  const { data, checks, tickets, online, pending, problems } = useVenue();
  const [area, setArea] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [seating, setSeating] = useState<FloorItem | null>(null);
  const [panel, setPanel] = useState<'tabs' | null>(null);
  const [paying, setPaying] = useState(Boolean(peekPay()));
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [, tick] = useState(0);

  useEffect(() => { if (session) setActor({ id: session.user.id, name: session.user.name }); }, [session]);
  useEffect(() => watch(), []);
  // The minutes on the tables move on by themselves.
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(id); }, []);
  // Tickets this device is to print (a station's till, or the device that sent the order).
  useEffect(() => {
    setPrinter(async (ticket, station) => { await print(stationTicket(ticket, station?.name ?? 'Order'), `${station?.name ?? 'Order'} · ${ticket.body.table}`); });
    return () => setPrinter(null);
  }, [print]);
  // Paid (or the server went back): the floor again.
  const [justPaid, setJustPaid] = useState(false);
  useEffect(() => {
    const back = (e: Event) => { setPaying(false); setJustPaid(Boolean((e as CustomEvent).detail)); };
    window.addEventListener(PAID_EVENT, back);
    return () => window.removeEventListener(PAID_EVENT, back);
  }, []);
  // After a payment: back to the floor when nothing is left to pay; else the check again, for its next part.
  useEffect(() => {
    if (!justPaid || !open) return;
    const c = checks.find((x) => x.id === open);
    if (!c || c.status !== 'open') setOpen(null);
    setJustPaid(false);
  }, [justPaid, open, checks]);
  // Who is due and who is waiting, for seating from the same screen.
  const loadArrivals = () => {
    if (!can('venue.floor') && !can('venue.orders')) return;
    void api<{ reservations: Array<{ id: string; name: string; partySize: number; startsAt: string; status: string; allergy: string | null; tableIds: string[] }>; waitlist: Array<{ id: string; name: string; partySize: number; addedAt: string }> }>('/v1/venue/reservations')
      .then((r) => setArrivals([
        ...r.reservations.filter((v) => v.status === 'booked' || v.status === 'confirmed').map((v) => ({ id: v.id, kind: 'reservation' as const, name: v.name, partySize: v.partySize, at: v.startsAt, allergy: v.allergy, tableIds: v.tableIds })),
        ...r.waitlist.map((w) => ({ id: w.id, kind: 'waitlist' as const, name: w.name, partySize: w.partySize, at: w.addedAt, allergy: null, tableIds: [] })),
      ])).catch(() => {});
  };
  useEffect(loadArrivals, []);

  const plans = useMemo(() => {
    const all = data?.floor ?? [];
    const layout = data?.venue.layout ?? 'Standard';
    // Each area in the layout in use, or its standard one when it has no such layout.
    return [...new Set(all.map((p) => p.area))].map((a) => all.find((p) => p.area === a && p.layout === layout) ?? all.find((p) => p.area === a)!);
  }, [data]);
  const plan = plans.find((p) => p.area === area) ?? plans[0];
  const byTable = useMemo(() => new Map(checks.filter((c) => c.tableId && (c.status === 'open' || c.status === 'paid')).map((c) => [c.tableId!, c])), [checks]);
  const tabs = checks.filter((c) => c.kind !== 'table' && c.status === 'open');

  if (!data) return <div className="skeleton" style={{ height: '20rem' }} />;
  if (!data.on) return <div className="card"><p>{t('Table service is off. An owner turns on Restaurant or Bar under Settings.')}</p></div>;
  if (paying) return <div className="venue-paying">{counter}</div>;
  if (open) return <OrderScreen checkId={open} onBack={() => setOpen(null)} onPay={() => setPaying(true)} print={print} />;

  const mayOrder = data.me.orders;
  const reservedSoon = (tableId: string) => arrivals.find((a) => a.kind === 'reservation' && a.tableIds.includes(tableId) && new Date(a.at).getTime() - Date.now() < 90 * 60_000 && new Date(a.at).getTime() - Date.now() > -30 * 60_000);
  const openCheck = (payload: Record<string, unknown>): string | null => {
    const id = crypto.randomUUID();
    const done = dispatch(id, 'open', payload);
    if (!done.ok) { toast(t(done.reason ?? 'That cannot be done'), 'bad'); return null; }
    return id;
  };
  const quick = () => { const id = openCheck({ kind: 'quick' }); if (id) setOpen(id); };
  const stuck = tickets.filter((k) => !k.bumpedAt && (k.status === 'failed' || (k.status === 'queued' && Date.now() - new Date(k.createdAt).getTime() > 45_000)));

  return (
    <div className="venue-floor stack">
      <div className="row venue-bar">
        <div className="tabs" role="group" aria-label={t('Area')}>
          {plans.map((p) => <button key={p.id} type="button" aria-pressed={plan?.id === p.id} className={plan?.id === p.id ? 'active' : ''} onClick={() => setArea(p.area)}>{p.area}</button>)}
        </div>
        <span className="spacer" />
        <span className={`venue-sync ${online ? '' : 'off'}`} role="status">{online ? (pending ? t('Sending {n}…', { n: pending }) : t('In step')) : t('No connection: {n} to send', { n: pending })}</span>
        {(data.venue.bar || tabs.length > 0) && <button type="button" className="secondary" onClick={() => setPanel('tabs')}>{t('Tabs')}{tabs.length > 0 && <span className="chip">{tabs.length}</span>}</button>}
        {mayOrder && <button type="button" onClick={quick}>{t('Quick sale')}</button>}
      </div>
      {stuck.length > 0 && <div className="banner bad" role="alert"><div><strong>{stuck.length === 1 ? t('An order did not print.') : t('{n} orders did not print.', { n: stuck.length })}</strong> {t('Open the table to print it again or send it to another printer.')} {[...new Set(stuck.map((k) => k.body.table))].join(', ')}</div></div>}
      {problems.map((p) => <div key={p.id} className="banner warn" role="alert"><div>{p.reason}</div><button type="button" className="link" onClick={() => dismissProblem(p.id)}>{t('OK')}</button></div>)}

      {!plan ? (
        <div className="card empty">{t('No floor plan yet. Draw one under Settings → Venue, or use Tabs and Quick sale.')}</div>
      ) : (
        <div className="venue-plan" role="group" aria-label={t('Floor plan of {area}', { area: plan.area })}>
          {plan.items.map((item) => {
            const style = { left: `${item.x / 10}%`, top: `${item.y / 10}%`, width: `${item.w / 10}%`, height: `${item.h / 10}%`, transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined };
            if (item.type === 'wall' || item.type === 'fixture') return <div key={item.id} className={`venue-fixture ${item.type}`} style={style} aria-hidden="true">{item.type === 'fixture' && item.name}</div>;
            const c = byTable.get(item.id);
            const booked = !c ? reservedSoon(item.id) : undefined;
            const st: TableState = c ? tableState(c) : booked ? 'reserved' : 'free';
            const total = c ? wholeBill(c, billContext(data, c)).totalCents : 0;
            const mine = data.sections.find((s) => s.tableIds.includes(item.id));
            const label = `${item.name}: ${t(STATE_TEXT[st])}${c ? `, ${c.partySize}, ${c.server.name}` : ''}`;
            return (
              <button key={item.id} type="button" className={`venue-table ${item.shape} state-${st} ${c && hasReady(c) ? 'ready' : ''}`} style={style} aria-label={label}
                onClick={() => (c ? setOpen(c.id) : mayOrder || data.me.floor ? setSeating(item) : undefined)}>
                <strong>{item.name}</strong>
                {c ? (
                  <>
                    <span className="small">{c.partySize}p · {initials(c.server.name)} · {minutes(c.openedAt)}′</span>
                    <span className="small num">{total > 0 ? money(centsText(total)) : t(STATE_TEXT[st])}</span>
                    {total > 0 && <span className="venue-state">{t(STATE_TEXT[st])} · {minutes(c.lastActivityAt)}′</span>}
                    {hasReady(c) && <span className="venue-bell" aria-label={t('Food is ready')}>●</span>}
                  </>
                ) : (
                  <span className="small">{booked ? `${booked.name} · ${new Date(booked.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `${item.seats} ${t('seats')}${mine ? ` · ${initials(data.staff.find((s) => s.id === mine.userId)?.name ?? '')}` : ''}`}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="venue-legend small" aria-hidden="true">{(Object.keys(STATE_TEXT) as TableState[]).map((s) => <span key={s} className={`state-${s}`}>{t(STATE_TEXT[s])}</span>)}</div>

      {seating && (
        <SeatDialog table={seating} arrivals={arrivals} staff={data.staff.filter((s) => s.orders)} me={data.me.id} section={data.sections.find((s) => s.tableIds.includes(seating.id))?.userId}
          onClose={() => setSeating(null)}
          onWalkIn={(partySize, serverId) => {
            const server = data.staff.find((s) => s.id === serverId);
            const id = openCheck({ kind: 'table', tableId: seating.id, tableName: seating.name, partySize, ...(server && { server: { id: server.id, name: server.name } }) });
            setSeating(null);
            if (id && mayOrder) setOpen(id);
          }}
          onArrival={async (a, serverId) => {
            try {
              const r = await api<{ checkId: string }>(`/v1/venue/${a.kind === 'reservation' ? 'reservations' : 'waitlist'}/${a.id}/seat`, { method: 'POST', body: { tableId: seating.id, tableName: seating.name, ...(serverId && { serverId }) } });
              setSeating(null);
              loadArrivals();
              await poll();
              if (mayOrder) setOpen(r.checkId);
            } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
          }} />
      )}
      {panel === 'tabs' && (
        <TabsDialog tabs={tabs} hotel={data.venue.hotel} onClose={() => setPanel(null)} onOpen={(id) => { setPanel(null); setOpen(id); }}
          onNew={(name, room) => { const id = openCheck({ kind: 'tab', name, ...(room && { room }) }); if (id) { setPanel(null); setOpen(id); } }}
          total={(c) => wholeBill(c, billContext(data, c)).totalCents} />
      )}
    </div>
  );
}

function SeatDialog({ table, arrivals, staff, me, section, onClose, onWalkIn, onArrival }: {
  table: FloorItem; arrivals: Arrival[]; staff: Array<{ id: string; name: string }>; me: string; section?: string;
  onClose: () => void; onWalkIn: (partySize: number, serverId: string) => void; onArrival: (a: Arrival, serverId: string) => void | Promise<void>;
}) {
  const t = useT();
  const [party, setParty] = useState(Math.min(2, table.seats));
  // The table's section decides the server; else whoever is at the screen, if they serve.
  const [server, setServer] = useState(section ?? (staff.some((s) => s.id === me) ? me : staff[0]?.id ?? ''));
  return (
    <Modal title={t('Seat a party at {table}', { table: table.name })} onClose={onClose}>
      <div className="stack">
        <Field label={t('Guests')}>
          <div className="venue-seats light">{Array.from({ length: Math.max(table.seats, 8) }, (_, n) => <button key={n} type="button" aria-pressed={party === n + 1} onClick={() => setParty(n + 1)}>{n + 1}</button>)}</div>
        </Field>
        {staff.length > 1 && <Field label={t('Server')}><Select value={server} onChange={(e) => setServer(e.target.value)}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
        <button type="button" className="big" onClick={() => onWalkIn(party, server)}>{t('Open the table for {n}', { n: party })}</button>
        {arrivals.length > 0 && (
          <>
            <strong>{t('Or seat a party that booked or is waiting')}</strong>
            <ul className="plain venue-arrivals">
              {arrivals.map((a) => (
                <li key={a.id}><button type="button" className="secondary" onClick={() => void onArrival(a, server)}>
                  <strong>{a.name}</strong> · {a.partySize}p · {a.kind === 'reservation' ? new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : t('waiting {n} min', { n: minutes(a.at) })}
                  {a.allergy && <span className="badge pay-overdue">{t('Allergy')}</span>}
                </button></li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

function TabsDialog({ tabs, hotel, onClose, onOpen, onNew, total }: { tabs: NumberedCheck[]; hotel: boolean; onClose: () => void; onOpen: (id: string) => void; onNew: (name: string, room: string) => void; total: (c: NumberedCheck) => number }) {
  const t = useT();
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  return (
    <Modal title={t('Open tabs')} onClose={onClose} wide>
      <div className="stack">
        {tabs.length === 0 ? <p className="muted">{t('No tabs are open.')}</p> : (
          <ul className="plain venue-tabs">
            {[...tabs].sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1)).map((c) => (
              <li key={c.id}><button type="button" className="secondary" onClick={() => onOpen(c.id)}>
                <strong>{c.name ?? (c.kind === 'quick' ? t('Quick sale') : t('Tab'))}</strong>{c.room && <span className="small muted"> · {t('Room {room}', { room: c.room })}</span>}
                <span className="small muted">{c.server.name} · {t('open {n} min', { n: minutes(c.openedAt) })}</span>
                <span className={`num ${minutes(c.openedAt) > 240 ? 'late' : ''}`}>{money(centsText(total(c)))}</span>
              </button></li>
            ))}
          </ul>
        )}
        <form className="row venue-new-tab" onSubmit={(e) => { e.preventDefault(); onNew(name.trim() || (room.trim() ? `Room ${room.trim()}` : ''), room.trim()); }}>
          <Field label={t('New tab: a name, or a seat at the bar')} className="grow"><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('Maria, Bar 3…')} /></Field>
          {hotel && <Field label={t('Room')}><input value={room} maxLength={20} onChange={(e) => setRoom(e.target.value)} style={{ width: '6rem' }} /></Field>}
          <button disabled={!name.trim() && !room.trim()}>{t('Open the tab')}</button>
        </form>
      </div>
    </Modal>
  );
}
