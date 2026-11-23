/**
 * What a store's pages say about themselves when shared or searched: the title, description and
 * picture link previews show (WhatsApp, Facebook, Instagram, X), written into the page itself since
 * those readers do not run the app, and each store's sitemap and robots file for search engines.
 */

import type { Queryable } from '../db/database.ts';
import { assetPath } from '../templates/assets.ts';
import { loadStore, priceWithGst, StoreError } from './store.ts';

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  image: string | null;
  type: 'website' | 'product';
  siteName: string;
  price?: { amount: string; currency: 'BZD' };
  available?: boolean;
}

const plain = (s: string, max: number) => {
  const text = s.replace(/<[^>]*>/g, ' ').replace(/[#*_`>\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The store page at `path` ("" for the home page, "products/<handle>" for a product), its links under
 * `base` (the store's own domain, or the app's address with the store in it). Null when there is no
 * such open store or product.
 */
export async function storePageMeta(db: Queryable, slug: string, path: string, base: string): Promise<PageMeta | null> {
  let s;
  try {
    s = await loadStore(db, slug);
  } catch (e) {
    if (e instanceof StoreError) return null;
    throw e;
  }
  const origin = base.replace(/\/$/, '');
  const absolute = (p: string) => (/^https?:\/\//.test(p) ? p : `${origin.replace(/^(https?:\/\/[^/]+).*$/, '$1')}${p}`);
  const logo = (await db.query<{ id: string; name: string }>('select a.id, a.name from tenants t join template_assets a on a.id = t.logo_asset_id where t.id = $1', [s.tenantId])).rows[0];
  const product = /^products\/([A-Za-z0-9_-]{1,80})\/?$/.exec(path);
  if (product) {
    const p = (await db.query<{ id: string; handle: string; title: string; description: string }>(
      `select id, handle, title, description from products where tenant_id = $1 and handle = $2 and status = 'active'`, [s.tenantId, product[1]],
    )).rows[0];
    if (!p) return null;
    const variants = (await db.query<{ unit_price: string; gst_category: 'S' | 'Z' | 'E'; stock_quantity: number | null }>(
      'select unit_price::text as unit_price, gst_category, stock_quantity::float8 as stock_quantity from items where product_id = $1 and archived_at is null order by position, created_at', [p.id],
    )).rows;
    const image = (await db.query<{ id: string }>('select id from product_images where product_id = $1 order by position, created_at limit 1', [p.id])).rows[0];
    const prices = variants.map((v) => priceWithGst(v.unit_price, v.gst_category));
    const lowest = prices.length ? prices.reduce((a, b) => (Number(b) < Number(a) ? b : a)) : null;
    const varies = new Set(prices).size > 1;
    const lead = lowest ? `${varies ? 'From ' : ''}BZ$${lowest}` : '';
    return {
      title: `${p.title} · ${s.name}`,
      description: plain([lead, p.description].filter(Boolean).join(' · ') || `${p.title} from ${s.name}`, 200),
      url: `${origin}/products/${p.handle}`,
      image: image ? absolute(`/v1/store/${s.slug}/images/${image.id}`) : logo ? absolute(assetPath(logo)) : null,
      type: 'product',
      siteName: s.name,
      ...(lowest && { price: { amount: lowest, currency: 'BZD' as const } }),
      available: variants.some((v) => v.stock_quantity === null || v.stock_quantity > 0),
    };
  }
  if (path.replace(/\/$/, '') !== '') return null;
  // The home page: the store's tagline, and its logo or its newest product's picture.
  const first = logo ? null : (await db.query<{ id: string }>(
    `select i.id from product_images i join products p on p.id = i.product_id where p.tenant_id = $1 and p.status = 'active' order by p.created_at desc, i.position limit 1`, [s.tenantId],
  )).rows[0];
  return {
    title: s.settings.tagline ? `${s.name} · ${plain(s.settings.tagline, 80)}` : s.name,
    description: plain(s.settings.about || s.settings.tagline || `Shop ${s.name} online${s.city ? ` in ${s.city}` : ''}, Belize.`, 200),
    url: origin,
    image: logo ? absolute(assetPath(logo)) : first ? absolute(`/v1/store/${s.slug}/images/${first.id}`) : null,
    type: 'website',
    siteName: s.name,
  };
}

/** The tags for a page's <head> (every value escaped). */
export function metaTags(m: PageMeta): string {
  const tags = [
    `<meta name="description" content="${attr(m.description)}">`,
    `<link rel="canonical" href="${attr(m.url)}">`,
    `<meta property="og:type" content="${m.type}">`,
    `<meta property="og:site_name" content="${attr(m.siteName)}">`,
    `<meta property="og:title" content="${attr(m.title)}">`,
    `<meta property="og:description" content="${attr(m.description)}">`,
    `<meta property="og:url" content="${attr(m.url)}">`,
    ...(m.image ? [`<meta property="og:image" content="${attr(m.image)}">`, `<meta name="twitter:image" content="${attr(m.image)}">`] : []),
    `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${attr(m.title)}">`,
    `<meta name="twitter:description" content="${attr(m.description)}">`,
    ...(m.price ? [`<meta property="product:price:amount" content="${attr(m.price.amount)}">`, `<meta property="product:price:currency" content="${m.price.currency}">`] : []),
    ...(m.available !== undefined ? [`<meta property="product:availability" content="${m.available ? 'in stock' : 'out of stock'}">`] : []),
  ];
  return tags.join('');
}

/** The app's page with a store page's title and tags. */
export function withMeta(indexHtml: string, m: PageMeta): string {
  return indexHtml.replace(/<title>[^<]*<\/title>/, `<title>${attr(m.title)}</title>`).replace('</head>', `${metaTags(m)}</head>`);
}

/** A store's sitemap: the home page and every active product, with when each last changed. */
export async function storeSitemap(db: Queryable, slug: string, base: string): Promise<string | null> {
  let s;
  try {
    s = await loadStore(db, slug);
  } catch (e) {
    if (e instanceof StoreError) return null;
    throw e;
  }
  const origin = base.replace(/\/$/, '');
  const products = (await db.query<{ handle: string; updated_at: Date | string }>(
    `select handle, updated_at from products where tenant_id = $1 and status = 'active' order by created_at desc limit 5000`, [s.tenantId],
  )).rows;
  const url = (loc: string, mod?: Date | string) => `<url><loc>${attr(loc)}</loc>${mod ? `<lastmod>${new Date(mod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${url(origin)}${products.map((p) => url(`${origin}/products/${p.handle}`, p.updated_at)).join('')}</urlset>\n`;
}

/** robots.txt for a store's own domain: the shop is open to search engines, and where its sitemap is. */
export function storeRobots(origin: string): string {
  return `User-agent: *\nAllow: /shop\nDisallow: /v1/\nSitemap: ${origin.replace(/\/$/, '')}/sitemap.xml\n`;
}
