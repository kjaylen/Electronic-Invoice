/**
 * The template editor's API (owners and admins: business.manage). Templates are Liquid, like a
 * Shopify theme: emails, printed documents and the online store.
 *
 *   GET    /v1/templates                      every template, and whether it is customized
 *   GET    /v1/templates/:key                 its source (yours or the default), variables, rules
 *   PUT    /v1/templates/:key                 { source, subject? }: checked, then saved (422 with problems)
 *   DELETE /v1/templates/:key                 back to the default
 *   POST   /v1/templates/:key/preview         { source, subject? }: rendered with sample data, and any problems
 *   GET    /v1/templates/:key/versions        the last 30 saves
 *   GET    /v1/templates/:key/versions/:id    one save's source
 *
 * Images ({{ 'logo.png' | asset_url }}, {{ business.logo }}):
 *   GET    /v1/templates/assets               the business's images, and which is its logo
 *   POST   /v1/templates/assets               { name, dataBase64 }: PNG, JPEG, GIF, WebP or SVG, up to 2 MB
 *   DELETE /v1/templates/assets/:id           (refused while a saved template uses it)
 *   PUT    /v1/templates/logo                 { assetId | null }
 *   PUT    /v1/templates/settings             { emailLanguage: en | es }: the language of customer emails
 *   GET    /v1/assets/:id/:name               the image itself, public (its id is random)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { addAsset, type AssetMap, assetMap, assetPath, type AssetRow, assetType, listAssets, MAX_ASSET_BYTES, MAX_ASSETS } from '../templates/assets.ts';
import { defaultSource, defaultSubject, TEMPLATES, type TemplateDef, templateDef } from '../templates/catalog.ts';
import { emailLanguage, type Lang, LANGS } from '../templates/lang.ts';
import { htmlToText, renderHtml, renderText } from '../templates/engine.ts';
import {
  businessContext, cleanCss, loadTemplate, revertTemplate, sampleContext, sanitizeSection, saveTemplate, storeContext, templateProblems, withAssets, withBtsStyles,
} from '../templates/render.ts';
import { ApiError, notFound } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

const keyParams = { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 40 } } } as const;
const body = {
  type: 'object',
  required: ['source'],
  additionalProperties: false,
  properties: { source: { type: 'string', maxLength: 150_000 }, subject: { type: ['string', 'null'], maxLength: 500 } },
} as const;

const assetJson = (a: AssetRow, logoId: string | null) => ({
  id: a.id, name: a.name, contentType: a.content_type, bytes: a.bytes, width: a.width, height: a.height,
  url: assetPath(a), logo: a.id === logoId, createdAt: new Date(a.created_at).toISOString(),
});

const summary = (def: TemplateDef) => ({
  key: def.key, group: def.group, name: def.name, description: def.description, language: def.language, preview: def.preview, hasSubject: def.subject !== undefined,
});

export function registerTemplateRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;

  const defOf = (key: string) => {
    const def = templateDef(key);
    if (!def) throw notFound('Template');
    return def;
  };

  /** The images a draft refers to, addressed for the editor's preview (same origin). */
  const draftAssets = (tenantId: string, source: string, subject: string | null): Promise<AssetMap> => assetMap(db, tenantId, [source, subject], { kind: 'url' });

  /** Sample data with the business's own details; store templates see the real store. */
  async function sample(def: TemplateDef, tenantId: string): Promise<Awaited<ReturnType<typeof sampleContext>> & { lang: Lang }> {
    const biz = await businessContext(db, tenantId);
    // Emails preview in the language they go out in.
    const lang: Lang = def.group === 'emails' ? await emailLanguage(db, tenantId) : 'en';
    const s = await sampleContext(def, biz, lang);
    if (def.group === 'store') {
      const real = await storeContext(db, tenantId);
      const products = (real.products as unknown[]).length ? real.products : s.context.products;
      return { ...s, context: { ...s.context, ...real, products }, lang };
    }
    return { ...s, lang };
  }

  // ---------- images ----------

  app.get('/templates/assets', async (request) => {
    requirePermission(request, 'business.manage');
    const { assets, logoId } = await listAssets(db, request.tenantId);
    return { data: assets.map((a) => assetJson(a, logoId)), logoId, maxBytes: MAX_ASSET_BYTES, max: MAX_ASSETS };
  });

  // Images arrive as Base64 in JSON (up to 2 MB of image).
  app.post<{ Body: { name: string; dataBase64: string } }>(
    '/templates/assets',
    {
      bodyLimit: 3 * 1024 * 1024 + 4096,
      schema: {
        body: {
          type: 'object', required: ['name', 'dataBase64'], additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, dataBase64: { type: 'string', minLength: 16, maxLength: 2_900_000 } },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'business.manage');
      const data = Buffer.from(request.body.dataBase64, 'base64');
      if (data.length > MAX_ASSET_BYTES) throw new ApiError(413, 'image_too_large', 'Images can be up to 2 MB');
      const type = assetType(data);
      if (!type) throw new ApiError(422, 'invalid_image', 'Use a PNG, JPEG, GIF, WebP or SVG image');
      const count = (await db.query<{ n: number }>('select count(*)::int as n from template_assets where tenant_id = $1', [request.tenantId])).rows[0]!.n;
      if (count >= MAX_ASSETS) throw new ApiError(409, 'too_many_images', `Up to ${MAX_ASSETS} images; delete one you no longer use`);
      const row = await addAsset(db, request.tenantId, request.body.name, data, type, request.userId || null);
      // The first image becomes the logo, if there is none yet.
      await db.query('update tenants set logo_asset_id = $2 where id = $1 and logo_asset_id is null', [request.tenantId, row.id]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'template.image_added', target: row.name, ip: request.ip });
      const { logoId } = await listAssets(db, request.tenantId);
      return reply.code(201).send(assetJson(row, logoId));
    },
  );

  app.delete<{ Params: { id: string } }>('/templates/assets/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requirePermission(request, 'business.manage');
    const a = (await db.query<{ name: string }>('select name from template_assets where id = $1 and tenant_id = $2', [request.params.id, request.tenantId])).rows[0];
    if (!a) throw notFound('Image');
    // A saved template that names it would stop rendering (and fall back to the default): say which.
    const using = (await db.query<{ key: string }>(
      `select key from templates where tenant_id = $1 and (strpos(source, $2) > 0 or strpos(source, $3) > 0 or strpos(coalesce(subject, ''), $2) > 0 or strpos(coalesce(subject, ''), $3) > 0)`,
      [request.tenantId, `'${a.name}'`, `"${a.name}"`],
    )).rows.map((r) => templateDef(r.key)?.name ?? r.key);
    if (using.length) throw new ApiError(409, 'image_in_use', `${using.join(', ')} ${using.length === 1 ? 'uses' : 'use'} ${a.name}. Take it out first.`, { templates: using });
    await db.query('update tenants set logo_asset_id = null where id = $1 and logo_asset_id = $2', [request.tenantId, request.params.id]);
    await db.query('delete from template_assets where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'template.image_deleted', target: a.name, ip: request.ip });
    return reply.code(204).send();
  });

  app.put<{ Body: { assetId: string | null } }>(
    '/templates/logo',
    { schema: { body: { type: 'object', required: ['assetId'], additionalProperties: false, properties: { assetId: { anyOf: [uuid, { type: 'null' }] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const id = request.body.assetId;
      if (id) {
        const found = await db.query('select 1 from template_assets where id = $1 and tenant_id = $2', [id, request.tenantId]);
        if (!found.rows.length) throw notFound('Image');
      }
      await db.query('update tenants set logo_asset_id = $2 where id = $1', [request.tenantId, id]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'template.logo_set', target: id ?? 'none', ip: request.ip });
      return { logoId: id };
    },
  );

  app.get('/templates', async (request) => {
    requirePermission(request, 'business.manage');
    const custom = new Map((await db.query<{ key: string; updated_at: Date | string }>('select key, updated_at from templates where tenant_id = $1', [request.tenantId])).rows
      .map((r) => [r.key, new Date(r.updated_at).toISOString()]));
    return {
      data: TEMPLATES.map((def) => ({ ...summary(def), custom: custom.has(def.key), updatedAt: custom.get(def.key) ?? null })),
      emailLanguage: await emailLanguage(db, request.tenantId),
    };
  });

  app.put<{ Body: { emailLanguage: Lang } }>(
    '/templates/settings',
    { schema: { body: { type: 'object', required: ['emailLanguage'], additionalProperties: false, properties: { emailLanguage: { type: 'string', enum: [...LANGS] } } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      await db.query('update tenants set email_language = $2 where id = $1', [request.tenantId, request.body.emailLanguage]);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'template.email_language', target: request.body.emailLanguage, ip: request.ip });
      return { emailLanguage: request.body.emailLanguage };
    },
  );

  app.get<{ Params: { key: string } }>('/templates/:key', { schema: { params: keyParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const def = defOf(request.params.key);
    const t = await loadTemplate(db, request.tenantId, def.key);
    return {
      ...summary(def), source: t.source, subject: t.subject, custom: t.custom, updatedAt: t.updatedAt, lang: t.lang,
      default: { source: defaultSource(def, t.lang), subject: defaultSubject(def, t.lang) },
      variables: def.variables, rules: (def.requires ?? []).map((r) => r.message),
    };
  });

  app.put<{ Params: { key: string }; Body: { source: string; subject?: string | null } }>(
    '/templates/:key', { schema: { params: keyParams, body } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const def = defOf(request.params.key);
      const source = request.body.source.replace(/\r\n?/g, '\n');
      const subject = def.subject !== undefined ? (request.body.subject ?? '').trim() : null;
      const { context, bts, lang } = await sample(def, request.tenantId);
      const problems = await templateProblems(def, source, subject, context, bts, await draftAssets(request.tenantId, source, subject), lang);
      if (problems.length) throw new ApiError(422, 'invalid_template', problems[0]!.message, { problems });
      await saveTemplate(db, request.tenantId, def.key, source, subject, request.userId || null);
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'template.saved', target: def.key, ip: request.ip });
      const t = await loadTemplate(db, request.tenantId, def.key);
      return { key: def.key, source: t.source, subject: t.subject, custom: t.custom, updatedAt: t.updatedAt };
    },
  );

  app.delete<{ Params: { key: string } }>('/templates/:key', { schema: { params: keyParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const def = defOf(request.params.key);
    if (await revertTemplate(db, request.tenantId, def.key, request.userId || null)) {
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'template.reverted', target: def.key, ip: request.ip });
    }
    const t = await loadTemplate(db, request.tenantId, def.key);
    return { key: def.key, source: t.source, subject: t.subject, custom: t.custom, updatedAt: t.updatedAt };
  });

  app.post<{ Params: { key: string }; Body: { source: string; subject?: string | null } }>(
    '/templates/:key/preview', { schema: { params: keyParams, body } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const def = defOf(request.params.key);
      const { context: plain, bts, lang } = await sample(def, request.tenantId);
      const subject = def.subject !== undefined ? (request.body.subject ?? '') : null;
      const assets = await draftAssets(request.tenantId, request.body.source, subject);
      const context = withAssets(plain, assets);
      const problems = await templateProblems(def, request.body.source, subject, plain, bts, assets, lang);
      // A template that is missing something it must keep still previews; one that does not render shows its problems.
      let html: string | null = null;
      let text: string | undefined;
      let renderedSubject: string | undefined;
      try {
        if (def.preview === 'css') html = cleanCss(await renderText(request.body.source, context, lang));
        else {
          const out = await renderHtml(request.body.source, context, bts, lang);
          html = def.preview === 'section' ? sanitizeSection(out) : def.group === 'documents' ? withBtsStyles(out) : out;
          if (def.preview === 'email') text = htmlToText(out);
        }
      } catch {
        // Already in the problems, with the line.
      }
      if (subject !== null) {
        try {
          renderedSubject = (await renderText(subject, context, lang)).replace(/\s+/g, ' ').trim();
        } catch {
          // Already in the problems.
        }
      }
      return { html, problems, ...(text !== undefined && { text }), ...(renderedSubject !== undefined && { subject: renderedSubject }) };
    },
  );

  app.get<{ Params: { key: string } }>('/templates/:key/versions', { schema: { params: keyParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const def = defOf(request.params.key);
    const rows = (await db.query<{ id: string; action: string; saved_at: Date | string; saved_by_name: string | null; size: number }>(
      `select v.id, v.action, v.saved_at, u.name as saved_by_name, length(v.source) as size
       from template_versions v left join users u on u.id = v.saved_by
       where v.tenant_id = $1 and v.key = $2 order by v.saved_at desc limit 30`,
      [request.tenantId, def.key],
    )).rows;
    return { data: rows.map((r) => ({ id: r.id, action: r.action, savedAt: new Date(r.saved_at).toISOString(), savedBy: r.saved_by_name, size: Number(r.size) })) };
  });

  app.get<{ Params: { key: string; id: string } }>(
    '/templates/:key/versions/:id', { schema: { params: { type: 'object', required: ['key', 'id'], properties: { key: { type: 'string', maxLength: 40 }, id: uuid } } } },
    async (request) => {
      requirePermission(request, 'business.manage');
      const def = defOf(request.params.key);
      const v = (await db.query<{ source: string; subject: string | null; action: string }>(
        'select source, subject, action from template_versions where tenant_id = $1 and key = $2 and id = $3', [request.tenantId, def.key, request.params.id],
      )).rows[0];
      if (!v) throw notFound('Version');
      const lang: Lang = def.group === 'emails' ? await emailLanguage(db, request.tenantId) : 'en';
      return v.action === 'reverted'
        ? { source: defaultSource(def, lang), subject: defaultSubject(def, lang), action: v.action }
        : { source: v.source, subject: v.subject, action: v.action };
    },
  );
}

/** Uploaded images, public by their random id: emails and the store load them from here. */
export function registerPublicAssetRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const serve = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const a = (await deps.db.query<{ data: Buffer; content_type: string }>('select data, content_type from template_assets where id = $1', [request.params.id])).rows[0];
    if (!a) throw notFound('Image');
    return reply
      .type(a.content_type)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      // Opened on its own, an image (an SVG especially) can run nothing.
      .header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(Buffer.from(a.data));
  };
  const params = { type: 'object', required: ['id'], properties: { id: uuid, name: { type: 'string', maxLength: 120 } } } as const;
  app.get<{ Params: { id: string } }>('/v1/assets/:id', { schema: { params } }, serve);
  app.get<{ Params: { id: string; name: string } }>('/v1/assets/:id/:name', { schema: { params } }, serve);
}
