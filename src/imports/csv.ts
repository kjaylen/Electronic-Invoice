/**
 * Reading spreadsheets saved as CSV (Excel, Google Sheets, Numbers, other systems' exports):
 * quoted fields with commas, quotes and line breaks inside, a byte-order mark, comma, semicolon
 * or tab separators (whichever the header row uses), Windows or Unix line endings.
 */

export class CsvError extends Error {
  override name = 'CsvError';
}

export const MAX_ROWS = 5000;

/** Rows of fields; the first row is the header. Blank lines are skipped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const delimiter = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) throw new CsvError(`Up to ${MAX_ROWS} rows at a time`);
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delimiter) {
      endField();
    } else if (c === '\n' || c === '\r') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += c;
    }
    i++;
  }
  if (quoted) throw new CsvError('A quoted field is not closed');
  if (field !== '' || row.length) endRow();
  return rows;
}

/** "Price (incl. GST)" -> "priceinclgst": how column names are compared. */
export const headerKey = (h: string) => h.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Map each wanted field to its column, from a list of names it may go by. */
export function columns<K extends string>(header: string[], aliases: Record<K, string[]>): Partial<Record<K, number>> {
  const keys = header.map(headerKey);
  const out: Partial<Record<K, number>> = {};
  for (const [field, names] of Object.entries(aliases) as Array<[K, string[]]>) {
    const at = keys.findIndex((k) => names.includes(k));
    if (at >= 0) out[field] = at;
  }
  return out;
}

/** yes / y / true / 1 / x. */
export const truthy = (v: string | undefined) => /^(y|yes|true|1|x|si|sí)$/i.test((v ?? '').trim());

/** "BZ$1,234.50" or "1234.5" -> "1234.50"; null when it is not an amount. */
export function amount(v: string | undefined): string | null {
  const s = (v ?? '').trim().replace(/^bz\$|^\$/i, '').replace(/,/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return null;
  return s;
}
