/**
 * Calls to the API. Same origin, session cookie, and the CSRF header the
 * server requires on every cookie-authenticated change.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Fired when a signed-in call answers 401 (session expired or signed out elsewhere). */
export const UNAUTHORIZED_EVENT = 'etd:unauthorized';

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'etd-web',
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      ...(options.signal && { signal: options.signal }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && !path.startsWith('/v1/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

// ---------- shapes returned by the API ----------

export type Role = 'owner' | 'member';

export interface Business {
  id: string;
  legalName: string;
  tradeName: string | null;
  environment: 'test' | 'production';
  role: Role;
}

export interface SessionInfo {
  user: { id: string; email: string; name: string };
  businesses: Business[];
  currentBusinessId: string | null;
  role?: Role | null;
}

export interface Me {
  id: string;
  legalName: string;
  tradeName: string | null;
  tin: string;
  environment: 'test' | 'production';
  certificate: { id: string; tin: string; validFrom: string; validTo: string; daysLeft: number; status: string } | null;
  contingency: { active: boolean; since: string | null; reason: string | null; queued: number };
}

export interface Customer {
  id: string;
  name: string;
  tin: string | null;
  otherId: { scheme: string; value: string } | null;
  address: { street: string; city: string; districtCode: string } | null;
  contact: { telephone: string | null; email: string | null };
  archived?: boolean;
}

export interface Item {
  id: string;
  name: string;
  description: string;
  sellerCode: string | null;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode: string | null;
  barcode: string | null;
  favorite: boolean;
}

export interface Condition {
  code: string;
  description?: string;
}

export type DocStatus = 'pending' | 'authorized' | 'authorized_with_alert' | 'rejected' | 'contingency_pending' | 'superseded' | 'cancelled';

export interface DocumentInfo {
  id: string;
  etdui: string;
  type: '01' | '02' | '03' | '04';
  typeName: string;
  series: string;
  serial: number;
  number: string;
  status: DocStatus;
  contingency: boolean;
  environment: 'test' | 'production';
  protocolNumber: string | null;
  issueDate: string;
  issueTime: string;
  customerId: string | null;
  customer: { name?: string; tin?: string; contact?: { telephone?: string; email?: string } } | null;
  referencedEtdui: string | null;
  totals: { lineExtension: string; gst: string; tax: string; taxInclusive: string; payable: string };
  conditions: Condition[];
  problem?: { kind: string; reason: string | null };
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface DocumentLine {
  lineNumber: number;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  gstCategory: 'S' | 'Z' | 'E';
  net: string;
  gst: string;
  tax: string;
  total: string;
}

export interface DocumentDetailInfo extends DocumentInfo {
  lines: DocumentLine[];
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

export interface Summary {
  period: { from: string; to: string };
  totals: { documents: number; net: string; gst: string; tax: string; total: string };
  byType: Array<{ type: string; typeName: string; documents: number; net: string; gst: string; tax: string; total: string }>;
  byRate: Array<{ category: 'S' | 'Z' | 'E'; name: string; net: string; gst: string }>;
  byDay: Array<{ date: string; documents: number; total: string }>;
}
