/** Item categories (Coffee, Bakery, Hardware…): how a typed name is stored. */

import type { Queryable } from '../db/database.ts';

/** A category as stored: trimmed, inner spaces collapsed; empty is none. */
export const categoryName = (v: string | null | undefined) => {
  const s = (v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 80) : null;
};

/** A category in the spelling the business already uses ("beans" joins "Beans"). */
export async function spelledCategory(db: Queryable, tenantId: string, v: string | null | undefined, editing?: string) {
  const name = categoryName(v);
  if (!name) return null;
  // Other items only: an item alone in its category can change its spelling.
  const found = (await db.query<{ category: string }>(
    `select category from items where tenant_id = $1 and lower(category) = lower($2) and archived_at is null and id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
     group by category order by count(*) desc, category limit 1`, [tenantId, name, editing ?? null],
  )).rows[0];
  return found?.category ?? name;
}
