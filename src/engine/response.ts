/**
 * Parse BTS replies (manual 7.3, 7.9.3 and 7.10.3).
 *
 * Reception services answer with a signed ApplicationResponse:
 *   cbc:UUID                                     the reply's own ETDUI: the authorization protocol number
 *   DocumentResponse/Response/ResponseCode       001 authorized, 002 authorized with alert, 003 rejected
 *   DocumentResponse/Response/Status/ConditionCode + Description, StatusReasonCode + StatusReason
 *                                                one per failed rule (e.g. 283), or alert
 *   DocumentResponse/DocumentReference/UUID      the ETDUI of the document BTS analyzed
 *
 * Document Query and System Status answer with JSON (GetDocument, GetStatus).
 * The manual gives the field names but not the exact JSON shape, so those
 * parsers look fields up by name anywhere in the object, ignoring case and
 * any "cbc:" prefix, and also accept an XML body.
 *
 * The raw reply is always kept by the caller: it is part of the legal record.
 */

import { DOMParser, type Element } from '@xmldom/xmldom';

const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const APP_RESPONSE = 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2';

export const RESPONSE_CODES = {
  AUTHORIZED: '001',
  AUTHORIZED_WITH_ALERT: '002',
  REJECTED: '003',
  NOT_FOUND: '004',
  FOUND: '005',
  FOUND_WITH_ALERT: '006',
  CANCELLED: '007',
  OPERATING: '008',
  NOT_OPERATING: '009',
} as const;

/** Rejection code for "this ETDUI is already authorized" (a duplicate send). */
export const DUPLICATE_ETDUI_CODE = '255';

export interface Condition {
  code: string;
  description?: string;
  reasonCode?: string;
  reason?: string;
}

export interface ApplicationResponseInfo {
  /** The reply's own ETDUI; for an authorization this is the protocol number. */
  responseUuid?: string;
  responseId?: string;
  issueDate?: string;
  issueTime?: string;
  responseCode?: string;
  description?: string;
  conditions: Condition[];
  /** ETDUI of the document BTS analyzed. */
  referencedEtdui?: string;
  referencedTypeCode?: string;
}

export class ResponseParseError extends Error {
  override name = 'ResponseParseError';
}

function childElements(parent: Element, ns: string, name: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (n): n is Element => (n as Element).namespaceURI === ns && (n as Element).localName === name,
  );
}

function childText(parent: Element | undefined, ns: string, name: string): string | undefined {
  const value = parent && childElements(parent, ns, name)[0]?.textContent?.trim();
  return value ? value : undefined;
}

export function parseApplicationResponse(xml: string): ApplicationResponseInfo {
  let root: Element | null;
  try {
    root = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml').documentElement;
  } catch {
    root = null;
  }
  if (!root || root.localName !== 'ApplicationResponse' || root.namespaceURI !== APP_RESPONSE) {
    throw new ResponseParseError('Reply is not a UBL ApplicationResponse');
  }
  const docResponse = childElements(root, CAC, 'DocumentResponse')[0];
  const response = docResponse && childElements(docResponse, CAC, 'Response')[0];
  const reference = docResponse && childElements(docResponse, CAC, 'DocumentReference')[0];
  const conditions: Condition[] = (response ? childElements(response, CAC, 'Status') : []).flatMap((s) => {
    const code = childText(s, CBC, 'ConditionCode');
    if (!code) return [];
    const c: Condition = { code };
    const description = childText(s, CBC, 'Description');
    const reasonCode = childText(s, CBC, 'StatusReasonCode');
    const reason = childText(s, CBC, 'StatusReason');
    if (description) c.description = description;
    if (reasonCode) c.reasonCode = reasonCode;
    if (reason) c.reason = reason;
    return [c];
  });
  const info: ApplicationResponseInfo = { conditions };
  const set = <K extends keyof ApplicationResponseInfo>(key: K, value: ApplicationResponseInfo[K] | undefined) => {
    if (value !== undefined) info[key] = value;
  };
  set('responseUuid', childText(root, CBC, 'UUID'));
  set('responseId', childText(root, CBC, 'ID'));
  set('issueDate', childText(root, CBC, 'IssueDate'));
  set('issueTime', childText(root, CBC, 'IssueTime'));
  set('responseCode', childText(response, CBC, 'ResponseCode'));
  set('description', childText(response, CBC, 'Description'));
  set('referencedEtdui', childText(reference, CBC, 'UUID'));
  set('referencedTypeCode', childText(reference, CBC, 'DocumentTypeCode'));
  return info;
}

