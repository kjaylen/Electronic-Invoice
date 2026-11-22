/** Settings → Plan: the business's plan with the platform, its usage, its invoices and how to pay. */

import { useCallback, useEffect, useState } from 'react';
import { api, link } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useToast } from '../toast';
import { ErrorText, money } from '../ui';

export type PlanCode = 'starter' | 'business' | 'pro';
export type Feature = 'store' | 'api' | 'webhooks' | 'integrations';

export interface PlanInfo {
  code: PlanCode;
  name: string;
  price: string;
  documentsPerMonth: number | null;
  users: number | null;
  features: Feature[];
  blurb: string;
}

export interface BillingInvoice {
  id: string;
  plan: PlanCode;
  planName: string;
  periodStart: string;
  periodEnd: string;
  net: string;
  gst: string;
  total: string;
  status: 'open' | 'paid' | 'void';
  overdue: boolean;
  dueAt: string;
  documentId: string | null;
  paidAt: string | null;
  paidReference: string | null;
}

export interface BillingInfo {
  plan: PlanCode;
  planName: string;
  status: 'trialing' | 'active' | 'past_due' | 'suspended';
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  nextPlan: PlanCode | null;
  features: Feature[];
  usage: { documents: number; documentsLimit: number | null; users: number; usersLimit: number | null };
  invoices: BillingInvoice[];
  amountDue: string;
  plans: PlanInfo[];
  paymentInstructions: string | null;
}

const ORDER: PlanCode[] = ['starter', 'business', 'pro'];
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const month = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'America/Belize' });

export function StatusPill({ status, daysLeft }: { status: BillingInfo['status']; daysLeft?: number | null }) {
  const t = useT();
  const map = {
    trialing: ['test', daysLeft === null || daysLeft === undefined ? t('Free trial') : daysLeft === 1 ? t('Trial: 1 day left') : t('Trial: {n} days left', { n: daysLeft })],
    active: ['authorized', t('Active')],
    past_due: ['pending', t('Payment overdue')],
    suspended: ['rejected', t('Issuing paused')],
  } as const;
  const [tone, label] = map[status];
  return <span className={`badge ${tone}`}>{label}</span>;
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const t = useT();
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="meter">
      <div className="row small"><span>{label}</span><span className="spacer" /><span className="mono">{limit === null ? t('{n} · no limit', { n: used }) : `${used} / ${limit}`}</span></div>
      <div className="meter-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit ?? used} aria-valuenow={used}>
        <span className={pct >= 90 ? 'hot' : pct >= 75 ? 'warm' : ''} style={{ width: limit === null ? '100%' : `${pct}%`, opacity: limit === null ? 0.25 : 1 }} />
      </div>
    </div>
  );
}

