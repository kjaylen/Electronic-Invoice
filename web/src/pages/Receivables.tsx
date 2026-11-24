/**
 * Getting paid: what customers owe (by customer and how late), each
 * invoice's payments, statements, reminders, and how customers can pay.
 */

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  type AgeBucket, api, type DocumentDetailInfo, type InvoicePayment, type InvoicePaymentMethod, link, type Receivable, type ReceivableSettingsInfo,
  type ReceivablesOverview,
} from '../api';
import { useT } from '../i18n';
import { Icons } from '../icons';
import { useSession } from '../session';
import { useToast } from '../toast';
import { belizeToday, ErrorText, Field, Modal, money, PAYMENT_METHOD_TEXT, PaymentBadge, Segmented, Select, toCents, TYPE_NAMES, usePageTitle } from '../ui';

const BUCKET_LABEL: Record<AgeBucket, string> = { current: 'Not yet due', '1-30': '1–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '90+': 'Over 90 days' };
const RECORDABLE: InvoicePaymentMethod[] = ['cash', 'bank_transfer', 'cheque', 'card', 'online', 'other'];

interface Statement {
  customer: { key: string; name: string; tin: string | null; email: string | null };
  asOf: string;
  open: Receivable[];
  payments: Array<InvoicePayment & { number: string }>;
  totalDue: string;
  overdue: string;
}

const isZero = (v: string) => toCents(v) === 0n;

// ---------- the page ----------

export function Receivables() {
  const t = useT();
  usePageTitle(t('Getting paid'));
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'customers' | 'invoices' | 'settings' | null) ?? 'customers';
  const [data, setData] = useState<ReceivablesOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [statementFor, setStatementFor] = useState<string | null>(null);
  const load = useCallback(() => api<ReceivablesOverview>('/v1/receivables').then(setData).catch(setError), []);
  useEffect(() => void load(), [load]);

  const tabs: Array<['customers' | 'invoices' | 'settings', string]> = [
    ['customers', t('By customer')],
    ['invoices', t('Invoices')],
    ...(can('business.manage') ? [['settings', t('Reminders and paying')] as ['settings', string]] : []),
  ];
  const s = data?.summary;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <span className="kicker">{t('Accounts receivable')}</span>
          <h1>{t('Getting paid')}</h1>
        </div>
        <span className="spacer" />
        <a className="button secondary" href={link('/v1/receivables/ageing.csv')}>{t('Download ageing (CSV)')}</a>
      </div>
      <ErrorText error={error} />

      <div className="kpis">
        <div className="card kpi">
          <span className="kpi-head"><Icons.documents />{t('Outstanding')}</span>
          <span className="kpi-value">{s ? money(s.outstanding) : '—'}</span>
          <span className="kpi-note">{s ? t('{n} open invoices · {c} customers', { n: s.openInvoices, c: s.customersOwing }) : ' '}</span>
        </div>
        <div className={`card kpi ${s && s.overdueInvoices ? 'alert' : ''}`}>
          <span className="kpi-head"><Icons.alert />{t('Overdue')}</span>
          <span className="kpi-value">{s ? money(s.overdue) : '—'}</span>
          <span className="kpi-note">{s ? (s.overdueInvoices ? t('{n} invoices past their due date', { n: s.overdueInvoices }) : t('Nothing is late')) : ' '}</span>
        </div>
        <div className="card kpi">
          <span className="kpi-head"><Icons.invoice />{t('Due in 7 days')}</span>
          <span className="kpi-value">{s ? money(s.dueThisWeek) : '—'}</span>
          <span className="kpi-note">{data ? (data.reminders.enabled ? t('Reminders are on') : t('Reminders are off')) : ' '}</span>
        </div>
        <div className="card kpi good">
          <span className="kpi-head"><Icons.counter />{t('Collected this month')}</span>
          <span className="kpi-value">{s ? money(s.collectedThisMonth) : '—'}</span>
          <span className="kpi-note">{data ? (data.onlinePayments ? t('Customers can pay online') : t('Online payments are off')) : ' '}</span>
        </div>
      </div>

      <Segmented switches label={t('View')} value={tab} options={tabs} onChange={(v) => setParams({ tab: v }, { replace: true })} />

      {tab === 'customers' && (
        <section className="card">
          {!data ? <div className="skeleton" style={{ height: '12rem' }} /> : data.ageing.customers.length === 0 ? (
            <div className="empty">{t('No customer owes you anything. Invoices you issue show here until they are paid.')}</div>
          ) : (
            <div className="table-wrap">
              <table className="responsive ageing">
                <thead>
                  <tr>
                    <th scope="col">{t('Customer')}</th>
                    {data.buckets.map((b) => <th key={b} scope="col" className="right">{t(BUCKET_LABEL[b])}</th>)}
                    <th scope="col" className="right">{t('Total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ageing.customers.map((c) => (
                    <tr key={c.key} className="clickable" onClick={() => setStatementFor(c.key)}>
                      <td data-label={t('Customer')}>
                        <button type="button" className="link" onClick={(e) => { e.stopPropagation(); setStatementFor(c.key); }}>{c.name}</button>
                        <span className="small muted"> · {t('{n} invoices', { n: c.invoices })}</span>
                      </td>
                      {data.buckets.map((b) => <td key={b} data-label={t(BUCKET_LABEL[b])} className={`right ${b !== 'current' && !isZero(c.buckets[b]) ? 'late' : ''}`}>{isZero(c.buckets[b]) ? '—' : money(c.buckets[b])}</td>)}
                      <td data-label={t('Total')} className="right strong">{money(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{t('Total')}</th>
                    {data.buckets.map((b) => <td key={b} className="right">{money(data.ageing.totals[b])}</td>)}
                    <td className="right strong">{money(data.ageing.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'invoices' && <OpenInvoices />}
      {tab === 'settings' && can('business.manage') && <><ReceivableSettingsForm onSaved={() => void load()} /><BillPayments /></>}

      {statementFor && <StatementModal customerKey={statementFor} onClose={() => setStatementFor(null)} />}
    </div>
  );
}

function OpenInvoices() {
  const t = useT();
  const navigate = useNavigate();
  const { can } = useSession();
  const mayRemind = can('payments.record') || can('documents.send');
  const [whatsapp, setWhatsapp] = useState<Receivable | null>(null);
  const [status, setStatus] = useState<'open' | 'overdue' | 'all'>('open');
  const [rows, setRows] = useState<Receivable[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setRows(null);
    api<{ data: Receivable[] }>(`/v1/receivables/invoices?status=${status}`).then((r) => setRows(r.data)).catch(setError);
  }, [status]);
  return (
    <section className="card stack">
      <Segmented switches label={t('Show')} value={status} options={[['open', t('Owed')], ['overdue', t('Overdue')], ['all', t('All, including paid')]]} onChange={setStatus} />
      <ErrorText error={error} />
      {!rows ? <div className="skeleton" style={{ height: '10rem' }} /> : rows.length === 0 ? <div className="empty">{t('Nothing here.')}</div> : (
        <div className="table-wrap">
          <table className="responsive">
            <thead>
              <tr><th scope="col">{t('Due')}</th><th scope="col">{t('Document')}</th><th scope="col">{t('Customer')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col" className="right">{t('Balance')}</th><th scope="col">{t('Status')}</th>{mayRemind && <th scope="col"><span className="sr-only">{t('Remind')}</span></th>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.documentId} className="clickable" onClick={() => navigate(`/documents/${r.documentId}`, { viewTransition: true })}>
                  <td data-label={t('Due')}>{r.dueDate}{r.daysOverdue > 0 && <span className="small late"> · {t('{n} days late', { n: r.daysOverdue })}</span>}</td>
                  <td data-label={t('Document')}><Link to={`/documents/${r.documentId}`} viewTransition onClick={(e) => e.stopPropagation()}>{t(TYPE_NAMES[r.type] ?? 'Tax invoice')}</Link> <span className="mono muted">{r.number}</span></td>
                  <td data-label={t('Customer')}>{r.customer.name}</td>
                  <td data-label={t('Total')} className="right">{money(r.total)}</td>
                  <td data-label={t('Balance')} className="right strong">{money(r.balance)}</td>
                  <td data-label={t('Status')}><PaymentBadge status={r.status} /></td>
                  {mayRemind && <td className="right">{toCents(r.balance) > 0n && <button type="button" className="secondary small-button" onClick={(e) => { e.stopPropagation(); setWhatsapp(r); }} aria-label={t('Remind {name} by WhatsApp', { name: r.customer.name })}>WhatsApp</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {whatsapp && <WhatsAppModal invoice={whatsapp} onClose={() => setWhatsapp(null)} />}
    </section>
  );
}

/** A reminder for WhatsApp: the message is written for you; you open the chat and press send. */
export function WhatsAppModal({ invoice, onClose }: { invoice: Receivable; onClose: () => void }) {
  const t = useT();
  const [phone, setPhone] = useState(invoice.customer.telephone ?? '');
  const [ready, setReady] = useState<{ phone: string; text: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const write = async (number: string) => {
    setBusy(true);
    setError(null);
    try {
      setReady(await api<{ phone: string; text: string; url: string }>(`/v1/documents/${invoice.documentId}/whatsapp-reminder`, { method: 'POST', body: number.trim() ? { phone: number.trim() } : {} }));
    } catch (e) {
      setReady(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // A customer with a number on the invoice: the message is ready when the dialog opens.
  useEffect(() => {
    if (invoice.customer.telephone) void write(invoice.customer.telephone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal title={t('Remind {name} by WhatsApp', { name: invoice.customer.name })} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void write(phone); }}>
        <p className="small muted">{t('For customers who read WhatsApp and not email. The message is written for you, with a link to the invoice; WhatsApp opens with it typed in, and you press send.')}</p>
        <div className="row whatsapp-phone">
          <Field label={t('Their WhatsApp number')} hint={t('Seven digits for a Belize number; with the country code for any other.')} className="grow"><input type="tel" inputMode="tel" required maxLength={40} value={phone} onChange={(e) => { setPhone(e.target.value); setReady(null); }} placeholder="610-1234" autoFocus={!invoice.customer.telephone} /></Field>
          {!ready && <button className="secondary" disabled={busy || !phone.trim()}>{busy ? t('Writing…') : t('Write the message')}</button>}
        </div>
        <ErrorText error={error} />
        {ready && (
          <>
            <div className="whatsapp-message" aria-label={t('The message')}>{ready.text}</div>
            <div className="row"><span className="small muted">{t('To {phone}', { phone: ready.phone })}</span><span className="spacer" /><button type="button" className="secondary" onClick={onClose}>{t('Close')}</button><a className="button" href={ready.url} target="_blank" rel="noreferrer noopener" onClick={onClose}>{t('Open WhatsApp')}</a></div>
          </>
        )}
      </form>
    </Modal>
  );
}

// ---------- a customer's statement ----------

export function StatementModal({ customerKey, onClose }: { customerKey: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const [s, setS] = useState<Statement | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const query = `customer=${encodeURIComponent(customerKey)}`;
  useEffect(() => {
    api<Statement>(`/v1/receivables/statement?${query}`).then((r) => {
      setS(r);
      setTo(r.customer.email ?? '');
    }).catch(setError);
  }, [query]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/receivables/statement/send', { method: 'POST', body: { customer: customerKey, ...(to.trim() && { to: to.trim() }) } });
      toast(t('Statement emailed to {to}', { to: to.trim() }));
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={s ? t('Statement for {name}', { name: s.customer.name }) : t('Statement')} onClose={onClose} wide>
      <ErrorText error={error} />
      {!s ? <div className="skeleton" style={{ height: '10rem' }} /> : (
        <>
          <div className="row statement-head">
            <div>
              <span className="kicker">{t('Total due')}</span>
              <div className="statement-total">{money(s.totalDue)}</div>
              {!isZero(s.overdue) && <span className="small late">{t('of which overdue: {amount}', { amount: money(s.overdue) })}</span>}
            </div>
            <span className="spacer" />
            <a className="button secondary" href={link(`/v1/receivables/statement.pdf?${query}`)} target="_blank" rel="noreferrer">{t('Open PDF')}</a>
          </div>
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Document')}</th><th scope="col">{t('Due')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col" className="right">{t('Balance')}</th><th scope="col">{t('Status')}</th></tr></thead>
              <tbody>
                {s.open.length === 0 && <tr><td colSpan={5} className="muted">{t('Nothing open.')}</td></tr>}
                {s.open.map((r) => (
                  <tr key={r.documentId}>
                    <td data-label={t('Document')}><Link to={`/documents/${r.documentId}`} onClick={onClose}>{t(TYPE_NAMES[r.type] ?? 'Tax invoice')} <span className="mono">{r.number}</span></Link></td>
                    <td data-label={t('Due')}>{r.dueDate}</td>
                    <td data-label={t('Total')} className="right">{money(r.total)}</td>
                    <td data-label={t('Balance')} className="right strong">{money(r.balance)}</td>
                    <td data-label={t('Status')}><PaymentBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.payments.length > 0 && (
            <div className="stack-tight">
              <h3>{t('Payments in the last 90 days')}</h3>
              <ul className="plain small">
                {s.payments.map((p) => <li key={p.id}>{p.paidOn} · {t(PAYMENT_METHOD_TEXT[p.method])}{p.reference && ` (${p.reference})`} · <span className="mono">{p.number}</span> · <strong>{money(p.amount)}</strong></li>)}
              </ul>
            </div>
          )}
          {can('payments.record') && s.open.some((r) => toCents(r.balance) > 0n) && (
            <form className="row" onSubmit={(e) => void send(e)}>
              <Field label={t('Email the statement to')} className="grow"><input type="email" required value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" /></Field>
              <button disabled={busy}>{busy ? t('Sending…') : t('Email statement')}</button>
            </form>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------- settings: reminders, paying online, how to pay ----------

const OFFSET_CHOICES = [-7, -3, -1, 0, 1, 3, 7, 14, 30, 60, 90];

function offsetLabel(t: ReturnType<typeof useT>, o: number): string {
  if (o === 0) return t('On the due date');
  if (o === -1) return t('The day before');
  if (o === 1) return t('The day after');
  return o < 0 ? t('{n} days before', { n: -o }) : t('{n} days after', { n: o });
}

function ReceivableSettingsForm({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const toast = useToast();
  const [s, setS] = useState<ReceivableSettingsInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<ReceivableSettingsInfo>('/v1/receivable-settings').then(setS).catch(setError), []);
  if (!s) return <section className="card"><ErrorText error={error} />{!error && <div className="skeleton" style={{ height: '10rem' }} />}</section>;
  const toggleOffset = (o: number) => {
    const has = s.reminders.offsets.includes(o);
    const offsets = has ? s.reminders.offsets.filter((x) => x !== o) : [...s.reminders.offsets, o].sort((a, b) => a - b);
    if (offsets.length === 0 || offsets.length > 6) return;
    setS({ ...s, reminders: { ...s.reminders, offsets } });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api<ReceivableSettingsInfo>('/v1/receivable-settings', { method: 'PUT', body: { reminders: s.reminders, payOnline: s.payOnline, instructions: s.instructions, monthlyStatements: Boolean(s.monthlyStatements) } });
      setS(saved);
      toast(t('Saved'));
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const names: Record<string, string> = { belizebank: t('Belize Bank cards'), ekyash: 'E-Kyash', paypal: 'PayPal', test: t('test payments (BTS test environment)') };
  const list = (s.onlineProviders ?? (s.onlineProvider ? [s.onlineProvider] : [])).map((p) => names[p] ?? p);
  const provider = list.length ? list.join(', ') : null;
  return (
    <form className="stack" onSubmit={(e) => void save(e)}>
      <section className="card stack">
        <div>
          <h2>{t('Automatic reminders')}</h2>
          <p className="small muted">{t('Customers with an email address get a reminder with the invoice attached and a link to pay. Each reminder is sent once per invoice.')}</p>
        </div>
        <label className="row"><input type="checkbox" checked={s.reminders.enabled} onChange={(e) => setS({ ...s, reminders: { ...s.reminders, enabled: e.target.checked } })} /> {t('Send payment reminders automatically')}</label>
        <div className="stack-tight">
          <span className="small muted">{t('When to send them (up to 6):')}</span>
          <div className="chips">
            {OFFSET_CHOICES.map((o) => (
              <button key={o} type="button" className={`chip-toggle ${s.reminders.offsets.includes(o) ? 'on' : ''}`} aria-pressed={s.reminders.offsets.includes(o)} onClick={() => toggleOffset(o)} disabled={!s.reminders.enabled}>{offsetLabel(t, o)}</button>
            ))}
          </div>
        </div>
        <label className="row"><input type="checkbox" checked={Boolean(s.monthlyStatements)} onChange={(e) => setS({ ...s, monthlyStatements: e.target.checked })} /> {t('Email each customer who owes their statement at the start of every month')}</label>
      </section>
      <section className="card stack">
        <div>
          <h2>{t('Paying online')}</h2>
          <p className="small muted">{provider ? t('Invoices you email include a “Pay online” link. Payments go through {provider} and are recorded on the invoice by themselves.', { provider }) : t('Connect Belize Bank, E-Kyash or PayPal in Settings → Online store to let customers pay invoices online.')}</p>
        </div>
        <label className="row"><input type="checkbox" checked={s.payOnline} onChange={(e) => setS({ ...s, payOnline: e.target.checked })} disabled={!provider} /> {t('Let customers pay invoices online')}</label>
      </section>
      <section className="card stack">
        <Field label={t('How to pay you')} hint={t('Bank details or where to bring a cheque. Printed on statements and included in reminders.')}>
          <textarea rows={3} maxLength={1000} value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} placeholder={t('e.g. Belize Bank account 123456789, name of the business. Use the invoice number as the reference.')} />
        </Field>
      </section>
      <ErrorText error={error} />
      <div className="row"><span className="spacer" /><button disabled={busy}>{busy ? t('Saving…') : t('Save')}</button></div>
    </form>
  );
}

// ---------- an invoice's payments (on the document page) ----------

interface PaymentsData {
  invoice: (Receivable & { status: Receivable['status'] }) | null;
  payments: InvoicePayment[];
}

export function PaymentsCard({ doc, onChange }: { doc: DocumentDetailInfo; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const [data, setData] = useState<PaymentsData | null>(null);
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<InvoicePayment | null>(null);
  const [reminding, setReminding] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  const load = useCallback(() => api<PaymentsData>(`/v1/documents/${doc.id}/payments`).then(setData).catch(() => {}), [doc.id]);
  useEffect(() => void load(), [load, doc.status]);
  const changed = () => {
    void load();
    onChange();
  };
  const inv = data?.invoice;
  if (!inv) return null;
  const owed = toCents(inv.balance) > 0n;
  const paidSoFar = toCents(inv.paid) + toCents(inv.credited) + toCents(inv.withheld ?? '0.00');
  const pct = toCents(inv.total) > 0n ? Number((paidSoFar * 100n) / toCents(inv.total)) : 0;
  return (
    <section className="card stack payments-card">
      <div className="row">
        <h2>{t('Payment')}</h2>
        <span className="spacer" />
        <PaymentBadge status={inv.status} />
      </div>
      <div className="pay-progress" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
      <dl className="pay-facts">
        <div><dt>{t('Balance')}</dt><dd className="strong">{money(inv.balance)}</dd></div>
        <div><dt>{t('Due')}</dt><dd>{inv.dueDate}{inv.daysOverdue > 0 && <span className="late"> · {t('{n} days late', { n: inv.daysOverdue })}</span>}</dd></div>
        {!isZero(inv.paid) && <div><dt>{t('Paid')}</dt><dd>{money(inv.paid)}</dd></div>}
        {!isZero(inv.credited) && <div><dt>{t('Credit notes')}</dt><dd>{money(inv.credited)}</dd></div>}
        {inv.withheld && !isZero(inv.withheld) && <div><dt>{t('Contract tax withheld')}</dt><dd>{money(inv.withheld)}</dd></div>}
      </dl>
      {data.payments.length > 0 && (
        <ul className="payment-list small">
          {data.payments.map((p) => (
            <li key={p.id} className={p.voided ? 'voided' : ''}>
              <div className="row">
                <span><strong>{money(p.amount)}</strong> · {t(PAYMENT_METHOD_TEXT[p.method])}{p.reference && <span className="muted"> ({p.reference})</span>}</span>
                <span className="spacer" />
                {!p.voided && can('payments.record') && p.method !== 'online' && <button type="button" className="link small" onClick={() => setVoiding(p)}>{t('Void')}</button>}
              </div>
              <span className="muted">{p.paidOn}{p.recordedBy && ` · ${p.recordedBy}`}{p.voided && ` · ${t('voided')}: ${p.voidReason ?? ''}`}</span>
            </li>
          ))}
        </ul>
      )}
      {owed && (can('payments.record') || can('documents.send')) && (
        <div className="action-grid">
          {can('payments.record') && <button onClick={() => setRecording(true)}>{t('Record payment')}</button>}
          <button className="secondary" onClick={() => setReminding(true)}>{t('Send reminder')}</button>
          <button className="secondary" onClick={() => setWhatsapp(true)}>{t('Remind by WhatsApp')}</button>
        </div>
      )}
      {recording && <RecordPaymentModal invoice={inv} onClose={() => setRecording(false)} onDone={() => { setRecording(false); toast(t('Payment recorded')); changed(); }} />}
      {voiding && <VoidPaymentModal payment={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); toast(t('Payment voided')); changed(); }} />}
      {whatsapp && <WhatsAppModal invoice={inv} onClose={() => setWhatsapp(false)} />}
      {reminding && <RemindModal documentId={doc.id} email={inv.customer.email} onClose={() => setReminding(false)} onDone={(to) => { setReminding(false); toast(t('Reminder sent to {to}', { to })); }} />}
    </section>
  );
}

function RecordPaymentModal({ invoice, onClose, onDone }: { invoice: Receivable; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [amount, setAmount] = useState(invoice.balance);
  const [method, setMethod] = useState<InvoicePaymentMethod>('bank_transfer');
  const [paidOn, setPaidOn] = useState(belizeToday());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/documents/${invoice.documentId}/payments`, {
        method: 'POST',
        body: { amount: amount.trim(), method, paidOn, ...(reference.trim() && { reference: reference.trim() }), ...(note.trim() && { note: note.trim() }) },
      });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Record a payment')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="small muted">{t('{doc} for {customer}. Balance {balance}.', { doc: `${t(TYPE_NAMES[invoice.type] ?? 'Tax invoice')} ${invoice.number}`, customer: invoice.customer.name, balance: money(invoice.balance) })}</p>
        <div className="form-grid">
          <Field label={t('Amount (BZ$)')}><input inputMode="decimal" required pattern="^\d{1,15}(\.\d{1,2})?$" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
          <Field label={t('Paid on')}><input type="date" required value={paidOn} min={invoice.issueDate} max={belizeToday()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        </div>
        <Field label={t('Method')}>
          <Select value={method} onChange={(e) => setMethod(e.target.value as InvoicePaymentMethod)}>
            {RECORDABLE.map((m) => <option key={m} value={m}>{t(PAYMENT_METHOD_TEXT[m])}</option>)}
          </Select>
        </Field>
        <Field label={t('Reference')} hint={t('Optional: cheque number, transfer reference, receipt number.')}><input maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label={t('Note')} hint={t('Optional; only you see it.')}><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy}>{busy ? t('Saving…') : t('Record {amount}', { amount: money(amount || '0') })}</button></div>
      </form>
    </Modal>
  );
}

function VoidPaymentModal({ payment, onClose, onDone }: { payment: InvoicePayment; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/v1/payments/${payment.id}/void`, { method: 'POST', body: { reason: reason.trim() } });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Void this payment?')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="small">{t('{amount} on {date} stays in the history, marked void, and the invoice balance goes back up.', { amount: money(payment.amount), date: payment.paidOn })}</p>
        <Field label={t('Why?')}><input required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder={t('e.g. Cheque bounced, entered twice')} /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Keep it')}</button><span className="spacer" /><button className="danger" disabled={busy}>{t('Void payment')}</button></div>
      </form>
    </Modal>
  );
}

function RemindModal({ documentId, email, onClose, onDone }: { documentId: string; email: string | null; onClose: () => void; onDone: (to: string) => void }) {
  const t = useT();
  const [to, setTo] = useState(email ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ to: string }>(`/v1/documents/${documentId}/remind`, { method: 'POST', body: { to: to.trim() } });
      onDone(r.to);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Send a payment reminder')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="small muted">{t('A short, polite reminder with the invoice attached and, when online payments are on, a link to pay.')}</p>
        <Field label={t('Email')}><input type="email" required value={to} onChange={(e) => setTo(e.target.value)} autoFocus /></Field>
        <ErrorText error={error} />
        <div className="row"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><span className="spacer" /><button disabled={busy}>{busy ? t('Sending…') : t('Send reminder')}</button></div>
      </form>
    </Modal>
  );
}

// ---------- bill payments through Belize Bank's online banking ----------

interface BillPaySetup {
  enabled: boolean;
  configured: boolean;
  referenceField: string;
  lastSeenAt: string | null;
  urls: { validate: string; post: string; reconcile: string } | null;
  last30Days: { payments: number; amount: string };
  problems: Array<{ id: string; kind: string; bankReference: string | null; reference: string | null; amount: string | null; outcome: string; createdAt: string }>;
  token?: string;
}

function BillPayments() {
  const t = useT();
  const toast = useToast();
  const [s, setS] = useState<BillPaySetup | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [field, setField] = useState('referenceNumber');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const show = (r: BillPaySetup) => {
    setS(r);
    setField(r.referenceField);
  };
  useEffect(() => void api<BillPaySetup>('/v1/bill-payments').then(show).catch(setError), []);
  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<BillPaySetup>('/v1/bill-payments', { method: 'POST', body: { referenceField: field } });
      show(r);
      setToken(r.token ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const update = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      show(await api<BillPaySetup>('/v1/bill-payments', { method: 'PUT', body: { referenceField: field, enabled } }));
      toast(enabled ? t('Saved') : t('Bill payments turned off'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!s) return <section className="card"><ErrorText error={error} /></section>;
  return (
    <section className="card stack">
      <div className="row">
        <div>
          <h2>{t('Bill payments in Belize Bank online banking')}</h2>
          <p className="small muted">{t('Customers pay an invoice as a bill in Belize Bank’s online or mobile banking, typing the invoice number. The bank checks the number and the balance with us first, and the payment is recorded on the invoice by itself.')}</p>
        </div>
        <span className="spacer" />
        {s.enabled ? <span className="badge authorized">{t('On')}</span> : <span className="badge test">{t('Off')}</span>}
      </div>
      {s.configured && (
        <p className="small">{s.lastSeenAt ? t('Last message from the bank: {when}.', { when: new Date(s.lastSeenAt).toLocaleString() }) : t('No message from the bank yet.')} {t('Last 30 days: {n} payments, {amount}.', { n: s.last30Days.payments, amount: money(s.last30Days.amount) })}</p>
      )}
      <Field label={t('Name of the invoice number field')} hint={t('As agreed with the bank. Common names such as referenceNumber and invoiceNumber are understood too.')}>
        <input value={field} maxLength={40} pattern="^[A-Za-z][A-Za-z0-9_]{0,39}$" onChange={(e) => setField(e.target.value.trim())} />
      </Field>
      {token && (
        <div className="banner warn">
          <div>
            <strong>{t('Give this token to Belize Bank now')}</strong>
            {t('It is shown only once. The bank sends it with every request; anyone with it can ask about your invoices.')}
            <code className="copyable token">{token}</code>
          </div>
        </div>
      )}
      {s.configured && s.urls && (
        <dl className="pay-facts urls">
          <div><dt>{t('Validation')}</dt><dd><code className="copyable">{s.urls.validate}</code></dd></div>
          <div><dt>{t('Payment posted')}</dt><dd><code className="copyable">{s.urls.post}</code></dd></div>
          <div><dt>{t('Daily reconciliation')}</dt><dd><code className="copyable">{s.urls.reconcile}</code></dd></div>
        </dl>
      )}
      <ErrorText error={error} />
      <div className="row">
        {!s.configured ? <button disabled={busy} onClick={() => void issue()}>{t('Turn on bill payments')}</button> : (
          <>
            {s.enabled ? <button className="secondary" disabled={busy} onClick={() => void update(true)}>{t('Save')}</button> : <button disabled={busy} onClick={() => void update(true)}>{t('Turn back on')}</button>}
            <button className="secondary" disabled={busy} onClick={() => void issue()}>{t('New token')}</button>
            {s.enabled && <button className="link danger-link" disabled={busy} onClick={() => void update(false)}>{t('Turn off')}</button>}
          </>
        )}
      </div>
      {s.problems.length > 0 && (
        <div className="stack-tight">
          <h3>{t('Payments to apply by hand')}</h3>
          <p className="small muted">{t('The bank took these payments but the reference matched no single open invoice. Find the invoice and record the payment on it.')}</p>
          <ul className="plain small">
            {s.problems.map((p) => <li key={p.id}>{new Date(p.createdAt).toLocaleDateString()} · {p.amount ? money(p.amount) : '—'} · {t('reference')} “{p.reference ?? '—'}” · {t('bank ref.')} <span className="mono">{p.bankReference ?? '—'}</span></li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
