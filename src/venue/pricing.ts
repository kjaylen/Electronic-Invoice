/**
 * Menus by the clock, promotions and modifier rules. Pure: the server and
 * the apps run the same code, so a price is the same on every device and
 * with no connection. Money is whole cents throughout.
 */

export interface Period {
  id: string;
  kind: 'menu' | 'promotion';
  name: string;
  /** 0 Sunday to 6 Saturday. */
  days: number[];
  /** Minutes from midnight. An end at or before the start runs past midnight. */
  startsMin: number;
  endsMin: number;
  /** A menu: the categories on it (none: everything) and prices that differ, in cents by item id. */
  categories: string[];
  prices: Record<string, number>;
  rules: PromoRule[];
  active: boolean;
  position: number;
}

export type PromoRule =
  /** A percentage off the items or categories named. */
  | { kind: 'percent'; percent: number; categories: string[]; itemIds: string[] }
  /** A fixed price for one item. */
  | { kind: 'price'; itemId: string; priceCents: number }
  /** Two for one: of every two of the same item, the second is free. */
  | { kind: 'twoForOne'; categories: string[]; itemIds: string[] }
  /** These items together for one price (one of each). */
  | { kind: 'bundle'; name: string; itemIds: string[]; priceCents: number };

export interface MenuItem { id: string; category: string | null; priceCents: number }

/** Is the period running at this minute of this weekday? A period past midnight belongs to the day it started. */
export function periodRuns(p: Period, minutes: number, weekday: number): boolean {
  if (!p.active) return false;
  if (p.endsMin > p.startsMin) return p.days.includes(weekday) && minutes >= p.startsMin && minutes < p.endsMin;
  // Past midnight: tonight's part, or the small hours of what started yesterday.
  return (p.days.includes(weekday) && minutes >= p.startsMin) || (p.days.includes((weekday + 6) % 7) && minutes < p.endsMin);
}

/** The menu in force: a manager's override, else the first menu period running, else none (the whole catalog at catalog prices). */
export function currentMenu(periods: Period[], minutes: number, weekday: number, overrideId?: string | null): Period | null {
  const menus = periods.filter((p) => p.kind === 'menu').sort((a, b) => a.position - b.position);
  if (overrideId) {
    const chosen = menus.find((p) => p.id === overrideId);
    if (chosen) return chosen;
  }
  return menus.find((p) => periodRuns(p, minutes, weekday)) ?? null;
}

export const runningPromotions = (periods: Period[], minutes: number, weekday: number) =>
  periods.filter((p) => p.kind === 'promotion' && periodRuns(p, minutes, weekday)).sort((a, b) => a.position - b.position);

const names = (rule: { categories: string[]; itemIds: string[] }, item: MenuItem) =>
  rule.itemIds.includes(item.id) || (item.category !== null && rule.categories.some((c) => c.toLowerCase() === item.category!.toLowerCase()));

/** Is the item on this menu? */
export const onMenu = (menu: Period | null, item: MenuItem) => !menu || menu.categories.length === 0 || (item.category !== null && menu.categories.some((c) => c.toLowerCase() === item.category!.toLowerCase())) || item.id in menu.prices;

export interface Priced {
  /** What one costs now, before modifiers. */
  priceCents: number;
  /** The promotion that set the price, to show ("Happy hour"). */
  promo?: string;
  /** Rules that are worked out on the whole bill (two for one, bundles): "periodId:index". */
  tags: string[];
}

/** The price of an item at this moment: the menu's price, then the best single-item promotion; whole-bill rules are tagged for later. */
export function priceNow(item: MenuItem, periods: Period[], minutes: number, weekday: number, overrideId?: string | null): Priced {
  const menu = currentMenu(periods, minutes, weekday, overrideId);
  let priceCents = menu?.prices[item.id] ?? item.priceCents;
  let promo: string | undefined;
  const tags: string[] = [];
  for (const p of runningPromotions(periods, minutes, weekday)) {
    p.rules.forEach((rule, i) => {
      if (rule.kind === 'percent' && names(rule, item)) {
        const cut = Math.round((priceCents * (100 - rule.percent)) / 100);
        if (cut < priceCents) { priceCents = cut; promo = p.name; }
      } else if (rule.kind === 'price' && rule.itemId === item.id && rule.priceCents < priceCents) {
        priceCents = rule.priceCents;
        promo = p.name;
      } else if ((rule.kind === 'twoForOne' && names(rule, item)) || (rule.kind === 'bundle' && rule.itemIds.includes(item.id))) {
        tags.push(`${p.id}:${i}`);
      }
    });
  }
  return { priceCents, ...(promo && { promo }), tags };
}

