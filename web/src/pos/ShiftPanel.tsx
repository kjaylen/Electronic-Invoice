/** The till's cash drawer: open a shift, cash in and out, close it, the X and Z reports on the receipt printer. */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { CashModal, CloseShiftModal, DifferenceText, OpenShiftModal, ReportView, type Shift, type ShiftReport } from '../pages/Shifts';
import { useToast } from '../toast';
import { ErrorText, money } from '../ui';
import { zReportTicket } from './ticket';
import { useTill } from './TillApp';
import { Button, dmy } from './design/components';

type Current = { shift: Shift | null; report: ShiftReport | null };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => `${dmy(iso)} ${time(iso)}`;

/** Print a shift's report (X while open, Z once closed). */
function usePrintReport() {
  const till = useTill();
  return useCallback(async (shiftId: string) => {
    const { shift, report } = await api<{ shift: Shift; report: ShiftReport }>(`/v1/shifts/${shiftId}`);
    const biz = till.till.business;
    await till.printTicket(zReportTicket({ business: { name: biz.name, tin: biz.tin }, till: till.till.device.name, shift, report }), { title: shift.number ? `Shift ${shift.number}` : 'Shift' });
  }, [till]);
}

/** The bar above the counter. */
export function TillShiftBar({ refreshKey }: { refreshKey?: string | null }) {
  const t = useT();
  const toast = useToast();
  const till = useTill();
  const printReport = usePrintReport();
  const [current, setCurrent] = useState<Current | null>(null);
  const [dialog, setDialog] = useState<null | 'open' | 'cash' | 'close'>(null);
  const load = useCallback(() => api<Current>('/v1/shifts/current').then(setCurrent).catch(() => {}), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => clearInterval(timer);
  }, [load, refreshKey]);
  if (!current) return null;
  const s = current.shift;
  const problem = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad');
  return (
    <>
      {s ? (
        <div className="shift-bar open">
          <span className="shift-dot" aria-hidden="true" />
          <span><strong>{s.number ? t('Shift #{n}', { n: s.number }) : t('New shift')}</strong> · {s.openedBy.name} · {t('since {time}', { time: time(s.openedAt) })}</span>
          <span className="spacer" />
          <span className="small">{t('Cash expected {amount}', { amount: money(current.report?.cash.expected ?? s.openingFloat) })}</span>
          {till.isManager && till.hardware.printers.some((p) => p.drawer) && <button type="button" className="secondary small-button" onClick={() => void till.openDrawer().catch(problem)}>{t('Open drawer')}</button>}
          <button type="button" className="secondary small-button" onClick={() => setDialog('cash')}>{t('Cash in/out')}</button>
          <button type="button" className="small-button" onClick={() => setDialog('close')}>{t('Close shift')}</button>
        </div>
      ) : (
        <div className="shift-bar">
          <span>{t('No shift open on this till. Open one with the cash in the drawer.')}</span>
          <span className="spacer" />
          <button type="button" className="small-button" onClick={() => setDialog('open')}>{t('Open shift')}</button>
        </div>
      )}
      {dialog === 'open' && <OpenShiftModal atTill onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog === 'cash' && s && <CashModal shift={s} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog === 'close' && s && current.report && (
        <CloseShiftModal
          shift={s}
          report={current.report}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            void load();
            if (till.hardware.printZReport) void printReport(id).catch(problem);
          }}
        />
      )}
    </>
  );
}

/** The Shift tab: the shift so far, and this till's earlier shifts. */
export function ShiftPanel() {
  const t = useT();
  const toast = useToast();
  const till = useTill();
  const printReport = usePrintReport();
  const [current, setCurrent] = useState<Current | null>(null);
  const [history, setHistory] = useState<Shift[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<null | 'open' | 'cash' | 'close'>(null);
  const load = useCallback(() => {
    api<Current>('/v1/shifts/current').then(setCurrent).catch(setError);
    api<{ data: Shift[] }>('/v1/shifts').then((r) => setHistory(r.data.filter((x) => x.register.id === till.till.device.register.id))).catch(setError);
  }, [till.till.device.register.id]);
  useEffect(() => void load(), [load]);
  const problem = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad');
  const s = current?.shift ?? null;
  return (
    <div className="stack till-shift-screen">
      <div className="till-list-head">
        <div><span className="kicker">{till.till.device.register.name}</span><h1>{s ? (s.number ? t('Shift #{n}', { n: s.number }) : t('New shift')) : t('Cash drawer')}</h1></div>
        {s ? (
          <div className="shift-actions">
            <Button icon="cash" size="lg" onClick={() => setDialog('cash')}>{t('Cash in/out')}</Button>
            <Button icon="printer" size="lg" onClick={() => void printReport(s.id).catch(problem)}>{t('Print X report')}</Button>
            <Button variant="primary" icon="drawer" size="lg" onClick={() => setDialog('close')}>{t('Close shift')}</Button>
          </div>
        ) : current && <Button variant="primary" icon="drawer" size="lg" onClick={() => setDialog('open')}>{t('Open shift')}</Button>}
      </div>
      <ErrorText error={error} />
      {s && current?.report && (
        <>
          <p className="muted">{t('Opened by {name} at {time} with {amount}', { name: s.openedBy.name, time: time(s.openedAt), amount: money(s.openingFloat) })}</p>
          <ReportView report={current.report} shift={s} />
        </>
      )}
      {current && !s && <p className="muted">{t('No shift open on this till. Open one with the cash in the drawer.')}</p>}
      {history && history.length > 0 && (
        <section className="card stack">
          <h2>{t('Earlier shifts on this till')}</h2>
          <table>
            <thead><tr><th>#</th><th>{t('Opened')}</th><th>{t('Closed')}</th><th className="right">{t('Counted')}</th><th>{t('Difference')}</th><th /></tr></thead>
            <tbody>
              {history.filter((x) => x.status === 'closed').slice(0, 20).map((x) => (
                <tr key={x.id}>
                  <td data-label="#" className="mono">{x.number || '—'}</td>
                  <td data-label={t('Opened')} className="small">{when(x.openedAt)} · {x.openedBy.name}</td>
                  <td data-label={t('Closed')} className="small">{x.closedAt ? when(x.closedAt) : ''}</td>
                  <td data-label={t('Counted')} className="right mono">{x.countedCash ? money(x.countedCash) : '—'}</td>
                  <td data-label={t('Difference')}><DifferenceText difference={x.difference} /></td>
                  <td><Button icon="printer" onClick={() => void printReport(x.id).catch(problem)}>{t('Print')}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {dialog === 'open' && <OpenShiftModal atTill onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {dialog === 'cash' && s && <CashModal shift={s} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {dialog === 'close' && s && current?.report && (
        <CloseShiftModal shift={s} report={current.report} onClose={() => setDialog(null)} onDone={(id) => {
          setDialog(null);
          load();
          if (till.hardware.printZReport) void printReport(id).catch(problem);
        }} />
      )}
    </div>
  );
}
