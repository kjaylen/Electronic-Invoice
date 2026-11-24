/**
 * The store's products as its pages show them (prices with GST, "was" prices,
 * badges, sold out), chosen and ordered for each place: every product, a
 * collection, a category, products on sale, the newest or best selling, ones
 * picked by hand, or ones related to a product.
 *
 * Collections group products: picked by hand (in the order chosen), or every
 * active product matching rules (category, title, tag, price, on sale, in
 * stock, added in the last N days), all or any of them.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { priceWithGst } from './store.ts';

export type CatalogSort = 'manual' | 'newest' | 'price_asc' | 'price_desc' | 'title' | 'best_selling';
export const SORTS: CatalogSort[] = ['manual', 'newest', 'price_asc', 'price_desc', 'title', 'best_selling'];

export interface ProductCard {
  handle: string;
  title: string;
  imageId: string | null;
  price: string;
  compareAt: string | null;
  priceVaries: boolean;
  soldOut: boolean;
  category: string | null;
  badge: string | null;
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  collection?: string;
  handles?: string[];
  onSale?: boolean;
  relatedTo?: string;
  sort?: CatalogSort;
  limit?: number;
  newWithinDays?: number;
  /** Rules not yet saved (a collection's preview). */
  rules?: CollectionRules;
}