/** One unit on a bill, for the whole-bill rules. */
export interface BillUnit { key: string; itemId: string; unitCents: number; tags: string[] }

/**
 * Two for one and bundles, worked out over a bill's units (each unit ordered
 * while the promotion ran carries its tag). Returns cents off per unit key.
 * A unit is used by one rule only: the first that takes it.
 */
export function billPromotions(units: BillUnit[], periods: Period[]): Map<string, { cents: number; name: string }> {
  const off = new Map<string, { cents: number; name: string }>();
  for (const p of periods.filter((x) => x.kind === 'promotion').sort((a, b) => a.position - b.position)) {
    p.rules.forEach((rule, i) => {
      const tag = `${p.id}:${i}`;
      const mine = units.filter((u) => u.tags.includes(tag) && !off.has(u.key));
      if (rule.kind === 'twoForOne') {
        const byItem = new Map<string, BillUnit[]>();
        for (const u of mine) byItem.set(u.itemId, [...(byItem.get(u.itemId) ?? []), u]);
        // Of every pair, the cheaper is free (the same item can carry different modifier prices).
        for (const same of byItem.values()) {
          same.sort((a, b) => b.unitCents - a.unitCents);
          for (let k = 1; k < same.length; k += 2) off.set(same[k]!.key, { cents: same[k]!.unitCents, name: p.name });
        }
      } else if (rule.kind === 'bundle') {
        const pools = rule.itemIds.map((id) => mine.filter((u) => u.itemId === id));
        const sets = Math.min(...pools.map((pool) => pool.length));
        for (let s = 0; s < sets; s++) {
          const set = pools.map((pool) => pool[s]!);
          const full = set.reduce((a, u) => a + u.unitCents, 0);
          let saving = full - rule.priceCents;
          if (saving <= 0) continue;
          // Spread by value; the last one takes the odd cents.
          set.forEach((u, n) => {
            const cents = n === set.length - 1 ? saving : Math.floor((full - rule.priceCents) * u.unitCents / full);
            saving -= cents;
            off.set(u.key, { cents, name: rule.name || p.name });
          });
        }
      }
    });
  }
  return off;
}

// ---------- modifiers ----------

export interface ModifierGroup {
  id: string;
  name: string;
  minChoices: number;
  maxChoices: number;
  options: Array<{ id: string; name: string; priceCents: number; isDefault: boolean; itemId?: string | null }>;
}

export interface ChosenModifier { groupId: string; optionId: string; name: string; priceCents: number; itemId?: string | null }

/** The choices an item starts with: each group's defaults, up to its maximum. */
export function defaultModifiers(groups: ModifierGroup[]): ChosenModifier[] {
  return groups.flatMap((g) => g.options.filter((o) => o.isDefault).slice(0, g.maxChoices).map((o) => ({ groupId: g.id, optionId: o.id, name: o.name, priceCents: o.priceCents, ...(o.itemId && { itemId: o.itemId }) })));
}

/** What is wrong with the choices made, in words for the server; null when they can be sent. */
export function modifierProblem(groups: ModifierGroup[], chosen: Array<{ groupId: string; optionId: string }>): string | null {
  for (const c of chosen) {
    const g = groups.find((x) => x.id === c.groupId);
    if (!g || !g.options.some((o) => o.id === c.optionId)) return 'That choice is not on this item';
  }
  for (const g of groups) {
    const mine = chosen.filter((c) => c.groupId === g.id);
    if (new Set(mine.map((c) => c.optionId)).size !== mine.length) return `${g.name}: each choice once`;
    if (mine.length < g.minChoices) return g.minChoices === 1 ? `${g.name}: choose one` : `${g.name}: choose at least ${g.minChoices}`;
    if (mine.length > g.maxChoices) return g.maxChoices === 1 ? `${g.name}: only one` : `${g.name}: at most ${g.maxChoices}`;
  }
  return null;
}

/** The choices with their names and prices as the menu has them now (a client's own prices are never trusted). */
export function resolveModifiers(groups: ModifierGroup[], chosen: Array<{ groupId: string; optionId: string }>): ChosenModifier[] {
  return chosen.flatMap((c) => {
    const o = groups.find((g) => g.id === c.groupId)?.options.find((x) => x.id === c.optionId);
    return o ? [{ groupId: c.groupId, optionId: o.id, name: o.name, priceCents: o.priceCents, ...(o.itemId && { itemId: o.itemId }) }] : [];
  });
}
