/**
 * The kitchen display: orders as cards for a station, turning amber then red
 * as they age against the station's target, bumped when done (which tells the
 * floor), brought back if bumped by mistake; an all-day count of what is
 * still to make; and an expediter's view of a whole table across stations.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { COURSES } from '../../../src/venue/check.ts';
import { setActor, type Ticket, ticketDid, useVenue, watch } from './store';
import './venue.css';

const age = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function KitchenScreen() {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const { data, tickets, online } = useVenue();
  const [station, setStation] = useState<string>(() => { try { return localStorage.getItem('venue.kds.station') ?? ''; } catch { return ''; } });
  const [recall, setRecall] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => watch(), []);
  useEffect(() => { if (session) setActor({ id: session.user.id, name: session.user.name }); }, [session]);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { try { localStorage.setItem('venue.kds.station', station); } catch { /* not kept */ } }, [station]);

  const stations = data?.stations ?? [];
  const expedite = station === 'all';
  const mine = (k: Ticket) => expedite || k.stationId === (station || stations[0]?.id);
  const live = useMemo(() => tickets.filter((k) => !k.bumpedAt && mine(k)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)), [tickets, station, stations]); // eslint-disable-line react-hooks/exhaustive-deps
  const bumped = tickets.filter((k) => k.bumpedAt && mine(k)).sort((a, b) => (a.bumpedAt! < b.bumpedAt! ? 1 : -1)).slice(0, 12);
  // All day: how many of each dish are still to make.
  const allDay = useMemo(() => {
    const count = new Map<string, number>();
    for (const k of live) if (k.kind === 'order') for (const i of k.body.items) count.set(i.name, (count.get(i.name) ?? 0) + i.quantity);
    return [...count.entries()].sort((a, b) => b[1] - a[1]);
  }, [live]);
  // The expediter sees one card per table, with every station's part of it.
  const groups = useMemo(() => {
    if (!expedite) return live.map((k) => ({ key: k.id, table: k.body.table, tickets: [k] }));
    const by = new Map<string, Ticket[]>();
    for (const k of live) by.set(k.checkId, [...(by.get(k.checkId) ?? []), k]);
    return [...by.entries()].map(([key, list]) => ({ key, table: list[0]!.body.table, tickets: list }));
  }, [live, expedite]);

  if (!data) return <div className="skeleton" style={{ height: '20rem' }} />;
  if (!data.on) return <div className="card"><p>{t('Table service is off.')}</p></div>;
  const target = (k: Ticket) => (stations.find((s) => s.id === k.stationId)?.targetMin ?? 12) * 60;
  const tone = (k: Ticket) => { const a = age(k.createdAt); return k.kind === 'void' ? 'void' : a >= target(k) ? 'late' : a >= target(k) * 0.7 ? 'warn' : ''; };
  const mark86 = async (name: string) => {
    const item = data.items.find((i) => i.name === name);
    if (!item) return;
    try { await api(`/v1/venue/items/${item.id}/availability`, { method: 'POST', body: { soldOut: !item.soldOut } }); toast(item.soldOut ? t('{name} is back on', { name }) : t('{name} is sold out on every device', { name })); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
  };

  return (
    <div className="kds">
      <div className="row venue-bar">
        <div className="tabs" role="group" aria-label={t('Station')}>
          {stations.map((s, n) => <button key={s.id} type="button" aria-pressed={!expedite && (station || stations[0]?.id) === s.id} className={!expedite && (station ? station === s.id : n === 0) ? 'active' : ''} onClick={() => setStation(s.id)}>{s.name}</button>)}
          <button type="button" aria-pressed={expedite} className={expedite ? 'active' : ''} onClick={() => setStation('all')}>{t('Expediter')}</button>
        </div>
        <span className="spacer" />
        <span className={`venue-sync ${online ? '' : 'off'}`} role="status">{online ? t('{n} to make', { n: live.filter((k) => k.kind === 'order').length }) : t('No connection')}</span>
        <button type="button" className="secondary" aria-pressed={recall} onClick={() => setRecall(!recall)}>{t('Recall')}</button>
      </div>
      {allDay.length > 0 && (
        <div className="kds-allday" aria-label={t('All day')}>
          <strong>{t('All day')}:</strong>
          {allDay.map(([name, n]) => <span key={name}>{n} × {name} <button type="button" className="link small" onClick={() => void mark86(name)}>86</button></span>)}
        </div>
      )}
      {recall && (
        <section className="card stack">
          <h2>{t('Bumped')}</h2>
          {bumped.length === 0 ? <p className="muted">{t('Nothing bumped yet.')}</p> : (
            <ul className="plain">{bumped.map((k) => <li key={k.id} className="row"><span>{k.body.table} · {k.body.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</span><span className="spacer" /><button type="button" className="secondary small-button" onClick={() => void ticketDid(k.id, 'recall')}>{t('Bring back')}</button></li>)}</ul>
          )}
        </section>
      )}
      {groups.length === 0 ? <div className="card empty">{t('No orders waiting.')}</div> : (
        <div className="kds-board">
          {groups.map((g) => {
            const oldest = g.tickets[0]!;
            return (
              <article key={g.key} className={`kds-card ${g.tickets.map(tone).includes('late') ? 'late' : g.tickets.map(tone).includes('warn') ? 'warn' : ''} ${g.tickets.every((k) => k.kind === 'void') ? 'void' : ''}`} aria-label={`${g.table}, ${clock(age(oldest.createdAt))}`}>
                <header><strong>{g.table}</strong><span className="kds-age">{clock(age(oldest.createdAt))}</span></header>
                <span className="small muted">#{oldest.body.number} · {oldest.body.server} · {oldest.body.partySize}p</span>
                {oldest.body.allergy && <div className="kds-allergy">{t('ALLERGY')}: {oldest.body.allergy}</div>}
                {g.tickets.map((k) => (
                  <div key={k.id}>
                    {expedite && <div className="kds-course">{stations.find((s) => s.id === k.stationId)?.name}{k.status === 'failed' ? ` · ${t('did not print')}` : ''}</div>}
                    {k.kind !== 'order' && <div className="kds-allergy">{k.kind === 'void' ? t('VOID: do not make') : t('CHANGE')}</div>}
                    <ul>
                      {k.body.items.map((i, n) => (
                        <li key={i.id}>
                          {(n === 0 || k.body.items[n - 1]!.course !== i.course) && <div className="kds-course">{t(COURSES[i.course] ?? 'Course')}</div>}
                          {i.quantity} × {i.name}{i.seat > 0 && <span className="small muted"> S{i.seat}</span>}
                          {i.modifiers.map((m) => <span key={m} className="mods">› {m}</span>)}
                          {i.note && <span className="mods"><strong>** {i.note}</strong></span>}
                          {oldest.body.allergy && i.allergens.length > 0 && <span className="mods late">!! {i.allergens.join(', ')}</span>}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className={k.kind === 'order' ? 'lime' : 'secondary'} onClick={() => void ticketDid(k.id, 'bump')}>{k.kind === 'order' ? t('Done') : t('Seen')}</button>
                  </div>
                ))}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
