/**
 * Products for the online store, and the store's settings.
 *
 *   GET/POST    /v1/products               list (status, q), create with its variants
 *   GET/PUT     /v1/products/:id           read, replace (variants upserted; missing ones archived)
 *   DELETE      /v1/products/:id           archive
 *   POST        /v1/products/:id/images    add a photo (JPEG, PNG or WebP, up to 5 MB, 10 per product)
 *   POST        /v1/products/:id/images/:imageId/cover   make it the first photo
 *   DELETE      /v1/products/:id/images/:imageId
 *   GET/PUT     /v1/store-settings         open or close the store, delivery, pickup, payments
 *
 * Each variant is an item: it has the price (before GST), GST category, unit,
 * your code, barcode and stock, and it sells at the counter and on invoices too.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { slugify } from '../db/tenants.ts';
import { DEFAULT_STORE_SETTINGS, priceWithGst, type StoreSettings, trimDecimal, variantTitle, withDefaults } from '../commerce/store.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { decimal, money, uuid } from './schemas.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;

interface VariantBody {
  id?: string;
  option1?: string | null;
  option2?: string | null;
  price: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode?: string | null;
  unitCode?: string;
  sellerCode?: string | null;
  barcode?: string | null;
  stock?: number | null;
}

interface ProductBody {
  title: string;
  handle?: string;
  description?: string;
  status?: 'draft' | 'active' | 'archived';
  option1Name?: string | null;
  option2Name?: string | null;
  variants: VariantBody[];
}

const text = (max: number) => ({ type: 'string', maxLength: max }) as const;
const nullableText = (max: number) => ({ type: ['string', 'null'], maxLength: max }) as const;

const productSchema = {
  type: 'object',
  required: ['title', 'variants'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    handle: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$' },
    description: text(10_000),
    status: { type: 'string', enum: ['draft', 'active', 'archived'] },
    option1Name: nullableText(40),
    option2Name: nullableText(40),
    variants: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['price', 'gstCategory'],
        additionalProperties: false,
        properties: {
          id: uuid,
          option1: nullableText(60),
          option2: nullableText(60),
          price: decimal,
          gstCategory: { type: 'string', enum: ['S', 'Z', 'E'] },
          exemptionReasonCode: nullableText(50),
          unitCode: { type: 'string', pattern: '^[A-Z0-9]{1,3}$' },
          sellerCode: nullableText(100),
          barcode: { type: ['string', 'null'], pattern: '^[0-9A-Za-z-]{1,64}$' },
          stock: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
        },
      },
    },
  },
} as const;

interface ProductRow {
  id: string;
  title: string;
  handle: string;
  description: string;
  status: string;
  option1_name: string | null;
  option2_name: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface VariantRow {
  id: string;
  option1: string | null;
  option2: string | null;
  unit_price: string;
  gst_category: 'S' | 'Z' | 'E';
  exemption_reason_code: string | null;
  unit_code: string;
  seller_code: string | null;
  barcode: string | null;
  stock_quantity: number | null;
  position: number;
}

const variantJson = (v: VariantRow) => ({
  id: v.id,
  title: variantTitle(v),
  option1: v.option1,
  option2: v.option2,
  price: trimDecimal(v.unit_price),
  priceWithGst: priceWithGst(v.unit_price, v.gst_category),
  gstCategory: v.gst_category,
  exemptionReasonCode: v.exemption_reason_code,
  unitCode: v.unit_code,
  sellerCode: v.seller_code,
  barcode: v.barcode,
  stock: v.stock_quantity,
});

/** "image/jpeg" etc. from the file's first bytes; never trust the name or the browser's claim. */
export function imageType(data: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function freeHandle(db: Queryable, tenantId: string, base: string, exceptId?: string): Promise<string> {
  const root = (slugify(base).slice(0, 70) || 'product').replace(/-+$/, '');
  for (let i = 1; i < 500; i++) {
    const h = i === 1 ? root : `${root}-${i}`;
    const taken = await db.query('select 1 from products where tenant_id = $1 and handle = $2 and id is distinct from $3', [tenantId, h, exceptId ?? null]);
    if (!taken.rows.length) return h;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

export async function productDetail(db: Queryable, tenantId: string, id: string) {
  const p = (await db.query<ProductRow>('select * from products where id = $1 and tenant_id = $2', [id, tenantId])).rows[0];
  if (!p) throw notFound('Product');
  const variants = (await db.query<VariantRow>(
    `select id, option1, option2, unit_price::text as unit_price, gst_category, exemption_reason_code, unit_code, seller_code, barcode, stock_quantity, position
     from items where product_id = $1 and tenant_id = $2 and archived_at is null order by position, created_at`,
    [id, tenantId],
  )).rows;
  const images = (await db.query<{ id: string; content_type: string; bytes: number }>(
    'select id, content_type, bytes from product_images where product_id = $1 order by position, created_at', [id],
  )).rows;
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    description: p.description,
    status: p.status,
    option1Name: p.option1_name,
    option2Name: p.option2_name,
    variants: variants.map(variantJson),
    images: images.map((i) => ({ id: i.id, contentType: i.content_type, bytes: i.bytes })),
    createdAt: new Date(p.created_at).toISOString(),
    updatedAt: new Date(p.updated_at).toISOString(),
  };
}

function checkVariants(b: ProductBody) {
  const seen = new Set<string>();
  for (const v of b.variants) {
    if (v.gstCategory === 'E' && !v.exemptionReasonCode) throw new ApiError(422, 'invalid_product', 'An exempt variant needs an exemption reason code');
    if (b.variants.length > 1 && !v.option1 && !v.option2) throw new ApiError(422, 'invalid_product', 'With several variants, give each one an option value (e.g. a size)');
    const key = `${v.option1 ?? ''}|${v.option2 ?? ''}`.toLowerCase();
    if (seen.has(key)) throw new ApiError(422, 'invalid_product', `Two variants have the same options (${[v.option1, v.option2].filter(Boolean).join(' / ') || 'none'})`);
    seen.add(key);
  }
}

/** Write the variants: update the ones that exist, add new ones, archive the ones left out. */
async function saveVariants(tx: Queryable, tenantId: string, productId: string, b: ProductBody) {
  const existing = new Set((await tx.query<{ id: string }>('select id from items where product_id = $1 and tenant_id = $2 and archived_at is null', [productId, tenantId])).rows.map((r) => r.id));
  const kept = new Set<string>();
  let position = 0;
  for (const v of b.variants) {
    const vt = variantTitle({ option1: v.option1 ?? null, option2: v.option2 ?? null });
    const name = vt ? `${b.title} – ${vt}` : b.title;
    const values = [v.option1 || null, v.option2 || null, v.price, v.gstCategory, v.gstCategory === 'E' ? v.exemptionReasonCode ?? null : null, v.unitCode ?? 'H87', v.sellerCode || null, v.barcode || null, v.stock ?? null, position++, name];
    if (v.id) {
      if (!existing.has(v.id)) throw new ApiError(422, 'invalid_product', 'A variant does not belong to this product');
      kept.add(v.id);
      await tx.query(
        `update items set option1 = $3, option2 = $4, unit_price = $5, gst_category = $6, exemption_reason_code = $7, unit_code = $8, seller_code = $9, barcode = $10,
           stock_quantity = $11, position = $12, name = $13, description = $13 where id = $1 and tenant_id = $2`,
        [v.id, tenantId, ...values],
      );
    } else {
      await tx.query(
        `insert into items (id, tenant_id, product_id, option1, option2, unit_price, gst_category, exemption_reason_code, unit_code, seller_code, barcode, stock_quantity, position, name, description)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
        [randomUUID(), tenantId, productId, ...values],
      );
    }
  }
  for (const id of existing) {
    if (!kept.has(id)) await tx.query('update items set archived_at = now(), barcode = null where id = $1', [id]);
  }
}

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    tagline: text(160),
    about: text(4000),
    notifyEmail: text(254),
    whatsapp: text(30),
    delivery: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        zones: { type: 'array', maxItems: 30, items: { type: 'object', required: ['name', 'fee'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, fee: money } } },
      },
    },
    pickup: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, instructions: text(1000) } },
    payments: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bankTransfer: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, instructions: text(2000) } },
        cashOnDelivery: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
        payAtPickup: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
      },
    },
  },
} as const;

export function registerProductRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  app.get<{ Querystring: { status?: string; q?: string } }>(
    '/products',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['draft', 'active', 'archived', 'all'] }, q: text(100) } } } },
    async (request) => {
      const params: unknown[] = [request.tenantId];
      let where = 'p.tenant_id = $1';
      const status = request.query.status ?? 'all';
      if (status === 'all') where += ` and p.status <> 'archived'`;
      else {
        params.push(status);
        where += ` and p.status = $${params.length}`;
      }
      if (request.query.q) {
        params.push(`%${request.query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where += ` and p.title ilike $${params.length}`;
      }
      const rows = (await db.query<ProductRow & { variants: number; min_price: string | null; max_price: string | null; gst: 'S' | 'Z' | 'E' | null; stock: number | null; untracked: number; image_id: string | null }>(
        `select p.*,
           (select count(*)::int from items i where i.product_id = p.id and i.archived_at is null) as variants,
           (select min(i.unit_price)::text from items i where i.product_id = p.id and i.archived_at is null) as min_price,
           (select max(i.unit_price)::text from items i where i.product_id = p.id and i.archived_at is null) as max_price,
           (select i.gst_category from items i where i.product_id = p.id and i.archived_at is null order by i.position limit 1) as gst,
           (select sum(i.stock_quantity)::int from items i where i.product_id = p.id and i.archived_at is null) as stock,
           (select count(*)::int from items i where i.product_id = p.id and i.archived_at is null and i.stock_quantity is null) as untracked,
           (select g.id from product_images g where g.product_id = p.id order by g.position, g.created_at limit 1) as image_id
         from products p where ${where} order by p.updated_at desc limit 500`,
        params,
      )).rows;
      return {
        data: rows.map((r) => ({
          id: r.id,
          title: r.title,
          handle: r.handle,
          status: r.status,
          variants: r.variants,
          priceFrom: r.min_price && r.gst ? priceWithGst(r.min_price, r.gst) : null,
          priceTo: r.max_price && r.gst ? priceWithGst(r.max_price, r.gst) : null,
          stock: r.untracked > 0 ? null : r.stock,
          imageId: r.image_id,
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/products/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) =>
    productDetail(db, request.tenantId, request.params.id),
  );

  app.post<{ Body: ProductBody }>('/products', { schema: { body: productSchema } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const b = request.body;
    checkVariants(b);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      const handle = await freeHandle(tx, request.tenantId, b.handle ?? b.title);
      await tx.query(
        'insert into products (id, tenant_id, title, handle, description, status, option1_name, option2_name) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, request.tenantId, b.title.trim(), handle, b.description ?? '', b.status ?? 'draft', b.option1Name || null, b.option2Name || null],
      );
      await saveVariants(tx, request.tenantId, id, b);
    }).catch(barcodeConflict);
    return reply.code(201).send(await productDetail(db, request.tenantId, id));
  });

  app.put<{ Params: { id: string }; Body: ProductBody }>(
    '/products/:id',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: productSchema } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      checkVariants(b);
      await db.transaction(async (tx) => {
        const current = (await tx.query<{ handle: string }>('select handle from products where id = $1 and tenant_id = $2 for update', [request.params.id, request.tenantId])).rows[0];
        if (!current) throw notFound('Product');
        const handle = b.handle && b.handle !== current.handle ? await freeHandle(tx, request.tenantId, b.handle, request.params.id) : current.handle;
        await tx.query(
          `update products set title = $3, handle = $4, description = $5, status = $6, option1_name = $7, option2_name = $8, updated_at = now() where id = $1 and tenant_id = $2`,
          [request.params.id, request.tenantId, b.title.trim(), handle, b.description ?? '', b.status ?? 'draft', b.option1Name || null, b.option2Name || null],
        );
        await saveVariants(tx, request.tenantId, request.params.id, b);
      }).catch(barcodeConflict);
      return productDetail(db, request.tenantId, request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/products/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    const r = await db.query(`update products set status = 'archived', updated_at = now() where id = $1 and tenant_id = $2 returning id`, [request.params.id, request.tenantId]);
    if (!r.rows.length) throw notFound('Product');
    return reply.code(204).send();
  });

  // Photos arrive as Base64 in JSON (up to 5 MB of image, so the body may reach ~7 MB).
  app.post<{ Params: { id: string }; Body: { dataBase64: string } }>(
    '/products/:id/images',
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: { type: 'object', required: ['dataBase64'], additionalProperties: false, properties: { dataBase64: { type: 'string', minLength: 16, maxLength: 7_200_000 } } },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'catalog.manage');
      const exists = await db.query('select 1 from products where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
      if (!exists.rows.length) throw notFound('Product');
      const data = Buffer.from(request.body.dataBase64, 'base64');
      if (data.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'image_too_large', 'Photos can be up to 5 MB');
      const type = imageType(data);
      if (!type) throw new ApiError(422, 'invalid_image', 'Use a JPEG, PNG or WebP photo');
      const count = (await db.query<{ n: number }>('select count(*)::int as n from product_images where product_id = $1', [request.params.id])).rows[0]!.n;
      if (count >= MAX_IMAGES) throw new ApiError(409, 'too_many_images', `A product can have up to ${MAX_IMAGES} photos`);
      const id = randomUUID();
      await db.query('insert into product_images (id, tenant_id, product_id, position, content_type, bytes, data) values ($1, $2, $3, $4, $5, $6, $7)', [
        id, request.tenantId, request.params.id, count, type, data.length, data,
      ]);
      await db.query('update products set updated_at = now() where id = $1', [request.params.id]);
      return reply.code(201).send({ id, contentType: type, bytes: data.length });
    },
  );

  app.post<{ Params: { id: string; imageId: string } }>(
    '/products/:id/images/:imageId/cover',
    { schema: { params: { type: 'object', required: ['id', 'imageId'], properties: { id: uuid, imageId: uuid } } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      const r = await db.query(
        `update product_images set position = (select coalesce(min(position), 0) - 1 from product_images where product_id = $2) where id = $1 and product_id = $2 and tenant_id = $3 returning id`,
        [request.params.imageId, request.params.id, request.tenantId],
      );
      if (!r.rows.length) throw notFound('Photo');
      return productDetail(db, request.tenantId, request.params.id);
    },
  );

  app.delete<{ Params: { id: string; imageId: string } }>(
    '/products/:id/images/:imageId',
    { schema: { params: { type: 'object', required: ['id', 'imageId'], properties: { id: uuid, imageId: uuid } } } },
    async (request, reply) => {
      requirePermission(request, 'catalog.manage');
      const r = await db.query('delete from product_images where id = $1 and product_id = $2 and tenant_id = $3 returning id', [request.params.imageId, request.params.id, request.tenantId]);
      if (!r.rows.length) throw notFound('Photo');
      return reply.code(204).send();
    },
  );

  // A photo, for the merchant's own screens (any status). Buyers use the storefront's route.
  app.get<{ Params: { id: string; imageId: string } }>(
    '/products/:id/images/:imageId',
    { schema: { params: { type: 'object', required: ['id', 'imageId'], properties: { id: uuid, imageId: uuid } } } },
    async (request, reply) => {
      const img = (await db.query<{ content_type: string; data: Buffer }>('select content_type, data from product_images where id = $1 and product_id = $2 and tenant_id = $3', [request.params.imageId, request.params.id, request.tenantId])).rows[0];
      if (!img) throw notFound('Photo');
      return reply.type(img.content_type).header('Cache-Control', 'private, max-age=86400').send(Buffer.from(img.data));
    },
  );

  // ---------- store settings ----------

  app.get('/store-settings', async (request) => {
    const row = (await db.query<{ store_settings: Partial<StoreSettings>; slug: string }>('select store_settings, slug from tenants where id = $1', [request.tenantId])).rows[0]!;
    return { ...withDefaults(row.store_settings), slug: row.slug };
  });

  app.put<{ Body: Partial<StoreSettings> }>('/store-settings', { schema: { body: settingsSchema } }, async (request) => {
    requirePermission(request, 'business.manage');
    const before = (await db.query<{ store_settings: Partial<StoreSettings> }>('select store_settings from tenants where id = $1', [request.tenantId])).rows[0]!.store_settings;
    const merged = withDefaults({ ...withDefaults(before), ...request.body } as Partial<StoreSettings>);
    const zones = merged.delivery.zones.map((z) => z.name.trim().toLowerCase());
    if (new Set(zones).size !== zones.length) throw new ApiError(422, 'invalid_settings', 'Two delivery zones have the same name');
    if (merged.enabled && !merged.delivery.enabled && !merged.pickup.enabled) throw new ApiError(422, 'invalid_settings', 'Offer delivery, pickup, or both');
    if (merged.enabled && !merged.payments.bankTransfer.enabled && !merged.payments.cashOnDelivery.enabled && !merged.payments.payAtPickup.enabled) {
      throw new ApiError(422, 'invalid_settings', 'Turn on at least one way to pay');
    }
    await db.query('update tenants set store_settings = $2 where id = $1', [request.tenantId, JSON.stringify(merged)]);
    if (Boolean(withDefaults(before).enabled) !== merged.enabled) {
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: merged.enabled ? 'store.opened' : 'store.closed', ip: request.ip });
    }
    return merged;
  });
}

function barcodeConflict(e: unknown): never {
  if ((e as { code?: string }).code === '23505' && /items_barcode/.test(String((e as Error).message))) throw new ApiError(409, 'conflict', 'Another item already has this barcode');
  throw e;
}

export { DEFAULT_STORE_SETTINGS };
