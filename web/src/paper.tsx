/**
 * The document as a sheet of paper on screen: the same content as the
 * printed copy (read from the signed XML), laid out like a real invoice,
 * with stamps for test, pending, cancelled and rejected documents. A
 * receipt view shows it the way a till printer would.
 */

import { useT } from './i18n';
import { money, TYPE_NAMES, unitName } from './ui';

export interface PaperParty {
  name?: string;
  tin?: string;
  otherId?: string;
  addressLines: string[];
  telephone?: string;
  email?: string;
}

export interface PaperView {
  etdType: string;
  typeName: string;
  etdui: string;
  number: string;
  series: string;
  issueDate: string;
  issueTime: string;
  pendingAuthorization: boolean;
  testEnvironment: boolean;
  issuer: PaperParty;
  customer?: PaperParty;
  lines: Array<{
    number: string;
    quantity: string;
    unitCode: string;
    description: string;
    code?: string;
    unitPrice: string;
    adjustments: Array<{ reason: string; amount: string; isCharge: boolean }>;
    net: string;
    tax: string;
    total: string;
  }>;
  totals: { taxExclusive: string; gst: string; otherTaxes: Array<{ scheme: string; amount: string }>; taxInclusive: string; prepaid?: string; payable: string };
  reference?: { etdui: string; documentType: string; reason: string };
  contingency?: { reason: string; initDate: string; initTime: string };
  note?: string;
  payment?: { dueDate?: string; terms?: string };
  regulatory: string[];
}

export interface PaperData {
  view: PaperView;
  status: string;
  protocolNumber: string | null;
  qr: { url: string; image: string } | null;
}

/** "1,000" style quantities without trailing zeros. */
const qty = (q: string) => {
  const [w = '0', f = ''] = q.split('.');
  const frac = f.replace(/0+$/, '');
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
};
const initials = (name = '') => name.replace(/\b(ltd|limited|inc|co)\b\.?/gi, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';
const dateLong = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};
const shortId = (etdui: string) => `${etdui.slice(0, 6)}…${etdui.slice(-6)}`;

function Stamp({ status, view }: { status: string; view: PaperView }) {
  const t = useT();
  const stamp = status === 'cancelled' ? { text: t('Cancelled'), tone: 'bad' }
    : status === 'rejected' ? { text: t('Rejected by BTS'), tone: 'bad' }
      : status === 'superseded' ? { text: t('Replaced'), tone: 'muted' }
        : status === 'pending' ? { text: t('Not authorized yet'), tone: 'warn' }
          : status === 'draft' ? { text: t('Preview'), tone: 'muted' }
          : null;
  return (
    <>
      {stamp && <div className={`paper-stamp ${stamp.tone}`} aria-hidden="true">{stamp.text}</div>}
      {view.testEnvironment && <div className="paper-watermark" aria-hidden="true">{t('Test · no fiscal value')}</div>}
    </>
  );
}

function Party({ party }: { party: PaperParty }) {
  const t = useT();
  return (
    <>
      <strong className="paper-party-name">{party.name ?? t('Walk-in customer')}</strong>
      {party.tin && <div className="paper-mono">TIN {party.tin}</div>}
      {party.otherId && <div className="paper-mono">ID {party.otherId}</div>}
      {party.addressLines.map((l) => <div key={l}>{l}</div>)}
      {(party.telephone || party.email) && <div className="paper-faint">{[party.telephone, party.email].filter(Boolean).join(' · ')}</div>}
    </>
  );
}

function Authorization({ data }: { data: PaperData }) {
  const t = useT();
  const { view } = data;
  return (
    <div className="paper-auth">
      {data.qr && <a href={data.qr.url} target="_blank" rel="noreferrer" className="paper-qr" title={t('Check this document with BTS')}><img src={data.qr.image} alt={t('QR code to check this document with BTS')} /></a>}
      <div className="paper-auth-text">
        <span className="paper-label">{t('Document ID (ETDUI)')}</span>
        <span className="paper-mono paper-break">{view.etdui}</span>
        <span className="paper-label">{t('BTS authorization')}</span>
        <span className="paper-mono paper-break">{view.pendingAuthorization ? t('Pending of BTS authorization') : data.protocolNumber ?? '—'}</span>
        {view.regulatory.map((m) => <span key={m} className="paper-regulatory">{m}</span>)}
      </div>
    </div>
  );
}

