/** The public pages: pricing, terms of service, privacy policy. */

import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Brand } from '../art';
import { LanguageToggle, useT } from '../i18n';
import { money, usePageTitle } from '../ui';
import type { PlanInfo } from './Billing';

interface Site {
  productName: string;
  legalName: string | null;
  contactEmail: string | null;
  plans: PlanInfo[];
  trialDays: number;
}

function useSite() {
  const [site, setSite] = useState<Site | null>(null);
  useEffect(() => {
    void api<Site>('/v1/site').then(setSite).catch(() => {});
  }, []);
  return site;
}

function PublicPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const t = useT();
  return (
    <div className="public-page">
      <header className="public-top">
        <Link to="/" className="brand"><Brand /></Link>
        <nav className="public-nav">
          <Link to="/pricing">{t('Pricing')}</Link>
          <a href="/docs">{t('API')}</a>
          <Link to="/signup" className="button small-button">{t('Create a business')}</Link>
        </nav>
        <LanguageToggle />
      </header>
      <main className={`public-main ${wide ? 'wide' : ''}`}>{children}</main>
      <PublicFooter />
    </div>
  );
}

export function PublicFooter() {
  const t = useT();
  return (
    <footer className="public-footer">
      <span>Floreo · {t('by Altiora Technologies')}</span>
      <span className="spacer" />
      <Link to="/pricing">{t('Pricing')}</Link>
      <a href="/docs">{t('API')}</a>
      <Link to="/terms">{t('Terms')}</Link>
      <Link to="/privacy">{t('Privacy')}</Link>
    </footer>
  );
}