export function PlanTab() {
  const t = useT();
  const toast = useToast();
  const { role, refreshMe } = useSession();
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<PlanCode | null>(null);
  const load = useCallback(() => api<BillingInfo>('/v1/billing').then(setInfo).catch(setError), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!info) return error ? <ErrorText error={error} /> : <div className="skeleton" style={{ height: '16rem' }} />;
  const owner = role === 'owner';
  const current = info.plans.find((p) => p.code === info.plan)!;
  const features: Record<Feature, string> = { store: t('Online store'), api: t('API keys'), webhooks: t('Webhooks'), integrations: t('Accounting integrations') };

  const choose = async (plan: PlanCode) => {
    setBusy(plan);
    setError(null);
    try {
      const next = await api<BillingInfo>('/v1/billing/plan', { method: 'PUT', body: { plan } });
      setInfo(next);
      void refreshMe();
      const name = next.plans.find((p) => p.code === plan)?.name ?? plan;
      toast(next.nextPlan === plan ? t('You move to {plan} at the end of this period', { plan: name }) : t('You are on the {plan} plan', { plan: name }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      {info.status === 'suspended' && <div className="banner bad" role="alert"><div><strong>{t('Issuing is paused')}</strong>{t('An invoice for your plan is more than 14 days overdue. Pay it and issuing resumes as soon as the payment is recorded. Your documents stay available.')}</div></div>}
      {info.status === 'past_due' && <div className="banner warn" role="status"><div><strong>{t('An invoice is overdue')}</strong>{t('Please pay it to avoid a pause in issuing.')}</div></div>}

      <div className="grid two">
        <section className="card stack plan-current">
          <div className="row">
            <div><span className="kicker">{t('Your plan')}</span><h2 className="plan-name">{current.name}</h2></div>
            <span className="spacer" />
            <StatusPill status={info.status} daysLeft={info.trialDaysLeft} />
          </div>
          <p className="small muted">{t(current.blurb)}</p>
          {info.status === 'trialing' && info.trialEndsAt && (
            <p className="small">{current.price === '0'
              ? t('Your trial ends on {date}.', { date: day(info.trialEndsAt) })
              : t('Your trial ends on {date}. Then the first month is invoiced: {amount} + GST.', { date: day(info.trialEndsAt), amount: money(current.price) })}</p>
          )}
          {info.status !== 'trialing' && info.currentPeriodEnd && <p className="small">{t('This period ends on {date}.', { date: day(info.currentPeriodEnd) })}</p>}
          {info.nextPlan && <p className="small"><strong>{t('Changing to {plan} on {date}.', { plan: info.plans.find((p) => p.code === info.nextPlan)?.name ?? '', date: day(info.currentPeriodEnd ?? info.trialEndsAt ?? new Date().toISOString()) })}</strong></p>}
          <Meter label={t('Documents this month (production)')} used={info.usage.documents} limit={info.usage.documentsLimit} />
          <Meter label={t('Active accounts')} used={info.usage.users} limit={info.usage.usersLimit} />
          <p className="small muted">{t('Documents in the BTS test environment are free and unlimited.')}</p>
        </section>

        <section className="card stack">
          <h2>{t('Paying')}</h2>
          {info.amountDue !== '0.00' ? (
            <div className="banner info"><div><strong>{t('Amount due: {amount}', { amount: money(info.amountDue) })}</strong>{info.paymentInstructions ?? t('Our team will contact you with payment details.')}</div></div>
          ) : (
            <p className="small muted">{t('Nothing to pay right now.')}</p>
          )}
          {info.paymentInstructions && info.amountDue === '0.00' && <p className="small">{info.paymentInstructions}</p>}
          <p className="small muted">{t('Each month is invoiced at the start of the period and due in 14 days. Invoices are real BTS e-invoices, emailed to your billing address.')}</p>
        </section>
      </div>

      <section className="stack">
        <h2>{t('Plans')}</h2>
        <div className="plan-grid">
          {info.plans.map((p) => {
            const isCurrent = p.code === info.plan;
            const lower = ORDER.indexOf(p.code) < ORDER.indexOf(info.plan);
            const scheduled = info.nextPlan === p.code;
            return (
              <article key={p.code} className={`card plan-card${isCurrent ? ' current' : ''}${p.code === 'business' ? ' featured' : ''}`}>
                {p.code === 'business' && <span className="plan-flag">{t('Most popular')}</span>}
                <h3>{p.name}</h3>
                <div className="plan-price">{p.price === '0' ? <span className="amount">{t('Free')}</span> : <><span className="amount">{money(p.price)}</span><span className="per">{t('/ month + GST')}</span></>}</div>
                <p className="small muted">{t(p.blurb)}</p>
                <ul className="plan-features">
                  <li>{p.documentsPerMonth === null ? t('Unlimited documents') : t('{n} documents a month', { n: p.documentsPerMonth.toLocaleString() })}</li>
                  <li>{p.users === null ? t('Unlimited accounts') : t('{n} accounts', { n: p.users })}</li>
                  <li>{t('Invoices, receipts, credit notes, the counter')}</li>
                  {(['store', 'api', 'webhooks', 'integrations'] as Feature[]).map((f) => (
                    <li key={f} className={p.features.includes(f) ? '' : 'no'}>{features[f]}</li>
                  ))}
                </ul>
                {isCurrent ? (
                  <button className="secondary" disabled>{info.nextPlan ? t('Current plan') : t('Your plan')}</button>
                ) : (
                  <button className={lower ? 'secondary' : ''} disabled={!owner || busy !== null || scheduled} onClick={() => void choose(p.code)}>
                    {busy === p.code ? t('Saving…') : scheduled ? t('Scheduled') : lower ? (info.status === 'trialing' ? t('Switch to {plan}', { plan: p.name }) : t('Move down at period end')) : t('Upgrade to {plan}', { plan: p.name })}
                  </button>
                )}
              </article>
            );
          })}
        </div>
        {!owner && <p className="small muted">{t('Only an owner can change the plan.')}</p>}
        <ErrorText error={error} />
      </section>

      <section className="card stack">
        <h2>{t('Invoices')}</h2>
        {info.invoices.length === 0 ? <p className="small muted">{t('No invoices yet.')}</p> : (
          <div className="table-wrap">
            <table className="responsive">
              <thead><tr><th scope="col">{t('Period')}</th><th scope="col">{t('Plan')}</th><th scope="col" className="right">{t('Total')}</th><th scope="col">{t('Status')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
              <tbody>
                {info.invoices.map((i) => (
                  <tr key={i.id}>
                    <td data-label={t('Period')}>{month(i.periodStart)}</td>
                    <td data-label={t('Plan')}>{i.planName}</td>
                    <td data-label={t('Total')} className="right">{money(i.total)}</td>
                    <td data-label={t('Status')}>
                      {i.status === 'paid' ? <span className="badge authorized">{t('Paid')}</span> : i.status === 'void' ? <span className="badge cancelled">{t('Void')}</span> : i.overdue ? <span className="badge rejected">{t('Overdue')}</span> : <span className="badge pending">{t('Due {date}', { date: day(i.dueAt) })}</span>}
                    </td>
                    <td className="right">{i.documentId && <a href={link(`/v1/billing/invoices/${i.id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** For a page whose feature the plan does not include. */
export function UpgradeNotice({ feature }: { feature: Feature }) {
  const t = useT();
  const names: Record<Feature, string> = { store: t('The online store'), api: t('API keys'), webhooks: t('Webhooks'), integrations: t('Accounting integrations') };
  const plan = feature === 'store' || feature === 'api' ? 'Business' : 'Pro';
  return (
    <div className="banner info upgrade-notice">
      <div><strong>{t('{feature} come with the {plan} plan', { feature: names[feature], plan })}</strong>{t('Upgrade in Settings → Plan; it takes effect at once.')}</div>
      <a className="button" href="?tab=plan">{t('See plans')}</a>
    </div>
  );
}
