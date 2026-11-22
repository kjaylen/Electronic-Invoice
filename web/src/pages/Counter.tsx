/**
 * The counter: tax receipts at speed. Scan or type a code and press Enter,
 * tap a quick button, adjust quantities, take payment, issue, print. Built to
 * work from the keyboard alone, and to survive a closed tab (the sale in
 * progress is kept on this device).
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type DocumentDetailInfo, type DocumentInfo, type Item, link, type Page } from '../api';
import { useT } from '../i18n';
import { printPdf } from '../print';
import { useSession } from '../session';
import { useToast } from '../toast';
import { Combobox, ErrorText, fromCents, money, PAYMENT_MEANS, Segmented, StatusBadge, store, toCents, useDebounced, usePageTitle } from '../ui';
import { searchItems } from './NewDocument';

interface CartLine {
  key: number;
  itemId?: string;
  name: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode?: string;
  custom?: boolean;
}

interface Sale {
  lines: CartLine[];
  meansCode: string;
  tendered: string;
  tin: string;
  idempotencyKey: string;
}

let key = 0;
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const newSale = (): Sale => ({ lines: [], meansCode: '10', tendered: '', tin: '', idempotencyKey: crypto.randomUUID() });
const fromItem = (it: Item, quantity = '1'): CartLine => ({
  key: ++key, itemId: it.id, name: it.name, quantity, unitCode: it.unitCode, unitPrice: it.unitPrice, gstCategory: it.gstCategory,
  ...(it.exemptionReasonCode && { exemptionReasonCode: it.exemptionReasonCode }),
});
const addQty = (q: string, delta: number) => {
  const n = Math.round((Number(q) + delta) * 1e6) / 1e6;
  return n > 0 ? String(n) : q;
};

export function Counter() {
  const t = useT();
  usePageTitle(t('Counter'));
  const toast = useToast();
  const { me, session } = useSession();
  const storageKey = `etd.counter.${session?.business.id}.${session?.user.id}`;
  const [sale, setSale] = useState<Sale>(() => {
    const saved = store.get<Sale>(storageKey);
    if (saved?.lines) key = Math.max(key, ...saved.lines.map((l) => l.key), 0);
    return saved?.lines ? saved : newSale();
  });
  const [favorites, setFavorites] = useState<Item[]>([]);
  const [totals, setTotals] = useState<DocumentInfo['totals'] | null>(null);
  const [last, setLast] = useState<{ doc: DocumentInfo; change: string | null } | null>(null);
  const [autoPrint, setAutoPrint] = useState(() => store.get<boolean>('etd.counter.autoprint') ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => store.set(storageKey, sale), [sale, storageKey]);
  // Ready to scan as soon as the page opens.
  useEffect(() => {
    const timer = setTimeout(() => search.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => store.set('etd.counter.autoprint', autoPrint), [autoPrint]);
  useEffect(() => {
    void api<Page<Item>>('/v1/items?favorite=true&limit=24').then(async (r) => {
      setFavorites(r.data.length ? r.data : (await api<Page<Item>>('/v1/items?limit=12')).data);
    }).catch(() => {});
  }, []);

  const set = (patch: Partial<Sale>) => setSale((s) => ({ ...s, ...patch }));
  const focusSearch = () => setTimeout(() => search.current?.focus(), 0);
  const add = useCallback((line: CartLine) => {
    setSale((s) => {
      // Scanning the same item again adds one more.
      const same = line.itemId ? s.lines.find((l) => l.itemId === line.itemId && !l.custom) : undefined;
      if (same) return { ...s, lines: s.lines.map((l) => (l === same ? { ...l, quantity: addQty(l.quantity, Number(line.quantity)) } : l)) };
      return { ...s, lines: [...s.lines, line] };
    });
    setLast(null);
  }, []);
  const update = (k: number, patch: Partial<CartLine>) => setSale((s) => ({ ...s, lines: s.lines.map((l) => (l.key === k ? { ...l, ...patch } : l)) }));
  const remove = (k: number) => setSale((s) => ({ ...s, lines: s.lines.filter((l) => l.key !== k) }));

  // Enter with no suggestion highlighted: "3*CODE" or "CODE" -> exact barcode or code match, else the only search result.
  const enter = async (text: string) => {
    const m = /^(\d+(?:\.\d+)?)\s*[*x]\s*(.+)$/i.exec(text);
    const quantity = m ? m[1]! : '1';
    const code = (m ? m[2]! : text).trim();
    try {
      let [hit] = (await api<Page<Item>>(`/v1/items?limit=1&code=${encodeURIComponent(code)}`)).data;
      if (!hit) {
        const found = await searchItems(code, 2);
        if (found.length === 1) hit = found[0];
      }
      if (hit) add(fromItem(hit, quantity));
      else toast(t('No item matches "{code}"', { code }), 'bad');
    } catch (e) {
      setError(e);
    }
  };

  const repeatLast = async () => {
    try {
      const [doc] = (await api<Page<DocumentInfo>>('/v1/documents?type=02&limit=1')).data;
      if (!doc) return toast(t('No receipts yet'), 'info');
      const d = await api<DocumentDetailInfo>(`/v1/documents/${doc.id}`);
      set({ lines: d.lines.map((l) => ({ key: ++key, name: l.description, quantity: l.quantity, unitCode: l.unitCode, unitPrice: l.unitPrice, gstCategory: l.gstCategory, custom: true })) });
      focusSearch();
    } catch (e) {
      setError(e);
    }
  };

  const valid = sale.lines.filter((l) => l.name.trim() && DECIMAL.test(l.quantity) && Number(l.quantity) > 0 && DECIMAL.test(l.unitPrice) && (l.gstCategory !== 'E' || l.exemptionReasonCode));
  const linesBody = valid.map((l) => ({
    ...(l.itemId && !l.custom ? { itemId: l.itemId } : {}),
    description: l.name.trim(),
    quantity: l.quantity,
    unitCode: l.unitCode,
    unitPrice: l.unitPrice,
    gstCategory: l.gstCategory,
    ...(l.gstCategory === 'E' && { exemptionReasonCode: l.exemptionReasonCode }),
  }));
  const previewKey = useDebounced(JSON.stringify(linesBody), 250);
  useEffect(() => {
    const body = JSON.parse(previewKey) as typeof linesBody;
    if (!body.length) return setTotals(null);
    let live = true;
    void api<{ totals: DocumentInfo['totals'] }>('/v1/documents/preview', { method: 'POST', body: { type: '02', lines: body } })
      .then((p) => live && setTotals(p.totals)).catch(() => live && setTotals(null));
    return () => {
      live = false;
    };
  }, [previewKey]);

  const total = totals?.taxInclusive ?? '0.00';
  const change = sale.meansCode === '10' && DECIMAL.test(sale.tendered) && totals ? toCents(sale.tendered) - toCents(total) : null;
  const canIssue = valid.length > 0 && valid.length === sale.lines.length && Boolean(totals) && Boolean(me?.certificate) && (change === null || change >= 0n);

  const issue = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canIssue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const doc = await api<DocumentInfo>('/v1/documents', {
        method: 'POST',
        headers: { 'Idempotency-Key': sale.idempotencyKey },
        body: {
          type: '02',
          ...(sale.tin.trim() && { customer: { tin: sale.tin.trim() } }),
          lines: linesBody,
          payment: { meansCode: sale.meansCode, terms: `Paid by ${PAYMENT_MEANS.find(([c]) => c === sale.meansCode)?.[1].toLowerCase()}` },
        },
      });
      setLast({ doc, change: change !== null ? fromCents(change) : null });
      setSale(newSale());
      if (doc.status === 'rejected') toast(t('Rejected by BTS'), 'bad');
      else if (autoPrint) printPdf(link(`/v1/documents/${doc.id}/pdf?format=receipt&widthMm=80`));
      focusSearch();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // Shortcuts: F2 or Ctrl+Enter issues; in the empty search box, + and - change the last line's quantity and Delete removes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        void issue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const searchKeys = (e: React.KeyboardEvent) => {
    const input = e.target as HTMLInputElement;
    const lastLine = sale.lines.at(-1);
    if (input.value || !lastLine) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      remove(lastLine.key);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Tax receipts')}</span><h1>{t('Counter')}</h1></div>
        <span className="spacer" />
        <label className="row small"><input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} /> {t('Print each receipt automatically')}</label>
      </div>
      {!me?.certificate && <div className="banner bad"><div><strong>{t('Install your BTS certificate in Settings before issuing.')}</strong></div></div>}

      <div className="counter">
        <div className="stack">
          <div className="card stack">
            <div onKeyDown={searchKeys}>
              <Combobox<Item>
                label={t('Add an item')}
                inputRef={search}
                autoFocus
                clearOnPick
                placeholder={t('Scan a barcode, type a code or search… (3*code adds three)')}
                search={(q) => (/^\d+(\.\d+)?\s*[*x]/i.test(q) ? Promise.resolve([]) : searchItems(q))}
                render={(it) => <><strong>{it.name}</strong> <span className="muted">· {money(it.unitPrice)}{it.sellerCode && ` · ${it.sellerCode}`}</span></>}
                onPick={(it) => {
                  add(fromItem(it));
                  focusSearch();
                }}
                onEnter={enter}
                onText={(v) => {
                  // "+" or "-" typed into the empty box (any keyboard, including phones): change the last line's quantity.
                  const lastLine = sale.lines.at(-1);
                  if (!lastLine || (v !== '+' && v !== '-')) return false;
                  update(lastLine.key, { quantity: addQty(lastLine.quantity, v === '+' ? 1 : -1) });
                  return true;
                }}
              />
            </div>
            <p className="small muted keys">
              <span><kbd>Enter</kbd> {t('add')}</span> <span><kbd>+</kbd> <kbd>−</kbd> {t('quantity')}</span> <span><kbd>Del</kbd> {t('remove last')}</span> <span><kbd>F2</kbd> {t('issue')}</span>
            </p>
          </div>
          {favorites.length > 0 && (
            <div className="quick-grid" role="group" aria-label={t('Quick buttons')}>
              {favorites.map((it) => (
                <button key={it.id} type="button" className="quick" onClick={() => { add(fromItem(it)); focusSearch(); }}>
                  <span className="name">{it.name}</span>
                  <span className="price num">{money(it.unitPrice)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <button type="button" className="secondary" onClick={() => void repeatLast()}>{t('Repeat last sale')}</button>
            <button type="button" className="secondary" onClick={() => add({ key: ++key, name: '', quantity: '1', unitCode: 'H87', unitPrice: '', gstCategory: 'S', custom: true })}>+ {t('Custom item')}</button>
          </div>
          {last && (
            <div className={`card last-sale ${last.doc.status}`} role="status">
              <div className="row">
                <div>
                  <span className="kicker">{t('Last sale')}</span>
                  <h2 className="num">{last.doc.series}-{last.doc.number} · {money(last.doc.totals.payable)}</h2>
                  {last.change && <p className="change">{t('Change')}: <strong className="num">{money(last.change)}</strong></p>}
                </div>
                <span className="spacer" />
                <StatusBadge status={last.doc.status} />
              </div>
              <div className="row">
                {['authorized', 'authorized_with_alert', 'contingency_pending'].includes(last.doc.status) && (
                  <button type="button" onClick={() => printPdf(link(`/v1/documents/${last.doc.id}/pdf?format=receipt&widthMm=80`))}>{t('Print receipt')}</button>
                )}
                <Link className="button secondary" to={`/documents/${last.doc.id}`} viewTransition>{t('Open or send')}</Link>
              </div>
            </div>
          )}
        </div>

        <form className="card ticket cart stack" onSubmit={issue}>
          <span className="kicker" style={{ color: 'var(--lime)' }}>{t('Tax receipt')} · BZD</span>
          {sale.lines.length === 0 ? <p className="cart-empty">{t('Scan or pick items to start a sale.')}</p> : (
            <ul className="cart-lines">
              {sale.lines.map((l) => (
                <li key={l.key}>
                  {l.custom ? (
                    <div className="custom">
                      <input aria-label={t('Description')} placeholder={t('Description')} value={l.name} onChange={(e) => update(l.key, { name: e.target.value })} />
                      <input aria-label={t('Price (BZ$)')} placeholder="0.00" inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
                    </div>
                  ) : <span className="name">{l.name}<span className="each num"> · {money(l.unitPrice)}</span></span>}
                  <div className="qty">
                    <button type="button" aria-label={t('One less {name}', { name: l.name })} onClick={() => update(l.key, { quantity: addQty(l.quantity, -1) })}>−</button>
                    <input aria-label={t('Quantity of {name}', { name: l.name })} inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                    <button type="button" aria-label={t('One more {name}', { name: l.name })} onClick={() => update(l.key, { quantity: addQty(l.quantity, 1) })}>+</button>
                  </div>
                  <span className="sum num">{DECIMAL.test(l.quantity) && DECIMAL.test(l.unitPrice) ? money(fromCents((toCents(l.unitPrice) * BigInt(Math.round(Number(l.quantity) * 1000))) / 1000n)) : ''}</span>
                  <button type="button" className="remove" aria-label={t('Remove {name}', { name: l.name || t('item') })} onClick={() => remove(l.key)}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div><span>{t('Subtotal')}</span><span>{money(totals?.lineExtension ?? '0.00')}</span></div>
          <div><span>GST</span><span>{money(totals?.gst ?? '0.00')}</span></div>
          <div className="grand"><span>{t('Total')}</span><span aria-live="polite">{money(total)}</span></div>
          <Segmented label={t('Payment')} value={sale.meansCode} onChange={(v) => set({ meansCode: v })} options={PAYMENT_MEANS.slice(0, 3).map(([c, n]) => [c, t(n)])} />
          {sale.meansCode === '10' && (
            <div className="tender">
              <label>{t('Cash received')}<input inputMode="decimal" placeholder="0.00" value={sale.tendered} onChange={(e) => set({ tendered: e.target.value })} /></label>
              <span className={change !== null && change < 0n ? 'short' : ''}>{change === null ? '' : change < 0n ? t('Short {amount}', { amount: money(fromCents(-change)) }) : `${t('Change')} ${money(fromCents(change))}`}</span>
            </div>
          )}
          <details className="tin">
            <summary>{t('Customer TIN on the receipt')}</summary>
            <input inputMode="numeric" pattern="\d{6}" maxLength={6} aria-label={t('Customer TIN (optional)')} value={sale.tin} onChange={(e) => set({ tin: e.target.value })} />
          </details>
          <ErrorText error={error} />
          <button type="submit" className="big lime" disabled={!canIssue || busy}>{busy ? t('Signing and sending…') : t('Issue receipt')}<span className="chip" aria-hidden="true">F2</span></button>
          {sale.lines.length > 0 && <button type="button" className="link on-dark" onClick={() => { setSale(newSale()); focusSearch(); }}>{t('Clear sale')}</button>}
        </form>
      </div>
    </div>
  );
}
