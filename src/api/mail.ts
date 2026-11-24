/**
 * Email settings, the email log and the do-not-send list.
 *
 * For a business (owners and admins), under /v1/mail:
 *   GET    /mail/settings            its own mail server (never the password), the presets, where mail goes without one
 *   PUT    /mail/settings            save it
 *   DELETE /mail/settings            go back to the platform's sender
 *   POST   /mail/settings/test       { to, settings? }  send a real test message and say exactly what happened
 *   GET    /mail/deliverability      SPF, DKIM and DMARC of the domain it sends from
 *   GET    /mail/messages            its email log
 *   POST   /mail/messages/:id/resend
 *   GET    /mail/suppressions        addresses not written to
 *   POST   /mail/suppressions        { email }
 *   DELETE /mail/suppressions/:id
 *
 * For the platform's staff, the same under /v1/platform/mail: the platform's
 * own server, every business's log, the platform's own do-not-send list.
 *
 * No sign-in:
 *   GET  /v1/mail/unsubscribe/:token   a page with one button
 *   POST /v1/mail/unsubscribe/:token   stops emails like the one the link came in (also what mail apps call: RFC 8058)
 *
 * A password is accepted on save and never returned, logged or audited.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Queryable } from '../db/database.ts';
import { platformAudit } from '../db/platform.ts';
import { overLimit } from '../db/ratelimit.ts';
import { checkAddress, domainOf } from '../mail/address.ts';
import { checkDeliverability } from '../mail/dns.ts';
import { escapeHtml } from '../mail/layout.ts';
import type { MailService } from '../mail/service.ts';
import { deleteMailSettings, loadMailSettings, MAIL_PORTS, MAIL_PRESETS, type MailSettingsInput, PLATFORM_SCOPE, publicSettings, saveMailSettings, settingsForTest } from '../mail/settings.ts';
import { MAIL_TYPES } from '../mail/types.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import type { ServerContext } from './context.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

const text = (max: number) => ({ type: 'string', maxLength: max }) as const;
const settingsBody = {
  type: 'object', additionalProperties: false,
  properties: {
    host: text(253), port: { type: ['integer', 'string'] }, security: text(20), username: text(320), password: { type: ['string', 'null'], maxLength: 1024 },
    fromName: text(200), fromAddress: text(254), replyTo: text(254), enabled: { type: 'boolean' },
  },
} as const;
const testBody = { type: 'object', required: ['to'], additionalProperties: false, properties: { to: text(254), settings: settingsBody } } as const;
const listQuery = {
  type: 'object', additionalProperties: false,
  properties: { status: { type: 'string', enum: ['queued', 'sending', 'sent', 'failed', 'suppressed'] }, type: text(40), q: text(200), before: text(40), limit: { type: 'integer', minimum: 1, maximum: 200 }, tenantId: uuid },
} as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

interface ListQuery { status?: string; type?: string; q?: string; before?: string; limit?: number; tenantId?: string }

const types = Object.entries(MAIL_TYPES).map(([key, def]) => ({ key, label: def.label }));

async function suppressions(db: Queryable, tenantId: string | null) {
  return (await db.query<{ id: string; email: string; reason: string; detail: string | null; created_at: Date | string }>(
    'select id, email, reason, detail, created_at from mail_suppressions where tenant_id is not distinct from $1 order by created_at desc limit 500', [tenantId],
  )).rows.map((r) => ({ id: r.id, email: r.email, reason: r.reason, detail: r.detail, createdAt: new Date(r.created_at).toISOString() }));
}

async function addSuppression(db: Queryable, tenantId: string | null, email: string) {
  const address = checkAddress(email).toLowerCase();
  await db.query(
    `insert into mail_suppressions (id, tenant_id, email, reason, detail) values ($1, $2, $3, 'manual', 'Added by hand')
     on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), email) do nothing`,
    [randomUUID(), tenantId, address],
  );
  return address;
}

async function removeSuppression(db: Queryable, tenantId: string | null, id: string) {
  const r = await db.query<{ email: string }>('delete from mail_suppressions where id = $1 and tenant_id is not distinct from $2 returning email', [id, tenantId]);
  if (!r.rows.length) throw new ApiError(404, 'not_found', 'This address is not on the list');
  return r.rows[0]!.email;
}

/** A business's own mail server, its log and its do-not-send list. */
export function registerMailRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, mail: MailService) {
  const { db, keys } = deps;
  const allowed = (request: FastifyRequest) => requirePermission(request, 'business.manage');
  const restrictPorts = !mail.limits.allowPrivateHosts;

  const view = async (tenantId: string) => {
    const own = await loadMailSettings(db, keys, tenantId);
    const route = await mail.describe();
    const business = (await db.query<{ name: string; email: string }>('select coalesce(trade_name, legal_name) as name, email from tenants where id = $1', [tenantId])).rows[0]!;
    return {
      settings: own ? publicSettings(own) : null,
      // Where this business's email goes when it has no server of its own, or its server fails.
      platform: { available: route.source !== 'none', fromAddress: route.from?.address ?? null, fromName: business.name, replyTo: business.email },
      presets: MAIL_PRESETS, ports: MAIL_PORTS, types,
      limits: { perHour: mail.limits.perHour, perDay: mail.limits.perDay, maxAttempts: mail.limits.maxAttempts, logDays: mail.limits.logDays, contentDays: mail.limits.contentDays },
    };
  };

  app.get('/mail/settings', async (request) => {
    allowed(request);
    return view(request.tenantId);
  });

  app.put<{ Body: MailSettingsInput }>('/mail/settings', { schema: { body: settingsBody } }, async (request) => {
    allowed(request);
    const { settings, warnings } = await saveMailSettings(db, keys, request.tenantId, request.body, { by: request.userId || null, ...(restrictPorts && { restrictPorts: true }) });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'mail.settings_saved', target: settings.host, details: { port: settings.port, security: settings.security, from: settings.fromAddress, enabled: settings.enabled }, ip: request.ip });
    return { ...(await view(request.tenantId)), warnings };
  });

  app.delete('/mail/settings', async (request) => {
    allowed(request);
    if (await deleteMailSettings(db, request.tenantId)) await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'mail.settings_removed', ip: request.ip });
    return view(request.tenantId);
  });

  app.post<{ Body: { to: string; settings?: MailSettingsInput } }>('/mail/settings/test', { schema: { body: testBody } }, async (request) => {
    allowed(request);
    if (await overLimit(db, `mail-test|${request.tenantId}`, 10, 10 * 60_000)) throw new ApiError(429, 'too_many_requests', 'Enough test emails for now. Wait ten minutes and try again.');
    const settings = await settingsForTest(db, keys, request.tenantId, request.body.settings, { ...(restrictPorts && { restrictPorts: true }) });
    if (!settings) throw new ApiError(422, 'no_settings', 'Fill in the server’s details first');
    const result = await mail.sendTest(request.tenantId, settings, request.body.to, { saved: !request.body.settings, userId: request.userId || null });
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'mail.test_sent', target: result.to, details: { ok: result.ok, host: settings.host }, ip: request.ip });
    return result;
  });

  app.get<{ Querystring: { selector?: string } }>('/mail/deliverability', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { selector: text(63) } } } }, async (request) => {
    allowed(request);
    const own = await loadMailSettings(db, keys, request.tenantId);
    if (!own?.enabled) {
      const route = await mail.describe();
      // Nothing for the business to set up: its email goes out from the platform's domain.
      return { sendsFrom: 'platform' as const, domain: route.from ? domainOf(route.from.address) : null, provider: null, checks: [] };
    }
    if (await overLimit(db, `mail-dns|${request.tenantId}`, 30, 10 * 60_000)) throw new ApiError(429, 'too_many_requests', 'Enough checks for now. Wait a few minutes and try again.');
    const result = await checkDeliverability(domainOf(own.fromAddress), { ...(ctx.resolveTxt && { resolveTxt: ctx.resolveTxt }), host: own.host, selector: request.query.selector ?? null });
    return { sendsFrom: 'own' as const, ...result };
  });

  app.get<{ Querystring: ListQuery }>('/mail/messages', { schema: { querystring: listQuery } }, async (request) => {
    allowed(request);
    const { tenantId: _ignored, ...filter } = request.query;
    return mail.list({ ...filter, tenantId: request.tenantId });
  });

  app.post<{ Params: { id: string } }>('/mail/messages/:id/resend', { schema: { params: idParams } }, async (request) => {
    allowed(request);
    if (await overLimit(db, `mail-resend|${request.tenantId}`, 30, 3600_000)) throw new ApiError(429, 'too_many_requests', 'Enough emails sent again for now. Wait an hour and try again.');
    const receipt = await mail.resend(request.params.id, { tenantId: request.tenantId }, request.userId || null);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'mail.resent', target: request.params.id, ip: request.ip });
    return receipt;
  });

  app.get('/mail/suppressions', async (request) => {
    allowed(request);
    return { data: await suppressions(db, request.tenantId) };
  });

  app.post<{ Body: { email: string } }>('/mail/suppressions', { schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: text(254) } } } }, async (request) => {
    allowed(request);
    const email = await addSuppression(db, request.tenantId, request.body.email);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'mail.suppression_added', target: email, ip: request.ip });
    return { data: await suppressions(db, request.tenantId) };
  });

  app.delete<{ Params: { id: string } }>('/mail/suppressions/:id', { schema: { params: idParams } }, async (request) => {
    allowed(request);
    const email = await removeSuppression(db, request.tenantId, request.params.id);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'mail.suppression_removed', target: email, ip: request.ip });
    return { data: await suppressions(db, request.tenantId) };
  });
}