export function DocumentPaper({ data, variant = 'sheet' }: { data: PaperData; variant?: 'sheet' | 'receipt' }) {
  const t = useT();
  const { view } = data;
  const type = t(TYPE_NAMES[view.etdType] ?? view.typeName);
  const otherTaxes = view.totals.otherTaxes.filter((x) => Number(x.amount) !== 0);

  if (variant === 'receipt') {
    return (
      <article className="paper paper-receipt" aria-label={`${type} ${view.series}-${view.number}`}>
        <Stamp status={data.status} view={view} />
        <header className="center">
          <strong className="paper-party-name">{view.issuer.name}</strong>
          {view.issuer.tin && <div>TIN {view.issuer.tin}</div>}
          {view.issuer.addressLines.map((l) => <div key={l}>{l}</div>)}
          <div className="paper-rule" />
          <strong>{type.toUpperCase()}</strong>
          <div>{view.series}-{view.number}</div>
          <div>{view.issueDate} {view.issueTime.slice(0, 5)}</div>
          {view.customer?.name && <div>{view.customer.name}{view.customer.tin && ` · TIN ${view.customer.tin}`}</div>}
        </header>
        <div className="paper-rule" />
        {view.lines.map((l) => (
          <div key={l.number} className="paper-receipt-line">
            <div>{l.description}</div>
            <div className="row"><span>{qty(l.quantity)} × {money(l.unitPrice)}</span><span className="spacer" /><span>{money(l.total)}</span></div>
          </div>
        ))}
        <div className="paper-rule" />
        <div className="row"><span>{t('Subtotal')}</span><span className="spacer" /><span>{money(view.totals.taxExclusive)}</span></div>
        <div className="row"><span>GST</span><span className="spacer" /><span>{money(view.totals.gst)}</span></div>
        {otherTaxes.map((x) => <div key={x.scheme} className="row"><span>{x.scheme}</span><span className="spacer" /><span>{money(x.amount)}</span></div>)}
        <div className="row paper-receipt-total"><span>{t('Total')}</span><span className="spacer" /><span>{money(view.totals.payable)}</span></div>
        <div className="paper-rule" />
        <div className="center">{data.qr && <img className="paper-receipt-qr" src={data.qr.image} alt={t('QR code to check this document with BTS')} />}</div>
        <div className="center paper-break small">{view.etdui}</div>
        {view.regulatory.map((m) => <div key={m} className="center paper-regulatory">{m}</div>)}
      </article>
    );
  }

  return (
    <article className="paper paper-sheet" aria-label={`${type} ${view.series}-${view.number}`}>
      <Stamp status={data.status} view={view} />
      <header className="paper-head">
        <div className="paper-issuer">
          <div className="paper-monogram" aria-hidden="true">{initials(view.issuer.name)}</div>
          <div><Party party={view.issuer} /></div>
        </div>
        <div className="paper-title">
          <span className="paper-type">{type}</span>
          <span className="paper-number">№ {view.series}-{view.number}</span>
          <dl className="paper-meta">
            <dt>{t('Date')}</dt><dd>{dateLong(view.issueDate)}</dd>
            <dt>{t('Time')}</dt><dd>{view.issueTime.slice(0, 5)}</dd>
            {view.payment?.dueDate && <><dt>{t('Due')}</dt><dd>{dateLong(view.payment.dueDate)}</dd></>}
          </dl>
        </div>
      </header>

      <section className="paper-parties">
        <div>
          <span className="paper-label">{view.etdType === '04' || view.etdType === '03' ? t('Customer') : t('Bill to')}</span>
          {view.customer ? <Party party={view.customer} /> : <strong className="paper-party-name">{t('Walk-in customer')}</strong>}
        </div>
        {view.reference && (
          <div>
            <span className="paper-label">{view.etdType === '04' ? t('Credits') : t('Corrects')}</span>
            <strong>{t(TYPE_NAMES[view.reference.documentType] ?? 'Document')}</strong>
            <div className="paper-mono" title={view.reference.etdui}>{shortId(view.reference.etdui)}</div>
            <div className="paper-faint">“{view.reference.reason}”</div>
          </div>
        )}
        {view.payment?.terms && (
          <div>
            <span className="paper-label">{t('Payment')}</span>
            <div>{view.payment.terms}</div>
          </div>
        )}
      </section>

      <div className="paper-table-wrap">
        <table className="paper-lines">
          <thead>
            <tr>
              <th scope="col" className="num-col">#</th>
              <th scope="col">{t('Description')}</th>
              <th scope="col" className="right">{t('Qty')}</th>
              <th scope="col" className="right">{t('Unit price')}</th>
              <th scope="col" className="right hide-narrow">{t('Net')}</th>
              <th scope="col" className="right hide-narrow">{t('Tax')}</th>
              <th scope="col" className="right">{t('Amount')}</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l) => (
              <tr key={l.number}>
                <td className="num-col paper-faint">{l.number}</td>
                <td>
                  <span className="paper-desc">{l.description}</span>
                  {l.code && <span className="paper-code">{l.code}</span>}
                  {l.adjustments.map((a) => <div key={a.reason} className="paper-adjust">{a.isCharge ? '+' : '−'} {a.reason}{a.amount && ` ${money(a.amount)}`}</div>)}
                </td>
                <td className="right nowrap">{qty(l.quantity)} <span className="paper-faint">{unitName(t, l.unitCode)}</span></td>
                <td className="right nowrap">{money(l.unitPrice)}</td>
                <td className="right nowrap hide-narrow">{money(l.net)}</td>
                <td className="right nowrap hide-narrow paper-faint">{money(l.tax)}</td>
                <td className="right nowrap paper-strong">{money(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="paper-foot">
        <Authorization data={data} />
        <dl className="paper-totals">
          <div><dt>{t('Subtotal')}</dt><dd>{money(view.totals.taxExclusive)}</dd></div>
          <div><dt>GST</dt><dd>{money(view.totals.gst)}</dd></div>
          {otherTaxes.map((x) => <div key={x.scheme}><dt>{x.scheme}</dt><dd>{money(x.amount)}</dd></div>)}
          {view.totals.prepaid && <div><dt>{t('Total')}</dt><dd>{money(view.totals.taxInclusive)}</dd></div>}
          {view.totals.prepaid && <div><dt>{t('Prepaid')}</dt><dd>−{money(view.totals.prepaid)}</dd></div>}
          <div className="paper-grand"><dt>{view.totals.prepaid ? t('Amount due') : t('Total')} <span className="paper-faint">BZD</span></dt><dd>{money(view.totals.payable)}</dd></div>
        </dl>
      </section>

      {(view.note || view.contingency) && (
        <footer className="paper-notes">
          {view.note && <p>{view.note}</p>}
          {view.contingency && <p className="paper-faint">{t('Issued in contingency since {date} {time}: {reason}', { date: view.contingency.initDate, time: view.contingency.initTime.slice(0, 5), reason: view.contingency.reason })}</p>}
        </footer>
      )}
    </article>
  );
}
