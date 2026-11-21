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

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'etd-web',
      ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

// ---------- shapes returned by the API ----------

export interface Business {
  id: string;
  legalName: string;
  tradeName: string | null;
  environment: 'test' | 'production';
  role: 'owner' | 'member';
}

export interface SessionInfo {
  user: { id: string; email: string; name: string };
  businesses: Business[];
  currentBusinessId: string | null;
  role?: 'owner' | 'member' | null;
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
}

export interface Condition {
  code: string;
  description?: string;
}

export interface DocumentInfo {
  id: string;
  etdui: string;
  type: '01' | '02' | '03' | '04';
  typeName: string;
  series: string;
  serial: number;
  number: string;
  status: 'pending' | 'authorized' | 'authorized_with_alert' | 'rejected' | 'contingency_pending' | 'superseded' | 'cancelled';
  contingency: boolean;
  environment: 'test' | 'production';
  protocolNumber: string | null;
  issueDate: string;
  issueTime: string;
  customerId: string | null;
  customer: { name?: string; tin?: string } | null;
  referencedEtdui: string | null;
  totals: { lineExtension: string; gst: string; tax: string; taxInclusive: string; payable: string };
  conditions: Condition[];
  problem?: { kind: string; reason: string | null };
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