/** The platform's own mail server, every business's log, the platform's do-not-send list. Registered inside the platform console's routes (staff only). */
export function registerPlatformMailRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext, mail: MailService) {
  const { db, keys } = deps;
  const admin = (request: FastifyRequest) => request.platformAdmin!;

  const view = async () => {
    const saved = await loadMailSettings(db, keys, PLATFORM_SCOPE);
    return {
      settings: saved ? publicSettings(saved) : null,
      // What is used while nothing is saved here: SMTP_URL from the server's environment, a development outbox, or nothing.
      route: await mail.describe(),
      presets: MAIL_PRESETS, types,
      limits: mail.limits,
    };
  };

  app.get('/mail/settings', async () => view());

  app.put<{ Body: MailSettingsInput }>('/mail/settings', { schema: { body: settingsBody } }, async (request) => {
    const { settings, warnings } = await saveMailSettings(db, keys, PLATFORM_SCOPE, request.body, { by: admin(request).id });
    await mail.refresh();
    await platformAudit(db, { adminId: admin(request).id, action: 'mail.settings_saved', details: { host: settings.host, port: settings.port, security: settings.security, from: settings.fromAddress, enabled: settings.enabled }, ip: request.ip });
    return { ...(await view()), warnings };
  });

  app.delete('/mail/settings', async (request) => {
    if (await deleteMailSettings(db, PLATFORM_SCOPE)) await platformAudit(db, { adminId: admin(request).id, action: 'mail.settings_removed', ip: request.ip });
    await mail.refresh();
    return view();
  });

  app.post<{ Body: { to: string; settings?: MailSettingsInput } }>('/mail/settings/test', { schema: { body: testBody } }, async (request) => {
    if (await overLimit(db, `mail-test|platform|${admin(request).id}`, 20, 10 * 60_000)) throw new ApiError(429, 'too_many_requests', 'Enough test emails for now. Wait ten minutes and try again.');
    const settings = await settingsForTest(db, keys, PLATFORM_SCOPE, request.body.settings);
    // Nothing saved and nothing typed: test whatever the server uses now (SMTP_URL, or the development outbox).
    const route = await mail.describe();
    if (!settings && route.source === 'none') throw new ApiError(422, 'no_settings', 'Fill in the server’s details first');
    const result = await mail.sendTest(PLATFORM_SCOPE, settings, request.body.to, { saved: !request.body.settings && Boolean(settings) });
    await platformAudit(db, { adminId: admin(request).id, action: 'mail.test_sent', details: { to: result.to, ok: result.ok }, ip: request.ip });
    return result;
  });

  app.get<{ Querystring: { selector?: string } }>('/mail/deliverability', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { selector: text(63) } } } }, async (request) => {
    const route = await mail.describe();
    if (!route.from || route.source === 'outbox' || route.source === 'none') return { sendsFrom: 'none' as const, domain: null, provider: null, checks: [] };
    const result = await checkDeliverability(domainOf(route.from.address), { ...(ctx.resolveTxt && { resolveTxt: ctx.resolveTxt }), host: route.host, selector: request.query.selector ?? null });
    return { sendsFrom: 'own' as const, ...result };
  });

  app.get<{ Querystring: ListQuery }>('/mail/messages', { schema: { querystring: listQuery } }, async (request) => mail.list({ ...request.query, all: true }));

  app.post<{ Params: { id: string } }>('/mail/messages/:id/resend', { schema: { params: idParams } }, async (request) => {
    const receipt = await mail.resend(request.params.id, { all: true });
    await platformAudit(db, { adminId: admin(request).id, action: 'mail.resent', details: { message: request.params.id }, ip: request.ip });
    return receipt;
  });

  app.get('/mail/suppressions', async () => ({ data: await suppressions(db, null) }));

  app.post<{ Body: { email: string } }>('/mail/suppressions', { schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: text(254) } } } }, async (request) => {
    const email = await addSuppression(db, null, request.body.email);
    await platformAudit(db, { adminId: admin(request).id, action: 'mail.suppression_added', details: { email }, ip: request.ip });
    return { data: await suppressions(db, null) };
  });

  app.delete<{ Params: { id: string } }>('/mail/suppressions/:id', { schema: { params: idParams } }, async (request) => {
    const email = await removeSuppression(db, null, request.params.id);
    await platformAudit(db, { adminId: admin(request).id, action: 'mail.suppression_removed', details: { email }, ip: request.ip });
    return { data: await suppressions(db, null) };
  });
}

