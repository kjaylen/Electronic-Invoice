/**
 * The price list as a PDF:
 *
 *   GET /v1/items/price-list.pdf?prices=retail|wholesale&gst=include|exclude&category=
 *
 * Items by category (those without one last), with their price and quantity prices. Wholesale
 * prices fall back to the usual price for items without one. Anyone who sells can print it.
 */

import type { FastifyInstance } from 'fastify';
import { formatCents, mul, parseDecimal, roundToCents } from '../engine/decimal.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { renderPriceList } from '../render/price-list.ts';
import { logoForPdf } from '../templates/assets.ts';
import { can, requirePermission } from './permissions.ts';
import { UNIT_NAMES } from './quotes.ts';
import { businessContact } from './receivables.ts';

const belizeToday = () => new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);

export function registerPriceListRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db } = deps;
  app.get<{ Querystring: { prices?: 'retail' | 'wholesale'; gst?: 'include' | 'exclude'; category?: string } }>(
    '/items/price-list.pdf',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { prices: { type: 'string', enum: ['retail', 'wholesale'] }, gst: { type: 'string', enum: ['include', 'exclude'] }, category: { type: 'string', maxLength: 80 } },
        },
      },
    },
    async (request, reply) => {
      if (!can(request.principal, 'catalog.manage')) requirePermission(request, 'documents.issue');
      const q = request.query;
      const wholesale = q.prices === 'wholesale';
      const withGst = q.gst !== 'exclude';
      const params: unknown[] = [request.tenantId];
      let where = 'i.tenant_id = $1 and i.archived_at is null';
      if (q.category) {
        params.push(q.category);
        where += ` and lower(i.category) = lower($${params.length})`;
      }
      const rows = (await db.query<{ name: string; seller_code: string | null; unit_code: string; unit_price: string; wholesale_price: string | null; gst_category: string; category: string | null; breaks: Array<{ m: string; p: string }> }>(
        `select i.name, i.seller_code, i.unit_code, i.unit_price::text, i.wholesale_price::text, i.gst_category, i.category,
           (select coalesce(json_agg(json_build_object('m', b.min_quantity::text, 'p', b.unit_price::text) order by b.min_quantity), '[]'::json) from item_price_breaks b where b.item_id = i.id) as breaks
         from items i where ${where} order by lower(i.category) nulls last, lower(i.name) limit 3000`, params,
      )).rows;
      // Before GST as kept; with GST, 12.5% on standard-rated items, to the cent.
      const show = (net: string, gst: string) => formatCents(roundToCents(withGst && gst === 'S' ? mul(parseDecimal(net), parseDecimal('1.125')) : parseDecimal(net)));
      const groups: Array<{ name: string; items: Array<{ name: string; code: string | null; unit: string; price: string; deals: string[] }> }> = [];
      for (const r of rows) {
        const name = r.category ?? 'Other items';
        let g = groups.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!g) {
          g = { name, items: [] };
          groups.push(g);
        }
        const price = wholesale && r.wholesale_price ? r.wholesale_price : r.unit_price;
        g.items.push({
          name: r.name, code: r.seller_code, unit: UNIT_NAMES[r.unit_code] ?? '', price: show(price, r.gst_category),
          // Quantity prices are for retail customers.
          deals: wholesale ? [] : r.breaks.map((b) => `${Number(b.m)} or more: ${show(b.p, r.gst_category)} each`),
        });
      }
      const logo = await logoForPdf(db, request.tenantId);
      const pdf = await renderPriceList({
        business: await businessContact(db, request.tenantId),
        ...(logo && { logo }),
        title: wholesale ? 'Wholesale price list' : 'Price list',
        date: belizeToday(),
        basis: withGst ? 'Prices include GST' : 'Prices before GST',
        groups,
      });
      return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${wholesale ? 'wholesale-' : ''}price-list-${belizeToday()}.pdf"`).send(pdf);
    },
  );
}
