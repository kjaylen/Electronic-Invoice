/**
 * Calls to the API. Same origin, session cookie, and the CSRF header the
 * server requires on every cookie-authenticated change. On a till (the POS
 * apps), the server's address and the cashier's bearer token instead.
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

import { BUSINESS } from './business';

/** Fired when a signed-in call answers 401 (session expired or signed out elsewhere). */
export const UNAUTHORIZED_EVENT = 'etd:unauthorized';

/** On a till: where the server is and the token to send (the cashier's session, or the till's own before sign-in). */
interface TillTransport {
  baseUrl: string;
  token: () => string | null;
}
let till: TillTransport | null = null;

/** Make every API call go to the till's server with its bearer token (the POS apps). */
export function setTillTransport(t: TillTransport | null) {
  till = t;
}

type CallOptions = { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; token?: string | null };

async function call(path: string, options: CallOptions): Promise<Response> {
  const token = options.token !== undefined ? options.token : till?.token() ?? null;
  try {
    return await fetch(till ? `${till.baseUrl}${path}` : path, {
      method: options.method ?? 'GET',
      credentials: till ? 'omit' : 'same-origin',
      headers: {
        'X-Requested-With': 'etd-web',
        // Which business this call is for: each business has its own sign-in cookie.
        ...(!till && BUSINESS && { 'X-Business': BUSINESS }),
        ...(till && token && { Authorization: `Bearer ${token}` }),
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
}

async function failure(res: Response, path: string): Promise<ApiError> {
  let data: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  try {
    data = JSON.parse(await res.text());
  } catch {
    data = undefined;
  }
  const e = data?.error ?? {};
  if (res.status === 401 && !path.startsWith('/v1/auth/') && !path.startsWith('/v1/pos/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
}

/** A file from the API (a PDF), with the same sign-in as other calls. */
export async function apiBlob(path: string, options: CallOptions = {}): Promise<Blob> {
  const res = await call(path, options);
  if (!res.ok) throw await failure(res, path);
  return res.blob();
}

export async function api<T = unknown>(path: string, options: CallOptions = {}): Promise<T> {
  const res = await call(path, options);
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
    if (res.status === 401 && !path.startsWith('/v1/auth/') && !path.startsWith('/v1/pos/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

/** A plain link to the API (PDF, XML, CSV), naming the business since links cannot carry headers. */
export function link(path: string): string {
  if (!BUSINESS) return path;
  return `${path}${path.includes('?') ? '&' : '?'}b=${encodeURIComponent(BUSINESS)}`;
}

/** An error code that means "sign in again", not "something broke". */
export const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401;

// ---------- shapes returned by the API ----------

export type Role = 'owner' | 'admin' | 'manager' | 'cashier' | 'accountant';
export type Permission =
  | 'documents.issue' | 'documents.adjust' | 'documents.cancel' | 'documents.send' | 'catalog.manage' | 'orders.manage'
  | 'payments.record' | 'expenses.manage' | 'reports.view' | 'business.manage' | 'users.manage' | 'apikeys.manage' | 'audit.view';

export interface Account {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  role: Role;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Has a PIN for signing in on tills. */
  hasPin?: boolean;
}

export interface SessionInfo {
  user: Account;
  business: { id: string; slug: string; legalName: string; tradeName: string | null; environment: 'test' | 'production' };
  permissions: Permission[];
  twoFactor: { enabled: boolean; required: boolean; setupRequired: boolean };
}

export interface Me {
  id: string;
  legalName: string;
  tradeName: string | null;
  tin: string;
  environment: 'test' | 'production';
  certificate: { id: string; tin: string; validFrom: string; validTo: string; daysLeft: number; status: string } | null;
  contingency: { active: boolean; since: string | null; reason: string | null; queued: number };
  /** How the counter works: the most a cashier may take off a line (percent), or no limit. */
  counter?: { cashierDiscountLimit: string | null };
  billing?: { plan: 'starter' | 'business' | 'pro'; planName: string; status: 'trialing' | 'active' | 'past_due' | 'suspended'; trialDaysLeft: number | null; overdueInvoices: number; features: Array<'store' | 'api' | 'webhooks' | 'integrations'> };
}

export interface Customer {
  id: string;
  name: string;
  tin: string | null;
  otherId: { scheme: string; value: string } | null;
  address: { street: string; city: string; districtCode: string } | null;
  contact: { telephone: string | null; email: string | null };
  /** Wholesale customers pay items' wholesale prices. */
  priceList?: 'retail' | 'wholesale';
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
  /** The price before GST for wholesale customers; null: the usual price. */
  wholesalePrice?: string | null;
  /** In stock now; null when stock is not tracked. */
  stock?: number | null;
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
  issuedBy?: string | null;
  createdAt: string;
  /** Tax invoices and debit notes: what is owed (null for other documents and store orders paid at checkout). */
  payment?: { status: InvoiceStatus; balance: string; dueDate: string; total?: string; paid?: string; credited?: string; daysOverdue?: number } | null;
}

// ---------- getting paid ----------

export type InvoiceStatus = 'paid' | 'partial' | 'unpaid' | 'overdue' | 'credit';
export type InvoicePaymentMethod = 'cash' | 'cheque' | 'bank_transfer' | 'card' | 'online' | 'refund' | 'other';

export interface Receivable {
  documentId: string;
  type: '01' | '03';
  number: string;
  issueDate: string;
  dueDate: string;
  daysOverdue: number;
  customer: { id: string | null; key: string; name: string; tin: string | null; email: string | null };
  total: string;
  paid: string;
  credited: string;
  balance: string;
  status: InvoiceStatus;
}

export interface InvoicePayment {
  id: string;
  documentId: string;
  amount: string;
  method: InvoicePaymentMethod;
  reference: string | null;
  paidOn: string;
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
  voided: boolean;
  voidReason: string | null;
}

export type AgeBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

export interface ReceivablesOverview {
  summary: { outstanding: string; overdue: string; dueThisWeek: string; collectedThisMonth: string; openInvoices: number; overdueInvoices: number; customersOwing: number };
  ageing: {
    customers: Array<{ key: string; id: string | null; name: string; tin: string | null; email: string | null; invoices: number; oldestDue: string; buckets: Record<AgeBucket, string>; total: string }>;
    totals: Record<AgeBucket | 'total', string>;
  };
  buckets: AgeBucket[];
  reminders: { enabled: boolean; offsets: number[] };
  onlinePayments: boolean;
}

export interface ReceivableSettingsInfo {
  reminders: { enabled: boolean; offsets: number[] };
  payOnline: boolean;
  instructions: string;
  onlineProvider: string | null;
  onlineProviders?: string[];
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
  /** Invoices and receipts: what credit notes have taken off, and what is left to credit. */
  credit?: { credited: string; debited: string; remaining: string };
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ManagedAccount extends Account {
  activeSessions: number;
  manageable: boolean;
  twoFactor: boolean;
}

export interface AuditEvent {
  id: number;
  at: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user: { id: string; name: string } | null;
}

export interface BusinessProfile {
  id: string;
  slug: string;
  legalName: string;
  tradeName: string | null;
  tin: string;
  address: { street: string; additionalStreet?: string; city: string; districtCode: string };
  contact: { telephone: string; email: string };
  environment: 'test' | 'production';
  requireTwoFactor: boolean;
  /** The morning summary email to owners and admins. */
  dailySummary?: boolean;
}

export interface Summary {
  period: { from: string; to: string };
  totals: { documents: number; net: string; gst: string; tax: string; total: string };
  byType: Array<{ type: string; typeName: string; documents: number; net: string; gst: string; tax: string; total: string }>;
  byRate: Array<{ category: 'S' | 'Z' | 'E'; name: string; net: string; gst: string }>;
  byDay: Array<{ date: string; documents: number; total: string }>;
}

// ---------- online store ----------

export interface Variant {
  id?: string;
  title?: string | null;
  option1: string | null;
  option2: string | null;
  price: string;
  priceWithGst?: string;
  gstCategory: 'S' | 'Z' | 'E';
  exemptionReasonCode: string | null;
  unitCode: string;
  sellerCode: string | null;
  barcode: string | null;
  stock: number | null;
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  description: string;
  status: 'draft' | 'active' | 'archived';
  option1Name: string | null;
  option2Name: string | null;
  variants: Variant[];
  images: Array<{ id: string; contentType: string; bytes: number }>;
}

export interface ProductSummary {
  id: string;
  title: string;
  handle: string;
  status: 'draft' | 'active' | 'archived';
  variants: number;
  priceFrom: string | null;
  priceTo: string | null;
  stock: number | null;
  imageId: string | null;
}

export interface StoreSettings {
  enabled: boolean;
  tagline: string;
  about: string;
  notifyEmail: string;
  whatsapp: string;
  delivery: { enabled: boolean; zones: Array<{ name: string; fee: string }> };
  pickup: { enabled: boolean; instructions: string };
  payments: { bankTransfer: { enabled: boolean; instructions: string }; cashOnDelivery: { enabled: boolean }; payAtPickup: { enabled: boolean }; online: { enabled: boolean; provider: 'paypal' | 'test' | 'belizebank' | 'ekyash' } };
  slug?: string;
}

export type PaymentMethod = 'bank_transfer' | 'cash_on_delivery' | 'pay_at_pickup' | 'online';

export interface Order {
  id: string;
  number: number;
  status: 'open' | 'cancelled';
  paymentStatus: 'unpaid' | 'paid';
  fulfillmentStatus: 'unfulfilled' | 'fulfilled';
  paymentMethod: PaymentMethod;
  fulfillment: 'delivery' | 'pickup';
  deliveryZone: string | null;
  deliveryFee: string;
  customer: { name: string; email: string | null; phone: string };
  address: { street: string; city: string; districtCode: string; districtName: string | null } | null;
  business: { tin: string; name: string } | null;
  note: string | null;
  totals: { lineExtension: string; gst: string; total: string; refunded: string };
  documentId: string | null;
  document?: { id: string; status: DocStatus; type: string; series: string; number: string } | null;
  refunds?: Array<{
    id: string; amount: string; lines: Array<{ lineNumber: number; quantity: number }>; delivery: boolean; reason: string; restocked: boolean; createdAt: string;
    document: { id: string; status: DocStatus; type: string; series: string; number: string } | null;
  }>;
  refundable?: { lines: Array<{ lineNumber: number; quantity: number }>; delivery: boolean };
  lines?: Array<{ lineNumber: number; variantId: string | null; productTitle: string; variantTitle: string | null; quantity: number; unitPrice: string; gstCategory: string; total: string }>;
  createdAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}
