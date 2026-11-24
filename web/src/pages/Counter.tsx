/**
 * The counter: tax receipts at speed. Scan or type a code and press Enter,
 * tap a quick button, adjust quantities, take payment, issue, print. Built to
 * work from the keyboard alone, and to survive a closed tab (the sale in
 * progress is kept on this device).
 *
 * Also: discounts on a line or on the whole sale, holding a sale to serve the
 * next customer and recalling it later, a saved customer on the receipt (or on
 * an invoice charged to their account), and payment split between cash and a
 * card or transfer.
 *
 * CounterPanel is the counter itself; the web page and the till apps wrap it
 * (the tills print on their own receipt printer and open the cash drawer).
 * A barcode read anywhere on the page arrives as a SCAN_EVENT.
 */

import { ShiftBar } from './Shifts';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, type Customer, type DocumentDetailInfo, type DocumentInfo, type Item, link, type Page } from '../api';
import { useConnectivity } from '../connectivity';
import { useT } from '../i18n';
import { printPdf } from '../print';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeDate, Combobox, CountUp, ErrorText, fromCents, Modal, money, Segmented, StatusBadge, store, toCents, useDebounced, usePageTitle, usdOf } from '../ui';
import { searchItems } from './NewDocument';
import { ClockButton } from './TimeClock';

interface LineDiscount { kind: 'percent' | 'amount'; value: string }

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
  discount?: LineDiscount;
  /** The catalog's prices, so the line can follow the customer's price list. */
  retailPrice?: string;
  wholesalePrice?: string | null;
  /** Lower prices from a quantity on (retail customers). */
  breaks?: Array<{ minQuantity: string; unitPrice: string }>;
}

/** 68: a mobile wallet (DigiWallet, E-Kyash): the customer pays on their phone and shows the confirmation. */
type Means = '10' | '48' | '30' | '68' | 'split' | 'account';

interface Sale {
  lines: CartLine[];
  meansCode: Means;
  tendered: string;
  /** The cash came in US dollars (BZ$2 to US$1); change is given in BZ$. */
  usd?: boolean;
  tin: string;
  idempotencyKey: string;
  /** A percentage off every line. */
  discount?: string;
  customer?: { id: string; name: string; tin: string | null; email?: string | null; priceList?: 'retail' | 'wholesale' } | null;
  /** Split payment: the card, transfer or wallet part; cash pays the rest. */
  split?: { means: '48' | '30' | '68'; amount: string };
  /** The wallet's confirmation number, when the cashier types it. */
  walletRef?: string;
  /** The business's service charge is on this sale. */
  service?: boolean;
  /** A tip the customer adds to a card or wallet payment (not part of the sale). */
  tip?: string;
  /** Charged to the customer's account: days until it is due. */
  dueDays?: number;
  /** Loyalty points the customer uses on this sale. */
  redeemPoints?: number;
  /** A gift card paying what it can (checked when it was entered); cash, card or transfer pays the rest. */
  giftCard?: { code: string; last4: string; balance: string };
}

interface HeldSale { id: string; at: string; label: string; total: string; count: number; sale: Sale; heldBy?: string | null }

/** A barcode scanned outside the search box (a CustomEvent<string> on window). */
export const SCAN_EVENT = 'etd:scan';

export interface CounterCart {
  lines: Array<{ name: string; quantity: string; unitPrice: string }>;
  subtotal: string;
  gst: string;
  total: string;
  change: string | null;
  /** The total in US dollars, when the business shows it. */
  usd?: string;
}

let key = 0;
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const MONEY = /^\d+(\.\d{1,2})?$/;
const newSale = (): Sale => ({ lines: [], meansCode: '10', tendered: '', tin: '', idempotencyKey: crypto.randomUUID() });
const fromItem = (it: Item, quantity = '1', wholesale = false): CartLine => ({
  key: ++key, itemId: it.id, name: it.name, quantity, unitCode: it.unitCode, unitPrice: wholesale && it.wholesalePrice ? it.wholesalePrice : it.unitPrice, gstCategory: it.gstCategory,
  retailPrice: it.unitPrice, wholesalePrice: it.wholesalePrice ?? null,
  ...(it.priceBreaks?.length && { breaks: it.priceBreaks }),
  ...(it.exemptionReasonCode && { exemptionReasonCode: it.exemptionReasonCode }),
});
/** The retail price each at this quantity: the best quantity price reached, else the usual price. */
const retailFor = (l: CartLine) => {
  let best = l.retailPrice!;
  for (const b of l.breaks ?? []) if (Number(l.quantity) >= Number(b.minQuantity)) best = b.unitPrice;
  return best;
};
/** Catalog lines follow the customer's price list (lines typed in by hand keep their price). */
const reprice = (lines: CartLine[], wholesale: boolean) => lines.map((l) => (l.custom || !l.retailPrice ? l : { ...l, unitPrice: wholesale && l.wholesalePrice ? l.wholesalePrice : retailFor(l) }));
const addQty = (q: string, delta: number) => {
  const n = Math.round((Number(q) + delta) * 1e6) / 1e6;
  return n > 0 ? String(n) : q;
};
/** Quantity × price, to the cent. */
const lineBase = (l: CartLine) => (DECIMAL.test(l.quantity) && DECIMAL.test(l.unitPrice) ? (toCents(l.unitPrice) * BigInt(Math.round(Number(l.quantity) * 1000))) / 1000n : null);
/** The Belize dollar is pegged: BZ$2 to US$1. */
const USD_RATE = 2n;
/** Amounts to offer for cash received: the exact amount, then the next notes up. */
function quickCash(dueCents: bigint, usd: boolean): bigint[] {
  if (dueCents <= 0n) return [];
  const due = usd ? (dueCents + USD_RATE - 1n) / USD_RATE : dueCents; // in the currency handed over
  const notes = (usd ? [1, 5, 10, 20, 50, 100] : [5, 10, 20, 50, 100]).map((n) => BigInt(n) * 100n);
  const out: bigint[] = [due];
  for (const n of notes) {
    const up = ((due + n - 1n) / n) * n;
    if (up > due && !out.includes(up)) out.push(up);
  }
  return out.slice(0, 4);
}
const percentOk = (v: string | undefined) => Boolean(v && DECIMAL.test(v) && Number(v) > 0 && Number(v) <= 100);
const discountOk = (l: CartLine) => {
  if (!l.discount) return true;
  if (l.discount.kind === 'percent') return percentOk(l.discount.value);
  const base = lineBase(l);
  return MONEY.test(l.discount.value) && toCents(l.discount.value) > 0n && base !== null && toCents(l.discount.value) <= base;
};

