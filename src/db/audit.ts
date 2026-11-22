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

export async function auditEvents(db: Queryable, tenantId: string, opts: { limit: number; before?: number }): Promise<AuditEvent[]> {
  const params: unknown[] = [tenantId, opts.limit];
  let where = 'a.tenant_id = $1';
  if (opts.before) {
    params.push(opts.before);
    where += ' and a.id < $3';
  }
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