// ---------- JSON services ----------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const normalizeKey = (k: string) => k.replace(/^[a-z]+:/i, '').toLowerCase();

/** Find the first value for a field name anywhere in a JSON value (depth-first). */
function findField(value: Json, name: string, depth = 0): Json | undefined {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, name, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const target = normalizeKey(name);
  for (const [k, v] of Object.entries(value)) if (normalizeKey(k) === target) return v;
  for (const v of Object.values(value)) {
    const found = findField(v, name, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findAllStrings(value: Json, name: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) findAllStrings(item, name, out, depth + 1);
    return out;
  }
  const target = normalizeKey(name);
  for (const [k, v] of Object.entries(value)) {
    if (normalizeKey(k) === target && typeof v === 'string') out.push(v);
    else findAllStrings(v, name, out, depth + 1);
  }
  return out;
}

const asText = (v: Json | undefined): string | undefined =>
  typeof v === 'string' ? v.trim() || undefined : typeof v === 'number' ? String(v) : undefined;

/** Parse a JSON body, or wrap an XML body so the same field lookups work. */
function parseServiceBody(body: string): Json {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Json;
    } catch {
      throw new ResponseParseError('Reply is not valid JSON');
    }
  }
  if (trimmed.startsWith('<')) {
    let root: Element | null = null;
    try {
      root = new DOMParser({ onError: () => {} }).parseFromString(trimmed, 'text/xml').documentElement;
    } catch {
      root = null;
    }
    if (!root) throw new ResponseParseError('Reply is not valid XML');
    const toJson = (e: Element): Json => {
      const kids = Array.from(e.childNodes).filter((n) => n.nodeType === 1) as Element[];
      if (kids.length === 0) return e.textContent ?? '';
      const obj: Record<string, Json> = {};
      for (const k of kids) obj[k.localName ?? k.nodeName] = toJson(k);
      return obj;
    };
    return { [root.localName ?? 'root']: toJson(root) };
  }
  throw new ResponseParseError('Reply is neither JSON nor XML');
}

export interface DocumentQueryInfo {
  etdui?: string;
  responseCode?: string;
  description?: string;
  status: 'not_found' | 'authorized' | 'authorized_with_alert' | 'cancelled' | 'other';
  /** The complete ETD, when the querying taxpayer is a party to it. */
  etdXml?: string;
  /** Related ApplicationResponse XMLs (events), when returned. */
  events: string[];
}

export function parseDocumentQuery(body: string): DocumentQueryInfo {
  const json = parseServiceBody(body);
  const code = asText(findField(json, 'ResponseCode'));
  const status =
    code === RESPONSE_CODES.NOT_FOUND ? 'not_found'
    : code === RESPONSE_CODES.FOUND ? 'authorized'
    : code === RESPONSE_CODES.FOUND_WITH_ALERT ? 'authorized_with_alert'
    : code === RESPONSE_CODES.CANCELLED ? 'cancelled'
    : 'other';
  const info: DocumentQueryInfo = { status, events: findAllStrings(json, 'ETDEvent') };
  const etdui = asText(findField(json, 'UUID'));
  const description = asText(findField(json, 'Description'));
  const etdXml = asText(findField(json, 'ReferencedXML'));
  if (etdui) info.etdui = etdui;
  if (code) info.responseCode = code;
  if (description) info.description = description;
  if (etdXml) info.etdXml = etdXml;
  return info;
}

export interface SystemStatusInfo {
  operational: boolean;
  responseCode?: string;
  description?: string;
  /** Average response time over the last five minutes, in milliseconds. */
  averageResponseMs?: number;
}

export function parseSystemStatus(body: string): SystemStatusInfo {
  const json = parseServiceBody(body);
  const code = asText(findField(json, 'ResponseCode'));
  const info: SystemStatusInfo = { operational: code === RESPONSE_CODES.OPERATING };
  const description = asText(findField(json, 'Description'));
  const ms = Number(asText(findField(json, 'StatusResponseTime')));
  if (code) info.responseCode = code;
  if (description) info.description = description;
  if (Number.isFinite(ms)) info.averageResponseMs = ms;
  return info;
}
