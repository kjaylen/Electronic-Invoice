/**
 * A request that does not fit a route's schema, said in words a person can
 * act on: which field, and what it must be.
 *
 *   body/lines/0/quantity must be integer          → lines[0].quantity must be a whole number
 *   body must have required property 'fulfillment' → fulfillment is required
 *   querystring must NOT have additional properties → query parameter page is not a parameter this request takes
 */

import { date, decimal, etdui, money, tin, uuid } from './schemas.ts';

export interface ValidationFinding {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}

/** Patterns the schemas share, and what they ask for. */
const PATTERN_WORDS = new Map<string, string>([
  [uuid.pattern, 'must be an id (36 characters, as this API gave it out)'],
  [decimal.pattern, 'must be a decimal number written as text, like "24.99"'],
  [money.pattern, 'must be an amount written as text, like "24.99"'],
  [date.pattern, 'must be a date like 2026-12-31'],
  [tin.pattern, 'must be 6 digits'],
  [etdui.pattern, 'must be the 44 digits of an ETDUI'],
  ['^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$', 'must be a store\'s name as in its address (lower-case letters, digits and hyphens)'],
  ['^[0-9+()\\-\\s]+$', 'must be a phone number (digits, spaces, + - and brackets)'],
]);

function patternWords(pattern: string): string {
  const known = PATTERN_WORDS.get(pattern);
  if (known) return known;
  if (pattern.includes('@')) return 'must be an email address';
  if (/^\^\\d\{\d+(,\d+)?\}\$$/.test(pattern)) return 'must be a whole number (digits only)';
  if (/^\^\\d\{1,\d+\}\(\\\.\\d\{1,\d+\}\)\?\$$/.test(pattern)) return 'must be an amount written as text, like "24.99"';
  return `is not in the form expected (${pattern})`;
}

const TYPE_WORDS: Record<string, string> = {
  integer: 'a whole number', number: 'a number', string: 'text (in quotes)', boolean: 'true or false', array: 'a list', object: 'an object', null: 'null',
};

/** "/lines/0/quantity" → "lines[0].quantity" */
function fieldName(instancePath: string | undefined, extra?: string): string {
  const parts = (instancePath ?? '').split('/').filter(Boolean);
  if (extra) parts.push(extra);
  return parts.map((p, i) => (/^\d+$/.test(p) ? `[${p}]` : i ? `.${p}` : p)).join('');
}

/** One finding of the validator, in words. `where` is the part of the request it was found in. */
export function describeValidation(finding: ValidationFinding, where: string | undefined): string {
  const p = finding.params ?? {};
  const place = where === 'querystring' ? 'query parameter ' : where === 'params' ? 'in the address, ' : where === 'headers' ? 'header ' : '';
  const name = (extra?: string) => {
    const f = fieldName(finding.instancePath, extra);
    return f ? `${place}${f}` : where === 'querystring' ? 'the query' : where === 'params' ? 'the address' : 'the request body';
  };
  switch (finding.keyword) {
    case 'required':
      return `${name(String(p.missingProperty))} is required`;
    case 'additionalProperties':
      return `${name(String(p.additionalProperty))} is not a ${where === 'querystring' ? 'parameter' : 'field'} this request takes. Check its spelling against the API reference.`;
    case 'type': {
      // Not JSON at all (a form, plain text): the whole body is the wrong kind of thing.
      if (!finding.instancePath && where === 'body') return 'The body must be a JSON object. Send JSON, with the header Content-Type: application/json';
      const types = ([] as string[]).concat(p.type as string | string[]).map((t) => TYPE_WORDS[t] ?? t);
      return `${name()} must be ${types.join(' or ')}`;
    }
    case 'enum':
      return `${name()} must be one of: ${((p.allowedValues as unknown[] | undefined) ?? []).map((v) => JSON.stringify(v)).join(', ')}`;
    case 'pattern':
      return `${name()} ${patternWords(String(p.pattern))}`;
    case 'format':
      return `${name()} must be ${p.format === 'email' ? 'an email address' : `a valid ${String(p.format)}`}`;
    case 'minLength':
      return Number(p.limit) <= 1 ? `${name()} must not be empty` : `${name()} must be at least ${String(p.limit)} characters`;
    case 'maxLength':
      return `${name()} must be at most ${String(p.limit)} characters`;
    case 'minimum':
      return `${name()} must be at least ${String(p.limit)}`;
    case 'exclusiveMinimum':
      return `${name()} must be more than ${String(p.limit)}`;
    case 'maximum':
      return `${name()} must be at most ${String(p.limit)}`;
    case 'exclusiveMaximum':
      return `${name()} must be less than ${String(p.limit)}`;
    case 'minItems':
      return Number(p.limit) <= 1 ? `${name()} must have at least one item` : `${name()} must have at least ${String(p.limit)} items`;
    case 'maxItems':
      return `${name()} must have at most ${String(p.limit)} items`;
    case 'uniqueItems':
      return `${name()} must not repeat an item`;
    case 'minProperties':
      return `${name()} must have at least one field`;
    default:
      return `${name()} ${finding.message ?? 'is not valid'}`;
  }
}
