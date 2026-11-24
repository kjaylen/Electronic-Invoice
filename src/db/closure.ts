/**
 * Deleting a business, in two steps so that a mistake (or someone at an
 * unlocked computer) can be undone:
 *
 *   1. An owner closes it. At once nobody but an owner can sign in, tills and
 *      API keys stop, the store shows as closed, nothing new is issued, billed
 *      or emailed. Every other session is ended.
 *   2. Thirty days later the server erases it: every row of every table that
 *      belongs to the business, its stored files, then the business itself.
 *      Until then an owner can sign in and reopen it, and nothing is lost.
 *
 * Erasing does not go table by table from a list (a table added later would be
 * forgotten and block it): it reads the database's own foreign keys to find
 * everything that hangs off the business, and deletes in an order they allow.
 * Documents authorized by BTS stay registered with BTS; erasing removes this
 * system's copies.
 */

import type { ObjectStore } from '../storage/objects.ts';
import type { Database, Queryable } from './database.ts';

/** How long a closed business can still be reopened. */
export const GRACE_DAYS = 30;

export class ClosureError extends Error {
  override name = 'ClosureError';
  readonly code: 'not_closed' | 'already_closed' | 'not_due' | 'not_found';
  constructor(code: ClosureError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Closure { closedAt: string; eraseAfter: string }

/** Whether a business is closed, and when it will be erased. */
export async function closureOf(db: Queryable, tenantId: string): Promise<Closure | null> {
  const r = (await db.query<{ closed_at: Date | string | null; erase_after: Date | string | null }>('select closed_at, erase_after from tenants where id = $1', [tenantId])).rows[0];
  return r?.closed_at && r.erase_after ? { closedAt: new Date(r.closed_at).toISOString(), eraseAfter: new Date(r.erase_after).toISOString() } : null;
}

/** Close a business: it will be erased `GRACE_DAYS` from now. Everyone but its owners is signed out, tills included. */
export async function closeBusiness(db: Database, tenantId: string, userId: string, now = new Date()): Promise<Closure> {
  return db.transaction(async (tx) => {
    const eraseAfter = new Date(now.getTime() + GRACE_DAYS * 86_400_000);
    const closed = (await tx.query<{ closed_at: Date | string }>(
      'update tenants set closed_at = $2, erase_after = $3, closed_by = $4 where id = $1 and closed_at is null returning closed_at',
      [tenantId, now.toISOString(), eraseAfter.toISOString(), userId],
    )).rows[0];
    if (!closed) throw new ClosureError('already_closed', 'This business is already closed');
    await tx.query(`delete from sessions s using users u where u.id = s.user_id and u.tenant_id = $1 and (u.role <> 'owner' or s.device_id is not null)`, [tenantId]);
    return { closedAt: new Date(closed.closed_at).toISOString(), eraseAfter: eraseAfter.toISOString() };
  });
}

/** Reopen a closed business: everything is as it was (people sign in again; the store opens if it was open). */
export async function reopenBusiness(db: Queryable, tenantId: string): Promise<void> {
  const r = await db.query('update tenants set closed_at = null, erase_after = null, closed_by = null where id = $1 and closed_at is not null returning id', [tenantId]);
  if (!r.rows.length) throw new ClosureError('not_closed', 'This business is not closed');
}

// ---------- erasing ----------

interface ForeignKey { child: string; childColumns: string[]; parent: string; parentColumns: string[]; nullable: boolean }

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function foreignKeys(db: Queryable): Promise<ForeignKey[]> {
  const rows = (await db.query<{ child: string; parent: string; child_columns: string[]; parent_columns: string[]; nullable: boolean }>(
    `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
       (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_columns,
       (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_columns,
       (select bool_and(not a.attnotnull) from unnest(c.conkey) k(attnum) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as nullable
     from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where c.contype = 'f' and n.nspname = current_schema()`,
  )).rows;
  return rows.map((r) => ({ child: r.child.replace(/"/g, ''), parent: r.parent.replace(/"/g, ''), childColumns: r.child_columns, parentColumns: r.parent_columns, nullable: r.nullable }));
}

/**
 * Which rows of which tables belong to a business: every table with a tenant_id, and, through
 * their foreign keys, the tables without one (document lines through documents, and so on).
 * Each entry is a condition on the table's rows; `$1` is the business.
 */
async function ownedTables(db: Queryable, fks: ForeignKey[]): Promise<Map<string, string>> {
  const direct = (await db.query<{ table_name: string }>(
    `select c.table_name::text from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = current_schema() and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'`,
  )).rows.map((r) => r.table_name);
  const owned = new Map<string, string>(direct.map((t) => [t, 'tenant_id = $1']));
  // The platform's own log of what its staff did is kept (detached from the business), not erased.
  owned.delete('platform_audit');
  for (let grew = true; grew;) {
    grew = false;
    for (const fk of fks) {
      if (owned.has(fk.child) || fk.parent === 'tenants' || fk.child === 'tenants' || !owned.has(fk.parent) || fk.childColumns.length !== 1) continue;
      owned.set(fk.child, `${ident(fk.childColumns[0]!)} in (select ${ident(fk.parentColumns[0]!)} from ${ident(fk.parent)} where ${owned.get(fk.parent)})`);
      grew = true;
    }
  }
  return owned;
}

export interface Erased { tenantId: string; slug: string; name: string; rows: number; files: number }

/**
 * Erase a business for good: its rows everywhere, then the business. One transaction: either
 * all of it goes or none. Files kept outside the database (product photos, receipts) are
 * removed afterwards. With `force`, the 30 days are not waited for (tests, platform staff).
 */
export async function eraseBusiness(db: Database, tenantId: string, options: { objects?: ObjectStore; force?: boolean; now?: Date } = {}): Promise<Erased> {
  const erased = await db.transaction(async (tx) => {
    const t = (await tx.query<{ slug: string; name: string; tin: string; erase_after: Date | string | null }>(
      'select slug, coalesce(trade_name, legal_name) as name, tin, erase_after from tenants where id = $1 for update', [tenantId],
    )).rows[0];
    if (!t) throw new ClosureError('not_found', 'There is no such business');
    if (!options.force) {
      if (!t.erase_after) throw new ClosureError('not_closed', 'This business is not closed');
      if (new Date(t.erase_after).getTime() > (options.now ?? new Date()).getTime()) throw new ClosureError('not_due', 'This business can still be reopened');
    }
    // Lets the rules that make documents and logs permanent stand aside, for this business and this transaction only.
    await tx.query(`select set_config('floreo.erasing_tenant', $1, true)`, [tenantId]);

    const fks = await foreignKeys(tx);
    const owned = await ownedTables(tx, fks);

    // Keys of files stored outside the database, read before their rows go.
    const keys: string[] = [];
    for (const [table, column] of [['product_images', 'storage_key'], ['expenses', 'receipt_key']] as const) {
      if (!owned.has(table)) continue;
      const rows = (await tx.query<{ key: string }>(`select ${ident(column)} as key from ${ident(table)} where ${owned.get(table)} and ${ident(column)} is not null`, [tenantId])).rows;
      keys.push(...rows.map((r) => r.key));
    }

    // Platform staff's log keeps what they did, without pointing at a business that is gone.
    await tx.query(
      `update platform_audit set tenant_id = null, details = coalesce(details, '{}'::jsonb) || jsonb_build_object('erasedBusiness', $2::text) where tenant_id = $1`,
      [tenantId, `${t.name} (${t.slug})`],
    );
    // The business's own pointers to its rows (its logo, who closed it) let go first.
    for (const fk of fks.filter((f) => f.child === 'tenants' && f.nullable && owned.has(f.parent))) {
      await tx.query(`update tenants set ${fk.childColumns.map((c) => `${ident(c)} = null`).join(', ')} where id = $1`, [tenantId]);
    }

    // Delete table by table; one that others still point at is tried again once they are empty.
    let rows = 0;
    const count = (r: { rows: unknown[] }) => r.rows.length;
    const sweep = async () => {
    let remaining = [...owned.keys()];
    while (remaining.length) {
      const blocked: string[] = [];
      for (const table of remaining) {
        await tx.query('savepoint erase_table');
        try {
          rows += count(await tx.query(`delete from ${ident(table)} where ${owned.get(table)} returning 1`, [tenantId]));
          await tx.query('release savepoint erase_table');
        } catch (e) {
          if ((e as { code?: string }).code !== '23503') throw e;
          await tx.query('rollback to savepoint erase_table');
          blocked.push(table);
        }
      }
      if (blocked.length === remaining.length) {
        // Tables that point at each other: their optional pointers are emptied, then they can go.
        let loosened = 0;
        for (const fk of fks.filter((f) => f.nullable && f.child !== f.parent && blocked.includes(f.child) && blocked.includes(f.parent))) {
          await tx.query('savepoint erase_loosen');
          try {
            loosened += count(await tx.query(
              `update ${ident(fk.child)} set ${fk.childColumns.map((c) => `${ident(c)} = null`).join(', ')} where (${owned.get(fk.child)}) and ${ident(fk.childColumns[0]!)} is not null returning 1`, [tenantId],
            ));
            await tx.query('release savepoint erase_loosen');
          } catch {
            // A permanent record that may not be changed: left as it is.
            await tx.query('rollback to savepoint erase_loosen');
          }
        }
        if (!loosened) throw new Error(`Could not erase the business: these tables still hold rows others point at: ${blocked.join(', ')}`);
      }
      remaining = blocked;
    }
    };
    await sweep();
    // Once more: emptying pointers above can leave new rows behind (a change to an order is noted for webhooks).
    await sweep();
    await tx.query('delete from tenants where id = $1', [tenantId]);
    // What remains, for good: that it was erased, and whose it was.
    await tx.query(`insert into platform_audit (admin_id, tenant_id, action, details) values (null, null, 'tenant.erased', $1)`, [JSON.stringify({ slug: t.slug, name: t.name, tin: t.tin, rows })]);
    return { slug: t.slug, name: t.name, rows, keys };
  });
  let files = 0;
  if (options.objects) {
    for (const key of erased.keys) {
      await options.objects.delete(key).then(() => files++).catch(() => {});
    }
  }
  return { tenantId, slug: erased.slug, name: erased.name, rows: erased.rows, files };
}

/** Erase every closed business whose 30 days have passed. One that fails is left closed and reported; the others still go. */
export async function eraseDueBusinesses(db: Database, options: { objects?: ObjectStore; now?: Date; onError?: (tenantId: string, error: unknown) => void } = {}): Promise<Erased[]> {
  const now = options.now ?? new Date();
  const due = (await db.query<{ id: string }>('select id from tenants where erase_after is not null and erase_after <= $1 order by erase_after', [now.toISOString()])).rows;
  const out: Erased[] = [];
  for (const { id } of due) {
    try {
      out.push(await eraseBusiness(db, id, { ...(options.objects && { objects: options.objects }), now }));
    } catch (e) {
      options.onError?.(id, e);
    }
  }
  return out;
}
