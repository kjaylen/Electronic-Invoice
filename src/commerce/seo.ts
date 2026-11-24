/**
 * What a store's pages say about themselves when shared or searched: the title, description and
 * picture link previews show (WhatsApp, Facebook, Instagram, X), written into the page itself since
 * those readers do not run the app, and each store's sitemap and robots file for search engines.
 */

import type { Queryable } from '../db/database.ts';
import { assetPath } from '../templates/assets.ts';
import { loadStore, priceWithGst, StoreError } from './store.ts';
import { publishedSite } from './site.ts';

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  image: string | null;
  type: 'website' | 'product';
  siteName: string;
  price?: { amount: string; currency: 'BZD' };
  available?: boolean;
  /** What the page is, in schema.org terms (a product with its price, the store with its address), for search engines. */
  jsonLd?: Record<string, unknown>;
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
    const highest = prices.length ? prices.reduce((a, b) => (Number(b) > Number(a) ? b : a)) : null;
    const available = variants.some((v) => v.stock_quantity === null || v.stock_quantity > 0);
    const url = `${origin}/products/${p.handle}`;
    const picture = image ? absolute(`/v1/store/${s.slug}/images/${image.id}`) : logo ? absolute(assetPath(logo)) : null;
    const availability = `https://schema.org/${available ? 'InStock' : 'OutOfStock'}`;
    return {
      title: `${p.title} · ${s.name}`,
      description: plain([lead, p.description].filter(Boolean).join(' · ') || `${p.title} from ${s.name}`, 200),
      url,
      image: picture,
      type: 'product',
      siteName: s.name,
      ...(lowest && { price: { amount: lowest, currency: 'BZD' as const } }),
      available,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'Product', name: p.title, url,
        ...(p.description && { description: plain(p.description, 500) }),
        ...(picture && { image: picture }),
        brand: { '@type': 'Brand', name: s.name },
        ...(lowest && {
          offers: varies
            ? { '@type': 'AggregateOffer', priceCurrency: 'BZD', lowPrice: lowest, highPrice: highest, offerCount: prices.length, availability, url }
            : { '@type': 'Offer', priceCurrency: 'BZD', price: lowest, availability, url },
        }),
      },
    };
  }
  // A picture the site builder chose: one of the business's images, or a product photo.
  const picture = (ref: string | null | undefined) => (ref?.startsWith('a:') ? absolute(`/v1/assets/${ref.slice(2)}`) : ref?.startsWith('p:') ? absolute(`/v1/store/${s.slug}/images/${ref.slice(2)}`) : null);
  const site = await publishedSite(db, s.tenantId);
  const shared = picture(site.seo.image) ?? (logo ? absolute(assetPath(logo)) : null);
  const collection = /^collections\/([a-z0-9-]{1,80})\/?$/.exec(path);
  if (collection) {
    const c = (await db.query<{ handle: string; title: string; description: string; image: string | null; seo_title: string | null; seo_description: string | null }>(
      'select handle, title, description, image, seo_title, seo_description from store_collections where tenant_id = $1 and handle = $2 and published', [s.tenantId, collection[1]],
    )).rows[0];
    if (!c) return null;
    return {
      title: `${c.seo_title || c.title} · ${s.name}`,
      description: plain(c.seo_description || c.description || `${c.title} from ${s.name}`, 200),
      url: `${origin}/collections/${c.handle}`, image: picture(c.image) ?? shared, type: 'website', siteName: s.name,
    };
  }
  const page = /^pages\/([a-z0-9-]{1,80})\/?$/.exec(path);
  if (page) {
    const p = site.pages.find((x) => x.slug === page[1]);
    if (!p) return null;
    const firstText = p.sections.map((x) => String(x.settings.text ?? x.settings.heading ?? '')).find(Boolean) ?? '';
    return { title: `${p.seoTitle || p.title} · ${s.name}`, description: plain(p.seoDescription || firstText || `${p.title} · ${s.name}`, 200), url: `${origin}/pages/${p.slug}`, image: shared, type: 'website', siteName: s.name };
  }
  if (/^(all|collections)\/?$/.test(path)) {
    const all = path.startsWith('all');
    return { title: `${all ? 'All products' : 'Collections'} · ${s.name}`, description: plain(site.seo.description || s.settings.about || s.settings.tagline || s.name, 200), url: `${origin}/${all ? 'all' : 'collections'}`, image: shared, type: 'website', siteName: s.name };
  }
  if (path.replace(/\/$/, '') !== '') return null;
  // The home page: what the site builder says, or the store's tagline, and its logo or its newest product's picture.
  const first = logo ? null : (await db.query<{ id: string }>(
    `select i.id from product_images i join products p on p.id = i.product_id where p.tenant_id = $1 and p.status = 'active' order by p.created_at desc, i.position limit 1`, [s.tenantId],
  )).rows[0];
  const description = plain(site.seo.description || s.settings.about || s.settings.tagline || `Shop ${s.name} online${s.city ? ` in ${s.city}` : ''}, Belize.`, 200);
  const image = shared ?? (first ? absolute(`/v1/store/${s.slug}/images/${first.id}`) : null);
  const sameAs = Object.values(site.social).filter(Boolean);
  return {
    title: site.seo.title || (s.settings.tagline ? `${s.name} · ${plain(s.settings.tagline, 80)}` : s.name),
    description,
    url: origin,
    image,
    type: 'website',
    siteName: s.name,
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'Store', name: s.name, url: origin, description,
      ...(image && { image }),
      ...(logo && { logo: absolute(assetPath(logo)) }),
      ...(s.telephone && { telephone: s.telephone }),
      ...((s.street || s.city) && { address: { '@type': 'PostalAddress', ...(s.street && { streetAddress: s.street }), ...(s.city && { addressLocality: s.city }), addressCountry: 'BZ' } }),
      ...(sameAs.length && { sameAs }),
    },
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
    // A block of data, not a script that runs; "<" is written so that nothing in it can end the block.
    ...(m.jsonLd ? [`<script type="application/ld+json">${JSON.stringify(m.jsonLd).replace(/</g, '\\u003c')}</script>`] : []),
  ];
  return tags.join('');
}