function unsubscribePage(title: string, lines: string[], button?: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1117">
  <main style="max-width:460px;margin:12vh auto 0;padding:28px 28px 24px;background:#ffffff;border:1px solid #e6e8ec;border-radius:14px">
    <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3">${escapeHtml(title)}</h1>
    ${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${escapeHtml(l)}</p>`).join('\n    ')}
    ${button ? `<form method="post"><button type="submit" style="margin-top:6px;background:#6d2d93;color:#ffffff;border:0;padding:12px 22px;border-radius:9px;font-weight:600;font-size:15px;cursor:pointer">${escapeHtml(button)}</button></form>` : ''}
  </main>
</body>
</html>`;
}

/** The link in an optional email. The token is the permission; looking at the page changes nothing (mail scanners open links). */
export async function registerUnsubscribeRoutes(app: FastifyInstance, mail: MailService) {
  await app.register(async (u) => {
    // Mail apps post "List-Unsubscribe=One-Click" as a form; the page's own button posts an empty one.
    u.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_request, _body, done) => done(null, {}));
    const html = (reply: import('fastify').FastifyReply, status: number, page: string) => reply.code(status)
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
      .header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page);
    const gone = unsubscribePage('This link no longer works', ['It may have been cut short when it was copied, or the email it came in is too old.']);

    u.get<{ Params: { token: string } }>('/:token', async (request, reply) => {
      const found = await mail.unsubscribe(request.params.token, false);
      if (!found) return html(reply, 404, gone);
      const from = found.business ?? 'us';
      return html(reply, 200, unsubscribePage('Stop these emails?', [`${found.email} will no longer get emails like this one (${found.what.toLowerCase()}) from ${from}.`, 'Receipts, invoices and anything about an order you place are still sent.'], 'Stop these emails'));
    });

    u.post<{ Params: { token: string } }>('/:token', async (request, reply) => {
      const found = await mail.unsubscribe(request.params.token, true);
      if (!found) return html(reply, 404, gone);
      return html(reply, 200, unsubscribePage('Done', [`${found.email} will no longer get these emails from ${found.business ?? 'us'}.`]));
    });
  }, { prefix: '/v1/mail/unsubscribe' });
}
