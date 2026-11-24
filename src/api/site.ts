/**
 * The site builder, for the business (owners and admins edit the site;
 * collections are catalog work).
 *
 *   GET  /v1/store-site                         the draft, whether it differs from what is published, and the builder's catalog
 *                                         (section types and their fields, theme presets, fonts, icons, categories, collections)
 *   PUT  /v1/store-site/draft { site, base? }   save the draft (checked and completed; returns it as saved).
 *                                         With base (the draftUpdatedAt last seen), 409 draft_changed if someone else saved since
 *   POST /v1/store-site/publish { note? }       customers see the draft from now on; the version is kept
 *   POST /v1/store-site/discard                 back to what is published
 *   GET  /v1/store-site/versions                published versions kept (the last 30)
 *   POST /v1/store-site/versions/:id/restore    an earlier version as the draft
 *   POST /v1/store-site/render { code }         a custom code section as the store would show it (for the preview)
 *   POST /v1/store-site/sections { type }       a new section with its starting content
 *
 *   GET|POST /v1/collections, GET|PUT|DELETE /v1/collections/:id
 *   POST /v1/collections/preview { rules } the products some rules would gather
 */

import type { FastifyInstance } from 'fastify';
import { audit } from '../db/audit.ts';
import { catalog, CatalogError, type CatalogSort, categories, checkRules, collectionJson, type CollectionInput, deleteCollection, getCollection, listCollections, saveCollection } from '../commerce/catalog.ts';
import { FONTS, ICONS, LINK_TYPES, PRESETS, SECTIONS, THEME_OPTIONS } from '../commerce/site-schema.ts';
import { discardDraft, listVersions, loadSite, newSection, publishSite, restoreVersion, saveDraft, SiteError } from '../commerce/site.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderStoreSection, storeContext } from '../templates/render.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

const ruleSchema = {
  type: ['object', 'null'],
  required: ['match', 'conditions'],
  additionalProperties: false,
  properties: {
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: {
      type: 'array', minItems: 1, maxItems: 10,
      items: {
        type: 'object', required: ['field', 'op', 'value'], additionalProperties: false,
        properties: { field: { type: 'string', maxLength: 20 }, op: { type: 'string', maxLength: 20 }, value: { type: 'string', maxLength: 100 } },
      },
    },
  },
} as const;

const collectionSchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    handle: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$' },
    description: { type: 'string', maxLength: 5000 },
    image: { type: ['string', 'null'], maxLength: 40 },
    rules: ruleSchema,
    products: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 80 } },
    sort: { type: 'string', enum: ['manual', 'newest', 'price_asc', 'price_desc', 'title', 'best_selling'] },
    published: { type: 'boolean' },
    seoTitle: { type: ['string', 'null'], maxLength: 120 },
    seoDescription: { type: ['string', 'null'], maxLength: 300 },
  },
} as const;

