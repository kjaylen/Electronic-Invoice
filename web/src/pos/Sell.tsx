/** Selling on the till: the counter, printing on the till's printer, the cash drawer, scanners, the customer display. */

import { useCallback, useEffect } from 'react';
import { useT } from '../i18n';
import { type CounterCart, CounterPanel, SCAN_EVENT } from '../pages/Counter';
import { useToast } from '../toast';
import { useKeyboardScanner } from './hardware';
import { TillShiftBar } from './ShiftPanel';
import { ClockButton } from '../pages/TimeClock';
import { useTill } from './TillApp';

const lineAmount = (quantity: string, unitPrice: string) => {
  const n = Number(quantity) * Number(unitPrice);
  return Number.isFinite(n) ? n.toFixed(2) : '';
};

export function Sell() {
  const t = useT();
  const toast = useToast();
  const till = useTill();
  const problem = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'bad'), [toast]);

  // USB and Bluetooth scanners anywhere on the screen.
  useKeyboardScanner(till.hardware.scanner.keyboard, till.hardware.scanner.minLength, (code) => window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail: code })));

  // The customer display, on a second screen (desktop).
  const display = till.hardware.customerDisplay ? till.platform.customerDisplay ?? null : null;
  const business = till.till.business.name;
  useEffect(() => {
    if (!display) return;
    void display.open();
    return () => display.close();
  }, [display]);
  const onCart = useCallback((cart: CounterCart) => {
    display?.update({
      business,
      lines: cart.lines.map((l) => ({ name: l.name, quantity: l.quantity, amount: lineAmount(l.quantity, l.unitPrice) })),
      total: cart.total,
      change: cart.change,
      ...(cart.usd && { usd: cart.usd }),
    });
  }, [display, business]);

  const scanWithCamera = till.scanWithCamera;
  return (
    <CounterPanel
      touch
      shiftBar={(refreshKey) => <TillShiftBar refreshKey={refreshKey} />}
      onIssued={(doc, sale) => {
        if (doc.status === 'rejected') return;
        const kick = sale.meansCode === '10' && till.hardware.openDrawerOnCash;
        if (till.hardware.autoPrint) void till.printDocument(doc.id, { openDrawer: kick }).catch(problem);
        else if (kick) void till.openDrawer().catch(problem);
        display?.update({ business, lines: [], total: doc.totals.payable, change: sale.change, message: t('Thank you!') });
      }}
      print={(doc) => void till.printDocument(doc.id).catch(problem)}
      printOrder={(ticket, title) => till.printTicket(ticket, { title })}
      extraButtons={<>{scanWithCamera && (
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            const code = await scanWithCamera().catch(() => null);
            if (code) window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail: code }));
          }}
        >
          {t('Scan with the camera')}
        </button>
      )}<ClockButton /></>}
      onCart={onCart}
    />
  );
}