/** The app's page with a store page's title and tags. */
export function withMeta(indexHtml: string, m: PageMeta): string {
  return indexHtml.replace(/<title>[^<]*<\/title>/, `<title>${attr(m.title)}</title>`).replace('</head>', `${metaTags(m)}</head>`);
}

/** A page of a store that is not there (no such product, page or collection, or a closed store): kept out of search results. */
export function withoutMeta(indexHtml: string): string {
  return indexHtml.replace('</head>', '<meta name="robots" content="noindex"></head>');
}

/** Whether `path` (under /shop) names one product, page or collection: when there is none, the answer is "not found". */
export const namesOneThing = (path: string) => /^(products|pages|collections)\/[^/]+\/?$/.test(path);

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
  const collections = (await db.query<{ handle: string; updated_at: Date | string }>('select handle, updated_at from store_collections where tenant_id = $1 and published order by title', [s.tenantId])).rows;
  const pages = (await publishedSite(db, s.tenantId)).pages;
  const extra = [url(`${origin}/all`), ...collections.map((c) => url(`${origin}/collections/${c.handle}`, c.updated_at)), ...pages.map((p) => url(`${origin}/pages/${p.slug}`))].join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${url(origin)}${extra}${products.map((p) => url(`${origin}/products/${p.handle}`, p.updated_at)).join('')}</urlset>\n`;
}

/** robots.txt for a store's own domain: the shop is open to search engines, and where its sitemap is. */
export function storeRobots(origin: string): string {
  return `User-agent: *\nAllow: /shop\nDisallow: /v1/\nSitemap: ${origin.replace(/\/$/, '')}/sitemap.xml\n`;
}