export function Pricing() {
  const t = useT();
  usePageTitle(t('Pricing'));
  const site = useSite();
  const features: Record<string, string> = { store: t('Online store'), api: t('API keys'), webhooks: t('Webhooks'), integrations: t('QuickBooks and other integrations') };
  const faqs: Array<[string, string]> = [
    [t('What counts as a document?'), t('Every tax invoice, receipt, credit or debit note issued in the BTS production environment. Documents in the test environment are always free and unlimited.')],
    [t('Is there a free trial?'), t('Yes: every new business gets {n} days of the Business plan, with no card needed.', { n: site?.trialDays ?? 30 })],
    [t('Can I change plans?'), t('Any time, in Settings → Plan. Upgrades apply at once; a downgrade applies at the end of the month.')],
    [t('How do I pay?'), t('Each month is invoiced at the start (a BTS e-invoice, of course) and due in 14 days. GST is added at 12.5%.')],
    [t('What if a payment is late?'), t('After 14 days overdue, issuing new documents pauses until it is paid. Your documents always stay available to view, print and download.')],
  ];
  return (
    <PublicPage wide>
      <section className="pricing-hero">
        <span className="kicker">{t('Pricing')}</span>
        <h1>{t('Simple plans for Belizean businesses.')}</h1>
        <p className="muted">{t('Issue BTS-authorized invoices and receipts, sell online and keep working through outages. Start free for {n} days.', { n: site?.trialDays ?? 30 })}</p>
      </section>
      <div className="plan-grid pricing-grid">
        {(site?.plans ?? []).map((p) => (
          <article key={p.code} className={`card plan-card${p.code === 'business' ? ' featured' : ''}`}>
            {p.code === 'business' && <span className="plan-flag">{t('Most popular')}</span>}
            <h3>{p.name}</h3>
            <div className="plan-price">{p.price === '0' ? <span className="amount">{t('Free')}</span> : <><span className="amount">{money(p.price)}</span><span className="per">{t('/ month + GST')}</span></>}</div>
            <p className="small muted">{t(p.blurb)}</p>
            <ul className="plan-features">
              <li>{p.documentsPerMonth === null ? t('Unlimited documents') : t('{n} documents a month', { n: p.documentsPerMonth.toLocaleString() })}</li>
              <li>{p.users === null ? t('Unlimited accounts') : t('{n} accounts', { n: p.users })}</li>
              <li>{t('Invoices, receipts, credit notes, the counter')}</li>
              <li>{t('Contingency mode when BTS is down')}</li>
              {Object.entries(features).map(([f, label]) => <li key={f} className={p.features.includes(f as PlanInfo['features'][number]) ? '' : 'no'}>{label}</li>)}
            </ul>
            <Link className={`button ${p.code === 'business' ? '' : 'secondary'}`} to="/signup">{t('Start free')}</Link>
          </article>
        ))}
      </div>
      <section className="faq">
        <h2>{t('Questions')}</h2>
        {faqs.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
      </section>
    </PublicPage>
  );
}

const UPDATED = '22 November 2026';

function Who({ site }: { site: Site | null }) {
  const t = useT();
  return <>{site?.legalName ?? t('the company that runs this service')}</>;
}

function Contact({ site }: { site: Site | null }) {
  const t = useT();
  return site?.contactEmail ? <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a> : <>{t('the contact details on our website')}</>;
}

export function Terms() {
  const t = useT();
  usePageTitle(t('Terms of service'));
  const site = useSite();
  return (
    <PublicPage>
      <article className="legal">
        <span className="kicker">{t('Last updated {date}', { date: UPDATED })}</span>
        <h1>{t('Terms of service')}</h1>
        <p>These terms are an agreement between your business and <Who site={site} /> ("we") for the use of Floreo, a service that prepares, signs and sends electronic tax documents to the Belize Tax Service (BTS), and the related online store, counter and tools.</p>
        <h2>1. Your account</h2>
        <p>You create an account for a business you are allowed to act for. You are responsible for the people you give access to, their roles, and keeping sign-in details safe. Turn on two-step sign-in for owners and admins.</p>
        <h2>2. Your documents and BTS</h2>
        <p>You are responsible for the content of the documents you issue: customers, items, prices, tax categories and reasons. We sign each document with your BTS certificate and submit it as the BTS rules require. Whether a document is authorized is decided by BTS. When BTS cannot be reached, the service issues documents in contingency mode and sends them when BTS is back, as the BTS manual allows.</p>
        <h2>3. Your certificate</h2>
        <p>You obtain your BTS certificate and keep it valid. We store its private key encrypted and use it only to sign your documents.</p>
        <h2>4. Plans, trials and payment</h2>
        <p>Plans, limits and prices are shown on the pricing page. New businesses get a free trial. Paid plans are invoiced monthly in advance and due in 14 days; GST is added. If an invoice is more than 14 days overdue, issuing new documents pauses until it is paid. Upgrades apply at once; downgrades at the end of the period.</p>
        <h2>5. Your data is yours</h2>
        <p>You own your business's data. You can download all of it, including every signed document, at any time (Reports → Download archive). We use it only to provide the service, as described in the privacy policy.</p>
        <h2>6. Acceptable use</h2>
        <p>Do not use the service to issue false or fraudulent documents, to evade tax, to send spam, to break into other accounts or systems, or to overload the service. We may suspend accounts that do.</p>
        <h2>7. Availability</h2>
        <p>We work to keep the service running and your data safe, with backups and monitoring, but we cannot promise it will never be interrupted. The service depends on BTS and on providers such as hosting, email and payment services.</p>
        <h2>8. Liability</h2>
        <p>To the extent the law allows, our liability for any claim is limited to the fees you paid in the three months before it, and we are not liable for indirect losses. Nothing in these terms limits liability that cannot be limited by law.</p>
        <h2>9. Ending the service</h2>
        <p>You can stop at any time. Before closing an account, download your archive; we keep documents for as long as tax law requires and then delete them. We may end the service with reasonable notice, giving you time to download your data.</p>
        <h2>10. Changes and law</h2>
        <p>We may update these terms and will tell you about important changes in advance. These terms are governed by the laws of Belize. Questions: <Contact site={site} />.</p>
      </article>
    </PublicPage>
  );
}

export function Privacy() {
  const t = useT();
  usePageTitle(t('Privacy policy'));
  const site = useSite();
  return (
    <PublicPage>
      <article className="legal">
        <span className="kicker">{t('Last updated {date}', { date: UPDATED })}</span>
        <h1>{t('Privacy policy')}</h1>
        <p>This policy explains what <Who site={site} /> collects when businesses use Floreo and when people buy from their online stores, why, and what you can do about it.</p>
        <h2>What we collect</h2>
        <ul>
          <li><strong>Businesses:</strong> registered and trade name, TIN, address, contact details, BTS certificate.</li>
          <li><strong>Accounts:</strong> names, email or username, role, password (stored as a one-way hash), two-step sign-in secret (encrypted), sign-in times and IP addresses.</li>
          <li><strong>Documents:</strong> what a business puts on its invoices and receipts, including its customers' names, TINs and addresses.</li>
          <li><strong>Online store buyers:</strong> name, phone, email and address given at checkout, and what was ordered. If a buyer gives their email and leaves without ordering, the cart is kept for up to 30 days so the store can send a reminder (if it uses them); every reminder has a link to stop them. A buyer who makes an account at a store (signing in with a code sent to their email) also keeps their addresses and, if they choose, their business's name and TIN there; they can change these or close the account at any time.</li>
          <li><strong>Security logs:</strong> an activity log of sign-ins and changes, kept so businesses can see who did what.</li>
        </ul>
        <h2>Why</h2>
        <p>To provide the service: prepare, sign and submit documents to BTS, which the law requires; email documents and notices; run online stores; bill for plans; and keep the service secure.</p>
        <h2>Who we share it with</h2>
        <ul>
          <li><strong>The Belize Tax Service</strong>, which receives every document, as required by law.</li>
          <li><strong>Service providers</strong> we rely on to run the service: hosting and storage, email delivery, and backups.</li>
          <li><strong>Providers a business chooses to connect</strong>, such as PayPal for online payments or QuickBooks for accounting. They receive what is needed for that connection.</li>
        </ul>
        <p>We do not sell personal data, and we do not use it for advertising.</p>
        <h2>How it is protected</h2>
        <p>Connections are encrypted (HTTPS). Certificate keys and sign-in secrets are encrypted at rest. Accounts can use two-step sign-in. Signed documents cannot be altered after issue. Access is limited to what each role needs and is logged.</p>
        <h2>How long we keep it</h2>
        <p>Tax documents are kept for as long as tax law requires businesses to keep them, and at least while the account is open. Other data is deleted when no longer needed. Businesses can download everything at any time.</p>
        <h2>Cookies and storage</h2>
        <p>We use a cookie only to keep you signed in (to the app, or to your account at a store). Your browser also keeps your cart and unsent drafts on your device. There are no tracking or advertising cookies.</p>
        <h2>Your choices</h2>
        <p>You can ask to see, correct or export your personal data. Buyers should contact the business they bought from, which controls its store data; we help it respond. Some data must be kept by law (for example, issued tax documents).</p>
        <h2>Contact</h2>
        <p>Questions or requests: <Contact site={site} />.</p>
      </article>
    </PublicPage>
  );
}
