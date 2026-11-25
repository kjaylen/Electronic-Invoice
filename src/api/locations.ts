/**
 * More than one shop: the business's locations, and stock sent between them.
 *
 *   GET    /v1/locations                 the locations (empty for a business with one shop)
 *   POST   /v1/locations                 { name, mainName? }  add one; the first time, the shop there already is gets a name too
 *   PUT    /v1/locations/:id             { name }
 *   DELETE /v1/locations/:id             close one (it must hold no stock, have no till and nothing on the way)
 *   GET    /v1/transfers                 ?status=sent|received|cancelled
 *   POST   /v1/transfers                 { fromLocationId, toLocationId, lines: [{ itemId, quantity }], note? }  send
 *   POST   /v1/transfers/:id/receive     it arrived
 *   POST   /v1/transfers/:id/cancel      it never left: back where it came from
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../db/audit.ts';
import { closeTransfer, listLocations, sendTransfer, transferNumber } from '../inventory/locations.ts';
import { StockError } from '../inventory/stock.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { ApiError, notFound } from './errors.ts';
import { can, requirePermission } from './permissions.ts';
import { uuid } from './schemas.ts';

export const MAX_LOCATIONS = 20;

export function registerLocationRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
  const name = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;
  const canRead = (request: FastifyRequest) => {
    if (!can(request.principal, 'catalog.manage') && !can(request.principal, 'documents.issue')) requirePermission(request, 'reports.view');
  };
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StockError) throw new ApiError(422, 'invalid_stock', e.message);
      if (/locations_name|unique|duplicate/i.test(String((e as Error).message))) throw new ApiError(409, 'duplicate', 'There is already a location with that name');
      throw e;
    }
  };

  const locationsJson = async (tenantId: string) => {
    const rows = (await db.query<{ id: string; name: string; is_main: boolean; registers: number; items: number }>(
      `select l.id, l.name, l.is_main,
         (select count(*)::int from registers r where r.tenant_id = l.tenant_id and r.archived_at is null and (r.location_id = l.id or (l.is_main and r.location_id is null))) as registers,
         (select count(*)::int from location_stock s where s.location_id = l.id and s.quantity <> 0) as items
       from locations l where l.tenant_id = $1 and l.archived_at is null order by l.is_main desc, lower(l.name)`,
      [tenantId],
    )).rows;
    return { data: rows.map((r) => ({ id: r.id, name: r.name, main: r.is_main, registers: r.registers, ...(!r.is_main && { itemsInStock: r.items }) })) };
  };

  app.get('/locations', async (request) => {
    canRead(request);
    return locationsJson(request.tenantId);
  });

  app.post<{ Body: { name: string; mainName?: string } }>(
    '/locations',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name, mainName: name } } } },
    async (request, reply) => {
      requirePermission(request, 'business.manage');
      const b = request.body;
      const id = randomUUID();
      await wrap(() => db.transaction(async (tx) => {
        const have = await listLocations(tx, request.tenantId);
        if (have.length >= MAX_LOCATIONS) throw new ApiError(422, 'too_many', `Up to ${MAX_LOCATIONS} locations`);
        // The first time: the shop there has been all along becomes the main location, with all the stock.
        if (!have.some((l) => l.main)) {
          await tx.query('insert into locations (id, tenant_id, name, is_main) values ($1, $2, $3, true)', [randomUUID(), request.tenantId, b.mainName?.trim() || 'Main shop']);
        }
        await tx.query('insert into locations (id, tenant_id, name) values ($1, $2, $3)', [id, request.tenantId, b.name.trim()]);
      }));
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'location.added', target: b.name.trim(), ip: request.ip });
      return reply.code(201).send({ id, ...(await locationsJson(request.tenantId)) });
    },
  );

  app.put<{ Params: { id: string }; Body: { name: string } }>('/locations/:id', { schema: { params: idParams, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name } } } }, async (request) => {
    requirePermission(request, 'business.manage');
    const r = await wrap(() => db.query('update locations set name = $3 where id = $1 and tenant_id = $2 and archived_at is null returning id', [request.params.id, request.tenantId, request.body.name.trim()]));
    if (!r.rows.length) throw notFound('Location');
    return locationsJson(request.tenantId);
  });

  app.delete<{ Params: { id: string } }>('/locations/:id', { schema: { params: idParams } }, async (request) => {
    requirePermission(request, 'business.manage');
    const l = (await db.query<{ name: string; is_main: boolean }>('select name, is_main from locations where id = $1 and tenant_id = $2 and archived_at is null', [request.params.id, request.tenantId])).rows[0];
    if (!l) throw notFound('Location');
    if (l.is_main) throw new ApiError(409, 'main_location', 'The main location stays: it is where everything not at another location is');
    const stock = (await db.query<{ n: number }>('select count(*)::int as n from location_stock where location_id = $1 and quantity <> 0', [request.params.id])).rows[0]!.n;
    if (stock) throw new ApiError(409, 'has_stock', `${l.name} still has stock of ${stock} item${stock === 1 ? '' : 's'}. Transfer it out, or count it to zero, first.`);
    const moving = (await db.query("select 1 from stock_transfers where tenant_id = $1 and status = 'sent' and (from_location_id = $2 or to_location_id = $2) limit 1", [request.tenantId, request.params.id])).rows.length;
    if (moving) throw new ApiError(409, 'on_the_way', 'Stock is on the way to or from this location. Receive or cancel the transfer first.');
    const tills = (await db.query('select 1 from registers where tenant_id = $1 and location_id = $2 and archived_at is null limit 1', [request.tenantId, request.params.id])).rows.length;
    if (tills) throw new ApiError(409, 'has_registers', 'A register is at this location. Move it to another location first (Settings, Tills).');
    await db.query('update locations set archived_at = now() where id = $1 and tenant_id = $2', [request.params.id, request.tenantId]);
    await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'location.closed', target: l.name, ip: request.ip });
    return locationsJson(request.tenantId);
  });

  // ---------- transfers ----------
  interface TransferRow { id: string; number: number; status: string; note: string | null; from_id: string; from_name: string; to_id: string; to_name: string; sent_at: Date | string; sent_by: string | null; received_at: Date | string | null; received_by: string | null; cancelled_at: Date | string | null }
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  const transfersJson = async (tenantId: string, where: string, params: unknown[]) => {
    const rows = (await db.query<TransferRow>(
      `select t.id, t.number, t.status, t.note, f.id as from_id, f.name as from_name, d.id as to_id, d.name as to_name, t.sent_at, us.name as sent_by, t.received_at, ur.name as received_by, t.cancelled_at
       from stock_transfers t join locations f on f.id = t.from_location_id join locations d on d.id = t.to_location_id
         left join users us on us.id = t.sent_by left join users ur on ur.id = t.received_by
       where t.tenant_id = $1 ${where} order by (t.status = 'sent') desc, t.sent_at desc limit 200`,
      [tenantId, ...params],
    )).rows;
    const lines = rows.length ? (await db.query<{ transfer_id: string; item_id: string; name: string; unit_code: string; quantity: string }>(
      `select tl.transfer_id, tl.item_id, i.name, i.unit_code, tl.quantity::text as quantity from stock_transfer_lines tl join items i on i.id = tl.item_id
       where tl.transfer_id = any($1::uuid[]) order by lower(i.name)`, [rows.map((r) => r.id)],
    )).rows : [];
    return rows.map((r) => ({
      id: r.id, number: transferNumber(r.number), status: r.status, note: r.note,
      from: { id: r.from_id, name: r.from_name }, to: { id: r.to_id, name: r.to_name },
      sentAt: iso(r.sent_at), sentBy: r.sent_by, receivedAt: iso(r.received_at), receivedBy: r.received_by, cancelledAt: iso(r.cancelled_at),
      lines: lines.filter((l) => l.transfer_id === r.id).map((l) => ({ itemId: l.item_id, name: l.name, unitCode: l.unit_code, quantity: Number(l.quantity) })),
    }));
  };

  app.get<{ Querystring: { status?: string } }>(
    '/transfers',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['sent', 'received', 'cancelled'] } } } } },
    async (request) => {
      canRead(request);
      return { data: request.query.status ? await transfersJson(request.tenantId, 'and t.status = $2', [request.query.status]) : await transfersJson(request.tenantId, '', []) };
    },
  );

  app.post<{ Body: { fromLocationId: string; toLocationId: string; note?: string; lines: Array<{ itemId: string; quantity: string }> } }>(
    '/transfers',
    {
      schema: {
        body: {
          type: 'object', required: ['fromLocationId', 'toLocationId', 'lines'], additionalProperties: false,
          properties: {
            fromLocationId: uuid, toLocationId: uuid, note: { type: 'string', maxLength: 500 },
            lines: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['itemId', 'quantity'], additionalProperties: false, properties: { itemId: uuid, quantity: { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,3})?$' } } } },
          },
        },
      },
    },
    async (request, reply) => {
      requirePermission(request, 'catalog.manage');
      const b = request.body;
      const sent = await wrap(() => db.transaction((tx) => sendTransfer(tx, { tenantId: request.tenantId, fromLocationId: b.fromLocationId, toLocationId: b.toLocationId, lines: b.lines, note: b.note ?? null, userId: request.userId || null })));
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: 'stock.transfer_sent', target: transferNumber(sent.number), details: { lines: b.lines.length }, ip: request.ip });
      return reply.code(201).send((await transfersJson(request.tenantId, 'and t.id = $2', [sent.id]))[0]);
    },
  );

  for (const [path, how] of [['receive', 'received'], ['cancel', 'cancelled']] as const) {
    app.post<{ Params: { id: string } }>(`/transfers/:id/${path}`, { schema: { params: idParams } }, async (request) => {
      requirePermission(request, 'catalog.manage');
      const done = await db.transaction((tx) => closeTransfer(tx, request.tenantId, request.params.id, how, request.userId || null));
      const t = (await transfersJson(request.tenantId, 'and t.id = $2', [request.params.id]))[0];
      if (!t) throw notFound('Transfer');
      if (!done) throw new ApiError(409, 'not_on_the_way', t.status === 'received' ? 'This transfer was already received' : 'This transfer was cancelled');
      await audit(db, { tenantId: request.tenantId, userId: request.userId || null, action: `stock.transfer_${how}`, target: t.number, ip: request.ip });
      return t;
    });
  }
}
