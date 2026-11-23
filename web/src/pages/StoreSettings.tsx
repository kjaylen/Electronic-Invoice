/** Settings → Online store: open the store, delivery zones, pickup, payment methods, online payments, discount codes, own domain. */

import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type CheckoutSummary, type StoreSettings } from '../api';
import { useT } from '../i18n';
import { useToast } from '../toast';
import { ErrorText, Field, money, Select } from '../ui';
import { type Accounts, BelizeBankConnect, DiscountCodes, EKyashConnect, PayPalConnect, StoreDomains } from './StoreExtras';

const feeWithGst = (fee: string) => (/^\d+(\.\d{1,2})?$/.test(fee) ? (Math.round(Number(fee) * 100 * 1.125) / 100).toFixed(2) : '');

export function StoreSettingsTab() {
  const t = useT();
  const toast = useToast();
  const [s, setS] = useState<StoreSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [accountsVersion, setAccountsVersion] = useState(0);
  const [testAvailable, setTestAvailable] = useState(false);
  const [connected, setConnected] = useState<{ paypal: boolean; belizebank: boolean; ekyash: boolean }>({ paypal: false, belizebank: false, ekyash: false });
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  useEffect(() => {
    void api<{ summary: CheckoutSummary }>('/v1/store-checkouts').then((r) => setSummary(r.summary)).catch(() => {});
  }, []);
  useEffect(() => {
    void api<StoreSettings>('/v1/store-settings').then(setS).catch(setError);
  }, [accountsVersion]);
  useEffect(() => {
    void api<Accounts>('/v1/payment-accounts').then((a) => {
      setTestAvailable(a.test.available);
      setConnected({ paypal: a.paypal.connected, belizebank: a.belizebank.connected, ekyash: a.ekyash.connected });
    }).catch(() => {});
  }, []);
  if (!s) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '12rem' }} />;
  const url = `${window.location.origin}/${s.slug}/shop`;

  const save = async (e?: FormEvent, patch: Partial<StoreSettings> = {}) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    const { slug: _slug, ...body } = { ...s, ...patch };
    try {
      const saved = await api<StoreSettings>('/v1/store-settings', { method: 'PUT', body });
      setS({ ...saved, slug: s.slug });
      toast(patch.enabled === true ? t('Your store is open') : patch.enabled === false ? t('Your store is closed') : t('Store settings saved'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const zones = s.delivery.zones;
  const setZone = (i: number, patch: Partial<{ name: string; fee: string }>) => setS({ ...s, delivery: { ...s.delivery, zones: zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) } });

  return (
    <form className="stack" onSubmit={(e) => void save(e)}>
      <section className={`card store-status ${s.enabled ? 'open' : ''}`}>
        <div className="row">
          <div>
            <h2>{s.enabled ? t('Your store is open') : t('Your store is closed')}</h2>
            <p className="small muted">{s.enabled ? t('Buyers can order at your store address. Each paid order becomes a BTS receipt.') : t('Set up delivery, pickup and payment below, add products, then open it.')}</p>
            <a className="mono small" href={url} target="_blank" rel="noreferrer">{url}</a>
          </div>
          <span className="spacer" />
          <button type="button" className={s.enabled ? 'secondary' : 'lime'} disabled={busy} onClick={() => void save(undefined, { enabled: !s.enabled })}>
            {s.enabled ? t('Close the store') : t('Open the store')}{!s.enabled && <span className="chip" aria-hidden="true">→</span>}
          </button>
        </div>
      </section>
      <ErrorText error={error} />

      <section className="card stack">
        <h2>{t('Storefront')}</h2>
        <Field label={t('Tagline')} hint={t('One line under your name, e.g. "Fresh coffee from Cayo".')}><input maxLength={160} value={s.tagline} onChange={(e) => setS({ ...s, tagline: e.target.value })} /></Field>
        <Field label={t('About')} hint={t('Shown at the bottom of your store.')}><textarea rows={3} maxLength={4000} value={s.about} onChange={(e) => setS({ ...s, about: e.target.value })} /></Field>
        <div className="form-grid">
          <Field label={t('WhatsApp number')} hint={t('Buyers can message you about an order.')}><input type="tel" value={s.whatsapp} onChange={(e) => setS({ ...s, whatsapp: e.target.value })} /></Field>
          <Field label={t('New-order emails to')} hint={t('Defaults to the business email.')}><input type="email" value={s.notifyEmail} onChange={(e) => setS({ ...s, notifyEmail: e.target.value })} /></Field>
        </div>
      </section>

      <div className="grid two">
        <section className="card stack">
          <label className="row toggle"><input type="checkbox" checked={s.delivery.enabled} onChange={(e) => setS({ ...s, delivery: { ...s.delivery, enabled: e.target.checked } })} /> <strong>{t('Delivery')}</strong></label>
          {s.delivery.enabled && (
            <>
              <p className="small muted">{t('Areas you deliver to and what you charge (before GST). The fee is a line on the receipt.')}</p>
              {zones.map((z, i) => (
                <div className="row zone" key={i}>
                  <input aria-label={t('Zone {n} name', { n: i + 1 })} placeholder={t('e.g. Belize City')} required value={z.name} onChange={(e) => setZone(i, { name: e.target.value })} />
                  <input aria-label={t('Zone {n} fee', { n: i + 1 })} inputMode="decimal" pattern="\d+(\.\d{1,2})?" placeholder="0.00" required value={z.fee} onChange={(e) => setZone(i, { fee: e.target.value })} style={{ maxWidth: 110 }} />
                  <span className="small muted">{feeWithGst(z.fee) && t('{amount} with GST', { amount: money(feeWithGst(z.fee)) })}</span>
                  <button type="button" className="link danger-link" aria-label={t('Remove zone {n}', { n: i + 1 })} onClick={() => setS({ ...s, delivery: { ...s.delivery, zones: zones.filter((_, j) => j !== i) } })}>×</button>
                </div>
              ))}
              <div><button type="button" className="secondary" onClick={() => setS({ ...s, delivery: { ...s.delivery, zones: [...zones, { name: '', fee: '' }] } })}>+ {t('Add a zone')}</button></div>
            </>
          )}
        </section>
        <section className="card stack">
          <label className="row toggle"><input type="checkbox" checked={s.pickup.enabled} onChange={(e) => setS({ ...s, pickup: { ...s.pickup, enabled: e.target.checked } })} /> <strong>{t('Pickup at your shop')}</strong></label>
          {s.pickup.enabled && <Field label={t('Pickup instructions')} hint={t('Opening hours, where to go. Your business address is shown too.')}><textarea rows={3} value={s.pickup.instructions} onChange={(e) => setS({ ...s, pickup: { ...s.pickup, instructions: e.target.value } })} /></Field>}
        </section>
      </div>

      <section className="card stack">
        <h2>{t('Payment')}</h2>
        <p className="small muted">{t('Paid online, the receipt is issued and emailed by itself. Paid another way, you mark the order paid: that issues the receipt.')}</p>
        <label className="row toggle"><input type="checkbox" checked={s.payments.bankTransfer.enabled} onChange={(e) => setS({ ...s, payments: { ...s.payments, bankTransfer: { ...s.payments.bankTransfer, enabled: e.target.checked } } })} /> {t('Bank transfer')}</label>
        {s.payments.bankTransfer.enabled && (
          <Field label={t('Bank details for buyers')} hint={t('Bank, account name and number. Shown after they order, with the order number as reference.')}>
            <textarea rows={3} required={s.payments.bankTransfer.enabled && s.enabled} value={s.payments.bankTransfer.instructions} onChange={(e) => setS({ ...s, payments: { ...s.payments, bankTransfer: { ...s.payments.bankTransfer, instructions: e.target.value } } })} />
          </Field>
        )}
        <label className="row toggle"><input type="checkbox" checked={s.payments.cashOnDelivery.enabled} onChange={(e) => setS({ ...s, payments: { ...s.payments, cashOnDelivery: { enabled: e.target.checked } } })} /> {t('Cash on delivery')}</label>
        <label className="row toggle"><input type="checkbox" checked={s.payments.payAtPickup.enabled} onChange={(e) => setS({ ...s, payments: { ...s.payments, payAtPickup: { enabled: e.target.checked } } })} /> {t('Pay at pickup')}</label>
        <div className="online-pay stack">
          <label className="row toggle"><input type="checkbox" checked={s.payments.online.enabled} onChange={(e) => setS({ ...s, payments: { ...s.payments, online: { ...s.payments.online, enabled: e.target.checked } } })} /> <strong>{t('Pay online at checkout')}</strong></label>
          {s.payments.online.enabled && (
            <Field label={t('Through')}>
              <Select value={s.payments.online.provider} onChange={(e) => setS({ ...s, payments: { ...s.payments, online: { ...s.payments.online, provider: e.target.value as StoreSettings['payments']['online']['provider'] } } })}>
                {(connected.belizebank || s.payments.online.provider === 'belizebank') && <option value="belizebank">{t('Belize Bank cards (BZ$)')}</option>}
                {(connected.ekyash || s.payments.online.provider === 'ekyash') && <option value="ekyash">E-Kyash</option>}
                <option value="paypal">PayPal</option>
                {testAvailable && <option value="test">{t('Test payments (BTS test environment, no money moves)')}</option>}
              </Select>
            </Field>
          )}
          <BelizeBankConnect onChanged={() => setAccountsVersion((v) => v + 1)} />
          <EKyashConnect onChanged={() => setAccountsVersion((v) => v + 1)} />
          <PayPalConnect onChanged={() => setAccountsVersion((v) => v + 1)} />
        </div>
      </section>
      <section className="card stack">
        <label className="row toggle"><input type="checkbox" checked={s.reminders.enabled} onChange={(e) => setS({ ...s, reminders: { ...s.reminders, enabled: e.target.checked } })} /> <strong>{t('Checkout reminders')}</strong></label>
        <p className="small muted" style={{ margin: 0 }}>{t('A buyer who gives their email at checkout and leaves without ordering gets an email with a link back to their cart. Every reminder has a link to stop them.')}</p>
        {s.reminders.enabled && (
          <div className="row" style={{ gap: '1rem', alignItems: 'end' }}>
            <Field label={t('Send the reminder')}>
              <Select value={String(s.reminders.afterHours)} onChange={(e) => setS({ ...s, reminders: { ...s.reminders, afterHours: Number(e.target.value) } })}>
                {[1, 2, 3, 6, 12, 24].map((h) => <option key={h} value={String(h)}>{h === 1 ? t('1 hour after they leave') : t('{n} hours after they leave', { n: h })}</option>)}
              </Select>
            </Field>
            <label className="row toggle" style={{ paddingBottom: '0.55rem' }}><input type="checkbox" checked={s.reminders.second} onChange={(e) => setS({ ...s, reminders: { ...s.reminders, second: e.target.checked } })} /> {t('And once more a day later')}</label>
          </div>
        )}
        {summary && summary.reminded > 0 && (
          <p className="small" style={{ margin: 0 }}>
            {t('Last 30 days: {reminded} reminded, {recovered} came back and ordered ({amount}).', { reminded: summary.reminded, recovered: summary.recovered, amount: money(summary.recoveredTotal) })} <Link to="/orders?view=unfinished" viewTransition>{t('See unfinished checkouts')}</Link>
          </p>
        )}
      </section>
      <section className="card stack">
        <label className="row toggle"><input type="checkbox" checked={s.accounts.enabled} onChange={(e) => setS({ ...s, accounts: { enabled: e.target.checked } })} /> <strong>{t('Buyer accounts')}</strong></label>
        <p className="small muted" style={{ margin: 0 }}>{t('Buyers can sign in with a code sent to their email (no password) to see their orders, keep their addresses and check out faster. Anyone can still check out without an account.')}</p>
        {s.accounts.enabled && <p className="small" style={{ margin: 0 }}><Link to="/orders?view=buyers">{t('See buyers with an account')}</Link></p>}
      </section>
      <div className="row"><span className="spacer" /><button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save store settings')}</button></div>
      <DiscountCodes />
      <StoreDomains />
    </form>
  );
}