export function Counter() {
  const t = useT();
  usePageTitle(t('Counter'));
  const [autoPrint, setAutoPrint] = useState(() => store.get<boolean>('etd.counter.autoprint') ?? false);
  useEffect(() => {
    store.set('etd.counter.autoprint', autoPrint);
  }, [autoPrint]);
  const print = (doc: DocumentInfo) => printPdf(link(`/v1/documents/${doc.id}/pdf?format=${doc.type === '02' ? 'receipt&widthMm=80' : 'sheet'}`));
  return (
    <CounterPanel
      header={(
        <div className="row">
          <div><span className="kicker">{t('Tax receipts')}</span><h1>{t('Counter')}</h1></div>
          <span className="spacer" />
          <ClockButton />
          <label className="row small"><input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} /> {t('Print each receipt automatically')}</label>
        </div>
      )}
      shiftBar={(refreshKey) => <ShiftBar refreshKey={refreshKey} />}
      onIssued={(doc) => {
        if (autoPrint && doc.status !== 'rejected') print(doc);
      }}
      print={print}
      lastSaleActions={(doc) => <Link className="button secondary" to={`/documents/${doc.id}`} viewTransition>{t('Open or send')}</Link>}
    />
  );
}

export function CounterPanel(props: {
  header?: ReactNode;
  shiftBar?: (refreshKey: string | null) => ReactNode;
  /** After a sale is issued: print it, open the drawer. */
  onIssued?: (doc: DocumentInfo, sale: { meansCode: string; change: string | null }) => void;
  print: (doc: DocumentInfo) => void;
  lastSaleActions?: (doc: DocumentInfo) => ReactNode;
  /** More buttons beside "Repeat last sale" (the camera scanner on phones). */
  extraButtons?: ReactNode;
  /** The sale as it changes (the customer display). */
  onCart?: (cart: CounterCart) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { me, session, can } = useSession();
  // On a till without the server: cash, card and transfer only (gift cards, points and accounts need it).
  const { serverFeatures } = useConnectivity();
  // The sale in progress is kept per business and person; never before both are known (a cart kept
  // under no one would come back later with an old sale's idempotency key, and that sale would be lost).
  const storageKey = session ? `etd.counter.${session.business.id}.${session.user.id}` : null;
  // Held sales are shared by every till of the business (they used to stay on the device: those are moved up once).
  const heldKey = `etd.counter.held.${session?.business.id}`;
  const [sale, setSale] = useState<Sale>(() => {
    const saved = storageKey ? store.get<Sale>(storageKey) : null;
    if (saved?.lines) key = Math.max(key, ...saved.lines.map((l) => l.key), 0);
    return saved?.lines ? saved : newSale();
  });
  const [held, setHeld] = useState<HeldSale[]>([]);
  const loadHeld = useCallback(() => api<{ data: HeldSale[] }>('/v1/held-sales').then((r) => setHeld(r.data)).catch(() => {}), []);
  const [favorites, setFavorites] = useState<Item[]>([]);
  // Category tabs over the quick buttons: null shows the quick buttons, a name that category's items.
  const [categories, setCategories] = useState<string[]>([]);
  const [tab, setTab] = useState<string | null>(null);
  const [tabItems, setTabItems] = useState<Item[] | null>(null);
  const [preview, setPreview] = useState<{ totals: DocumentInfo['totals']; lines: Array<{ net: string }> } | null>(null);
  // With points used: the same sale with the reward, for what the customer pays.
  const [rewardPreview, setRewardPreview] = useState<{ key: string; totals: DocumentInfo['totals'] } | null>(null);
  const [points, setPoints] = useState<{ customerId: string; balance: number } | null>(null);
  const [last, setLast] = useState<{ doc: DocumentInfo; change: string | null; email?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [discountFor, setDiscountFor] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'hold' | 'held' | 'discount' | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (storageKey) store.set(storageKey, sale);
  }, [sale, storageKey]);
  useEffect(() => {
    void (async () => {
      // Oldest first; each one leaves the device only once the server has it (the rest wait for the next time).
      const local = [...(store.get<HeldSale[]>(heldKey) ?? [])].reverse();
      while (local.length) {
        const h = local[0]!;
        try {
          await api('/v1/held-sales', { method: 'POST', body: { label: h.label, total: h.total, count: Math.max(1, h.count), sale: h.sale } });
        } catch {
          break;
        }
        local.shift();
        if (local.length) store.set(heldKey, [...local].reverse());
        else store.remove(heldKey);
      }
      await loadHeld();
    })();
    // Other tills hold and recall too: keep the count fresh.
    const timer = setInterval(() => void loadHeld(), 30_000);
    return () => clearInterval(timer);
  }, [heldKey, loadHeld]);
  // Ready to scan as soon as the page opens.
  useEffect(() => {
    const timer = setTimeout(() => search.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    void api<Page<Item>>('/v1/items?favorite=true&limit=24').then(async (r) => {
      setFavorites(r.data.length ? r.data : (await api<Page<Item>>('/v1/items?limit=12')).data);
    }).catch(() => {});
    void api<{ data: Array<{ name: string }> }>('/v1/items/categories').then((r) => setCategories(r.data.map((c) => c.name))).catch(() => {});
  }, []);
  useEffect(() => {
    setTabItems(null);
    if (tab === null) return;
    let live = true;
    void api<Page<Item>>(`/v1/items?category=${encodeURIComponent(tab)}&limit=60`).then((r) => { if (live) setTabItems(r.data); }).catch(() => { if (live) setTabItems([]); });
    return () => { live = false; };
  }, [tab]);
  const buttons = tab === null ? favorites : tabItems ?? [];

  const set = (patch: Partial<Sale>) => setSale((s) => ({ ...s, ...patch }));
  const wholesale = sale.customer?.priceList === 'wholesale';
  // Quantity prices follow the quantity: whenever a line with them changes, its price is worked out again.
  useEffect(() => {
    const next = reprice(sale.lines, wholesale);
    if (next.some((l, i) => l.unitPrice !== sale.lines[i]!.unitPrice && l.breaks)) setSale((s) => ({ ...s, lines: reprice(s.lines, wholesale) }));
  }, [sale.lines, wholesale]);
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
      if (hit) add(fromItem(hit, quantity, wholesale));
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

  const saleDiscount = percentOk(sale.discount) ? sale.discount! : null;
  // The business's service charge, when this sale carries it: a charge on every line, so it is on the receipt with its GST.
  const servicePercent = me?.counter?.serviceChargePercent ?? null;
  const serviceOn = Boolean(servicePercent) && sale.service === true;
  const valid = sale.lines.filter((l) => l.name.trim() && DECIMAL.test(l.quantity) && Number(l.quantity) > 0 && DECIMAL.test(l.unitPrice) && (l.gstCategory !== 'E' || l.exemptionReasonCode) && discountOk(l));
  const linesBody = valid.map((l) => {
    const allowances = [
      ...(l.discount ? [{ isCharge: false, reason: 'Discount', ...(l.discount.kind === 'percent' ? { percent: l.discount.value } : { amount: l.discount.value }) }] : []),
      ...(saleDiscount ? [{ isCharge: false, reason: `Sale discount ${saleDiscount}%`, percent: saleDiscount }] : []),
      ...(serviceOn ? [{ isCharge: true, reason: `Service charge ${servicePercent}%`, percent: servicePercent! }] : []),
    ];
    return {
      ...(l.itemId && !l.custom ? { itemId: l.itemId } : {}),
      description: l.name.trim(),
      quantity: l.quantity,
      unitCode: l.unitCode,
      unitPrice: l.unitPrice,
      gstCategory: l.gstCategory,
      ...(l.gstCategory === 'E' && { exemptionReasonCode: l.exemptionReasonCode }),
      ...(allowances.length && { allowanceCharges: allowances }),
    };
  });
  const previewKey = useDebounced(JSON.stringify(linesBody), 250);
  useEffect(() => {
    const body = JSON.parse(previewKey) as typeof linesBody;
    if (!body.length) return setPreview(null);
    let live = true;
    void api<{ totals: DocumentInfo['totals']; lines: Array<{ net: string }> }>('/v1/documents/preview', { method: 'POST', body: { type: '02', lines: body } })
      .then((p) => live && setPreview(p)).catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [previewKey]);
  // Loyalty: the customer's points, and the sale's total once they use some.
  const loyalty = me?.counter?.loyalty ?? null;
  const customerId = sale.customer?.id ?? null;
  useEffect(() => {
    setPoints(null);
    if (!loyalty || !customerId) return;
    let live = true;
    void api<{ balance: number }>(`/v1/customers/${customerId}/loyalty`).then((r) => live && setPoints({ customerId, balance: r.balance })).catch(() => {});
    return () => {
      live = false;
    };
  }, [customerId, loyalty]);
  const redeem = sale.redeemPoints && customerId ? sale.redeemPoints : 0;
  const rewardKey = redeem ? JSON.stringify([linesBody, customerId, redeem]) : '';
  const rewardDebounced = useDebounced(rewardKey, 250);
  useEffect(() => {
    if (!rewardDebounced) return setRewardPreview(null);
    const [body, cid, n] = JSON.parse(rewardDebounced) as [typeof linesBody, string, number];
    let live = true;
    void api<{ totals: DocumentInfo['totals'] }>('/v1/documents/preview', { method: 'POST', body: { type: '02', customerId: cid, lines: body, redeemPoints: n } })
      .then((p) => live && setRewardPreview({ key: rewardDebounced, totals: p.totals }))
      .catch((e) => {
        if (!live) return;
        setRewardPreview(null);
        setError(e);
        setSale((s) => ({ ...s, redeemPoints: undefined }));
      });
    return () => {
      live = false;
    };
  }, [rewardDebounced]);
  const rewardFresh = !redeem || (rewardPreview !== null && rewardPreview.key === rewardKey);
  const totals = redeem ? (rewardFresh ? rewardPreview!.totals : null) : preview?.totals ?? null;
  const previewFresh = previewKey === JSON.stringify(linesBody) && rewardFresh;

  const total = totals?.taxInclusive ?? '0.00';
  const totalCents = toCents(total);
  // What was taken off, before GST: the lines at full price less the subtotal.
  const fullPrice = valid.reduce((a, l) => a + (lineBase(l) ?? 0n), 0n);
  const chargeCents = totals?.charges ? toCents(totals.charges) : 0n;
  const discounted = totals ? fullPrice + chargeCents - toCents(totals.lineExtension) : 0n;
  const showUsd = Boolean(me?.counter?.showUsd);

  // A gift card pays what it can; the rest is paid by cash, card or transfer (not split, not on account).
  const gift = sale.giftCard ?? null;
  const giftApplied = gift && totals ? (toCents(gift.balance) < totalCents ? toCents(gift.balance) : totalCents) : 0n;
  const rest = totalCents - giftApplied;
  // Payment: cash (with change), card, transfer, split (card or transfer plus cash), or the customer's account.
  const means: Means = (sale.meansCode === 'account' && (!sale.customer || !serverFeatures)) || (gift && (sale.meansCode === 'split' || sale.meansCode === 'account')) ? '10' : sale.meansCode;
  const splitOther = means === 'split' && sale.split && MONEY.test(sale.split.amount) ? toCents(sale.split.amount) : null;
  const splitOk = means !== 'split' || (splitOther !== null && splitOther > 0n && splitOther < totalCents);
  const cashDue = gift && rest === 0n ? null : means === '10' ? rest : means === 'split' && splitOther !== null ? totalCents - splitOther : null;
  // Cash received, in BZ$ (US dollars count double).
  const tenderedBz = DECIMAL.test(sale.tendered) ? toCents(sale.tendered) * (sale.usd ? USD_RATE : 1n) : null;
  const change = cashDue !== null && tenderedBz !== null && totals ? tenderedBz - cashDue : null;
  // A cashier's discounts stay within the business's limit (the server checks it too).
  const limitText = session?.user.role === 'cashier' ? me?.counter?.cashierDiscountLimit ?? null : null;
  const overLimit = limitText !== null && previewFresh && preview !== null && valid.some((l, i) => {
    const base = lineBase(l);
    const net = preview.lines[i]?.net;
    return base !== null && base > 0n && net !== undefined && Number(base - toCents(net)) * 100 > Number(limitText) * Number(base) + 50;
  });
  // A tip rides with a card or wallet payment; cash tips go straight to the staff.
  const tipAllowed = Boolean(me?.counter?.tips) && (means === '48' || means === '68') && !gift;
  const tipOk = !tipAllowed || !sale.tip || MONEY.test(sale.tip);
  const tipCents = tipAllowed && sale.tip && MONEY.test(sale.tip) ? toCents(sale.tip) : 0n;
  const canIssue = tipOk && valid.length > 0 && valid.length === sale.lines.length && Boolean(totals) && previewFresh && Boolean(me?.certificate) && (change === null || change >= 0n) && splitOk && !overLimit;

  const issue = async (e?: FormEvent, overrideCreditLimit = false) => {
    e?.preventDefault();
    if (!canIssue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const onAccount = means === 'account' && sale.customer;
      const days = sale.dueDays ?? 30;
      const body = {
        type: onAccount ? '01' : '02',
        ...(sale.customer ? { customerId: sale.customer.id } : sale.tin.trim() ? { customer: { tin: sale.tin.trim() } } : {}),
        lines: linesBody,
        ...(overrideCreditLimit && { overrideCreditLimit: true }),
        ...(redeem && { redeemPoints: redeem }),
        ...(tipCents > 0n && { tip: { amount: fromCents(tipCents), meansCode: means } }),
        ...(onAccount
          ? { payment: { meansCode: '30', dueDate: belizeDate(days), terms: `Payment due in ${days} days` } }
          : gift
            ? { giftCard: { code: gift.code, amount: fromCents(giftApplied) }, ...(rest > 0n && { tenders: [{ meansCode: '1', amount: fromCents(giftApplied) }, { meansCode: means, amount: fromCents(rest) }] }) }
          : means === 'split'
            ? { tenders: [{ meansCode: sale.split!.means, amount: sale.split!.amount }, { meansCode: '10', amount: fromCents(cashDue!) }] }
            : { payment: { meansCode: means, terms: means === '10' && sale.usd && tenderedBz !== null ? `Paid by cash (US$${fromCents(toCents(sale.tendered))} received)` : means === '68' ? `Paid by mobile wallet${sale.walletRef?.trim() ? ` (ref ${sale.walletRef.trim().slice(0, 40)})` : ''}` : `Paid by ${means === '10' ? 'cash' : means === '48' ? 'card' : 'bank transfer'}` } }),
      };
      const doc = await api<DocumentInfo>('/v1/documents', { method: 'POST', headers: { 'Idempotency-Key': sale.idempotencyKey }, body });
      const changeText = change !== null ? fromCents(change) : null;
      setLast({ doc, change: changeText, email: sale.customer?.email ?? null });
      setSale(newSale());
      setDiscountFor(null);
      if (doc.status === 'rejected') toast(t('Rejected by BTS'), 'bad');
      props.onIssued?.(doc, { meansCode: gift && rest === 0n ? '1' : means === 'split' ? '10' : means === 'account' ? '30' : means, change: changeText });
      focusSearch();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // ---------- holding sales ----------

  const putOnHold = (label: string, s: Sale) => api<HeldSale>('/v1/held-sales', { method: 'POST', body: { label: label.trim(), total: totals ? total : fromCents(fullPrice), count: s.lines.length, sale: s } });
  const holdCurrent = async (label: string) => {
    if (!sale.lines.length) return;
    try {
      await putOnHold(label, { ...sale, giftCard: undefined });
    } catch (e) {
      setError(e);
      return;
    }
    setSale(newSale());
    setDiscountFor(null);
    setLast(null);
    toast(t('Sale held. Recall it from Held sales, at any till.'));
    void loadHeld();
    focusSearch();
  };
  const recall = async (h: HeldSale) => {
    let got: HeldSale;
    try {
      // A sale in progress is held in its place, not lost.
      if (sale.lines.length) await putOnHold('', { ...sale, giftCard: undefined });
      got = await api<HeldSale>(`/v1/held-sales/${h.id}/recall`, { method: 'POST' });
    } catch (e) {
      setError(e);
      setDialog(null);
      void loadHeld();
      return;
    }
    key = Math.max(key, ...got.sale.lines.map((l) => l.key), 0);
    // A fresh key: the held sale was never sent.
    setSale({ ...got.sale, idempotencyKey: crypto.randomUUID() });
    setDialog(null);
    setLast(null);
    if (sale.lines.length) toast(t('The sale you had open is held.'), 'info');
    void loadHeld();
    focusSearch();
  };
  const deleteHeld = async (h: HeldSale) => {
    setHeld((list) => list.filter((x) => x.id !== h.id));
    await api(`/v1/held-sales/${h.id}`, { method: 'DELETE' }).catch(() => {});
    void loadHeld();
  };

  // Shortcuts: F2 or Ctrl+Enter issues; in the empty search box, + and - change the last line's quantity and Delete removes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      if (e.key === 'F2' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        void issue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // A barcode scanner read while the search box did not have focus (the till listens for it page-wide).
  useEffect(() => {
    const onScan = (e: Event) => void enter((e as CustomEvent<string>).detail);
    window.addEventListener(SCAN_EVENT, onScan);
    return () => window.removeEventListener(SCAN_EVENT, onScan);
  });
  // The customer display follows the sale.
  const onCart = props.onCart;
  const cartKey = JSON.stringify([sale.lines.map((l) => [l.name, l.quantity, l.unitPrice]), totals, change === null ? null : String(change)]);
  useEffect(() => {
    onCart?.({
      lines: sale.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice })),
      subtotal: totals?.lineExtension ?? '0.00',
      gst: totals?.gst ?? '0.00',
      total,
      change: change !== null && change >= 0n ? fromCents(change) : null,
      ...(showUsd && { usd: usdOf(total) }),
    });
    // Only when what the customer sees changes.
  }, [cartKey, onCart]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchKeys = (e: React.KeyboardEvent) => {
    const input = e.target as HTMLInputElement;
    const lastLine = sale.lines.at(-1);
    if (input.value || !lastLine) return;
    if (e.key === 'Delete') {
      e.preventDefault();
      remove(lastLine.key);
    }
  };

  const meansOptions: Array<[Means, string]> = [['10', t('Cash')], ['48', t('Card')], ['30', t('Transfer')], ['68', t('Wallet')], ...(sale.giftCard ? [] : [['split', t('Split')] as [Means, string], ...(sale.customer && serverFeatures ? [['account', t('On account')] as [Means, string]] : [])])];
  const lineNet = (l: CartLine) => {
    const i = valid.indexOf(l);
    if (previewFresh && preview && i >= 0 && preview.lines[i]) return preview.lines[i]!.net;
    const base = lineBase(l);
    return base === null ? '' : fromCents(base);
  };

  return (
    <div className="stack">
      {props.header}
      {!me?.certificate && <div className="banner bad"><div><strong>{t('Install your BTS certificate in Settings before issuing.')}</strong></div></div>}
      {props.shiftBar?.(last?.doc.id ?? null)}

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
                  add(fromItem(it, '1', wholesale));
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
          {categories.length > 0 && (
            <div className="quick-tabs" role="group" aria-label={t('Categories')}>
              <button type="button" aria-pressed={tab === null} onClick={() => setTab(null)}>★ {t('Quick')}</button>
              {categories.map((c) => <button key={c} type="button" aria-pressed={tab === c} onClick={() => setTab(c)}>{c}</button>)}
            </div>
          )}
          {tab !== null && tabItems === null && <div className="quick-grid"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
          {tab !== null && tabItems?.length === 0 && <p className="small muted">{t('No items in this category.')}</p>}
          {buttons.length > 0 && (
            <div className="quick-grid" role="group" aria-label={tab ?? t('Quick buttons')}>
              {buttons.map((it) => (
                <button key={it.id} type="button" className="quick" onClick={() => { add(fromItem(it, '1', wholesale)); focusSearch(); }}>
                  <span className="name">{it.name}</span>
                  <span className="price num">{money(it.unitPrice)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="row counter-actions">
            <button type="button" className="secondary" onClick={() => void repeatLast()}>{t('Repeat last sale')}</button>
            <button type="button" className="secondary" onClick={() => add({ key: ++key, name: '', quantity: '1', unitCode: 'H87', unitPrice: '', gstCategory: 'S', custom: true })}>+ {t('Custom item')}</button>
            <button type="button" className="secondary" disabled={!sale.lines.length} onClick={() => setDialog('hold')}>{t('Hold sale')}</button>
            <button type="button" className="secondary" disabled={!held.length} onClick={() => { void loadHeld(); setDialog('held'); }}>
              {t('Held sales')}{held.length > 0 && <span className="chip">{held.length}</span>}
            </button>
            {props.extraButtons}
          </div>
          {last && (
            <div className={`card last-sale ${last.doc.status}`} role="status">
              <div className="row">
                <div>
                  <span className="kicker">{last.doc.type === '01' ? t('Last sale, on account') : t('Last sale')}</span>
                  <h2 className="num">{last.doc.series}-{last.doc.number} · {money(last.doc.totals.payable)}</h2>
                  {last.change && <p className="change">{t('Change')}: <strong className="num">{money(last.change)}</strong></p>}
                </div>
                <span className="spacer" />
                <StatusBadge status={last.doc.status} />
              </div>
              <div className="row">
                {['authorized', 'authorized_with_alert', 'contingency_pending'].includes(last.doc.status) && (
                  <button type="button" onClick={() => props.print(last.doc)}>{last.doc.type === '01' ? t('Print invoice') : t('Print receipt')}</button>
                )}
                {props.lastSaleActions?.(last.doc)}
              </div>
              {serverFeatures && ['authorized', 'authorized_with_alert', 'contingency_pending'].includes(last.doc.status) && <EmailReceipt key={last.doc.id} doc={last.doc} initial={last.email ?? ''} />}
            </div>
          )}
        </div>

        <form className="card ticket cart stack" onSubmit={issue}>
          <span className="kicker">{means === 'account' ? t('Tax invoice, on account') : t('Tax receipt')} · BZD</span>
          {sale.lines.length === 0 ? <p className="cart-empty">{t('Scan or pick items to start a sale.')}</p> : (
            <ul className="cart-lines">
              {sale.lines.map((l) => (
                <li key={l.key} className={l.discount ? 'has-discount' : ''}>
                  {l.custom ? (
                    <div className="custom">
                      <input aria-label={t('Description')} placeholder={t('Description')} value={l.name} onChange={(e) => update(l.key, { name: e.target.value })} />
                      <input aria-label={t('Price (BZ$)')} placeholder="0.00" inputMode="decimal" value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
                    </div>
                  ) : (
                    <span className="name">
                      {l.name}<span className="each num"> · {money(l.unitPrice)}</span>
                      {l.discount && discountOk(l) && <span className="line-discount num">{l.discount.kind === 'percent' ? t('{n}% off', { n: l.discount.value }) : t('{amount} off', { amount: money(l.discount.value) })}</span>}
                    </span>
                  )}
                  <div className="qty">
                    <button type="button" aria-label={t('One less {name}', { name: l.name })} onClick={() => update(l.key, { quantity: addQty(l.quantity, -1) })}>−</button>
                    <input aria-label={t('Quantity of {name}', { name: l.name })} inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                    <button type="button" aria-label={t('One more {name}', { name: l.name })} onClick={() => update(l.key, { quantity: addQty(l.quantity, 1) })}>+</button>
                  </div>
                  <span className="sum num">{lineNet(l) && money(lineNet(l))}</span>
                  <button type="button" className={`disc ${l.discount ? 'on' : ''}`} aria-label={t('Discount on {name}', { name: l.name || t('item') })} aria-expanded={discountFor === l.key} onClick={() => setDiscountFor((k) => (k === l.key ? null : l.key))}>%</button>
                  <button type="button" className="remove" aria-label={t('Remove {name}', { name: l.name || t('item') })} onClick={() => remove(l.key)}>×</button>
                  {discountFor === l.key && <LineDiscountEditor line={l} onChange={(d) => update(l.key, { discount: d })} onDone={() => { setDiscountFor(null); focusSearch(); }} />}
                </li>
              ))}
            </ul>
          )}
          <div><span>{t('Subtotal')}</span><span>{money(fromCents(toCents(totals?.lineExtension ?? '0.00') - chargeCents))}</span></div>
          {chargeCents > 0n && <div className="cart-service"><span>{t('Service charge ({n}%)', { n: servicePercent ?? '' })}</span><span>{money(fromCents(chargeCents))}</span></div>}
          {discounted > 0n && <div className="cart-discount"><span>{saleDiscount ? t('Discounts (incl. {n}% on the sale)', { n: saleDiscount }) : t('Discounts')}</span><span>−{money(fromCents(discounted))}</span></div>}
          <div><span>GST</span><span>{money(totals?.gst ?? '0.00')}</span></div>
          <div className="grand"><span>{t('Total')}</span><span aria-live="polite"><CountUp value={Number(totalCents)} duration={420} format={(n) => money(fromCents(BigInt(Math.round(n))))} /></span></div>
          {showUsd && totalCents > 0n && <div className="grand-usd"><span>{t('In US dollars')}</span><span>US${usdOf(total)}</span></div>}
          {sale.lines.length > 0 && (
            <button type="button" className="link on-dark cart-sale-discount" onClick={() => setDialog('discount')}>
              {saleDiscount ? t('Sale discount: {n}% (change)', { n: saleDiscount }) : t('Discount the whole sale')}
            </button>
          )}
          {sale.lines.length > 0 && servicePercent && (
            <button type="button" className="link on-dark cart-sale-discount" aria-pressed={serviceOn} onClick={() => set({ service: !serviceOn })}>
              {serviceOn ? t('Service charge {n}%: on (remove)', { n: servicePercent }) : t('Add the service charge ({n}%)', { n: servicePercent })}
            </button>
          )}

          <CustomerPicker
            customer={sale.customer ?? null}
            tin={sale.tin}
            onCustomer={(c) => setSale((s) => ({ ...s, customer: c, redeemPoints: undefined, lines: reprice(s.lines, c?.priceList === 'wholesale'), ...(c === null && s.meansCode === 'account' && { meansCode: '10' as Means }) }))}
            onTin={(tin) => set({ tin })}
          />
          {loyalty && sale.customer && points && points.customerId === sale.customer.id && (() => {
            // As many points as the sale allows (its total without the reward), at most what they have.
            const plain = preview?.totals ? toCents(preview.totals.taxInclusive) : 0n;
            const valueCents = Math.round(Number(loyalty.pointValue) * 100);
            const usable = valueCents > 0 ? Math.min(points.balance, Math.floor(Number(plain) / valueCents)) : 0;
            const worth = (n: number) => money(fromCents(BigInt(Math.round(n * Number(loyalty.pointValue) * 100))));
            return (
              <div className="tender points">
                <span>{redeem ? t('Using {n} points: {amount} off', { n: redeem, amount: worth(redeem) }) : t('{n} points ({amount})', { n: points.balance, amount: worth(points.balance) })}</span>
                {redeem
                  ? <button type="button" className="link on-dark" onClick={() => set({ redeemPoints: undefined })}>{t('Don’t use')}</button>
                  : <button type="button" className="secondary" disabled={usable < Math.max(1, loyalty.minRedeem) || !sale.lines.length} onClick={() => set({ redeemPoints: usable })}>{t('Use points')}</button>}
                {!redeem && points.balance > 0 && points.balance < loyalty.minRedeem && <span className="small">{t('At least {n} to use', { n: loyalty.minRedeem })}</span>}
              </div>
            );
          })()}

          {serverFeatures || gift
            ? <GiftCardTender gift={gift} applied={giftApplied} rest={rest} disabled={!sale.lines.length || !serverFeatures} onUse={(g) => set({ giftCard: g })} onRemove={() => set({ giftCard: undefined })} />
            : <p className="small offline-note">{t('Offline: cash, card and transfer sales work and are sent when the connection is back. Gift cards, points and sales on account need a connection.')}</p>}
          {!(gift && rest === 0n) && <Segmented label={gift ? t('The rest') : t('Payment')} value={means} onChange={(v) => set({ meansCode: v })} options={meansOptions} />}
          {means === 'split' && (
            <div className="tender split">
              <label>
                <select aria-label={t('Paid with')} value={sale.split?.means ?? '48'} onChange={(e) => set({ split: { means: e.target.value as '48' | '30' | '68', amount: sale.split?.amount ?? '' } })}>
                  <option value="48">{t('Card')}</option>
                  <option value="30">{t('Transfer')}</option>
                  <option value="68">{t('Wallet')}</option>
                </select>
                <input inputMode="decimal" placeholder="0.00" aria-label={t('Amount by card or transfer')} value={sale.split?.amount ?? ''} onChange={(e) => set({ split: { means: sale.split?.means ?? '48', amount: e.target.value } })} />
              </label>
              <span>{cashDue !== null && splitOk ? t('Cash: {amount}', { amount: money(fromCents(cashDue)) }) : sale.split?.amount ? t('Less than the total, please') : ''}</span>
            </div>
          )}
          {((means === '10' && cashDue !== null) || (means === 'split' && splitOk && cashDue !== null)) && (
            <div className="tender-block">
              <div className="tender">
                <div className="tender-field">
                  <span className="tender-label">
                    <span>{t('Cash received')}</span>
                    <span className="currency-switch" role="group" aria-label={t('Currency of the cash')}>
                      <button type="button" aria-pressed={!sale.usd} onClick={() => set({ usd: false })}>BZ$</button>
                      <button type="button" aria-pressed={Boolean(sale.usd)} onClick={() => set({ usd: true })}>US$</button>
                    </span>
                  </span>
                  <input inputMode="decimal" placeholder="0.00" aria-label={t('Cash received')} value={sale.tendered} onChange={(e) => set({ tendered: e.target.value })} />
                </div>
                <span className={change !== null && change < 0n ? 'short' : ''}>{change === null ? '' : change < 0n ? t('Short {amount}', { amount: money(fromCents(-change)) }) : `${t('Change')} ${money(fromCents(change))}`}</span>
              </div>
              {sale.usd && tenderedBz !== null && <p className="usd-note">{t('US${usd} is {bz} (BZ$2 to US$1). Change in BZ$.', { usd: fromCents(toCents(sale.tendered)), bz: money(fromCents(tenderedBz)) })}</p>}
              {cashDue !== null && cashDue > 0n && (
                <div className="quick-cash" role="group" aria-label={t('Quick amounts')}>
                  {quickCash(cashDue, Boolean(sale.usd)).map((a, i) => (
                    <button key={String(a)} type="button" onClick={() => set({ tendered: fromCents(a) })}>{i === 0 ? t('Exact') : `${sale.usd ? 'US$' : 'BZ$'}${Number(a / 100n)}`}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {means === '68' && (
            <div className="tender wallet">
              <label>
                <span>{t('Wallet reference (optional)')}</span>
                <input aria-label={t('Wallet reference (optional)')} value={sale.walletRef ?? ''} maxLength={40} autoComplete="off" onChange={(e) => set({ walletRef: e.target.value })} />
              </label>
              <span className="small muted">{t('The number the customer’s DigiWallet or E-Kyash shows after paying. It prints on the receipt.')}</span>
            </div>
          )}
          {tipAllowed && (
            <div className="tender wallet">
              <label>
                <span>{t('Tip (optional)')}</span>
                <input inputMode="decimal" placeholder="0.00" aria-label={t('Tip (optional)')} value={sale.tip ?? ''} onChange={(e) => set({ tip: e.target.value })} />
              </label>
              <span className="small muted">
                {tipCents > 0n ? t('Charge {amount} in all. The tip is not on the receipt.', { amount: money(fromCents(rest + tipCents)) }) : t('What the customer adds for the staff. It is not on the receipt.')}
              </span>
            </div>
          )}
          {means === 'account' && sale.customer && (
            <div className="tender account">
              <span>{t('Invoice {name}, due in', { name: sale.customer.name })}</span>
              <Segmented label={t('Due in')} value={String(sale.dueDays ?? 30)} onChange={(v) => set({ dueDays: Number(v) })} options={[['7', t('{n} days', { n: 7 })], ['15', t('{n} days', { n: 15 })], ['30', t('{n} days', { n: 30 })]]} />
            </div>
          )}
          {overLimit && <p className="form-error" role="alert">{t('You can take up to {n}% off a line. Ask a manager to make this sale.', { n: limitText! })}</p>}
          <ErrorText error={error} />
          {error instanceof ApiError && error.code === 'credit_limit' && can('documents.adjust') && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void issue(undefined, true)}>{t('Allow it this time')}</button>
          )}
          <button type="submit" className="big lime" disabled={!canIssue || busy}>
            {busy ? t('Signing and sending…') : means === 'account' ? t('Issue invoice') : t('Issue receipt')}<span className="chip" aria-hidden="true">F2</span>
          </button>
          {sale.lines.length > 0 && <button type="button" className="link on-dark" onClick={() => { setSale(newSale()); setDiscountFor(null); focusSearch(); }}>{t('Clear sale')}</button>}
        </form>
      </div>

      {dialog === 'hold' && <HoldDialog onHold={(label) => { void holdCurrent(label); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog === 'held' && (
        <HeldDialog
          held={held}
          onRecall={recall}
          onDelete={(h) => void deleteHeld(h)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'discount' && (
        <SaleDiscountDialog
          value={sale.discount ?? ''}
          onSave={(v) => { set({ discount: v || undefined }); setDialog(null); focusSearch(); }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** Paying with a gift card: its code, checked; then what it pays and what is left. */
function GiftCardTender({ gift, applied, rest, disabled, onUse, onRemove }: {
  gift: Sale['giftCard'] | null; applied: bigint; rest: bigint; disabled: boolean;
  onUse: (g: NonNullable<Sale['giftCard']>) => void; onRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (gift) {
    return (
      <div className="tender gift">
        <span>{t('Gift card ••••{last4} pays {amount}', { last4: gift.last4, amount: money(fromCents(applied)) })}<span className="small"> · {rest === 0n ? t('{amount} left on the card', { amount: money(fromCents(toCents(gift.balance) - applied)) }) : t('the card is used up')}</span></span>
        <button type="button" className="link on-dark" onClick={onRemove}>{t('Remove')}</button>
      </div>
    );
  }
  if (!open) return <button type="button" className="link on-dark gift-link" disabled={disabled} onClick={() => setOpen(true)}>{t('Pay with a gift card')}</button>;
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ card: { last4: string; balance: string } }>('/v1/gift-cards/check', { method: 'POST', body: { code: code.trim() } });
      onUse({ code: code.trim(), last4: r.card.last4, balance: r.card.balance });
      setOpen(false);
      setCode('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tender gift stack">
      <div className="row">
        <input aria-label={t('Gift card code')} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (code.trim()) void check(); } if (e.key === 'Escape') setOpen(false); }} />
        <button type="button" className="secondary" disabled={busy || !code.trim()} onClick={() => void check()}>{busy ? t('Checking…') : t('Use card')}</button>
        <button type="button" className="link on-dark" onClick={() => { setOpen(false); setError(null); }}>{t('Cancel')}</button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/** Email the receipt (PDF and signed XML) from the counter: to the customer's saved address, or one typed in. */
function EmailReceipt({ doc, initial }: { doc: DocumentInfo; initial: string }) {
  const t = useT();
  const toast = useToast();
  const [to, setTo] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!to.trim() || busy) return;
    setBusy(true);
    try {
      await api(`/v1/documents/${doc.id}/email`, { method: 'POST', body: { to: to.trim() } });
      setSent(to.trim());
      toast(t('Sent to {email}', { email: to.trim() }));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (sent) return <p className="small muted email-sent">{t('Emailed to {email}.', { email: sent })}</p>;
  return (
    <form className="email-receipt" onSubmit={send}>
      <input type="email" inputMode="email" autoComplete="off" aria-label={t('Customer email')} placeholder={t('Email it to the customer')} value={to} onChange={(e) => setTo(e.target.value)} />
      <button type="submit" className="secondary" disabled={!to.trim() || busy}>{busy ? t('Sending…') : t('Email')}</button>
    </form>
  );
}

/** A discount on one line: a percentage, or an amount off the line. */
function LineDiscountEditor({ line, onChange, onDone }: { line: CartLine; onChange: (d: LineDiscount | undefined) => void; onDone: () => void }) {
  const t = useT();
  const d = line.discount ?? { kind: 'percent' as const, value: '' };
  const ok = !line.discount || discountOk(line);
  return (
    <div className="line-discount-editor" role="group" aria-label={t('Discount on {name}', { name: line.name })}>
      <Segmented label={t('Kind of discount')} value={d.kind} onChange={(kind) => onChange({ kind, value: d.value })} options={[['percent', '%'], ['amount', 'BZ$']]} />
      <input
        autoFocus
        inputMode="decimal"
        aria-label={d.kind === 'percent' ? t('Percent off') : t('Amount off')}
        placeholder={d.kind === 'percent' ? '10' : '0.00'}
        value={d.value}
        onChange={(e) => onChange(e.target.value ? { kind: d.kind, value: e.target.value } : undefined)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
      />
      {[5, 10, 15, 20].map((p) => (
        <button key={p} type="button" className="preset" onClick={() => { onChange({ kind: 'percent', value: String(p) }); onDone(); }}>{p}%</button>
      ))}
      {line.discount && <button type="button" className="link on-dark" onClick={() => { onChange(undefined); onDone(); }}>{t('Remove')}</button>}
      {!ok && <span className="short">{d.kind === 'percent' ? t('1 to 100%') : t('Up to the line\'s amount')}</span>}
    </div>
  );
}

function SaleDiscountDialog({ value, onSave, onClose }: { value: string; onSave: (v: string) => void; onClose: () => void }) {
  const t = useT();
  const [v, setV] = useState(value);
  const ok = !v || percentOk(v);
  return (
    <Modal title={t('Discount the whole sale')} onClose={onClose}>
      <p className="muted small">{t('A percentage off every line, shown on the receipt.')}</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(v); }}>
        <div className="row">
          {[5, 10, 15, 20, 25].map((p) => <button key={p} type="button" className={`secondary ${v === String(p) ? 'active' : ''}`} onClick={() => setV(String(p))}>{p}%</button>)}
        </div>
        <label className="field">
          <span>{t('Percent off')}</span>
          <input autoFocus inputMode="decimal" placeholder="10" value={v} onChange={(e) => setV(e.target.value)} />
        </label>
        {!ok && <p className="form-error">{t('1 to 100%')}</p>}
        <div className="row end">
          {value && <button type="button" className="secondary" onClick={() => onSave('')}>{t('No discount')}</button>}
          <button type="submit" disabled={!ok}>{t('Apply')}</button>
        </div>
      </form>
    </Modal>
  );
}

function HoldDialog({ onHold, onClose }: { onHold: (label: string) => void; onClose: () => void }) {
  const t = useT();
  const [label, setLabel] = useState('');
  return (
    <Modal title={t('Hold this sale')} onClose={onClose}>
      <p className="muted small">{t('Serve the next customer, and recall this sale when they are ready. It stays on this device.')}</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onHold(label); }}>
        <label className="field">
          <span>{t('Name it (optional)')}</span>
          <input autoFocus maxLength={60} placeholder={t('Table 4, Maria, blue truck…')} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit">{t('Hold sale')}</button>
        </div>
      </form>
    </Modal>
  );
}

function HeldDialog({ held, onRecall, onDelete, onClose }: { held: HeldSale[]; onRecall: (h: HeldSale) => void; onDelete: (h: HeldSale) => void; onClose: () => void }) {
  const t = useT();
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return (
    <Modal title={t('Held sales')} onClose={onClose}>
      {held.length === 0 ? <p className="muted">{t('No sales on hold.')}</p> : (
        <ul className="held-list">
          {held.map((h) => (
            <li key={h.id}>
              <div>
                <strong>{h.label || t('Sale at {time}', { time: time(h.at) })}</strong>
                <span className="muted small">{h.count === 1 ? t('1 item') : t('{n} items', { n: h.count })} · {money(h.total)}{h.label ? ` · ${time(h.at)}` : ''}{h.sale.customer ? ` · ${h.sale.customer.name}` : ''}{h.heldBy ? ` · ${t('held by {name}', { name: h.heldBy })}` : ''}</span>
              </div>
              <span className="spacer" />
              <button type="button" className="icon-button" aria-label={t('Delete {name}', { name: h.label || t('this sale') })} onClick={() => onDelete(h)}>×</button>
              <button type="button" onClick={() => onRecall(h)}>{t('Recall')}</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** A saved customer on the sale (or just their TIN on the receipt). */
function CustomerPicker({ customer, tin, onCustomer, onTin }: {
  customer: { id: string; name: string; tin: string | null; email?: string | null; priceList?: 'retail' | 'wholesale' } | null;
  tin: string;
  onCustomer: (c: { id: string; name: string; tin: string | null; email?: string | null; priceList?: 'retail' | 'wholesale' } | null) => void;
  onTin: (tin: string) => void;
}) {
  const t = useT();
  if (customer) {
    return (
      <div className="cart-customer">
        <span className="cart-customer-name"><span className="kicker">{customer.priceList === 'wholesale' ? t('Customer · wholesale prices') : t('Customer')}</span>{customer.name}{customer.tin && <span className="muted"> · TIN {customer.tin}</span>}</span>
        <button type="button" className="remove" aria-label={t('Remove the customer')} onClick={() => onCustomer(null)}>×</button>
      </div>
    );
  }
  return (
    <details className="tin" open={Boolean(tin)}>
      <summary>{t('Customer on the receipt')}</summary>
      <Combobox<Customer>
        label={t('Saved customer')}
        placeholder={t('Search by name or TIN')}
        search={(q) => api<Page<Customer>>(`/v1/customers?limit=6&q=${encodeURIComponent(q)}`).then((r) => r.data)}
        render={(c) => <><strong>{c.name}</strong>{c.tin && <span className="muted"> · TIN {c.tin}</span>}</>}
        onPick={(c) => onCustomer({ id: c.id, name: c.name, tin: c.tin, email: c.contact.email, priceList: c.priceList ?? 'retail' })}
      />
      <label className="cart-tin">
        <span>{t('Or just their TIN')}</span>
        <input inputMode="numeric" pattern="\d{6}" maxLength={6} aria-label={t('Customer TIN (optional)')} value={tin} onChange={(e) => onTin(e.target.value)} />
      </label>
    </details>
  );
}
