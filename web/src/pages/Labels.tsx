/**
 * Labels: price tags and barcode labels for items, printed on an A4 sheet of 24 (70 x 37 mm,
 * the common sticker sheets) or one per label on a 50 x 30 mm label printer. Each label has the
 * item's name, its price with GST, and its barcode (EAN-13 when the barcode is one, Code 128
 * otherwise; the item's own code when it has no barcode).
 */

import JsBarcode from 'jsbarcode';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, type Item } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { Combobox, money, Segmented, usePageTitle } from '../ui';
import { searchItems } from './NewDocument';

type Format = 'sheet' | 'roll';
interface Row { item: Item; copies: number }

/** The price a customer pays: GST added on standard-rated items. */
export const priceWithGst = (item: Pick<Item, 'unitPrice' | 'gstCategory'>) => {
  const net = Math.round(Number(item.unitPrice) * 100);
  return ((item.gstCategory === 'S' ? Math.round(net * 1.125) : net) / 100).toFixed(2);
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A barcode as SVG markup: EAN-13 for a valid 13-digit code, Code 128 for anything else. Empty when it cannot be drawn. */
export function barcodeSvg(value: string, height = 34): string {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const ean = /^\d{13}$/.test(value);
  for (const format of ean ? ['EAN13', 'CODE128'] : ['CODE128']) {
    try {
      JsBarcode(svg, value, { format, height, width: 1.5, margin: 0, fontSize: 11, textMargin: 1, displayValue: true, background: 'transparent' });
      return svg.outerHTML;
    } catch {
      // Not a valid EAN-13 (its check digit): Code 128 instead.
    }
  }
  return '';
}

function labelHtml(item: Item, business: string, show: { business: boolean; barcode: boolean }): string {
  const code = item.barcode ?? item.sellerCode ?? '';
  const bars = show.barcode && code ? barcodeSvg(code) : '';
  return `<div class="label">${show.business ? `<div class="biz">${escapeHtml(business)}</div>` : ''}<div class="name">${escapeHtml(item.name)}</div>`
    + `<div class="price">BZ$${priceWithGst(item)}</div>${bars ? `<div class="bars">${bars}</div>` : ''}</div>`;
}

const SHEET_CSS = `@page { size: A4; margin: 10mm 7mm; }
body { margin: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #000; }
.labels { display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 37mm; }
.label { box-sizing: border-box; height: 37mm; padding: 2.5mm 3mm; display: flex; flex-direction: column; overflow: hidden; page-break-inside: avoid; }`;
const ROLL_CSS = `@page { size: 50mm 30mm; margin: 0; }
body { margin: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #000; }
.label { box-sizing: border-box; width: 50mm; height: 30mm; padding: 1.5mm 2mm; display: flex; flex-direction: column; overflow: hidden; page-break-after: always; }`;
const LABEL_CSS = `.biz { font-size: 6.5pt; color: #444; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name { font-size: 9pt; font-weight: 600; line-height: 1.15; max-height: 2.3em; overflow: hidden; }
.price { font-size: 15pt; font-weight: 800; letter-spacing: -0.01em; margin: 0.6mm 0; }
.bars { margin-top: auto; line-height: 0; }
.bars svg { max-width: 100%; height: auto; max-height: 13mm; }`;

/** The whole printable page, for the print frame and the preview. */
export function labelsDocument(rows: Row[], format: Format, business: string, show: { business: boolean; barcode: boolean }): string {
  const labels = rows.flatMap((r) => Array.from({ length: r.copies }, () => labelHtml(r.item, business, show))).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>${format === 'sheet' ? SHEET_CSS : ROLL_CSS}${LABEL_CSS}</style></head>`
    + `<body><div class="labels">${labels}</div></body></html>`;
}

function printHtml(html: string) {
  document.querySelectorAll('iframe.print-frame').forEach((f) => f.remove());
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.title = 'Print';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  }, 250);
}

export function Labels() {
  const t = useT();
  usePageTitle(t('Labels'));
  const { me, session } = useSession();
  const business = me?.tradeName ?? me?.legalName ?? session?.business.tradeName ?? session?.business.legalName ?? '';
  const [params] = useSearchParams();
  const [rows, setRows] = useState<Row[]>([]);
  const [format, setFormat] = useState<Format>('sheet');
  const [show, setShow] = useState({ business: true, barcode: true });

  // Items chosen elsewhere (the item list): ?items=id,id
  useEffect(() => {
    const ids = (params.get('items') ?? '').split(',').filter(Boolean).slice(0, 100);
    if (!ids.length) return;
    void Promise.all(ids.map((id) => api<Item>(`/v1/items/${id}`).catch(() => null))).then((items) => {
      setRows(items.filter((i): i is Item => Boolean(i)).map((item) => ({ item, copies: 1 })));
    });
  }, [params]);

  const add = (item: Item) => setRows((r) => (r.some((x) => x.item.id === item.id) ? r.map((x) => (x.item.id === item.id ? { ...x, copies: x.copies + 1 } : x)) : [...r, { item, copies: 1 }]));
  const total = rows.reduce((a, r) => a + r.copies, 0);
  const html = useMemo(() => labelsDocument(rows, format, business, show), [rows, format, business, show]);
  const sheets = format === 'sheet' ? Math.ceil(total / 24) : total;

  return (
    <div className="stack">
      <div className="row">
        <div><span className="kicker">{t('Products')}</span><h1>{t('Labels')}</h1></div>
        <span className="spacer" />
        <button type="button" disabled={!total} onClick={() => printHtml(html)}>{total === 1 ? t('Print 1 label') : t('Print {n} labels', { n: total })}</button>
      </div>
      <div className="labels-layout">
        <section className="card stack">
          <Combobox<Item>
            label={t('Add an item')}
            placeholder={t('Search by name, code or barcode')}
            clearOnPick
            search={(q) => searchItems(q)}
            render={(it) => <><strong>{it.name}</strong> <span className="muted">· {money(priceWithGst(it))}{it.barcode ? ` · ${it.barcode}` : it.sellerCode ? ` · ${it.sellerCode}` : ''}</span></>}
            onPick={add}
          />
          {rows.length === 0 ? <p className="muted">{t('Add the items to label. Each label shows the price with GST.')}</p> : (
            <ul className="label-rows">
              {rows.map((r) => (
                <li key={r.item.id}>
                  <div>
                    <strong>{r.item.name}</strong>
                    <span className="muted small">{money(priceWithGst(r.item))} · {r.item.barcode ?? r.item.sellerCode ?? t('no barcode')}</span>
                  </div>
                  <label className="label-copies">
                    <span className="sr-only">{t('Labels for {name}', { name: r.item.name })}</span>
                    <input type="number" min={1} max={500} value={r.copies} aria-label={t('Labels for {name}', { name: r.item.name })} onChange={(e) => setRows((list) => list.map((x) => (x.item.id === r.item.id ? { ...x, copies: Math.max(1, Math.min(500, Number(e.target.value) || 1)) } : x)))} />
                  </label>
                  <button type="button" className="icon-button" aria-label={t('Remove {name}', { name: r.item.name })} onClick={() => setRows((list) => list.filter((x) => x.item.id !== r.item.id))}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="stack label-options">
            <Segmented label={t('Paper')} value={format} onChange={setFormat} options={[['sheet', t('A4 sheet of 24')], ['roll', t('Label printer, 50 × 30 mm')]]} />
            <label className="row small"><input type="checkbox" checked={show.business} onChange={(e) => setShow((s) => ({ ...s, business: e.target.checked }))} /> {t('Business name on each label')}</label>
            <label className="row small"><input type="checkbox" checked={show.barcode} onChange={(e) => setShow((s) => ({ ...s, barcode: e.target.checked }))} /> {t('Barcode')}</label>
            {total > 0 && <p className="small muted">{format === 'sheet' ? (sheets === 1 ? t('{n} labels on 1 sheet', { n: total }) : t('{n} labels on {s} sheets', { n: total, s: sheets })) : t('{n} labels', { n: total })}</p>}
          </div>
        </section>
        <section className="card labels-preview" aria-label={t('Preview')}>
          {total === 0 ? <p className="muted">{t('The labels will show here.')}</p> : <LabelsPreview html={html} format={format} />}
        </section>
      </div>
    </div>
  );
}

function LabelsPreview({ html, format }: { html: string; format: Format }) {
  const t = useT();
  return (
    <iframe
      className={`labels-frame ${format}`}
      title={t('Labels preview')}
      sandbox="allow-same-origin"
      srcDoc={html.replace('</style>', `${format === 'sheet' ? '@media screen and (max-width: 800px) { html { zoom: 0.8; } } @media screen and (max-width: 640px) { html { zoom: 0.6; } } @media screen and (max-width: 480px) { html { zoom: 0.45; } }' : ''} @media screen { body { background: #eef0f3; padding: 12px; } .labels { ${format === 'sheet' ? 'background: #fff; width: 196mm; box-shadow: 0 2px 10px rgba(0,0,0,.12);' : 'display: flex; flex-wrap: wrap; gap: 8px;'} } .label { ${format === 'sheet' ? 'outline: 1px dashed #d7dae0;' : 'background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15);'} } }</style>`)}
    />
  );
}

export default Labels;
