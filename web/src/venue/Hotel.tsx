/** The hotel: the front desk, the availability calendar, a booking and its folio, housekeeping, the night audit, rooms and rates. */

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, money, Segmented, Select, usePageTitle } from '../ui';
import './venue.css';

interface Booking {
  id: string; number: string; status: 'booked' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show'; guest: { name: string; phone: string | null; email: string | null };
  roomType: { id: string; name: string }; room: { id: string; name: string } | null; arrival: string; departure: string; nights: number; adults: number; children: number; source: string;
  nightly: Array<{ date: string; rate: string }>; roomTotal: string; policy: string | null; groupName: string | null; notes: string | null;
}
interface Folio { id: string; name: string; balance: string; lines: Array<{ id: string; date: string; kind: string; description: string; amount: string; total: string; document: { id: string; number: string | null } | null }> }
type FullBooking = Booking & { folios: Folio[]; depositHeld: string; balance: string };
interface Room { id: string; name: string; roomType: { id: string; name: string }; status: 'clean' | 'dirty' | 'inspected' | 'out_of_order'; statusNote: string | null; occupied?: boolean; departs?: string; task?: { id: string; kind: string; userId: string | null; userName: string | null; doneAt: string | null } | null }
interface RoomType { id: string; name: string; capacity: number; rateCents: number; weekendRateCents: number | null; usd: boolean; minStay: number; features: string[]; seasons: Array<{ name: string; from: string; to: string; rateCents: number; weekendRateCents: number | null; minStay: number | null }> }
interface Audit { date: string; nextDate: string; roomsAvailable: number; roomsOccupied: number; outOfOrder: number; occupancyPercent: number; roomRevenue: string; hotelTax: string; adr: string; revpar: string; arrivals: number; departures: number; inHouse: number; guests: number; outletCharges: string; payments: string; flags: string[] }