export function registerSiteRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof SiteError) throw new ApiError(e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 422, e.code === 'conflict' ? 'draft_changed' : e.code, e.message);
      if (e instanceof CatalogError) throw new ApiError(e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 422, e.code, e.message);
      throw e;
    }
  };

  app.get('/store-site', async (request) => {
    requirePermission(request, 'business.manage');
    const site = await loadSite(db, request.tenantId);
    const slug = (await db.query<{ slug: string }>('select slug from tenants where id = $1', [request.tenantId])).rows[0]!.slug;
    const cols = await listCollections(db, request.tenantId);
    return {
      ...site,
      slug,
      builder: {
        sections: SECTIONS, presets: PRESETS, fonts: FONTS, icons: ICONS, linkTypes: LINK_TYPES, themeOptions: THEME_OPTIONS,
        categories: await categories(db, request.tenantId),
        collections: cols.map((c) => ({ handle: c.handle, title: c.title, published: c.published })),
      },
    };
  });

  app.put<{ Body: { site: unknown; base?: string | null } }>('/store-site/draft', { bodyLimit: 1024 * 1024, schema: { body: { type: 'object', required: ['site'], additionalProperties: false, properties: { site: { type: 'object' }, base: { type: ['string', 'null'], format: 'date-time' } } } } }, async (request) => {
    requirePermission(request, 'business.manage');
    return wrap(async () => {
      const draft = await saveDraft(db, request.tenantId, request.body.site, request.userId || null, request.body.base);
      const site = await loadSite(db, request.tenantId);
      return { draft, changed: site.changed, draftUpdatedAt: site.draftUpdatedAt };
    });
  });

  app.post<{ Body: { note?: string } }>('/store-site/publish', { schema: { body: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 200 } } } } }, async (request) => {
    requirePermission(request, 'business.manage');
    const r = await publishSite(db, request.tenantId, request.userId || null, request.body?.note);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'site.published', ...(request.body?.note && { details: { note: request.body.note } }), ip: request.ip });
    return { ...r, changed: false };
  });

  app.post('/store-site/discard', async (request) => {
    requirePermission(request, 'business.manage');
    const draft = await discardDraft(db, request.tenantId, request.userId || null);
    return { draft, changed: false, draftUpdatedAt: (await loadSite(db, request.tenantId)).draftUpdatedAt };
  });

  app.get('/store-site/versions', async (request) => {
    requirePermission(request, 'business.manage');
    return { data: await listVersions(db, request.tenantId) };
  });

  app.post<{ Params: { id: string } }>('/store-site/versions/:id/restore', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    requirePermission(request, 'business.manage');
    return wrap(async () => {
      const draft = await restoreVersion(db, request.tenantId, request.params.id, request.userId || null);
      const site = await loadSite(db, request.tenantId);
      return { draft, changed: site.changed, draftUpdatedAt: site.draftUpdatedAt };
    });
  });

  app.post<{ Body: { code: string } }>('/store-site/render', { schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', maxLength: 20000 } } } } }, async (request) => {
    requirePermission(request, 'business.manage');
    return { html: await renderStoreSection(db, request.tenantId, request.body.code, await storeContext(db, request.tenantId)) };
  });

  app.post<{ Body: { type: string } }>('/store-site/sections', { schema: { body: { type: 'object', required: ['type'], additionalProperties: false, properties: { type: { type: 'string', maxLength: 40 } } } } }, async (request) => {
    requirePermission(request, 'business.manage');
    return wrap(async () => ({ section: newSection(request.body.type) }));
  });

  // ---------- collections ----------

  app.get('/collections', async (request) => {
    requirePermission(request, 'catalog.manage');
    const rows = await listCollections(db, request.tenantId);
    return { data: await Promise.all(rows.map((c) => collectionJson(db, request.tenantId, c))) };
  });

  app.post<{ Body: CollectionInput }>('/collections', { schema: { body: collectionSchema } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    return wrap(async () => {
      const c = await saveCollection(db, request.tenantId, request.body);
      return reply.code(201).send(await collectionJson(db, request.tenantId, c));
    });
  });

  app.post<{ Body: { rules: CollectionInput['rules']; sort?: CatalogSort } }>(
    '/collections/preview',
    { schema: { body: { type: 'object', required: ['rules'], additionalProperties: false, properties: { rules: ruleSchema, sort: collectionSchema.properties.sort } } } },
    async (request) => {
      requirePermission(request, 'catalog.manage');
      return wrap(async () => {
        const rules = checkRules(request.body.rules);
        const products = await catalog(db, request.tenantId, { ...(rules && { rules }), sort: request.body.sort ?? 'newest', limit: 60 });
        return { data: products, count: products.length };
      });
    },
  );

  app.get<{ Params: { id: string } }>('/collections/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    requirePermission(request, 'catalog.manage');
    return wrap(async () => collectionJson(db, request.tenantId, await getCollection(db, request.tenantId, request.params.id)));
  });

  app.put<{ Params: { id: string }; Body: CollectionInput }>('/collections/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: collectionSchema } }, async (request) => {
    requirePermission(request, 'catalog.manage');
    return wrap(async () => collectionJson(db, request.tenantId, await saveCollection(db, request.tenantId, request.body, request.params.id)));
  });

  app.delete<{ Params: { id: string } }>('/collections/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requirePermission(request, 'catalog.manage');
    await wrap(() => deleteCollection(db, request.tenantId, request.params.id));
    return reply.code(204).send();
  });
}
