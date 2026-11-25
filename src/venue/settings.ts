/**
 * The hospitality module's switch and settings, kept on the business
 * (tenants.venue). A business with none of restaurant, bar or hotel on is a
 * shop: none of the module shows or runs for it.
 */

import type { Queryable } from '../db/database.ts';

export interface TipPool {
  /** How pooled tips are shared out. */
  method: 'none' | 'hours' | 'role' | 'points';
  /** For "role": each role's share, in percent of the pool. For "points": points per role, multiplied by hours. */
  weights: Record<string, number>;
}

export interface VenueSettings {
  restaurant: boolean;
  bar: boolean;
  hotel: boolean;
  /** BZ$ for one US$, in cents: 200 is the peg. */
  usdRateCents: number;
  /** Service charge: for nobody, for every bill, or for parties of at least `servicePartySize`. */
  serviceCharge: 'off' | 'all' | 'party';
  servicePercent: string;
  servicePartySize: number;
  /** The hour (0 to 12) the business day ends: sales before it belong to the day before. */
  dayEndsHour: number;
  /** A discount above this percent needs a supervisor. */
  discountLimitPercent: number;
  /** Minutes a party of this size is expected to stay: [upTo, minutes] pairs, ascending. */
  turnMinutes: Array<[number, number]>;
  tipPool: TipPool;
  /** The layout in use for the floor ("Standard", "Weekday", "Event"). */
  layout: string;
  /** A manager's override of the menu by the clock: a period's id, until the business day ends. */
  menuOverride: { periodId: string; businessDate: string } | null;
  /** Hotel: when a day's room is given up and taken, "HH:MM". */
  checkInTime: string;
  checkOutTime: string;
  /** Hotel rates are quoted in BZ$, US$ or both. */
  rateCurrency: 'BZD' | 'USD' | 'both';
  /** The hotel's business date: moved on by the night audit. */
  hotelDate: string | null;
}

export const VENUE_DEFAULTS: VenueSettings = {
  restaurant: false, bar: false, hotel: false,
  usdRateCents: 200,
  serviceCharge: 'off', servicePercent: '10', servicePartySize: 6,
  dayEndsHour: 4,
  discountLimitPercent: 10,
  turnMinutes: [[2, 75], [4, 90], [6, 105], [99, 120]],
  tipPool: { method: 'none', weights: {} },
  layout: 'Standard',
  menuOverride: null,
  checkInTime: '15:00', checkOutTime: '11:00',
  rateCurrency: 'both',
  hotelDate: null,
};

const PERCENT = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d);

/** Settings as stored (or as a client sent them), made whole. */
export function venueSettings(raw: unknown): VenueSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = VENUE_DEFAULTS;
  const pool = (r.tipPool && typeof r.tipPool === 'object' ? r.tipPool : {}) as Partial<TipPool>;
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(pool.weights ?? {})) if (/^[a-z]{3,20}$/.test(k) && typeof v === 'number' && v >= 0 && v <= 1000) weights[k] = v;
  const turns = Array.isArray(r.turnMinutes) ? (r.turnMinutes as unknown[]).filter((t): t is [number, number] => Array.isArray(t) && t.length === 2 && t.every((n) => typeof n === 'number' && n > 0 && n < 1000)).slice(0, 8) : [];
  const override = r.menuOverride as VenueSettings['menuOverride'];
  return {
    restaurant: r.restaurant === true, bar: r.bar === true, hotel: r.hotel === true,
    usdRateCents: int(r.usdRateCents, 100, 1000, d.usdRateCents),
    serviceCharge: r.serviceCharge === 'all' || r.serviceCharge === 'party' ? r.serviceCharge : 'off',
    servicePercent: typeof r.servicePercent === 'string' && PERCENT.test(r.servicePercent) && Number(r.servicePercent) <= 30 ? String(Number(r.servicePercent)) : d.servicePercent,
    servicePartySize: int(r.servicePartySize, 2, 50, d.servicePartySize),
    dayEndsHour: int(r.dayEndsHour, 0, 12, d.dayEndsHour),
    discountLimitPercent: int(r.discountLimitPercent, 0, 100, d.discountLimitPercent),
    turnMinutes: turns.length ? turns.sort((a, b) => a[0] - b[0]) : d.turnMinutes,
    tipPool: { method: pool.method === 'hours' || pool.method === 'role' || pool.method === 'points' ? pool.method : 'none', weights },
    layout: typeof r.layout === 'string' && r.layout.trim() ? r.layout.trim().slice(0, 40) : d.layout,
    menuOverride: override && typeof override.periodId === 'string' && typeof override.businessDate === 'string' ? { periodId: override.periodId, businessDate: override.businessDate } : null,
    checkInTime: typeof r.checkInTime === 'string' && TIME.test(r.checkInTime) ? r.checkInTime : d.checkInTime,
    checkOutTime: typeof r.checkOutTime === 'string' && TIME.test(r.checkOutTime) ? r.checkOutTime : d.checkOutTime,
    rateCurrency: r.rateCurrency === 'BZD' || r.rateCurrency === 'USD' ? r.rateCurrency : 'both',
    hotelDate: typeof r.hotelDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.hotelDate) ? r.hotelDate : null,
  };
}

export const venueOn = (v: VenueSettings) => v.restaurant || v.bar || v.hotel;

export async function loadVenue(db: Queryable, tenantId: string): Promise<VenueSettings> {
  return venueSettings((await db.query<{ venue: unknown }>('select venue from tenants where id = $1', [tenantId])).rows[0]?.venue);
}

export async function saveVenue(db: Queryable, tenantId: string, patch: Partial<VenueSettings>): Promise<VenueSettings> {
  const next = venueSettings({ ...(await loadVenue(db, tenantId)), ...patch });
  await db.query('update tenants set venue = $2 where id = $1', [tenantId, JSON.stringify(next)]);
  return next;
}

/** Belize is UTC-6 all year. */
const BELIZE_OFFSET_MS = 6 * 3600_000;

/**
 * The business date of a moment: the Belize calendar day, except that the
 * small hours before `dayEndsHour` still belong to the evening before (a bar
 * that closes at 2 am keeps Friday's sales on Friday).
 */
export function businessDate(at: Date, dayEndsHour: number): string {
  return new Date(at.getTime() - BELIZE_OFFSET_MS - dayEndsHour * 3600_000).toISOString().slice(0, 10);
}

/** Minutes from midnight and the weekday (0 Sunday) in Belize. */
export function belizeClock(at: Date): { minutes: number; weekday: number } {
  const local = new Date(at.getTime() - BELIZE_OFFSET_MS);
  return { minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday: local.getUTCDay() };
}

/** How long a party is expected to keep its table. */
export function expectedMinutes(v: VenueSettings, partySize: number): number {
  return (v.turnMinutes.find(([upTo]) => partySize <= upTo) ?? v.turnMinutes[v.turnMinutes.length - 1]!)[1];
}
