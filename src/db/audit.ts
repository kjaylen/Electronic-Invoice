/**
 * The activity log: who did what in a business (sign-ins, accounts,
 * certificate, keys, cancellations). Rows are permanent, like documents.
 */

import type { Queryable } from './database.ts';

export interface AuditEntry {
  tenantId: string;
  userId?: string | null;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query('insert into audit_events (tenant_id, user_id, action, target, details, ip) values ($1, $2, $3, $4, $5, $6)', [
    e.tenantId, e.userId ?? null, e.action, e.target ?? null, e.details ? JSON.stringify(e.details) : null, e.ip ?? null,
  ]);
}

export interface AuditEvent {
  id: number;
  at: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user: { id: string; name: string } | null;
}

export async function auditEvents(
  db: Queryable,
  tenantId: string,
  opts: { limit: number; before?: number; userId?: string; actions?: readonly string[]; from?: string; to?: string },
): Promise<AuditEvent[]> {
  const params: unknown[] = [tenantId, opts.limit];
  let where = 'a.tenant_id = $1';
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where += ` and ${sql.replaceAll('?', `$${params.length}`)}`;
  };
  if (opts.before) add('a.id < ?', opts.before);
  if (opts.userId) add('a.user_id = ?', opts.userId);
  // Actions as LIKE patterns ('order.%').
  if (opts.actions?.length) add('a.action like any(?::text[])', opts.actions);
  // Days in Belize.
  if (opts.from) add("(a.at at time zone 'America/Belize')::date >= ?::date", opts.from);
  if (opts.to) add("(a.at at time zone 'America/Belize')::date <= ?::date", opts.to);
  const rows = (await db.query<{ id: string | number; at: string | Date; action: string; target: string | null; details: Record<string, unknown> | null; ip: string | null; user_id: string | null; user_name: string | null }>(
    `select a.id, a.at, a.action, a.target, a.details, a.ip, a.user_id, u.name as user_name
     from audit_events a left join users u on u.id = a.user_id where ${where} order by a.id desc limit $2`,
    params,
  )).rows;
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    action: r.action,
    target: r.target,
    details: r.details,
    ip: r.ip,
    user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null,
  }));
}
