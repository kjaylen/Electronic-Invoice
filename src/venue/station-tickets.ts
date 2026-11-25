/**
 * The tickets an order makes: one per station, each with only what that
 * station prepares. Pure, so a device with no connection makes the same
 * tickets the server would.
 */

import type { Check, CheckItem } from './check.ts';

export interface TicketStation { id: string; name: string; screen: boolean; deviceId: string | null }

export interface TicketBody {
  number: number;
  table: string;
  server: string;
  partySize: number;
  allergy: string | null;
  at: string;
  /** Grouped by course, then seat. */
  items: Array<{ id: string; name: string; quantity: number; seat: number; course: number; modifiers: string[]; note: string | null; allergens: string[] }>;
}

/** One ticket per station for these items: each station sees only what it makes. */
export function ticketsFor<S extends TicketStation>(check: Check, itemIds: string[], kind: 'order' | 'void', stations: S[], number: number): Array<{ station: S; body: TicketBody }> {
  const items = check.items.filter((i) => itemIds.includes(i.id));
  const at = kind === 'order' ? items[0]?.sentAt ?? check.lastActivityAt : check.lastActivityAt;
  return stations.flatMap((station) => {
    const mine = items.filter((i) => i.stationIds.includes(station.id)).sort((a, b) => a.course - b.course || a.seat - b.seat);
    if (!mine.length) return [];
    return [{
      station,
      body: {
        number, table: check.tableName ?? check.name ?? (check.kind === 'quick' ? 'Counter' : 'Tab'), server: check.server.name, partySize: check.partySize, allergy: check.allergy, at,
        items: mine.map((i: CheckItem) => ({ id: i.id, name: i.name, quantity: i.quantity, seat: i.seat, course: i.course, modifiers: i.modifiers.map((m) => m.name), note: i.note ?? null, allergens: i.allergens })),
      },
    }];
  });
}