export class CatalogError extends Error {
  override name = 'CatalogError';
  readonly code: 'not_found' | 'invalid_collection' | 'conflict';
  constructor(code: CatalogError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const CATEGORY = `(select min(i.category) from items i where i.product_id = p.id and i.archived_at is null and i.category is not null)`;
const PRICE = `(select min(case when i.gst_category = 'S' then i.unit_price * 1.125 else i.unit_price end) from items i where i.product_id = p.id and i.archived_at is null)`;
const ON_SALE = `exists (select 1 from items i where i.product_id = p.id and i.archived_at is null and i.compare_at_price > i.unit_price)`;
const IN_STOCK = `exists (select 1 from items i where i.product_id = p.id and i.archived_at is null and (i.stock_quantity is null or i.stock_quantity > 0))`;
const SOLD_90 = `(select coalesce(sum(l.quantity), 0) from order_lines l join items i on i.id = l.item_id join orders o on o.id = l.order_id
  where i.product_id = p.id and o.status <> 'cancelled' and o.created_at > now() - interval '90 days')`;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface RuleCondition { field: 'category' | 'title' | 'tag' | 'price' | 'on_sale' | 'in_stock' | 'new'; op: 'is' | 'is_not' | 'contains' | 'gt' | 'lt' | 'within_days'; value: string }
export interface CollectionRules { match: 'all' | 'any'; conditions: RuleCondition[] }

/** The SQL for a collection's rules (values as parameters). */
function rulesSql(rules: CollectionRules, params: unknown[]): string {
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const parts = rules.conditions.map((c) => {
    switch (c.field) {
      case 'category':
        if (c.op === 'contains') return `${CATEGORY} ilike ${push(`%${escapeLike(c.value)}%`)}`;
        return c.op === 'is_not' ? `coalesce(lower(${CATEGORY}), '') <> lower(${push(c.value)})` : `lower(${CATEGORY}) = lower(${push(c.value)})`;
      case 'title':
        if (c.op === 'is') return `lower(p.title) = lower(${push(c.value)})`;
        return c.op === 'is_not' ? `p.title not ilike ${push(`%${escapeLike(c.value)}%`)}` : `p.title ilike ${push(`%${escapeLike(c.value)}%`)}`;
      case 'tag':
        return c.op === 'is_not' ? `not (lower(${push(c.value)}) = any (select lower(t) from unnest(p.tags) t))` : `lower(${push(c.value)}) = any (select lower(t) from unnest(p.tags) t)`;
      case 'price':
        return `${PRICE} ${c.op === 'lt' ? '<' : '>'} ${push(Number(c.value) || 0)}::numeric`;
      case 'on_sale':
        return c.op === 'is_not' ? `not ${ON_SALE}` : ON_SALE;
      case 'in_stock':
        return c.op === 'is_not' ? `not ${IN_STOCK}` : IN_STOCK;
      case 'new':
        return `p.created_at > now() - ${push(Math.max(1, Math.min(365, Number(c.value) || 30)))}::float8 * interval '1 day'`;
    }
  });
  if (!parts.length) return 'true';
  return `(${parts.join(rules.match === 'any' ? ' or ' : ' and ')})`;
}

const ORDER: Record<CatalogSort, string> = {
  manual: 'p.created_at desc',
  newest: 'p.created_at desc',
  price_asc: `${PRICE} asc nulls last, p.created_at desc`,
  price_desc: `${PRICE} desc nulls last, p.created_at desc`,
  title: 'lower(p.title) asc',
  best_selling: `${SOLD_90} desc, p.created_at desc`,
};

/** Products for a page of the store (active, with at least one variant). */
export async function catalog(db: Queryable, tenantId: string, query: CatalogQuery = {}): Promise<ProductCard[]> {
  const params: unknown[] = [tenantId];
  let where = `p.tenant_id = $1 and p.status = 'active'`;
  let order = ORDER[query.sort ?? 'newest'];
  if (query.q?.trim()) {
    params.push(`%${escapeLike(query.q.trim())}%`);
    where += ` and (p.title ilike $${params.length} or p.description ilike $${params.length} or exists (select 1 from unnest(p.tags) t where t ilike $${params.length}))`;
  }
  if (query.category) {
    params.push(query.category);
    where += ` and lower(${CATEGORY}) = lower($${params.length})`;
  }
  if (query.onSale) where += ` and ${ON_SALE}`;
  if (query.rules) where += ` and ${rulesSql(query.rules, params)}`;
  if (query.newWithinDays) {
    params.push(query.newWithinDays);
    where += ` and p.created_at > now() - $${params.length}::float8 * interval '1 day'`;
  }
  if (query.handles) {
    if (!query.handles.length) return [];
    params.push(query.handles);
    where += ` and p.handle = any($${params.length}::text[])`;
    order = `array_position($${params.length}::text[], p.handle)`;
  }
  if (query.collection) {
    const c = (await db.query<{ id: string; rules: CollectionRules | null; sort: CatalogSort }>(
      'select id, rules, sort from store_collections where tenant_id = $1 and handle = $2 and published', [tenantId, query.collection],
    )).rows[0];
    if (!c) return [];
    if (c.rules) {
      where += ` and ${rulesSql(c.rules, params)}`;
    } else {
      params.push(c.id);
      where += ` and exists (select 1 from store_collection_products cp where cp.collection_id = $${params.length} and cp.product_id = p.id)`;
      if (!query.sort || query.sort === 'manual') order = `(select cp.position from store_collection_products cp where cp.collection_id = $${params.length} and cp.product_id = p.id)`;
    }
    if (!query.sort && c.sort !== 'manual') order = ORDER[c.sort];
  }
  if (query.relatedTo) {
    // Same category first, then the newest; never the product itself.
    params.push(query.relatedTo);
    const self = `$${params.length}`;
    where += ` and p.handle <> ${self}`;
    order = `(${CATEGORY} is not distinct from (select ${CATEGORY.replace(/p\.id/g, 'x.id')} from products x where x.tenant_id = $1 and x.handle = ${self})) desc, p.created_at desc`;
  }
  params.push(Math.min(500, Math.max(1, query.limit ?? 500)));
  const rows = (await db.query<{ handle: string; title: string; badge: string | null; image_id: string | null; category: string | null; prices: Array<{ price: string; was: string | null; gst: 'S' | 'Z' | 'E'; stock: number | null }> | null }>(
    `select p.handle, p.title, p.badge, ${CATEGORY} as category,
       (select g.id from product_images g where g.product_id = p.id order by g.position, g.created_at limit 1) as image_id,
       (select json_agg(json_build_object('price', i.unit_price::text, 'was', i.compare_at_price::text, 'gst', i.gst_category, 'stock', i.stock_quantity::float8)) from items i where i.product_id = p.id and i.archived_at is null) as prices
     from products p where ${where} order by ${order} limit $${params.length}`,
    params,
  )).rows;
  return rows.filter((r) => r.prices?.length).map((r) => {
    const variants = r.prices!.map((x) => ({ price: Number(priceWithGst(x.price, x.gst)), was: x.was && Number(x.was) > Number(x.price) ? Number(priceWithGst(x.was, x.gst)) : null }));
    const cheapest = variants.reduce((a, b) => (b.price < a.price ? b : a));
    const max = Math.max(...variants.map((v) => v.price));
    return {
      handle: r.handle,
      title: r.title,
      imageId: r.image_id,
      price: cheapest.price.toFixed(2),
      compareAt: cheapest.was ? cheapest.was.toFixed(2) : null,
      priceVaries: cheapest.price !== max,
      soldOut: r.prices!.every((x) => x.stock !== null && x.stock <= 0),
      category: r.category,
      badge: r.badge,
    };
  });
}

/** The store's product categories (for category buttons and pickers). */
export async function categories(db: Queryable, tenantId: string): Promise<string[]> {
  return (await db.query<{ c: string }>(
    `select distinct i.category as c from items i join products p on p.id = i.product_id
     where p.tenant_id = $1 and p.status = 'active' and i.archived_at is null and i.category is not null order by 1`, [tenantId],
  )).rows.map((r) => r.c);
}

// ---------- collections ----------

export interface CollectionInput {
  title: string;
  handle?: string;
  description?: string;
  image?: string | null;
  rules?: CollectionRules | null;
  products?: string[];
  sort?: CatalogSort;
  published?: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
}

interface CollectionRow { id: string; handle: string; title: string; description: string; image: string | null; rules: CollectionRules | null; sort: CatalogSort; published: boolean; seo_title: string | null; seo_description: string | null; created_at: Date; updated_at: Date }

const FIELDS = ['category', 'title', 'tag', 'price', 'on_sale', 'in_stock', 'new'] as const;
const OPS = ['is', 'is_not', 'contains', 'gt', 'lt', 'within_days'] as const;

export function checkRules(rules: CollectionRules | null | undefined): CollectionRules | null {
  if (!rules) return null;
  if (!['all', 'any'].includes(rules.match)) throw new CatalogError('invalid_collection', 'Say whether products must match all the conditions or any of them');
  if (!Array.isArray(rules.conditions) || rules.conditions.length === 0 || rules.conditions.length > 10) throw new CatalogError('invalid_collection', 'Give one to ten conditions');
  return {
    match: rules.match,
    conditions: rules.conditions.map((c) => {
      if (!(FIELDS as readonly string[]).includes(c.field) || !(OPS as readonly string[]).includes(c.op)) throw new CatalogError('invalid_collection', 'A condition is not one the store knows');
      const value = String(c.value ?? '').trim().slice(0, 100);
      if (['category', 'title', 'tag'].includes(c.field) && !value) throw new CatalogError('invalid_collection', 'Each condition needs a value');
      if (c.field === 'price' && !(Number(value) >= 0)) throw new CatalogError('invalid_collection', 'A price condition needs an amount');
      return { field: c.field, op: c.op, value };
    }),
  };
}

const slugify = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'collection';

async function freeHandle(db: Queryable, tenantId: string, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base).replace(/-+$/, '');
  for (let i = 1; i < 200; i++) {
    const h = i === 1 ? root : `${root}-${i}`;
    if (!(await db.query('select 1 from store_collections where tenant_id = $1 and handle = $2 and id is distinct from $3', [tenantId, h, exceptId ?? null])).rows.length) return h;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

async function setProducts(db: Queryable, tenantId: string, collectionId: string, handles: string[]) {
  await db.query('delete from store_collection_products where collection_id = $1', [collectionId]);
  if (!handles.length) return;
  const found = (await db.query<{ id: string; handle: string }>('select id, handle from products where tenant_id = $1 and handle = any($2::text[])', [tenantId, handles])).rows;
  const byHandle = new Map(found.map((p) => [p.handle, p.id]));
  let position = 0;
  for (const h of handles) {
    const id = byHandle.get(h);
    if (id) await db.query('insert into store_collection_products (collection_id, product_id, position) values ($1, $2, $3) on conflict do nothing', [collectionId, id, position++]);
  }
}

export async function collectionJson(db: Queryable, tenantId: string, c: CollectionRow) {
  const products = c.rules ? null : (await db.query<{ handle: string }>(
    'select p.handle from store_collection_products cp join products p on p.id = cp.product_id where cp.collection_id = $1 order by cp.position', [c.id],
  )).rows.map((r) => r.handle);
  const count = (await catalog(db, tenantId, { collection: c.handle })).length;
  return {
    id: c.id, handle: c.handle, title: c.title, description: c.description, image: c.image, rules: c.rules, products, sort: c.sort, published: c.published,
    seoTitle: c.seo_title, seoDescription: c.seo_description, productCount: c.published ? count : null,
    createdAt: new Date(c.created_at).toISOString(), updatedAt: new Date(c.updated_at).toISOString(),
  };
}

export async function listCollections(db: Queryable, tenantId: string, options: { publishedOnly?: boolean } = {}) {
  return (await db.query<CollectionRow>(
    `select * from store_collections where tenant_id = $1 ${options.publishedOnly ? 'and published' : ''} order by lower(title)`, [tenantId],
  )).rows;
}

export async function getCollection(db: Queryable, tenantId: string, id: string): Promise<CollectionRow> {
  const c = (await db.query<CollectionRow>('select * from store_collections where tenant_id = $1 and id = $2', [tenantId, id])).rows[0];
  if (!c) throw new CatalogError('not_found', 'Collection not found');
  return c;
}

export async function saveCollection(db: Queryable, tenantId: string, input: CollectionInput, id?: string): Promise<CollectionRow> {
  const title = input.title.trim();
  if (!title) throw new CatalogError('invalid_collection', 'Give the collection a title');
  const rules = checkRules(input.rules);
  const image = input.image && /^(a|p):[0-9a-f-]{36}$/.test(input.image) ? input.image : null;
  let row: CollectionRow;
  if (id) {
    const current = await getCollection(db, tenantId, id);
    const handle = input.handle && input.handle !== current.handle ? await freeHandle(db, tenantId, input.handle, id) : current.handle;
    row = (await db.query<CollectionRow>(
      `update store_collections set handle = $3, title = $4, description = $5, image = $6, rules = $7, sort = $8, published = $9, seo_title = $10, seo_description = $11, updated_at = now()
       where tenant_id = $1 and id = $2 returning *`,
      [tenantId, id, handle, title, input.description ?? current.description, image, rules ? JSON.stringify(rules) : null, input.sort ?? current.sort, input.published ?? current.published, input.seoTitle ?? null, input.seoDescription ?? null],
    )).rows[0]!;
  } else {
    const handle = await freeHandle(db, tenantId, input.handle ?? title);
    row = (await db.query<CollectionRow>(
      `insert into store_collections (id, tenant_id, handle, title, description, image, rules, sort, published, seo_title, seo_description)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [randomUUID(), tenantId, handle, title, input.description ?? '', image, rules ? JSON.stringify(rules) : null, input.sort ?? (rules ? 'newest' : 'manual'), input.published ?? true, input.seoTitle ?? null, input.seoDescription ?? null],
    )).rows[0]!;
  }
  if (!rules) await setProducts(db, tenantId, row.id, input.products ?? []);
  else await db.query('delete from store_collection_products where collection_id = $1', [row.id]);
  return row;
}

export async function deleteCollection(db: Queryable, tenantId: string, id: string) {
  const r = await db.query('delete from store_collections where tenant_id = $1 and id = $2 returning id', [tenantId, id]);
  if (!r.rows.length) throw new CatalogError('not_found', 'Collection not found');
}
