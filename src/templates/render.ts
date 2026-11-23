/**
 * Templates at work: load a business's version (or the default), render emails, printed
 * documents and store sections, check a template before it is saved, and the sample data the
 * editor previews with.
 *
 * Safety nets: a business's own template that fails at render time falls back to the default
 * (an email or a receipt is never lost to a typo); store sections are sanitized (no scripts,
 * no event handlers, only safe links), since the store shares the app's web address.
 */

import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import sanitizeHtml from 'sanitize-html';
import type { Queryable } from '../db/database.ts';
import { buildEtdui } from '../engine/etdui.ts';
import { authorizationText, infoLines, regulatoryLines } from '../render/pdf.ts';
import { type PrintView, qrUrl } from '../render/view.ts';
import { type AssetMap, assetMap, emailAssets } from './assets.ts';
import { defaultSource, defaultSubject, requirementProblems, type TemplateDef, templateDef } from './catalog.ts';
import { documentTypeName, emailLanguage, type Lang, PHRASES } from './lang.ts';
import { type BtsBlock, htmlToText, parseTemplate, renderHtml, renderText, TemplateError } from './engine.ts';

const DISTRICTS: Record<string, string> = { '1': 'Belize', '2': 'Cayo', '3': 'Corozal', '4': 'Orange Walk', '5': 'Stann Creek', '6': 'Toledo' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface BusinessContext {
  name: string; legal_name: string; trade_name: string | null; tin: string; address_lines: string[]; telephone: string; email: string; slug: string;
  /** The logo's address (set per render, for where it loads: see assets.ts). */
  logo?: string | null;
}

/** A render's context with its images: {{ business.logo }} (and store.logo) and what asset_url finds. */
export function withAssets(context: Record<string, unknown>, assets: AssetMap | undefined): Record<string, unknown> {
  if (!assets) return context;
  const out: Record<string, unknown> = { ...context, __assets: assets.byName };
  for (const k of ['business', 'store']) {
    const v = out[k];
    if (v && typeof v === 'object') out[k] = { ...(v as Record<string, unknown>), logo: assets.logo };
  }
  return out;
}

export async function businessContext(db: Queryable, tenantId: string): Promise<BusinessContext> {
  const t = (await db.query<{ legal_name: string; trade_name: string | null; tin: string; street: string; additional_street: string | null; city: string; district_code: string; telephone: string; email: string; slug: string }>(
    'select legal_name, trade_name, tin, street, additional_street, city, district_code, telephone, email, slug from tenants where id = $1', [tenantId],
  )).rows[0]!;
  return {
    name: t.trade_name ?? t.legal_name, legal_name: t.legal_name, trade_name: t.trade_name, tin: t.tin,
    address_lines: [t.street, t.additional_street, `${t.city}, ${DISTRICTS[t.district_code] ?? ''}`].filter((x): x is string => Boolean(x && x.trim())),
    telephone: t.telephone, email: t.email, slug: t.slug,
  };
}

// ---------- loading and saving ----------

export interface LoadedTemplate { source: string; subject: string | null; custom: boolean; updatedAt: string | null; lang: Lang }

/** A business's template, or the default (emails: in the language its customer emails go out in). */
export async function loadTemplate(db: Queryable, tenantId: string, key: string, lang?: Lang): Promise<LoadedTemplate> {
  const def = templateDef(key);
  if (!def) throw new TemplateError(`No template "${key}"`);
  const language = def.group === 'emails' ? lang ?? await emailLanguage(db, tenantId) : 'en';
  const row = (await db.query<{ source: string; subject: string | null; updated_at: Date | string }>(
    'select source, subject, updated_at from templates where tenant_id = $1 and key = $2', [tenantId, key],
  )).rows[0];
  return row
    ? { source: row.source, subject: row.subject ?? defaultSubject(def, language), custom: true, updatedAt: new Date(row.updated_at).toISOString(), lang: language }
    : { source: defaultSource(def, language), subject: defaultSubject(def, language), custom: false, updatedAt: null, lang: language };
}

export interface Problem { message: string; line?: number; where: 'template' | 'subject' }

/** Everything wrong with a template, before it is saved: syntax, what it must keep, and a trial render. */
export async function templateProblems(def: TemplateDef, source: string, subject: string | null, sample: Record<string, unknown>, bts?: BtsBlock, assets?: AssetMap, lang: Lang = 'en'): Promise<Problem[]> {
  const problems: Problem[] = [];
  try {
    parseTemplate(source);
  } catch (e) {
    problems.push({ message: (e as Error).message, ...((e as TemplateError).line && { line: (e as TemplateError).line }), where: 'template' });
  }
  if (def.subject !== undefined) {
    if (!subject?.trim()) problems.push({ message: 'The subject is empty', where: 'subject' });
    else {
      try {
        parseTemplate(subject);
      } catch (e) {
        problems.push({ message: (e as Error).message, where: 'subject' });
      }
    }
  }
  for (const message of requirementProblems(def, source)) problems.push({ message, where: 'template' });
  if (!problems.length) {
    try {
      await renderHtml(source, withAssets(sample, assets), bts, lang);
    } catch (e) {
      problems.push({ message: (e as Error).message, ...((e as TemplateError).line && { line: (e as TemplateError).line }), where: 'template' });
    }
  }
  return problems;
}

export async function saveTemplate(db: Queryable, tenantId: string, key: string, source: string, subject: string | null, userId: string | null) {
  await db.query(
    `insert into templates (tenant_id, key, source, subject, updated_by, updated_at) values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id, key) do update set source = excluded.source, subject = excluded.subject, updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, key, source, subject, userId],
  );
  await db.query('insert into template_versions (id, tenant_id, key, source, subject, action, saved_by) values ($1, $2, $3, $4, $5, $6, $7)', [randomUUID(), tenantId, key, source, subject, 'saved', userId]);
  // Keep the last 30 versions of each template.
  await db.query(
    `delete from template_versions where tenant_id = $1 and key = $2 and id not in (select id from template_versions where tenant_id = $1 and key = $2 order by saved_at desc limit 30)`,
    [tenantId, key],
  );
}

export async function revertTemplate(db: Queryable, tenantId: string, key: string, userId: string | null) {
  const removed = await db.query('delete from templates where tenant_id = $1 and key = $2 returning key', [tenantId, key]);
  if (removed.rows.length) await db.query("insert into template_versions (id, tenant_id, key, source, subject, action, saved_by) values ($1, $2, $3, '', null, 'reverted', $4)", [randomUUID(), tenantId, key, userId]);
  return removed.rows.length > 0;
}

// ---------- emails ----------

/**
 * An email from the business's template (or the default), in the language its customer emails go
 * out in (`lang`, when the caller already knows it).
 */
export async function renderEmail(
  db: Queryable, tenantId: string, key: string, context: Record<string, unknown>, options: { publicUrl?: string | undefined; lang?: Lang } = {},
): Promise<{ subject: string; html: string; text: string }> {
  const def = templateDef(key)!;
  const lang = options.lang ?? await emailLanguage(db, tenantId);
  const t = await loadTemplate(db, tenantId, key, lang);
  const render = async (source: string, subject: string) => {
    // Images load from the public address (or are inlined when the server has none).
    const ctx = withAssets(context, await assetMap(db, tenantId, [source, subject], emailAssets(options.publicUrl)));
    const html = await renderHtml(source, ctx, undefined, lang);
    return { html, text: htmlToText(html), subject: (await renderText(subject, ctx, lang)).replace(/\s+/g, ' ').trim() };
  };
  try {
    return await render(t.source, t.subject ?? defaultSubject(def, lang) ?? '');
  } catch (e) {
    if (!t.custom) throw e;
    // The business's version broke at send time: send the default rather than nothing.
    return render(defaultSource(def, lang), defaultSubject(def, lang) ?? '');
  }
}

// ---------- printed documents ----------

const BTS_CSS = `
.bts { display: flex; gap: 4mm; align-items: flex-start; color: #000; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; page-break-inside: avoid; }
.bts-qr { flex: none; padding: 3mm !important; background: #fff !important; line-height: 0; }
.bts-qr svg { display: block; width: 22mm !important; height: 22mm !important; }
.bts-text { min-width: 0; }
.bts-label { font-size: 9pt !important; color: #444; margin-top: 1mm; }
.bts-value { font-size: 9pt !important; font-family: 'Courier New', Courier, monospace; overflow-wrap: anywhere; }
.bts-strong { font-weight: 700; }
.bts-notices { margin-top: 2mm; font-size: 9pt !important; font-weight: 700; }
.bts-stacked { flex-direction: column; align-items: center; text-align: center; gap: 1mm; }
`;

/** Put the compliance block's styles first in the page, so a template can style around it but not shrink it. */
export function withBtsStyles(html: string): string {
  const style = `<style data-bts>${BTS_CSS}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${style}`);
  return style + html;
}

const groupDigits = (s: string) => (s.match(/.{1,4}/g) ?? [s]).join(' ');

/** The data a printed document's template sees, all of it from the signed document, and its {% bts %} block. */
export async function documentPrintContext(view: PrintView, options: { protocolNumber?: string | null; message?: string | null; draft?: boolean } = {}) {
  const renderOptions = { ...(options.protocolNumber && { protocolNumber: options.protocolNumber }), ...(options.draft && { draft: true }) };
  const authorization = authorizationText(view, renderOptions);
  const regulatory = regulatoryLines(view, renderOptions);
  const url = qrUrl(view.etdui);
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
  const party = (p: PrintView['issuer'] | undefined) => p && ({ name: p.name ?? null, tin: p.tin ?? null, other_id: p.otherId ?? null, address_lines: p.addressLines, telephone: p.telephone ?? null, email: p.email ?? null });
  const bts: BtsBlock = {
    html: `<div class="bts"><div class="bts-qr">${svg}</div><div class="bts-text">`
      + `<div class="bts-label">ETDUI</div><div class="bts-value">${esc(groupDigits(view.etdui))}</div>`
      + `<div class="bts-label">Authorization</div><div class="bts-value${/^\d{44}$/.test(authorization) ? '' : ' bts-strong'}">${esc(/^\d{44}$/.test(authorization) ? groupDigits(authorization) : authorization)}</div>`
      + (regulatory.length ? `<div class="bts-notices">${regulatory.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : '')
      + '</div></div>',
  };
  return {
    bts,
    context: {
      message: options.message ?? null,
      document: {
        type: view.etdType, type_name: view.typeName, number: view.number, series: view.series, number_display: `${view.series}-${view.number}`,
        issue_date: view.issueDate, issue_time: view.issueTime, etdui: view.etdui, environment: view.testEnvironment ? 'test' : 'production',
        issuer: party(view.issuer), customer: party(view.customer) ?? null,
        lines: view.lines.map((l) => ({
          number: l.number, description: l.description, code: l.code ?? null, quantity: l.quantity, unit_code: l.unitCode, unit_price: l.unitPrice,
          adjustments: l.adjustments.map((a) => ({ reason: a.reason, amount: a.amount, is_charge: a.isCharge })), net: l.net, tax: l.tax, total: l.total,
        })),
        totals: {
          tax_exclusive: view.totals.taxExclusive, gst: view.totals.gst, tax_inclusive: view.totals.taxInclusive, prepaid: view.totals.prepaid ?? null, payable: view.totals.payable,
          other_taxes: view.totals.otherTaxes.map((x) => ({ name: x.scheme === 'EXC' ? 'Excise duty' : x.scheme === 'ENV' ? 'Environmental tax' : x.scheme, amount: x.amount })),
        },
        payment: { due_date: view.payment?.dueDate ?? null, terms: view.payment?.terms ?? null },
        note: view.note ?? null,
        reference: view.reference ? { etdui: view.reference.etdui, document_type: view.reference.documentType, reason: view.reference.reason } : null,
        pending_authorization: view.pendingAuthorization, authorization, regulatory, info: infoLines(view), qr_url: url,
      },
    },
  };
}

/** A printed document's HTML from the business's template (or the default). */
export async function renderDocumentHtml(db: Queryable, tenantId: string, key: 'document.invoice' | 'document.receipt' | 'document.quote' | 'document.statement', context: Record<string, unknown>, bts?: BtsBlock): Promise<{ html: string; custom: boolean }> {
  const def = templateDef(key)!;
  const t = await loadTemplate(db, tenantId, key);
  // The print browser has no network: images go in as data: URLs.
  const render = async (source: string) => withBtsStyles(await renderHtml(source, withAssets(context, await assetMap(db, tenantId, [source], { kind: 'inline' })), bts));
  try {
    return { html: await render(t.source), custom: t.custom };
  } catch (e) {
    if (!t.custom) throw e;
    return { html: await render(defaultSource(def)), custom: false };
  }
}

// ---------- the online store ----------

const SECTION_HTML: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'section', 'header', 'footer', 'figure', 'figcaption', 'small', 'span', 'h1', 'h2', 'picture', 'source'],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'aria-label', 'role', 'lang'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
    source: ['srcset', 'media', 'type'],
  },
  allowedSchemes: ['https', 'http', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https', 'data'], source: ['https'] },
  allowProtocolRelative: false,
  transformTags: { a: (tag, attribs) => ({ tagName: tag, attribs: attribs.target === '_blank' ? { ...attribs, rel: 'noopener noreferrer' } : attribs }) },
};

/** CSS from the theme template: no @import, nothing that could close the style element. */
export function cleanCss(css: string): string {
  return css.replace(/<\/?\s*style/gi, '').replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, '(').replace(/javascript:/gi, '');
}

export interface StoreTheme { css: string; announcement: string; home: string; footer: string }

/** The store's theme and sections, rendered and cleaned. A broken template shows nothing rather than breaking the store. */
export async function renderStoreTheme(db: Queryable, tenantId: string, context: Record<string, unknown>): Promise<StoreTheme> {
  const part = async (key: string, kind: 'css' | 'html') => {
    try {
      const t = await loadTemplate(db, tenantId, key);
      if (!t.custom) return '';
      const ctx = withAssets(context, await assetMap(db, tenantId, [t.source], { kind: 'url' }));
      const out = kind === 'css' ? cleanCss(await renderText(t.source, ctx)) : sanitizeHtml(await renderHtml(t.source, ctx), SECTION_HTML);
      return out.trim();
    } catch {
      return '';
    }
  };
  const [css, announcement, home, footer] = await Promise.all([part('store.theme', 'css'), part('store.announcement', 'html'), part('store.home', 'html'), part('store.footer', 'html')]);
  return { css, announcement, home, footer };
}

/** A store section as the store will show it (for the editor's preview). */
export const sanitizeSection = (html: string) => sanitizeHtml(html, SECTION_HTML);

/** What store templates see: the store and its newest products (prices with GST). */
export async function storeContext(db: Queryable, tenantId: string, options: { base?: string } = {}): Promise<Record<string, unknown>> {
  const t = (await db.query<{ slug: string; name: string; telephone: string; email: string; city: string; store_settings: { tagline?: string; about?: string } | null }>(
    'select slug, coalesce(trade_name, legal_name) as name, telephone, email, city, store_settings from tenants where id = $1', [tenantId],
  )).rows[0]!;
  const products = (await db.query<{ handle: string; title: string; image_id: string | null; price: string | null; gst: 'S' | 'Z' | 'E' | null }>(
    `select p.handle, p.title,
       (select g.id from product_images g where g.product_id = p.id order by g.position, g.created_at limit 1) as image_id,
       (select i.unit_price::text from items i where i.product_id = p.id and i.archived_at is null order by i.unit_price limit 1) as price,
       (select i.gst_category from items i where i.product_id = p.id and i.archived_at is null order by i.unit_price limit 1) as gst
     from products p where p.tenant_id = $1 and p.status = 'active' order by p.created_at desc limit 12`,
    [tenantId],
  )).rows.filter((p) => p.price !== null);
  const base = options.base ?? `/${t.slug}/shop`;
  const withGst = (net: string, gst: string | null) => (gst === 'S' ? Math.round(Number(net) * 112.5) / 100 : Number(net)).toFixed(2);
  return {
    store: { name: t.name, slug: t.slug, url: base, tagline: t.store_settings?.tagline ?? '', about: t.store_settings?.about ?? '', city: t.city, telephone: t.telephone, email: t.email },
    products: products.map((p) => ({
      name: p.title, handle: p.handle, price: withGst(p.price!, p.gst), url: `${base}/products/${p.handle}`,
      image: p.image_id ? `/v1/store/${t.slug}/images/${p.image_id}` : null,
    })),
  };
}

// ---------- sample data for the editor ----------

const sampleEtdui = (tin: string, receipt: boolean) => buildEtdui({
  etdType: receipt ? '02' : '01', tin: /^\d{6}$/.test(tin) ? tin : '123456', serial: 42, series: 1, issueDate: '2026-11-22', issueTime: '13:50', operMode: 1, receptionEnv: '02', securityCode: '123456789',
});

export function samplePrintView(biz: BusinessContext, receipt: boolean): PrintView {
  return {
    etdType: receipt ? '02' : '01', typeName: receipt ? 'Tax Receipt' : 'Tax Invoice', etdui: sampleEtdui(biz.tin, receipt), number: '000000042', series: '001',
    issueDate: '2026-11-22', issueTime: '13:50:41', operMode: 1, receptionEnv: '02', pendingAuthorization: false, testEnvironment: true,
    issuer: { name: biz.name, tin: biz.tin, addressLines: biz.address_lines, telephone: biz.telephone, email: biz.email },
    ...(!receipt && { customer: { name: 'Island Logistics Ltd.', tin: '777888', addressLines: ['4 Mile Northern Highway', 'Belize City, Belize'] } }),
    lines: [
      { number: '1', quantity: '2', unitCode: 'H87', description: 'Cappuccino', unitPrice: '6.50', adjustments: [], net: '13.00', tax: '1.63', total: '14.63' },
      { number: '2', quantity: '1', unitCode: 'H87', description: 'Banana bread', unitPrice: '3.75', adjustments: [{ reason: 'Discount', amount: '0.38', isCharge: false }], net: '3.37', tax: '0.42', total: '3.79' },
    ],
    totals: { taxExclusive: '16.37', gst: '2.05', otherTaxes: [], taxInclusive: '18.42', payable: '18.42' },
    ...(!receipt && { payment: { dueDate: '2026-12-22', terms: 'Net 30' } }),
    regulatory: ['Transmitted to tests environment, no fiscal value'],
  };
}

/** Realistic data for previewing a template, with the business's own details. */
export async function sampleContext(def: TemplateDef, biz: BusinessContext, lang: Lang = 'en'): Promise<{ context: Record<string, unknown>; bts?: BtsBlock }> {
  const es = lang === 'es';
  const say = PHRASES[lang];
  const transfer = es ? 'Pague por transferencia a Belize Bank, cuenta 000-111.' : 'Pay by transfer to Belize Bank, account 000-111.';
  const customer = { name: 'Island Logistics Ltd.', email: 'accounts@islandlogistics.example', tin: '777888', address_lines: ['4 Mile Northern Highway', 'Belize City, Belize'] };
  const document = { type_name: documentTypeName('Tax Invoice', lang), number_display: '001-000000042', series: '001', number: '000000042', issue_date: '2026-11-22', due_date: '2026-12-22', total: '1250.00' };
  const store = { name: biz.name, tagline: 'Fresh from Cayo, every morning', city: 'San Ignacio', telephone: biz.telephone };
  switch (def.key) {
    case 'email.document': return { context: { business: biz, customer, document, intro: [], message: `${es ? '¡Gracias por su compra!' : 'Thank you for your business!'}\n\n${transfer}`, pay_url: 'https://example.bz/pay/sample' } };
    case 'email.reminder': return { context: {
      business: biz, customer, document: { ...document, due_date: '2026-11-19' },
      reminder: { when: 'after', days: 3, what: `${say.receivable('01').toLowerCase()} 001-000000042`, balance: '1250.00' },
      message: transfer, pay_url: 'https://example.bz/pay/sample',
    } };
    case 'email.statement':
    case 'document.statement':
      return { context: { business: biz, customer, pay_url: 'https://example.bz/pay/sample', statement: {
        as_of: '2026-11-22', total_due: '1850.00', overdue: '600.00', note: def.key === 'email.statement' ? transfer : null, account_url: def.key === 'email.statement' ? 'https://example.bz/a/sample' : null,
        open: [
          { label: `${say.receivable('01')} 001-000000038`, type: 'Tax invoice', number: '001-000000038', issue_date: '2026-10-14', due_date: '2026-11-13', days_overdue: 9, total: '600.00', paid: '0.00', credited: '0.00', balance: '600.00', pay_url: 'https://example.bz/pay/sample-38' },
          { label: `${say.receivable('01')} 001-000000042`, type: 'Tax invoice', number: '001-000000042', issue_date: '2026-11-22', due_date: '2026-12-22', days_overdue: 0, total: '1250.00', paid: '0.00', credited: '0.00', balance: '1250.00', pay_url: 'https://example.bz/pay/sample-42' },
        ],
        payments: [{ number: '001-000000031', paid_on: '2026-11-02', method: 'Bank transfer', reference: 'BB-77812', amount: '420.00' }],
      } } };
    case 'email.quote': return { context: { business: biz, customer, quote: { number: 'Q-1007', total: '3400.00', valid_until: '2026-12-22' }, view_url: 'https://example.bz/q/sample', message: es ? 'Como lo conversamos por teléfono.' : 'As discussed on the phone.' } };
    case 'email.purchase-order': return { context: { business: biz, supplier: { name: 'Bze Wholesale Ltd.', email: 'orders@example.bz' }, order: {
      number: 'PO-12', expected_on: '2026-11-29', total: '640.00',
      lines: [{ description: 'Coffee beans 1lb', code: 'CB1', quantity: '40', unit_cost: '12.50', total: '500.00' }, { description: 'Paper cups 12 oz (50)', code: null, quantity: '20', unit_cost: '7.00', total: '140.00' }],
    }, message: es ? 'Por favor entregar en la mañana.' : 'Please deliver in the morning.' } };
    case 'email.order-ready': return { context: { store, order: {
      number: 1042, customer_name: 'Maria Chan', delivery: false, address: null, pickup_address: '12 Burns Avenue, San Ignacio', pickup_instructions: es ? 'Toque el timbre en la puerta lateral.' : 'Ring the bell at the side door.',
      items: [{ name: 'Coffee beans 1lb', variant: 'Dark roast', quantity: 2 }, { name: 'Banana bread', variant: null, quantity: 1 }],
    }, message: es ? 'Abrimos hasta las 6 pm.' : 'We are open until 6 pm.' } };
    case 'email.order': return { context: { store, order: {
      number: 1042, customer_name: 'Maria Chan', payment_method: 'bank_transfer',
      items: [{ name: 'Coffee beans 1lb', variant: 'Dark roast', quantity: 2, total: '44.00' }, { name: 'Banana bread', variant: null, quantity: 1, total: '3.75' }],
      payment_lines: [say.payByTransfer('BZ$52.75'), es ? 'Belize Bank, cuenta 000-111' : 'Belize Bank, account 000-111', say.orderReference(1042)],
      delivery: true, address: 'San Ignacio town', delivery_fee: '5.00', total: '52.75', paid: false, url: 'https://example.bz/shop/orders/1042',
    } } };
    case 'document.invoice':
    case 'document.receipt': {
      const { context, bts } = await documentPrintContext(samplePrintView(biz, def.key === 'document.receipt'), { message: 'Thank you! Returns within 7 days with this receipt.' });
      return { context: { ...context, business: biz }, bts };
    }
    case 'document.quote': return { context: { business: biz, customer, quote: {
      number: 'Q-1007', date: '2026-11-22', valid_until: '2026-12-22', status: 'sent', terms: '50% deposit to start; balance on delivery.', note: null,
      lines: [{ description: 'Office fit-out: labour', quantity: '40', unit: 'hours', unit_price: '45.00', gst: '225.00', total: '2025.00' }, { description: 'Materials', quantity: '1', unit: 'lot', unit_price: '1200.00', gst: '150.00', total: '1350.00' }],
      totals: { subtotal: '3000.00', gst: '375.00', total: '3375.00' },
    } } };
    default: return { context: { store, business: biz, products: [
      { name: 'Coffee beans 1lb', price: '22.00', url: '#', image: null },
      { name: 'Cappuccino', price: '6.50', url: '#', image: null },
      { name: 'Banana bread', price: '3.75', url: '#', image: null },
    ] } };
  }
}
