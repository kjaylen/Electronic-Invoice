/** Links to a customer's account page (/a/<token>): made here, read by the account page's routes. */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { publicLink, type ServerContext } from './context.ts';
import { notFound } from './errors.ts';

const LINK_TTL_MS = 366 * 86_400_000;
export const accountTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** A new link (valid a year) to a saved customer's account page. */
export async function createAccountLink(db: Queryable, ctx: ServerContext, tenantId: string, customerId: string, userId: string | null) {
  publicLink(ctx, '/');
  const c = (await db.query<{ id: string; name: string; email: string | null }>('select id, name, email from customers where id = $1 and tenant_id = $2 and archived_at is null', [customerId, tenantId])).rows[0];
  if (!c) throw notFound('Customer');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await db.query('insert into customer_links (id, tenant_id, customer_id, token_hash, created_by, expires_at) values ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), tenantId, customerId, accountTokenHash(token), userId, expiresAt.toISOString()]);
  return { customer: c, url: publicLink(ctx, `/a/${token}`), expiresAt: expiresAt.toISOString() };
}
