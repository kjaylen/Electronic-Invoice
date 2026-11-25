/**
 * The menu's sections: item categories, in the order the business puts them on its menu.
 *
 * A section is the items' category, so there is one list of categories for everything (the counter's
 * quick buttons, sales by category, the stations that make a category, menus by the clock and
 * promotions). Renaming a section renames that category everywhere it is named; removing one moves its
 * items to another section, or to none. venue_menu_sections keeps the order, and sections made before
 * any item is in them; categories in use but never ordered come after the ordered ones, A to Z.
 */

import type { Database, Queryable } from '../db/database.ts';
import { categoryName, spelledCategory } from '../inventory/categories.ts';

export interface MenuSection {
  name: string;
  /** Items in it (not archived). */
  items: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function menuSections(db: Queryable, tenantId: string): Promise<MenuSection[]> {
  const ordered = (await db.query<{ name: string }>('select name from venue_menu_sections where tenant_id = $1 order by position, lower(name)', [tenantId])).rows;
  const used = (await db.query<{ name: string; n: number }>(
    `select min(category) as name, count(*)::int as n from items where tenant_id = $1 and archived_at is null and category is not null
     group by lower(category) order by lower(min(category))`, [tenantId],
  )).rows;
  const out: MenuSection[] = ordered.map((o) => {
    const u = used.find((x) => same(x.name, o.name));
    return { name: u?.name ?? o.name, items: u?.n ?? 0 };
  });
  for (const u of used) if (!out.some((s) => same(s.name, u.name))) out.push({ name: u.name, items: u.n });
  return out;
}

/** Put the sections in this order (every section named, the first first). */
export async function orderSections(db: Database, tenantId: string, names: string[]): Promise<void> {
  const clean: string[] = [];
  for (const n of names) {
    const name = categoryName(n);
    if (name && !clean.some((c) => same(c, name))) clean.push(name);
  }
  await db.transaction(async (tx) => {
    // Sections not named keep their place after the named ones.
    const rest = (await tx.query<{ name: string }>('select name from venue_menu_sections where tenant_id = $1 order by position, lower(name)', [tenantId])).rows
      .map((r) => r.name).filter((n) => !clean.some((c) => same(c, n)));
    await tx.query('delete from venue_menu_sections where tenant_id = $1', [tenantId]);
    for (const [i, name] of [...clean, ...rest].entries()) {
      await tx.query('insert into venue_menu_sections (tenant_id, name, position) values ($1, $2, $3)', [tenantId, name, i]);
    }
  });
}

/** A new, empty section at the end. Null when there already is one by that name. */
export async function addSection(db: Database, tenantId: string, raw: string): Promise<string | null> {
  const name = categoryName(raw);
  if (!name) return null;
  const sections = await menuSections(db, tenantId);
  if (sections.some((s) => same(s.name, name))) return null;
  // Every section gets its place (those in use but never ordered keep theirs, A to Z), the new one last.
  await orderSections(db, tenantId, [...sections.map((s) => s.name), name]);
  return name;
}

/** Replace a category in a list (renamed: in its place; removed: taken out), once. */
const swap = (list: string[], from: string, to: string | null) => {
  const out: string[] = [];
  for (const c of list) {
    const next = same(c, from) ? to : c;
    if (next && !out.some((x) => same(x, next))) out.push(next);
  }
  return out;
};

/** Where a category is named besides the items: stations, menus by the clock, promotions. */
async function renameEverywhere(tx: Queryable, tenantId: string, from: string, to: string | null) {
  for (const s of (await tx.query<{ id: string; categories: string[] }>('select id, categories from venue_stations where tenant_id = $1', [tenantId])).rows) {
    if (s.categories.some((c) => same(c, from))) await tx.query('update venue_stations set categories = $2 where id = $1', [s.id, swap(s.categories, from, to)]);
  }
  for (const p of (await tx.query<{ id: string; categories: string[]; rules: Array<{ categories?: string[] }> }>('select id, categories, rules from venue_periods where tenant_id = $1', [tenantId])).rows) {
    const rules = p.rules.map((r) => (Array.isArray(r.categories) ? { ...r, categories: swap(r.categories, from, to) } : r));
    const changed = p.categories.some((c) => same(c, from)) || JSON.stringify(rules) !== JSON.stringify(p.rules);
    if (changed) await tx.query('update venue_periods set categories = $2, rules = $3 where id = $1', [p.id, swap(p.categories, from, to), JSON.stringify(rules)]);
  }
}

/**
 * Rename a section: its items, the stations that make it, the menus and promotions that name it.
 * To the name of another section: the two become one. Returns the new name, or null if there is no such section.
 */
export async function renameSection(db: Database, tenantId: string, rawFrom: string, rawTo: string): Promise<{ name: string; items: number } | null> {
  const from = categoryName(rawFrom);
  const wanted = categoryName(rawTo);
  if (!from || !wanted) return null;
  const sections = await menuSections(db, tenantId);
  const section = sections.find((s) => same(s.name, from));
  if (!section) return null;
  // Joining another section takes its spelling; only changing the case of this one keeps the new case.
  const other = sections.find((s) => same(s.name, wanted) && !same(s.name, from));
  const to = other ? other.name : wanted;
  return db.transaction(async (tx) => {
    const moved = await tx.query('update items set category = $3 where tenant_id = $1 and lower(category) = lower($2) returning id', [tenantId, from, to]);
    await renameEverywhere(tx, tenantId, from, to);
    const rows = (await tx.query<{ name: string; position: number }>('select name, position from venue_menu_sections where tenant_id = $1', [tenantId])).rows;
    const mine = rows.find((r) => same(r.name, from));
    const theirs = rows.find((r) => same(r.name, to) && !same(r.name, from));
    if (mine && theirs) await tx.query('delete from venue_menu_sections where tenant_id = $1 and lower(name) = lower($2)', [tenantId, from]);
    else if (mine) await tx.query('update venue_menu_sections set name = $3 where tenant_id = $1 and lower(name) = lower($2)', [tenantId, from, to]);
    return { name: to, items: moved.rows.length };
  });
}

/** Remove a section: its items go to another section, or to none; the stations and menus that named it forget it (or name the other). */
export async function removeSection(db: Database, tenantId: string, rawName: string, rawMoveTo: string | null): Promise<{ items: number } | null> {
  const name = categoryName(rawName);
  if (!name) return null;
  const sections = await menuSections(db, tenantId);
  if (!sections.some((s) => same(s.name, name))) return null;
  const target = rawMoveTo ? sections.find((s) => same(s.name, rawMoveTo) && !same(s.name, name))?.name ?? categoryName(rawMoveTo) : null;
  return db.transaction(async (tx) => {
    const moved = await tx.query('update items set category = $3 where tenant_id = $1 and lower(category) = lower($2) returning id', [tenantId, name, target]);
    await renameEverywhere(tx, tenantId, name, target);
    await tx.query('delete from venue_menu_sections where tenant_id = $1 and lower(name) = lower($2)', [tenantId, name]);
    if (target && !(await tx.query('select 1 from venue_menu_sections where tenant_id = $1 and lower(name) = lower($2)', [tenantId, target])).rows.length) {
      const last = (await tx.query<{ p: number | null }>('select max(position) as p from venue_menu_sections where tenant_id = $1', [tenantId])).rows[0]?.p ?? -1;
      await tx.query('insert into venue_menu_sections (tenant_id, name, position) values ($1, $2, $3)', [tenantId, target, last + 1]);
    }
    return { items: moved.rows.length };
  });
}

/** Put items in a section (null: in none). The section's spelling is the one the business already uses. */
export async function moveItems(db: Queryable, tenantId: string, itemIds: string[], raw: string | null): Promise<{ section: string | null; items: number }> {
  const known = raw ? (await menuSections(db, tenantId)).find((s) => same(s.name, raw))?.name : null;
  const section = raw ? known ?? (await spelledCategory(db, tenantId, raw)) : null;
  const r = await db.query('update items set category = $3 where tenant_id = $1 and id = any($2::uuid[]) and archived_at is null returning id', [tenantId, itemIds, section]);
  return { section, items: r.rows.length };
}