const addDays = (s: string, n: number) => new Date(new Date(`${s}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const STATUS: Record<Booking['status'], string> = { booked: 'Booked', in_house: 'In house', checked_out: 'Checked out', cancelled: 'Cancelled', no_show: 'No-show' };
const ROOM_STATUS: Record<Room['status'], string> = { clean: 'Clean', dirty: 'Dirty', inspected: 'Inspected', out_of_order: 'Out of order' };
const METHODS: Array<[string, string]> = [['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['online', 'Mobile wallet'], ['cheque', 'Cheque']];

export function HotelPage() {
  const t = useT();
  usePageTitle(t('Hotel'));
  const { can } = useSession();
  const desk = can('hotel.frontdesk');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'desk' | 'calendar' | 'housekeeping' | 'audit' | 'setup' | null) ?? (desk ? 'desk' : 'housekeeping');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ arrival?: string; departure?: string; roomId?: string; roomTypeId?: string } | null>(null);
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Service')}</span><h1>{t('Hotel')}</h1></div>
        <span className="spacer" />
        {desk && <button type="button" onClick={() => setCreating({})}>{t('New booking')}</button>}
      </div>
      <Segmented switches label={t('Show')} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} options={[
        ...(desk ? [['desk', t('Front desk')] as ['desk', string], ['calendar', t('Calendar')] as ['calendar', string]] : []),
        ['housekeeping', t('Housekeeping')],
        ...(desk ? [['audit', t('Night audit')] as ['audit', string]] : []),
        ...(can('business.manage') ? [['setup', t('Rooms and rates')] as ['setup', string]] : []),
      ]} />
      {tab === 'desk' && desk && <FrontDesk key={version} onOpen={setOpen} />}
      {tab === 'calendar' && desk && <Calendar key={version} onOpen={setOpen} onCreate={setCreating} onChanged={changed} />}
      {tab === 'housekeeping' && <Housekeeping key={version} />}
      {tab === 'audit' && desk && <NightAudit onRun={changed} />}
      {tab === 'setup' && can('business.manage') && <RoomSetup />}
      {open && <BookingDialog id={open} onClose={() => { setOpen(null); changed(); }} />}
      {creating && <NewBooking initial={creating} onClose={() => setCreating(null)} onBooked={(id) => { setCreating(null); changed(); setOpen(id); }} />}
    </div>
  );
}

// ---------- the front desk ----------

function FrontDesk({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const [d, setD] = useState<{ today: string; arrivals: Booking[]; departures: Booking[]; inHouse: Booking[]; departed: Booking[]; rooms: Room[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api<NonNullable<typeof d>>('/v1/hotel/front-desk').then(setD).catch(setError), []);
  if (error) return <ErrorText error={error} />;
  if (!d) return <div className="skeleton" style={{ height: '14rem' }} />;
  const list = (title: string, rows: Booking[], empty: string, action: string) => (
    <section className="card stack">
      <h2>{title} <span className="muted small">{rows.length}</span></h2>
      {rows.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="plain venue-setup-list">
          {rows.map((b) => (
            <li key={b.id} className="row">
              <button type="button" className="link" onClick={() => onOpen(b.id)}><strong>{b.guest.name}</strong></button>
              <span className="small muted">{b.number} · {b.room ? t('Room {room}', { room: b.room.name }) : b.roomType.name} · {b.arrival} → {b.departure} · {b.adults + b.children}p</span>
              <span className="spacer" />
              <button type="button" className="secondary small-button" onClick={() => onOpen(b.id)}>{action}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  const free = d.rooms.filter((r) => !d.inHouse.some((b) => b.room?.id === r.id) && r.status !== 'out_of_order').length;
  return (
    <div className="stack">
      <div className="kpis">
        <div className="card kpi"><span className="kpi-head">{t('The hotel’s day')}</span><span className="kpi-value">{d.today}</span><span className="kpi-note">{t('Moves on with the night audit')}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('In house')}</span><span className="kpi-value">{d.inHouse.length}</span><span className="kpi-note">{t('{n} rooms free tonight', { n: free })}</span></div>
        <div className="card kpi"><span className="kpi-head">{t('Arriving')}</span><span className="kpi-value">{d.arrivals.length}</span><span className="kpi-note">{t('{n} leaving', { n: d.departures.length })}</span></div>
      </div>
      {list(t('Arrivals'), d.arrivals, t('Nobody is due to arrive.'), t('Check in'))}
      {list(t('Departures'), d.departures, t('Nobody is due to leave.'), t('Check out'))}
      {list(t('In house'), d.inHouse.filter((b) => !d.departures.includes(b)), t('No guests are staying.'), t('Open'))}
      {d.departed.length > 0 && list(t('Left today'), d.departed, '', t('Open'))}
    </div>
  );
}

// ---------- the calendar ----------

function Calendar({ onOpen, onCreate, onChanged }: { onOpen: (id: string) => void; onCreate: (c: { arrival: string; departure: string; roomId: string; roomTypeId: string }) => void; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [from, setFrom] = useState<string | null>(null);
  const [d, setD] = useState<{ from: string; to: string; today: string; rooms: Room[]; bookings: Booking[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const DAYS = 21;
  const drag = useRef<{ id: string; offset: number; edge: boolean } | null>(null);
  const sweep = useRef<{ roomId: string; day: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const start = from ?? addDays(new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10), -2);
      setD(await api<NonNullable<typeof d>>(`/v1/hotel/calendar?from=${start}&to=${addDays(start, DAYS)}`));
    } catch (e) { setError(e); }
  }, [from]);
  useEffect(() => void load(), [load]);
  if (!d) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '16rem' }} />;
  const days = Array.from({ length: DAYS }, (_, n) => addDays(d.from, n));
  const col = (date: string) => Math.round((new Date(`${date}T12:00:00Z`).getTime() - new Date(`${d.from}T12:00:00Z`).getTime()) / 86_400_000);
  const cols = `7rem repeat(${DAYS}, minmax(2.6rem, 1fr))`;
  // Dropped on another night or another room: the stay moves, keeping its length.
  const drop = async (room: Room, day: number) => {
    const g = drag.current;
    drag.current = null;
    const b = d.bookings.find((x) => x.id === g?.id);
    if (!b || !g) return;
    // Taken by its right edge: the last night moves to where it is dropped, in the room it has.
    if (g.edge) {
      const departure = addDays(d.from, day + 1);
      if (departure <= b.arrival || departure === b.departure) return;
      try {
        await api(`/v1/hotel/bookings/${b.id}`, { method: 'PUT', body: { departure } });
        toast(t('{name} now leaves on {date}', { name: b.guest.name, date: departure }));
        await load();
        onChanged();
      } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
      return;
    }
    const arrival = b.status === 'in_house' ? b.arrival : addDays(d.from, day - g.offset);
    try {
      await api(`/v1/hotel/bookings/${b.id}`, { method: 'PUT', body: { roomId: room.id, roomTypeId: room.roomType.id, arrival, departure: b.status === 'in_house' ? b.departure : addDays(arrival, b.nights) } });
      toast(t('{name} moved to room {room}', { name: b.guest.name, room: room.name }));
      await load();
      onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
  };
  const unassigned = d.bookings.filter((b) => !b.room && b.status === 'booked');
  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="secondary" onClick={() => setFrom(addDays(d.from, -7))}>← {t('Earlier')}</button>
        <button type="button" className="secondary" onClick={() => setFrom(null)}>{t('Today')}</button>
        <button type="button" className="secondary" onClick={() => setFrom(addDays(d.from, 7))}>{t('Later')} →</button>
        <span className="spacer" />
        <span className="small muted">{t('Drag across empty nights to book; drag a booking to move it; drag its right edge to make the stay longer or shorter.')}</span>
      </div>
      <ErrorText error={error} />
      <section className="timeline" aria-label={t('Rooms against dates')}>
        <div className="timeline-grid">
          <div className="timeline-row" style={{ gridTemplateColumns: cols }}>
            <span className="head">{t('Room')}</span>
            {days.map((day) => <span key={day} className={`timeline-head ${day === d.today ? 'today' : ''}`}>{day.slice(8)}<br />{new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' })}</span>)}
          </div>
          {d.rooms.map((room) => (
            <div key={room.id} className="timeline-row" style={{ gridTemplateColumns: cols }}>
              <span className="head">{room.name}<span className="small muted"> {room.roomType.name}</span>{room.status === 'out_of_order' && <span className="badge pay-overdue">{t('Out of order')}</span>}</span>
              {days.map((day, n) => (
                <button key={day} type="button" className="timeline-cell" style={{ gridColumn: n + 2, gridRow: 1 }} aria-label={t('Room {room}, {date}', { room: room.name, date: day })}
                  onPointerDown={() => { sweep.current = { roomId: room.id, day: n }; }}
                  onPointerUp={() => { const s = sweep.current; sweep.current = null; if (s && s.roomId === room.id && !drag.current) { const a = Math.min(s.day, n); const z = Math.max(s.day, n); onCreate({ roomId: room.id, roomTypeId: room.roomType.id, arrival: addDays(d.from, a), departure: addDays(d.from, z + 1) }); } }}
                  onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void drop(room, n); }} />
              ))}
              {d.bookings.filter((b) => b.room?.id === room.id).map((b) => {
                const start = Math.max(0, col(b.arrival));
                const end = Math.min(DAYS, col(b.departure));
                if (end <= 0 || start >= DAYS) return null;
                return (
                  <button key={b.id} type="button" draggable={b.status !== 'checked_out'} className={`timeline-bar ${b.status}`} style={{ gridColumn: `${start + 2} / ${end + 2}`, gridRow: 1 }} title={`${b.guest.name}, ${b.arrival} → ${b.departure}`}
                    onDragStart={(e) => { const box = (e.currentTarget as HTMLElement).getBoundingClientRect(); drag.current = { id: b.id, offset: Math.floor(((e.clientX - box.left) / box.width) * (end - start)), edge: col(b.departure) <= DAYS && box.right - e.clientX <= 14 }; }}
                    onDragEnd={() => { drag.current = null; }}
                    // Dropped on a stay (its own, to make it shorter): the night under the pointer.
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const box = e.currentTarget.getBoundingClientRect(); void drop(room, Math.min(end - 1, start + Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * (end - start))))); }}
                    onClick={() => onOpen(b.id)}>{b.guest.name}{b.status !== 'checked_out' && col(b.departure) <= DAYS && <span className="timeline-grip" aria-hidden="true" />}</button>
                );
              })}
            </div>
          ))}
        </div>
      </section>
      {unassigned.length > 0 && (
        <section className="card stack"><h2>{t('Booked, no room yet')}</h2><div className="venue-pick">{unassigned.map((b) => <button key={b.id} type="button" className="secondary" onClick={() => onOpen(b.id)}>{b.guest.name} · {b.roomType.name} · {b.arrival} → {b.departure}</button>)}</div></section>
      )}
    </div>
  );
}

// ---------- a new booking ----------

function NewBooking({ initial, onClose, onBooked }: { initial: { arrival?: string; departure?: string; roomId?: string; roomTypeId?: string }; onClose: () => void; onBooked: (id: string) => void }) {
  const t = useT();
  const today = new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ guestName: '', phone: '', email: '', arrival: initial.arrival ?? today, departure: initial.departure ?? addDays(initial.arrival ?? today, 1), roomTypeId: initial.roomTypeId ?? '', roomId: initial.roomId ?? '', adults: 2, children: 0, source: 'direct', policy: '', groupName: '', notes: '' });
  const [avail, setAvail] = useState<Array<{ roomType: { id: string; name: string; capacity: number }; free: Array<{ id: string; name: string; status: string }>; minStay: number; total: string; totalUsd: string; nightly: Array<{ date: string; rate: string }> }>>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (f.arrival >= f.departure) return;
    void api<{ data: typeof avail }>(`/v1/hotel/availability?arrival=${f.arrival}&departure=${f.departure}`).then((r) => { setAvail(r.data); setError(null); }).catch(setError);
  }, [f.arrival, f.departure]);
  const type = avail.find((a) => a.roomType.id === f.roomTypeId) ?? avail.find((a) => a.free.length > 0);
  const nights = Math.max(0, Math.round((new Date(f.departure).getTime() - new Date(f.arrival).getTime()) / 86_400_000));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!type) return;
    setBusy(true);
    setError(null);
    try {
      const b = await api<{ id: string }>('/v1/hotel/bookings', { method: 'POST', body: { guestName: f.guestName.trim(), ...(f.phone.trim() && { phone: f.phone.trim() }), ...(f.email.trim() && { email: f.email.trim() }), roomTypeId: type.roomType.id, ...(f.roomId && type.free.some((r) => r.id === f.roomId) && { roomId: f.roomId }), arrival: f.arrival, departure: f.departure, adults: f.adults, children: f.children, source: f.source, ...(f.policy.trim() && { policy: f.policy.trim() }), ...(f.groupName.trim() && { groupName: f.groupName.trim() }), ...(f.notes.trim() && { notes: f.notes.trim() }) } });
      onBooked(b.id);
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal title={t('New booking')} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <div className="form-grid">
          <Field label={t('Arrival')}><input type="date" required value={f.arrival} onChange={(e) => setF({ ...f, arrival: e.target.value, departure: e.target.value >= f.departure ? addDays(e.target.value, 1) : f.departure })} /></Field>
          <Field label={t('Departure')}><input type="date" required min={addDays(f.arrival, 1)} value={f.departure} onChange={(e) => setF({ ...f, departure: e.target.value })} /></Field>
          <Field label={t('Room type')}>
            <Select value={type?.roomType.id ?? ''} onChange={(e) => setF({ ...f, roomTypeId: e.target.value, roomId: '' })}>{avail.map((a) => <option key={a.roomType.id} value={a.roomType.id}>{a.roomType.name} · {a.free.length === 0 ? t('none free') : t('{n} free', { n: a.free.length })}</option>)}</Select>
          </Field>
          <Field label={t('Room')}><Select value={f.roomId} onChange={(e) => setF({ ...f, roomId: e.target.value })}><option value="">{t('Decide at check-in')}</option>{(type?.free ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        </div>
        {type && <div className="banner ok"><div><strong>{nights === 1 ? t('1 night') : t('{n} nights', { n: nights })}: {money(type.total)} · US${type.totalUsd}</strong> {t('before the hotel tax.')} {nights < type.minStay && <span className="late">{t('This room is sold for at least {n} nights.', { n: type.minStay })}</span>}</div></div>}
        <div className="form-grid">
          <Field label={t('Guest')}><input required maxLength={120} autoFocus value={f.guestName} onChange={(e) => setF({ ...f, guestName: e.target.value })} /></Field>
          <Field label={t('Phone')}><input type="tel" maxLength={40} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={t('Email')}><input type="email" maxLength={254} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t('Adults')}><input type="number" min={1} max={30} value={f.adults} onChange={(e) => setF({ ...f, adults: Number(e.target.value) })} /></Field>
          <Field label={t('Children')}><input type="number" min={0} max={30} value={f.children} onChange={(e) => setF({ ...f, children: Number(e.target.value) })} /></Field>
          <Field label={t('Booked through')}><Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="direct">{t('Direct')}</option><option value="phone">{t('Phone')}</option><option value="website">{t('Website')}</option><option value="agent">{t('Agent')}</option><option value="walk_in">{t('Walk-in')}</option></Select></Field>
          <Field label={t('Group')}><input maxLength={80} value={f.groupName} onChange={(e) => setF({ ...f, groupName: e.target.value })} /></Field>
          <Field label={t('Cancellation policy')}><input maxLength={500} value={f.policy} placeholder={t('Free until 7 days before…')} onChange={(e) => setF({ ...f, policy: e.target.value })} /></Field>
        </div>
        <Field label={t('Notes')}><input maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || !type || !f.guestName.trim() || nights < 1}>{busy ? t('Saving…') : t('Book')}</button></div>
      </form>
    </Modal>
  );
}

// ---------- a booking and its folio ----------

function BookingDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [b, setB] = useState<FullBooking | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState<Array<{ amount: string; method: string }>>([{ amount: '', method: 'cash' }]);
  const [extra, setExtra] = useState({ description: '', amount: '', folioId: '' });
  const [deposit, setDeposit] = useState({ amount: '', method: 'cash' });
  const load = useCallback(() => api<FullBooking>(`/v1/hotel/bookings/${id}`).then(setB).catch(setError), [id]);
  useEffect(() => { void load(); void api<{ data: Room[] }>('/v1/hotel/rooms').then((r) => setRooms(r.data)).catch(() => {}); }, [load]);
  const act = async (path: string, body: unknown, done: string, method: 'POST' | 'PUT' = 'POST'): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try { setB(await api<FullBooking>(path, { method, body: body ?? {} })); toast(done); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); }
  };
  if (!b) return <Modal title={t('Booking')} onClose={onClose}>{error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '10rem' }} />}</Modal>;
  const open = b.status === 'booked' || b.status === 'in_house';
  const payments = pay.filter((p) => /^\d+(\.\d{1,2})?$/.test(p.amount) && Number(p.amount) > 0);
  return (
    <Modal title={`${b.guest.name} · ${b.number}`} onClose={onClose} wide>
      <div className="stack">
        <div className="row">
          <span className={`badge ${b.status === 'in_house' ? 'pay-paid' : b.status === 'booked' ? 'pay-credit' : 'pay-unpaid'}`}>{t(STATUS[b.status])}</span>
          <span>{b.room ? t('Room {room}', { room: b.room.name }) : t('No room yet')} · {b.roomType.name}</span>
          <span className="muted">{b.arrival} → {b.departure} · {b.nights === 1 ? t('1 night') : t('{n} nights', { n: b.nights })} · {b.adults + b.children}p · {t(b.source)}</span>
          <span className="spacer" />
          <strong>{t('Owed')}: {money(b.balance)}</strong>
        </div>
        {(b.guest.phone || b.notes || b.policy || b.groupName) && <p className="small muted">{[b.guest.phone, b.guest.email, b.groupName, b.policy, b.notes].filter(Boolean).join(' · ')}</p>}
        <ErrorText error={error} />

        {open && (
          <div className="form-grid">
            <Field label={t('Room')}>
              <Select value={b.room?.id ?? ''} onChange={(e) => e.target.value && void act(`/v1/hotel/bookings/${b.id}`, { roomId: e.target.value }, t('Room changed'), 'PUT')}>
                {!b.room && <option value="">{t('Choose…')}</option>}
                {rooms.filter((r) => r.roomType.id === b.roomType.id || r.id === b.room?.id).map((r) => <option key={r.id} value={r.id}>{r.name} · {t(ROOM_STATUS[r.status])}</option>)}
              </Select>
            </Field>
            <Field label={t('Departure')}><input type="date" min={addDays(b.arrival, 1)} value={b.departure} onChange={(e) => e.target.value && void act(`/v1/hotel/bookings/${b.id}`, { departure: e.target.value }, t('Stay changed'), 'PUT')} /></Field>
          </div>
        )}

        {b.folios.map((f) => (
          <section key={f.id} className="venue-group stack">
            <div className="row"><strong>{t('Folio')}: {f.name}</strong><span className="spacer" /><span>{t('Owed')}: <strong>{money(f.balance)}</strong></span></div>
            {f.lines.length === 0 ? <p className="small muted">{t('Nothing on it yet. Room nights are added by the night audit.')}</p> : (
              <div className="table-wrap">
                <table className="responsive">
                  <thead><tr><th scope="col">{t('Date')}</th><th scope="col">{t('What')}</th><th scope="col" className="right">{t('With taxes')}</th><th scope="col">{t('Document')}</th>{b.folios.length > 1 && <th scope="col"><span className="sr-only">{t('Move')}</span></th>}</tr></thead>
                  <tbody>
                    {f.lines.map((l) => (
                      <tr key={l.id}>
                        <td data-label={t('Date')}>{l.date}</td>
                        <td data-label={t('What')}>{l.description}</td>
                        <td data-label={t('With taxes')} className="right num">{money(l.total)}</td>
                        <td data-label={t('Document')}>{l.document ? <Link to={`/documents/${l.document.id}`} className="mono small">{l.document.number ?? t('Open')}</Link> : <span className="small muted">{l.kind === 'room' || l.kind === 'extra' ? t('on the final bill') : ''}</span>}</td>
                        {b.folios.length > 1 && <td>{(l.kind === 'charge' || !l.document) && l.kind !== 'payment' && l.kind !== 'deposit' && open && <Select value={f.id} aria-label={t('Folio of this line')} onChange={(e) => void act(`/v1/hotel/folio-lines/${l.id}`, { folioId: e.target.value }, t('Moved'), 'PUT')}>{b.folios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
        {Number(b.depositHeld) > 0 && <p className="small">{t('Deposit held: {amount}. It is used at check-out.', { amount: money(b.depositHeld) })}</p>}

        {open && (
          <details className="venue-group">
            <summary>{t('Add to the bill, a deposit, or a second folio')}</summary>
            <div className="stack" style={{ marginTop: '0.75rem' }}>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void act(`/v1/hotel/bookings/${b.id}/extras`, { description: extra.description.trim(), amount: extra.amount, ...(extra.folioId && { folioId: extra.folioId }) }, t('Added to the bill')).then((ok) => ok && setExtra({ description: '', amount: '', folioId: '' })); }}>
                <Field label={t('Extra (laundry, a tour…)')} className="grow"><input maxLength={120} value={extra.description} onChange={(e) => setExtra({ ...extra, description: e.target.value })} /></Field>
                <Field label={t('Before GST (BZ$)')}><input inputMode="decimal" style={{ width: '7rem' }} value={extra.amount} onChange={(e) => setExtra({ ...extra, amount: e.target.value.trim() })} /></Field>
                {b.folios.length > 1 && <Field label={t('Folio')}><Select value={extra.folioId || b.folios[0]!.id} onChange={(e) => setExtra({ ...extra, folioId: e.target.value })}>{b.folios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>}
                <button className="secondary" disabled={busy || !extra.description.trim() || !/^\d+(\.\d{1,2})?$/.test(extra.amount)}>{t('Add')}</button>
              </form>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void act(`/v1/hotel/bookings/${b.id}/deposit`, deposit, t('Deposit taken. A tax receipt was issued for it.')).then((ok) => ok && setDeposit({ amount: '', method: 'cash' })); }}>
                <Field label={t('Deposit (BZ$)')}><input inputMode="decimal" style={{ width: '8rem' }} value={deposit.amount} onChange={(e) => setDeposit({ ...deposit, amount: e.target.value.trim() })} /></Field>
                <Field label={t('Paid by')}><Select value={deposit.method} onChange={(e) => setDeposit({ ...deposit, method: e.target.value })}>{METHODS.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field>
                <button className="secondary" disabled={busy || !/^\d+(\.\d{1,2})?$/.test(deposit.amount)}>{t('Take the deposit')}</button>
              </form>
              {b.folios.length < 4 && <div><button type="button" className="secondary" disabled={busy} onClick={() => void act(`/v1/hotel/bookings/${b.id}/folios`, { name: b.folios.length === 1 ? 'Extras' : `Folio ${b.folios.length + 1}` }, t('Folio added. Charges from the restaurant and bar go to Extras.'))}>{t('Split: a second folio for the extras')}</button></div>}
            </div>
          </details>
        )}

        {b.status === 'in_house' && (
          <section className="venue-group stack">
            <strong>{t('Payment')}</strong>
            {pay.map((p, n) => (
              <div key={n} className="row">
                <Field label={t('Amount (BZ$)')}><input inputMode="decimal" style={{ width: '8rem' }} value={p.amount} onChange={(e) => setPay(pay.map((x, i) => (i === n ? { ...x, amount: e.target.value.trim() } : x)))} /></Field>
                <Field label={t('Paid by')}><Select value={p.method} onChange={(e) => setPay(pay.map((x, i) => (i === n ? { ...x, method: e.target.value } : x)))}>{METHODS.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field>
                {pay.length > 1 && <button type="button" className="link" onClick={() => setPay(pay.filter((_, i) => i !== n))}>{t('Remove')}</button>}
              </div>
            ))}
            <div className="row">
              <button type="button" className="link" onClick={() => setPay([...pay, { amount: '', method: 'card' }])}>+ {t('Another way of paying')}</button>
              <span className="spacer" />
              <button type="button" className="secondary" disabled={busy || !payments.length} onClick={() => void act(`/v1/hotel/bookings/${b.id}/payments`, { payments }, t('Payment recorded')).then((ok) => ok && setPay([{ amount: '', method: 'cash' }]))}>{t('Take a payment now')}</button>
              <button type="button" disabled={busy} onClick={() => void act(`/v1/hotel/bookings/${b.id}/check-out`, { payments }, t('Checked out. The room is on the housekeeper’s list.')).then((ok) => ok && setPay([{ amount: '', method: 'cash' }]))}>{t('Check out')}</button>
            </div>
            <p className="small muted">{t('Check-out puts the nights and extras on a tax invoice, uses the deposit, and takes these payments. The whole balance has to be paid, or left on the guest’s account:')} <button type="button" className="link" disabled={busy} onClick={async () => { if (await confirm({ title: t('Check out with BZ${amount} still owed?', { amount: b.balance }), body: t('The invoices stay open under Getting paid.'), confirm: t('Check out on account') })) void act(`/v1/hotel/bookings/${b.id}/check-out`, { payments, leaveBalance: true }, t('Checked out on account')); }}>{t('check out on account')}</button></p>
          </section>
        )}

        {b.status === 'booked' && (
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void act(`/v1/hotel/bookings/${b.id}/check-in`, {}, t('Checked in'))}>{t('Check in')}</button>
            <button type="button" className="link" disabled={busy} onClick={() => void act(`/v1/hotel/bookings/${b.id}/check-in`, { force: true }, t('Checked in'))}>{t('Check in anyway (early, or the room is not cleaned)')}</button>
            <span className="spacer" />
            <button type="button" className="link" disabled={busy} onClick={async () => { if (await confirm({ title: t('Mark {name} a no-show?', { name: b.guest.name }), body: t('The room is released. A deposit is kept.'), confirm: t('No-show'), danger: true })) void act(`/v1/hotel/bookings/${b.id}/no-show`, {}, t('Marked a no-show')); }}>{t('No-show')}</button>
            <button type="button" className="link danger-link" disabled={busy} onClick={async () => { if (await confirm({ title: t('Cancel this booking?'), body: Number(b.depositHeld) > 0 ? t('The deposit of {amount} is given back with a credit note.', { amount: money(b.depositHeld) }) : t('The room is released.'), confirm: t('Cancel the booking'), cancel: t('Keep it'), danger: true })) void act(`/v1/hotel/bookings/${b.id}/cancel`, { refundDeposit: true }, t('Booking cancelled')); }}>{t('Cancel the booking')}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- housekeeping ----------

function Housekeeping() {
  const t = useT();
  const { can } = useSession();
  const desk = can('hotel.frontdesk');
  const [d, setD] = useState<{ today: string; rooms: Room[]; housekeepers: Array<{ id: string; name: string }> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<NonNullable<typeof d>>('/v1/hotel/housekeeping').then(setD).catch(setError), []);
  // The desk sees it live: every few seconds while the screen is open.
  useEffect(() => { void load(); const id = setInterval(() => document.visibilityState !== 'hidden' && void load(), 5000); return () => clearInterval(id); }, [load]);
  const set = (room: Room, status: Room['status']) => void api(`/v1/hotel/rooms/${room.id}/status`, { method: 'POST', body: { status } }).then(load).catch(setError);
  if (!d) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '12rem' }} />;
  return (
    <div className="stack">
      <ErrorText error={error} />
      <div className="venue-legend small">{(Object.keys(ROOM_STATUS) as Room['status'][]).map((s) => <span key={s} className={`room-tile ${s}`} style={{ minHeight: 0, padding: '0.1rem 0.6rem' }}>{t(ROOM_STATUS[s])}: {d.rooms.filter((r) => r.status === s).length}</span>)}</div>
      <div className="room-grid">
        {d.rooms.map((r) => (
          <div key={r.id} className={`room-tile ${r.status}`}>
            <strong>{t('Room {room}', { room: r.name })}</strong>
            <span className="small">{t(ROOM_STATUS[r.status])}{r.occupied ? ` · ${t('guest in')}${r.departs === d.today ? `, ${t('leaves today')}` : ''}` : ''}</span>
            {r.task && <span className="small muted">{t(r.task.kind === 'departure' ? 'Clean after departure' : r.task.kind === 'stayover' ? 'Stay-over clean' : 'Deep clean')}{r.task.userName ? ` · ${r.task.userName}` : ''}{r.task.doneAt ? ' ✓' : ''}</span>}
            <div className="row" style={{ flexWrap: 'wrap', gap: '0.3rem' }}>
              {r.status !== 'clean' && r.status !== 'inspected' && r.status !== 'out_of_order' && <button type="button" className="small-button" onClick={() => set(r, 'clean')}>{t('Cleaned')}</button>}
              {r.status === 'clean' && desk && <button type="button" className="small-button secondary" onClick={() => set(r, 'inspected')}>{t('Inspected')}</button>}
              {(r.status === 'clean' || r.status === 'inspected') && <button type="button" className="link small" onClick={() => set(r, 'dirty')}>{t('Dirty')}</button>}
              {desk && r.status !== 'out_of_order' && <button type="button" className="link small" onClick={() => set(r, 'out_of_order')}>{t('Out of order')}</button>}
              {desk && r.status === 'out_of_order' && <button type="button" className="small-button secondary" onClick={() => set(r, 'dirty')}>{t('Back in use')}</button>}
            </div>
            {desk && r.task && d.housekeepers.length > 0 && (
              <Select value={r.task.userId ?? ''} aria-label={t('Housekeeper for room {room}', { room: r.name })} onChange={(e) => void api(`/v1/hotel/tasks/${r.task!.id}`, { method: 'PUT', body: { userId: e.target.value || null } }).then(load).catch(setError)}>
                <option value="">{t('Anyone')}</option>{d.housekeepers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </Select>
            )}
          </div>
        ))}
      </div>
      {d.rooms.length === 0 && <div className="card empty">{t('No rooms to show.')}</div>}
    </div>
  );
}

// ---------- the night audit ----------

function NightAudit({ onRun }: { onRun: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState<{ today: string; data: Audit[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<NonNullable<typeof d>>('/v1/hotel/audits').then(setD).catch(setError), []);
  useEffect(() => void load(), [load]);
  const run = async () => {
    if (!d || !(await confirm({ title: t('Run the night audit for {date}?', { date: d.today }), body: t('It charges tonight’s room to every guest in house, lists what needs a look, sets up tomorrow’s cleaning, and moves the hotel on to the next day. It runs once.'), confirm: t('Run the night audit') }))) return;
    setBusy(true);
    setError(null);
    try { const r = await api<Audit>('/v1/hotel/night-audit', { method: 'POST', body: {} }); toast(t('Night audit done: {n}% occupied, {amount} in rooms.', { n: r.occupancyPercent, amount: money(r.roomRevenue) })); await load(); onRun(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (!d) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '10rem' }} />;
  const last = d.data[0];
  return (
    <div className="stack">
      <section className="card row">
        <div><span className="kicker">{t('The hotel’s day')}</span><div className="stock-big">{d.today}</div></div>
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => void run()}>{busy ? t('Running…') : t('Run the night audit')}</button>
      </section>
      <ErrorText error={error} />
      {last && (
        <section className="card stack">
          <h2>{t('Manager’s report for {date}', { date: last.date })}</h2>
          <div className="kpis">
            <div className="card kpi"><span className="kpi-head">{t('Occupancy')}</span><span className="kpi-value">{last.occupancyPercent}%</span><span className="kpi-note">{t('{a} of {b} rooms', { a: last.roomsOccupied, b: last.roomsAvailable })}</span></div>
            <div className="card kpi"><span className="kpi-head">{t('Average daily rate')}</span><span className="kpi-value">{money(last.adr)}</span><span className="kpi-note">{t('Room revenue {amount}', { amount: money(last.roomRevenue) })}</span></div>
            <div className="card kpi"><span className="kpi-head">{t('Revenue per available room')}</span><span className="kpi-value">{money(last.revpar)}</span><span className="kpi-note">{t('Hotel tax {amount}', { amount: money(last.hotelTax) })}</span></div>
            <div className="card kpi"><span className="kpi-head">{t('Arrivals and departures')}</span><span className="kpi-value">{last.arrivals} / {last.departures}</span><span className="kpi-note">{t('{n} guests in house', { n: last.guests })}</span></div>
          </div>
          <p className="small">{t('Charged to rooms from the restaurant and bar: {a}. Payments taken: {b}.', { a: money(last.outletCharges), b: money(last.payments) })}</p>
          {last.flags.length > 0 ? <div className="banner warn"><div><strong>{t('To look at')}</strong><ul className="plain small">{last.flags.map((f) => <li key={f}>{f}</li>)}</ul></div></div> : <p className="small muted">{t('Nothing out of place.')}</p>}
        </section>
      )}
      {d.data.length > 1 && (
        <section className="card"><div className="table-wrap"><table className="responsive">
          <thead><tr><th scope="col">{t('Date')}</th><th scope="col" className="right">{t('Occupancy')}</th><th scope="col" className="right">{t('Room revenue')}</th><th scope="col" className="right">ADR</th><th scope="col" className="right">RevPAR</th><th scope="col" className="right">{t('In / out')}</th></tr></thead>
          <tbody>{d.data.map((a) => <tr key={a.date}><td data-label={t('Date')}>{a.date}</td><td data-label={t('Occupancy')} className="right">{a.occupancyPercent}%</td><td data-label={t('Room revenue')} className="right">{money(a.roomRevenue)}</td><td data-label="ADR" className="right">{money(a.adr)}</td><td data-label="RevPAR" className="right">{money(a.revpar)}</td><td data-label={t('In / out')} className="right">{a.arrivals} / {a.departures}</td></tr>)}</tbody>
        </table></div></section>
      )}
    </div>
  );
}

// ---------- rooms and rates ----------

function RoomSetup() {
  const t = useT();
  const toast = useToast();
  const [types, setTypes] = useState<RoomType[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editing, setEditing] = useState<(Partial<RoomType> & { rate: string; weekend: string }) | null>(null);
  const [room, setRoom] = useState({ name: '', roomTypeId: '' });
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => { void api<{ data: RoomType[] }>('/v1/hotel/room-types').then((r) => setTypes(r.data)).catch(setError); void api<{ data: Room[] }>('/v1/hotel/rooms').then((r) => setRooms(r.data)).catch(setError); }, []);
  useEffect(load, [load]);
  const c = (s: string) => Math.round(Number(s) * 100);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      const body = { name: editing.name!.trim(), capacity: editing.capacity ?? 2, rateCents: c(editing.rate), weekendRateCents: editing.weekend ? c(editing.weekend) : null, usd: editing.usd ?? false, minStay: editing.minStay ?? 1, features: editing.features ?? [], seasons: (editing.seasons ?? []).filter((s) => s.name.trim() && s.from && s.to) };
      await api(editing.id ? `/v1/hotel/room-types/${editing.id}` : '/v1/hotel/room-types', { method: editing.id ? 'PUT' : 'POST', body });
      toast(t('Saved'));
      setEditing(null);
      load();
    } catch (err) { setError(err); }
  };
  const season = (n: number, p: Partial<RoomType['seasons'][number]>) => setEditing((e) => (e ? { ...e, seasons: (e.seasons ?? []).map((s, i) => (i === n ? { ...s, ...p } : s)) } : e));
  return (
    <div className="stack">
      <ErrorText error={error} />
      <section className="card stack">
        <div><h2>{t('Room types and rates')}</h2><p className="small muted">{t('A rate per night for each type, before the hotel tax, in Belize or US dollars; another for Friday and Saturday nights if you like; seasons with their own rates and minimum stays.')}</p></div>
        <ul className="plain venue-setup-list">
          {types.map((x) => (
            <li key={x.id} className="row">
              <strong>{x.name}</strong>
              <span className="small muted">{x.usd ? 'US$' : 'BZ$'}{(x.rateCents / 100).toFixed(2)}{x.weekendRateCents !== null ? ` · ${t('weekends')} ${(x.weekendRateCents / 100).toFixed(2)}` : ''} · {t('sleeps {n}', { n: x.capacity })} · {t('{n} rooms', { n: rooms.filter((r) => r.roomType.id === x.id).length })}{x.seasons.length > 0 && ` · ${x.seasons.map((s) => s.name).join(', ')}`}</span>
              <span className="spacer" />
              <button type="button" className="link" onClick={() => setEditing({ ...x, rate: (x.rateCents / 100).toFixed(2), weekend: x.weekendRateCents === null ? '' : (x.weekendRateCents / 100).toFixed(2) })}>{t('Edit')}</button>
            </li>
          ))}
        </ul>
        {!editing && <div><button type="button" className="secondary" onClick={() => setEditing({ name: '', capacity: 2, rate: '', weekend: '', usd: false, minStay: 1, seasons: [] })}>+ {t('A room type')}</button></div>}
        {editing && (
          <form className="stack venue-group" onSubmit={(e) => void save(e)}>
            <div className="form-grid">
              <Field label={t('Name')}><input required maxLength={60} value={editing.name ?? ''} placeholder={t('Garden room, Sea-view suite…')} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label={t('Sleeps')}><input type="number" min={1} max={30} value={editing.capacity ?? 2} onChange={(e) => setEditing({ ...editing, capacity: Number(e.target.value) })} /></Field>
              <Field label={t('Rate per night')}><input inputMode="decimal" required value={editing.rate} onChange={(e) => setEditing({ ...editing, rate: e.target.value.trim() })} /></Field>
              <Field label={t('Friday and Saturday nights')} hint={t('Empty: the same.')}><input inputMode="decimal" value={editing.weekend} onChange={(e) => setEditing({ ...editing, weekend: e.target.value.trim() })} /></Field>
              <Field label={t('Quoted in')}><Select value={editing.usd ? 'usd' : 'bzd'} onChange={(e) => setEditing({ ...editing, usd: e.target.value === 'usd' })}><option value="bzd">{t('Belize dollars')}</option><option value="usd">{t('US dollars (billed in BZ$ at your rate)')}</option></Select></Field>
              <Field label={t('Minimum stay (nights)')}><input type="number" min={1} max={60} value={editing.minStay ?? 1} onChange={(e) => setEditing({ ...editing, minStay: Number(e.target.value) })} /></Field>
            </div>
            <strong>{t('Seasons')}</strong>
            {(editing.seasons ?? []).map((s, n) => (
              <div key={n} className="row" style={{ flexWrap: 'wrap' }}>
                <Field label={t('Season')}><input maxLength={60} value={s.name} onChange={(e) => season(n, { name: e.target.value })} /></Field>
                <Field label={t('From')}><input type="date" value={s.from} onChange={(e) => season(n, { from: e.target.value })} /></Field>
                <Field label={t('To')}><input type="date" value={s.to} onChange={(e) => season(n, { to: e.target.value })} /></Field>
                <Field label={t('Rate')}><input inputMode="decimal" style={{ width: '7rem' }} defaultValue={(s.rateCents / 100).toFixed(2)} onBlur={(e) => season(n, { rateCents: c(e.target.value) })} /></Field>
                <Field label={t('Min. stay')}><input type="number" min={1} max={60} style={{ width: '5rem' }} value={s.minStay ?? ''} onChange={(e) => season(n, { minStay: e.target.value ? Number(e.target.value) : null })} /></Field>
                <button type="button" className="link" onClick={() => setEditing({ ...editing, seasons: (editing.seasons ?? []).filter((_, i) => i !== n) })}>{t('Remove')}</button>
              </div>
            ))}
            <div><button type="button" className="secondary small-button" onClick={() => setEditing({ ...editing, seasons: [...(editing.seasons ?? []), { name: '', from: '', to: '', rateCents: c(editing.rate) || 0, weekendRateCents: null, minStay: null }] })}>+ {t('A season')}</button></div>
            <div className="row"><button type="button" className="secondary" onClick={() => setEditing(null)}>{t('Cancel')}</button><span className="spacer" /><button disabled={!editing.name?.trim() || !/^\d+(\.\d{1,2})?$/.test(editing.rate)}>{t('Save')}</button></div>
          </form>
        )}
      </section>
      <section className="card stack">
        <h2>{t('Rooms')}</h2>
        <div className="venue-pick">{rooms.map((r) => <span key={r.id} className={`room-tile ${r.status}`} style={{ minHeight: 0 }}><strong>{r.name}</strong><span className="small muted">{r.roomType.name}</span><button type="button" className="link danger-link small" onClick={() => void api(`/v1/hotel/rooms/${r.id}`, { method: 'DELETE' }).then(load).catch(setError)}>{t('Remove')}</button></span>)}</div>
        {types.length > 0 && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void api('/v1/hotel/rooms', { method: 'POST', body: { name: room.name.trim(), roomTypeId: room.roomTypeId || types[0]!.id } }).then(() => { setRoom({ ...room, name: '' }); load(); }).catch(setError); }}>
            <Field label={t('Room number or name')}><input required maxLength={20} value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} /></Field>
            <Field label={t('Room type')}><Select value={room.roomTypeId || types[0]!.id} onChange={(e) => setRoom({ ...room, roomTypeId: e.target.value })}>{types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <button className="secondary" disabled={!room.name.trim()}>{t('Add the room')}</button>
          </form>
        )}
      </section>
    </div>
  );
}
