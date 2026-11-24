/**
 * What may go into an email's headers.
 *
 * Addresses, names and subjects come from people (a customer's email typed at
 * a checkout, a business's name), and a header ends at a line break: a value
 * carrying one could add headers of its own (Bcc, a second To). So nothing
 * with a line break or control character ever reaches a header: addresses and
 * names with one are refused, subjects have them turned into spaces.
 */

export class MailAddressError extends Error {
  override name = 'MailAddressError';
}

// Line breaks and control characters, the Unicode line and paragraph separators among them (written by number, so this file has none).
const CONTROL = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
// One mailbox, nothing fancy: no display name, no comments, no quoted local part, no list.
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** One email address, trimmed, or a MailAddressError saying what is wrong with it. */
export function checkAddress(value: unknown, what = 'The email address'): string {
  if (typeof value !== 'string') throw new MailAddressError(`${what} is missing`);
  const address = value.trim();
  if (!address) throw new MailAddressError(`${what} is missing`);
  if (CONTROL.test(address)) throw new MailAddressError(`${what} has a line break or a character that cannot be typed`);
  if (/[,;<>\s]/.test(address)) throw new MailAddressError(`${what} must be one address, like name@example.com, with no spaces, commas or brackets`);
  if (address.length > 254) throw new MailAddressError(`${what} is too long`);
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) throw new MailAddressError(`${what} must look like name@example.com`);
  if (at > 64) throw new MailAddressError(`${what} has too long a name before the @`);
  if (!ADDRESS.test(address) || address.includes('..') || address.startsWith('.') || address[at - 1] === '.') throw new MailAddressError(`${what} must look like name@example.com`);
  return address;
}

export function isAddress(value: unknown): value is string {
  try {
    checkAddress(value);
    return true;
  } catch {
    return false;
  }
}

/** The part after the @, lower case. */
export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** A sender's name: one line, no characters that end or split a header. */
export function checkDisplayName(value: unknown, what = 'The name'): string {
  if (typeof value !== 'string' || !value.trim()) throw new MailAddressError(`${what} is missing`);
  const name = value.trim();
  if (CONTROL.test(name)) throw new MailAddressError(`${what} must be one line of text`);
  if (name.length > 80) throw new MailAddressError(`${what} must be 80 characters or fewer`);
  if (/[<>"]/.test(name)) throw new MailAddressError(`${what} cannot contain < > or "`);
  return name;
}

/** A subject line: line breaks and control characters become spaces, so what follows them stays part of the subject. */
export function cleanSubject(value: string): string {
  return value.replace(new RegExp(CONTROL.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** A name put into a From header by the service (a business's name): made safe rather than refused. */
export function cleanDisplayName(value: string): string {
  return value.replace(new RegExp(CONTROL.source, 'g'), ' ').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// The only extra headers callers may set; anything else is dropped.
const ALLOWED_HEADERS = new Map([['list-unsubscribe', 'List-Unsubscribe'], ['list-unsubscribe-post', 'List-Unsubscribe-Post'], ['auto-submitted', 'Auto-Submitted']]);

export function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const known = ALLOWED_HEADERS.get(name.toLowerCase());
    if (!known || typeof value !== 'string' || CONTROL.test(value) || value.length > 2000) continue;
    out[known] = value;
  }
  return out;
}

/** "Name <address>", the name quoted. */
export function formatFrom(name: string, address: string): string {
  const safe = cleanDisplayName(name);
  return safe ? `"${safe.replace(/\\/g, '')}" <${address}>` : address;
}

/** "Name <a@b.c>" or "a@b.c" (the MAIL_FROM setting) into its parts. */
export function parseFrom(value: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(value);
  if (m) return { name: m[1]!.trim(), address: m[2]!.trim() };
  return { name: '', address: value.trim() };
}
