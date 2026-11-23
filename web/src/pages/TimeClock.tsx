/**
 * The time clock: a button to clock in and out (at the counter and on tills), and the hours each
 * person worked for managers (Reports), with corrections and a CSV for the payroll.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, link } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, Modal } from '../ui';

interface Entry { id: string; userId: string; name: string; clockIn: string; clockOut: string | null; hours: number; note: string | null; edited: boolean; day: string }
interface Mine { open: Entry | null; today: number; week: number }

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'America/Belize' });
/** 3.5 -> "3 h 30 min". */
export const hoursText = (h: number) => {
  const m = Math.round(h * 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};

/** Clock in or out; shows since when and the hours today. */
export function ClockButton() {
  const t = useT();
  const toast = useToast();
  const [mine, setMine] = useState<Mine | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Mine>('/v1/timeclock/me').then(setMine).catch(() => setMine(null)), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!mine) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api<Mine>(mine.open ? '/v1/timeclock/out' : '/v1/timeclock/in', { method: 'POST' });
      toast(mine.open ? t('Clocked out: {h} today', { h: hoursText(r.today) }) : t('Clocked in'));
      setMine(r);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
      void load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`clock-pill ${mine.open ? 'on' : ''}`}>
      {mine.open && <span className="small">{t('In since {time}', { time: clock(mine.open.clockIn) })} · {hoursText(mine.open.hours)}</span>}
      <button type="button" className={mine.open ? 'secondary' : ''} disabled={busy} onClick={() => void toggle()}>{mine.open ? t('Clock out') : t('Clock in')}</button>
    </span>
  );
}

/** Hours worked by each person in a period (Reports), with each entry and corrections. */
export function HoursWorkedPanel({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [data, setData] = useState<{ people: Array<{ userId: string; name: string; hours: number; days: number; clockedIn: boolean }>; entries: Entry[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const load = useCallback(() => {
    if (!from || !to || from > to) return;
    api<NonNullable<typeof data>>(`/v1/timeclock?from=${from}&to=${to}`).then(setData).catch(setError);
  }, [from, to]);
  useEffect(() => void load(), [load]);
  if (error) return null;
  if (!data || data.people.length === 0) return null;
  const entries = person ? data.entries.filter((e) => e.userId === person) : [];
  return (
    <section className="card stack">
      <div className="row"><h2>{t('Hours worked')}</h2><span className="spacer" /><a className="button secondary" href={link(`/v1/timeclock?from=${from}&to=${to}&format=csv`)} download>CSV</a></div>
      <div className="table-wrap">
        <table className="responsive">
          <thead><tr><th scope="col">{t('Person')}</th><th scope="col" className="right">{t('Days')}</th><th scope="col" className="right">{t('Hours')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>
            {data.people.map((p) => (
              <tr key={p.userId}>
                <td data-label={t('Person')}>{p.name}{p.clockedIn && <span className="badge authorized clock-badge">{t('In now')}</span>}</td>
                <td data-label={t('Days')} className="right">{p.days}</td>
                <td data-label={t('Hours')} className="right num">{p.hours.toFixed(2)}</td>
                <td className="right"><button type="button" className="link" onClick={() => setPerson(person === p.userId ? null : p.userId)}>{person === p.userId ? t('Hide') : t('Entries')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {person && (
        <ul className="plain-list">
          {entries.map((e) => (
            <li key={e.id} className="row small">
              <span>{e.day}</span>
              <span className="muted">{clock(e.clockIn)} – {e.clockOut ? clock(e.clockOut) : t('still in')}</span>
              {e.edited && <span className="muted">({t('corrected')})</span>}
              {e.note && <span className="muted">· {e.note}</span>}
              <span className="spacer" />
              <span className="num">{hoursText(e.hours)}</span>
              <button type="button" className="link" onClick={() => setEditing(e)}>{t('Correct')}</button>
            </li>
          ))}
        </ul>
      )}
      {editing && <CorrectEntry entry={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
    </section>
  );
}

/** "2026-11-22T14:05:00Z" -> "2026-11-22T08:05" in Belize time, for a datetime-local input. */
const toLocal = (iso: string) => new Date(Date.parse(iso) - 6 * 3600_000).toISOString().slice(0, 16);
const fromLocal = (v: string) => new Date(`${v}:00-06:00`).toISOString();

function CorrectEntry({ entry, onClose, onDone }: { entry: Entry; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [clockIn, setClockIn] = useState(toLocal(entry.clockIn));
  const [clockOut, setClockOut] = useState(entry.clockOut ? toLocal(entry.clockOut) : '');
  const [note, setNote] = useState(entry.note ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/v1/timeclock/${entry.id}`, { method: 'PUT', body: { clockIn: fromLocal(clockIn), clockOut: clockOut ? fromLocal(clockOut) : null, note: note.trim() || null } });
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Correct {name}’s hours', { name: entry.name })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="form-grid">
          <Field label={t('Clocked in')}><input type="datetime-local" required value={clockIn} onChange={(e) => setClockIn(e.target.value)} /></Field>
          <Field label={t('Clocked out')} hint={t('Empty: still in.')}><input type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></Field>
        </div>
        <Field label={t('Note')}><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Forgot to clock out')} /></Field>
        <p className="small muted">{t('Belize time. The change is kept in the activity log.')}</p>
        <ErrorText error={error} />
        <div className="row"><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button type="submit" disabled={busy}>{t('Save')}</button></div>
      </form>
    </Modal>
  );
}
