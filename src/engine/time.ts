/**
 * Belize local time. Belize is UTC-6 all year and does not use daylight
 * saving time, so a fixed offset is correct.
 */

export const BELIZE_UTC_OFFSET = '-06:00';
const OFFSET_MS = -6 * 60 * 60 * 1000;

export interface BelizeDateTime {
  /** YYYY-MM-DD, as written to cbc:IssueDate. */
  date: string;
  /** HH:MM:SS, the local time without offset. */
  time: string;
  /** HH:MM:SS-06:00, as written to cbc:IssueTime. */
  timeWithOffset: string;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function toBelizeDateTime(instant: Date = new Date()): BelizeDateTime {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('Invalid date');
  }
  const local = new Date(instant.getTime() + OFFSET_MS);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return { date, time, timeWithOffset: `${time}${BELIZE_UTC_OFFSET}` };
}
