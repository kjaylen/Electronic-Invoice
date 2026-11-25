/** The host stand: the day's reservations on a timeline of tables, the waitlist, guest records, and which server has which tables. */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useConfirm } from '../confirm';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, Field, Modal, Select, usePageTitle } from '../ui';
import type { VenueData } from './store';
import './venue.css';

interface Reservation { id: string; guestId: string | null; name: string; phone: string | null; email: string | null; partySize: number; startsAt: string; endsAt: string; durationMin: number; tableIds: string[]; status: 'booked' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show'; occasion: string | null; allergy: string | null; notes: string | null; deposit: { amount: string; status: string } | null }
interface Waiting { id: string; name: string; phone: string | null; partySize: number; quotedMin: number; notes: string | null; status: string; waitedMin: number }
interface Guest { id: string; name: string; phone: string | null; email: string | null; allergies: string | null; preferences: string | null; notes: string | null; visits: number; noShows: number; lastVisit: string | null }

const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** Half-hour slots shown on the timeline: 7 am to 1 am. */
const FIRST_HOUR = 7;
const SLOTS = 36;
const slotOf = (iso: string, date: string) => Math.round((new Date(iso).getTime() - new Date(`${date}T${String(FIRST_HOUR + 6).padStart(2, '0')}:00:00.000Z`).getTime()) / 1_800_000);
const STATUS: Record<Reservation['status'], string> = { booked: 'Booked', confirmed: 'Confirmed', seated: 'Seated', completed: 'Finished', cancelled: 'Cancelled', no_show: 'No-show' };

export function HostPage() {
  const t = useT();
  usePageTitle(t('Reservations'));
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useSession();
  const [date, setDate] = useState(belizeToday());
  const [day, setDay] = useState<{ reservations: Reservation[]; waitlist: Waiting[] } | null>(null);
  const [venue, setVenue] = useState<VenueData | null>(null);
  const [editing, setEditing] = useState<Partial<Reservation> & { time?: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; whatsapp?: string; sms?: string; phone?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<{ reservations: Reservation[]; waitlist: Waiting[] }>(`/v1/venue/reservations?date=${date}`).then(setDay).catch(setError), [date]);
  useEffect(() => { setDay(null); void load(); }, [load]);
  useEffect(() => void api<VenueData>('/v1/venue').then(setVenue).catch(setError), []);
  const tables = useMemo(() => {
    const plans = venue?.floor ?? [];
    const layout = venue?.venue.layout ?? 'Standard';
    return [...new Set(plans.map((p) => p.area))].flatMap((a) => (plans.find((p) => p.area === a && p.layout === layout) ?? plans.find((p) => p.area === a)!).items.filter((i) => i.type === 'table' || i.type === 'stool').map((i) => ({ id: i.id, name: i.name, seats: i.seats, area: a })));
  }, [venue]);
  const act = async (fn: () => Promise<unknown>, done?: string) => { setError(null); try { await fn(); if (done) toast(done); await load(); } catch (e) { setError(e); } };
  const live = (day?.reservations ?? []).filter((r) => r.status !== 'cancelled');

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Service')}</span><h1>{t('Reservations')}</h1></div>
        <span className="spacer" />
        <Field label={t('Day')}><input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        {can('venue.floor') && <button type="button" onClick={() => setEditing({ partySize: 2, time: '19:00', tableIds: [] })}>{t('New booking')}</button>}
      </div>
      <ErrorText error={error} />

      <section className="timeline" aria-label={t('Tables against time')}>
        <div className="timeline-grid">
          <div className="timeline-row" style={{ gridTemplateColumns: `8rem repeat(${SLOTS}, minmax(1.6rem, 1fr))` }}>
            <span className="head">{t('Table')}</span>
            {Array.from({ length: SLOTS }, (_, n) => <span key={n} className="timeline-head">{n % 2 === 0 ? `${(FIRST_HOUR + n / 2) % 24}` : ''}</span>)}
          </div>
          {[{ id: '', name: t('No table yet'), seats: 0, area: '' }, ...tables].map((table) => {
            const mine = live.filter((r) => (table.id ? r.tableIds.includes(table.id) : r.tableIds.length === 0));
            if (!table.id && !mine.length) return null;
            return (
              <div key={table.id || 'none'} className="timeline-row" style={{ gridTemplateColumns: `8rem repeat(${SLOTS}, minmax(1.6rem, 1fr))` }}>
                <span className="head">{table.name}{table.seats > 0 && <span className="small muted"> · {table.seats}</span>}</span>
                {mine.map((r) => {
                  const start = Math.max(0, slotOf(r.startsAt, date));
                  const span = Math.max(1, Math.round(r.durationMin / 30));
                  return <button key={r.id} type="button" className={`timeline-bar ${r.status}`} style={{ gridColumn: `${start + 2} / span ${Math.min(span, SLOTS - start)}`, gridRow: 1 }} onClick={() => setEditing({ ...r, time: new Date(new Date(r.startsAt).getTime() - 6 * 3600_000).toISOString().slice(11, 16) })} title={`${r.name}, ${r.partySize}, ${timeOf(r.startsAt)}`}>{r.name} · {r.partySize}{r.allergy ? ' ⚠' : ''}</button>;
                })}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card stack">
        <h2>{t('The day’s bookings')}</h2>
        {!day ? <div className="skeleton" style={{ height: '6rem' }} /> : day.reservations.length === 0 ? <div className="empty">{t('No bookings for this day.')}</div> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Time')}</th><th scope="col">{t('Name')}</th><th scope="col" className="right">{t('Guests')}</th><th scope="col">{t('Table')}</th><th scope="col">{t('Notes')}</th><th scope="col">{t('Status')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {day.reservations.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('Time')}>{timeOf(r.startsAt)}</td>
                    <td data-label={t('Name')}><strong>{r.name}</strong>{r.phone && <div className="small muted">{r.phone}</div>}</td>
                    <td data-label={t('Guests')} className="right">{r.partySize}</td>
                    <td data-label={t('Table')}>{r.tableIds.map((id) => tables.find((x) => x.id === id)?.name ?? id).join(', ') || '—'}</td>
                    <td data-label={t('Notes')} className="small">{[r.occasion, r.allergy && `${t('Allergy')}: ${r.allergy}`, r.notes, r.deposit && `${t('Deposit')} BZ$${r.deposit.amount} (${t(r.deposit.status)})`].filter(Boolean).join(' · ')}</td>
                    <td data-label={t('Status')}><span className={`badge ${r.status === 'no_show' || r.status === 'cancelled' ? 'pay-overdue' : r.status === 'seated' || r.status === 'confirmed' ? 'pay-paid' : 'pay-credit'}`}>{t(STATUS[r.status])}</span></td>
                    <td className="right">
                      {(r.status === 'booked' || r.status === 'confirmed') && can('venue.floor') && (
                        <span className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {r.status === 'booked' && <button type="button" className="link small" onClick={() => void act(() => api(`/v1/venue/reservations/${r.id}`, { method: 'PUT', body: { status: 'confirmed' } }), t('Confirmed'))}>{t('Confirm')}</button>}
                          {r.phone && <button type="button" className="link small" onClick={() => void api<{ text: string; whatsapp: string; sms: string; phone: string }>(`/v1/venue/reservations/${r.id}/message`, { method: 'POST', body: {} }).then(setMessage).catch(setError)}>{t('Message')}</button>}
                          {!r.deposit && can('documents.issue') && <button type="button" className="link small" onClick={() => setEditing({ ...r, time: 'deposit' })}>{t('Deposit')}</button>}
                          <button type="button" className="link small" onClick={async () => { if (await confirm({ title: t('Mark {name} a no-show?', { name: r.name }), body: t('Their table is given up. A deposit is kept.'), confirm: t('No-show'), danger: true })) void act(() => api(`/v1/venue/reservations/${r.id}/no-show`, { method: 'POST', body: {} })); }}>{t('No-show')}</button>
                          <button type="button" className="link danger-link small" onClick={async () => { if (await confirm({ title: t('Cancel the booking for {name}?', { name: r.name }), body: r.deposit ? t('Their deposit of BZ${amount} is given back with a credit note.', { amount: r.deposit.amount }) : t('Their table is given up.'), confirm: t('Cancel the booking'), cancel: t('Keep it'), danger: true })) void act(() => api(`/v1/venue/reservations/${r.id}/cancel`, { method: 'POST', body: { refundDeposit: true } })); }}>{t('Cancel')}</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">{t('A party is seated from the Floor: tap its table, then its name.')}</p>
      </section>

      <WaitlistCard list={day?.waitlist ?? []} onChange={load} onMessage={setMessage} />
      {venue && can('venue.floor') && <SectionsCard venue={venue} tables={tables} />}
      <GuestsCard />

      {editing && editing.time !== 'deposit' && <BookingDialog initial={editing} date={date} tables={tables} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {editing?.time === 'deposit' && <DepositDialog reservation={editing as Reservation} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {message && (
        <Modal title={t('A message for the guest')} onClose={() => setMessage(null)}>
          <div className="stack">
            <div className="whatsapp-message">{message.text}</div>
            <p className="small muted">{t('It opens in WhatsApp or your messages with the text written; you press send.')}</p>
            <div className="row"><span className="small muted">{message.phone}</span><span className="spacer" />{message.sms && <a className="button secondary" href={message.sms}>{t('Text message')}</a>}{message.whatsapp && <a className="button" href={message.whatsapp} target="_blank" rel="noreferrer noopener">{t('Open WhatsApp')}</a>}</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function BookingDialog({ initial, date, tables, onClose, onSaved }: { initial: Partial<Reservation> & { time?: string }; date: string; tables: Array<{ id: string; name: string; seats: number; area: string }>; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [f, setF] = useState({ name: initial.name ?? '', phone: initial.phone ?? '', email: initial.email ?? '', partySize: initial.partySize ?? 2, time: initial.time ?? '19:00', tableIds: initial.tableIds ?? [], occasion: initial.occasion ?? '', allergy: initial.allergy ?? '', notes: initial.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const locked = Boolean(initial.id) && initial.status !== 'booked' && initial.status !== 'confirmed';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The time typed is Belize time (UTC-6, all year).
      const startsAt = new Date(new Date(`${date}T${f.time}:00.000Z`).getTime() + 6 * 3600_000).toISOString();
      const body = { name: f.name.trim(), ...(f.phone.trim() && { phone: f.phone.trim() }), ...(f.email.trim() && { email: f.email.trim() }), partySize: f.partySize, startsAt, tableIds: f.tableIds, ...(f.occasion.trim() && { occasion: f.occasion.trim() }), ...(f.allergy.trim() && { allergy: f.allergy.trim() }), ...(f.notes.trim() && { notes: f.notes.trim() }) };
      const r = await api<{ confirmationEmailed?: boolean }>(initial.id ? `/v1/venue/reservations/${initial.id}` : '/v1/venue/reservations', { method: initial.id ? 'PUT' : 'POST', body });
      toast(r.confirmationEmailed ? t('Booked. A confirmation was emailed.') : t('Booked'));
      onSaved();
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal title={initial.id ? t('Booking for {name}', { name: initial.name ?? '' }) : t('New booking')} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <div className="form-grid">
          <Field label={t('Name')}><input required maxLength={120} autoFocus value={f.name} disabled={locked} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t('Phone')}><input type="tel" maxLength={40} value={f.phone} disabled={locked} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={t('Email')} hint={t('For the confirmation and a reminder the day before.')}><input type="email" maxLength={254} value={f.email} disabled={locked} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t('Guests')}><input type="number" min={1} max={200} required value={f.partySize} disabled={locked} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} /></Field>
          <Field label={t('Time')}><input type="time" required value={f.time} disabled={locked} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
          <Field label={t('Occasion')}><input maxLength={80} value={f.occasion} disabled={locked} placeholder={t('Birthday, anniversary…')} onChange={(e) => setF({ ...f, occasion: e.target.value })} /></Field>
        </div>
        <Field label={t('Allergy')} hint={t('Goes with the party to the server and onto every kitchen ticket.')}><input maxLength={200} value={f.allergy} disabled={locked} onChange={(e) => setF({ ...f, allergy: e.target.value })} /></Field>
        <Field label={t('Notes')}><input maxLength={500} value={f.notes} disabled={locked} placeholder={t('Preferred table, high chair…')} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <div>
          <span className="small muted">{t('Tables held for them (none: a table is found when they arrive)')}</span>
          <div className="station-categories" role="group" aria-label={t('Tables')}>{tables.map((x) => <button key={x.id} type="button" className="chip-toggle" disabled={locked} aria-pressed={f.tableIds.includes(x.id)} onClick={() => setF({ ...f, tableIds: f.tableIds.includes(x.id) ? f.tableIds.filter((i) => i !== x.id) : [...f.tableIds, x.id] })}>{x.name} · {x.seats}</button>)}</div>
        </div>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Close')}</button><span className="spacer" />{!locked && <button disabled={busy || !f.name.trim()}>{busy ? t('Saving…') : initial.id ? t('Save') : t('Book the table')}</button>}</div>
      </form>
    </Modal>
  );
}

function DepositDialog({ reservation, onClose, onSaved }: { reservation: Reservation; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('A deposit from {name}', { name: reservation.name })} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { await api(`/v1/venue/reservations/${reservation.id}/deposit`, { method: 'POST', body: { amount, method } }); toast(t('Deposit taken. A tax receipt was issued for it.')); onSaved(); } catch (err) { setError(err); setBusy(false); } }}>
        <p className="small muted">{t('A tax receipt is issued now for what they hand over, GST included. When they eat, it comes off their bill.')}</p>
        <div className="form-grid">
          <Field label={t('Amount (BZ$)')}><input inputMode="decimal" required autoFocus pattern="\d{1,7}(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value.trim())} /></Field>
          <Field label={t('Paid by')}><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">{t('Cash')}</option><option value="card">{t('Card')}</option><option value="bank_transfer">{t('Bank transfer')}</option><option value="online">{t('Mobile wallet')}</option></Select></Field>
        </div>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy || !amount}>{t('Take the deposit')}</button></div>
      </form>
    </Modal>
  );
}

function WaitlistCard({ list, onChange, onMessage }: { list: Waiting[]; onChange: () => void; onMessage: (m: { text: string; whatsapp?: string; sms?: string; phone?: string }) => void }) {
  const t = useT();
  const toast = useToast();
  const [f, setF] = useState({ name: '', phone: '', partySize: 2, quotedMin: 15 });
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onChange(); } catch (e) { setError(e); } };
  return (
    <section className="card stack">
      <h2>{t('Waitlist')}</h2>
      {list.length > 0 && (
        <ul className="plain venue-setup-list">
          {list.map((w) => (
            <li key={w.id} className="row">
              <strong>{w.name}</strong><span>{w.partySize}p</span>
              <span className={`small ${w.waitedMin > w.quotedMin ? 'late' : 'muted'}`}>{t('waiting {n} min, told {q}', { n: w.waitedMin, q: w.quotedMin })}</span>
              {w.status === 'notified' && <span className="badge pay-paid">{t('Told the table is ready')}</span>}
              <span className="spacer" />
              <button type="button" className="secondary small-button" onClick={() => void api<{ text?: string; whatsapp?: string; sms?: string; phone?: string }>(`/v1/venue/waitlist/${w.id}/notify`, { method: 'POST', body: {} }).then((m) => { if (m.text) onMessage({ text: m.text, ...m }); else toast(t('Marked as told. They left no phone number: call their name.')); onChange(); }).catch(setError)}>{t('Table is ready')}</button>
              <button type="button" className="link small" onClick={() => void act(() => api(`/v1/venue/waitlist/${w.id}/left`, { method: 'POST', body: {} }))}>{t('Left')}</button>
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api('/v1/venue/waitlist', { method: 'POST', body: { name: f.name.trim(), ...(f.phone.trim() && { phone: f.phone.trim() }), partySize: f.partySize, quotedMin: f.quotedMin } }).then(() => setF({ name: '', phone: '', partySize: 2, quotedMin: 15 }))); }}>
        <Field label={t('Name')} className="grow"><input required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('Phone')}><input type="tel" maxLength={40} style={{ width: '9rem' }} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label={t('Guests')}><input type="number" min={1} max={200} style={{ width: '5rem' }} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} /></Field>
        <Field label={t('Wait told (min)')}><input type="number" min={0} max={600} step={5} style={{ width: '6rem' }} value={f.quotedMin} onChange={(e) => setF({ ...f, quotedMin: Number(e.target.value) })} /></Field>
        <button className="secondary" disabled={!f.name.trim()}>{t('Add to the list')}</button>
      </form>
      <p className="small muted">{t('A waiting party is seated from the Floor, like a booking.')}</p>
      <ErrorText error={error} />
    </section>
  );
}

function SectionsCard({ venue, tables }: { venue: VenueData; tables: Array<{ id: string; name: string }> }) {
  const t = useT();
  const toast = useToast();
  const servers = venue.staff.filter((s) => s.orders && ['server', 'bartender', 'supervisor'].includes(s.role));
  const [sections, setSections] = useState<Record<string, string[]>>(() => Object.fromEntries(venue.sections.map((s) => [s.userId, s.tableIds])));
  const [error, setError] = useState<unknown>(null);
  if (!servers.length || !tables.length) return null;
  const owner = (tableId: string) => Object.entries(sections).find(([, ids]) => ids.includes(tableId))?.[0];
  // A table belongs to one server: giving it to another takes it from the first.
  const give = (userId: string, tableId: string) => setSections((cur) => {
    const next = Object.fromEntries(Object.entries(cur).map(([u, ids]) => [u, ids.filter((i) => i !== tableId)]));
    if (owner(tableId) !== userId) next[userId] = [...(next[userId] ?? []), tableId];
    return next;
  });
  return (
    <section className="card stack">
      <div><h2>{t('Sections for today')}</h2><p className="small muted">{t('Which server looks after which tables. A table opened from the floor goes to its server.')}</p></div>
      {servers.map((s) => (
        <div key={s.id}>
          <strong>{s.name}</strong>
          <div className="station-categories" role="group" aria-label={t('Tables of {name}', { name: s.name })}>{tables.map((x) => <button key={x.id} type="button" className="chip-toggle" aria-pressed={owner(x.id) === s.id} onClick={() => give(s.id, x.id)}>{x.name}</button>)}</div>
        </div>
      ))}
      <ErrorText error={error} />
      <div><button type="button" onClick={() => void api('/v1/venue/sections', { method: 'PUT', body: { sections: Object.entries(sections).map(([userId, tableIds]) => ({ userId, tableIds })) } }).then(() => toast(t('Sections saved'))).catch(setError)}>{t('Save sections')}</button></div>
    </section>
  );
}

function GuestsCard() {
  const t = useT();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [list, setList] = useState<Guest[]>([]);
  const [open, setOpen] = useState<(Guest & { history: Array<{ date: string; table: string | null; partySize: number; ordered: string[] }>; reservations: Array<{ at: string; partySize: number; status: string; occasion: string | null }>; stays: Array<{ arrival: string; departure: string; status: string; room: string | null }> }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { const id = setTimeout(() => void api<{ data: Guest[] }>(`/v1/venue/guests?q=${encodeURIComponent(q.trim())}`).then((r) => setList(r.data)).catch(setError), 250); return () => clearTimeout(id); }, [q]);
  return (
    <section className="card stack">
      <div><h2>{t('Guests')}</h2><p className="small muted">{t('Everyone who has booked, waited or stayed: their visits, what they like, and their allergies, shown to the host and the server next time.')}</p></div>
      <input type="search" className="search-input" placeholder={t('Name, phone or email')} aria-label={t('Search guests')} value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="plain venue-setup-list">
        {list.slice(0, 12).map((g) => (
          <li key={g.id} className="row">
            <button type="button" className="link" onClick={() => void api<NonNullable<typeof open>>(`/v1/venue/guests/${g.id}`).then(setOpen).catch(setError)}><strong>{g.name}</strong></button>
            <span className="small muted">{[g.phone, g.visits === 1 ? t('1 visit') : t('{n} visits', { n: g.visits }), g.noShows > 0 && t('{n} no-shows', { n: g.noShows }), g.lastVisit].filter(Boolean).join(' · ')}</span>
            {g.allergies && <span className="badge pay-overdue">{g.allergies}</span>}
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
      {open && (
        <Modal title={open.name} onClose={() => setOpen(null)} wide>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void api(`/v1/venue/guests/${open.id}`, { method: 'PUT', body: { allergies: open.allergies ?? '', preferences: open.preferences ?? '', notes: open.notes ?? '' } }).then(() => { toast(t('Saved')); setOpen(null); setQ(q + ' '); }).catch(setError); }}>
            <Field label={t('Allergies')}><input maxLength={300} value={open.allergies ?? ''} onChange={(e) => setOpen({ ...open, allergies: e.target.value })} /></Field>
            <Field label={t('Likes')}><input maxLength={500} value={open.preferences ?? ''} placeholder={t('Window table, still water, extra spicy…')} onChange={(e) => setOpen({ ...open, preferences: e.target.value })} /></Field>
            <Field label={t('Notes')}><input maxLength={1000} value={open.notes ?? ''} onChange={(e) => setOpen({ ...open, notes: e.target.value })} /></Field>
            <div><button>{t('Save')}</button></div>
            <h3>{t('Visits')}</h3>
            {open.history.length === 0 && open.stays.length === 0 ? <p className="muted small">{t('None yet.')}</p> : (
              <ul className="plain small">
                {open.history.map((h, n) => <li key={n}>{h.date} · {h.table ?? t('Tab')} · {h.partySize}p · {h.ordered.join(', ')}</li>)}
                {open.stays.map((s, n) => <li key={`s${n}`}>{s.arrival} → {s.departure} · {t('Room {room}', { room: s.room ?? '—' })} · {t(s.status)}</li>)}
              </ul>
            )}
          </form>
        </Modal>
      )}
    </section>
  );
}
