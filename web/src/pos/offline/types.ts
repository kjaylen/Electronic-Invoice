/** What the till keeps on the device: the server's snapshot, and the sales and shifts it made. */

import type { LineInput, TaxConfig } from '../../../../src/engine/calc.ts';
import type { PrintParty, PrintView } from '../../../../src/engine/print-view.ts';
import type { Customer, DocumentInfo, DocumentLine, Item, Me, Permission, Role } from '../../api';
import type { Shift, ShiftReport } from '../../pages/Shifts';

/** GET /v1/pos/snapshot: everything the till sells from. */
export interface Snapshot {
  serverTime: string;
  business: { id: string; slug: string; name: string; legalName: string; tradeName: string | null; tin: string; environment: 'test' | 'production' };
  device: { id: string; name: string; register: { id: string; name: string } };
  users: Array<{ id: string; name: string; role: Role; hasPin: boolean; pinSetAt: string | null; permissions: Permission[] }>;
  openShift: { shift: Shift; report: ShiftReport } | null;
  me: Me;
  receipt: { issuer: PrintParty; qrBase: string; logo: string | null };
  tax: TaxConfig | null;
  offline: { series: number; nextSerial: number; receptionEnv: '01' | '02'; environment: 'test' | 'production' };
  items: Array<Item & { archived?: boolean }>;
  categories: Array<{ name: string }>;
  customers: Customer[];
}

export type Tender = { means: string; cents: string };

/** A receipt as the till uploads it (POST /v1/pos/sync, kind "sale"). */
export interface SaleEvent {
  id: string;
  kind: 'sale';
  at: string;
  userId: string | null;
  shiftId: string | null;
  environment: 'test' | 'production';
  series: number;
  serial: number;
  issueDate: string;
  issueTime: string;
  securityCode: string;
  etdui: string;
  request: {
    lines: LineInput[];
    customer?: { name?: string; tin?: string; otherId?: { scheme: string; value: string }; address?: { street: string; city: string; districtCode: string; districtName?: string }; contact?: { telephone?: string; email?: string } };
    customerId?: string;
    payment?: { meansCode?: string; terms?: string };
    note?: string;
    lineItemIds: Array<string | null>;
  };
  tenders?: Tender[];
}

export interface ShiftOpenEvent { id: string; kind: 'shift_open'; at: string; userId: string; shiftId: string; openingFloat: string }
export interface CashEvent { id: string; kind: 'cash'; at: string; userId: string | null; shiftId: string; type: 'pay_in' | 'pay_out'; amount: string; reason: string }
export interface ShiftCloseEvent { id: string; kind: 'shift_close'; at: string; userId: string; shiftId: string; countedCash: string; counted?: Record<string, number> | null; note?: string | null }
export type SyncEvent = SaleEvent | ShiftOpenEvent | CashEvent | ShiftCloseEvent;

/** A receipt made on this till, kept for its printed copy, the sales list and the shift report. */
export interface LocalSale {
  doc: DocumentInfo;
  lines: DocumentLine[];
  view: PrintView;
  /** How it was paid: one part per means (a single part when paid one way). */
  tenders: Tender[];
  /** Taken off the lines' full prices, before GST (the shift report's discounts). */
  discountCents: string;
  userId: string | null;
}

/** A sale the server made for this till during a shift (a gift card, on account, a refund): counted in its report. */
export interface RemoteSale {
  id: string;
  type: string;
  payableCents: string;
  gstCents: string;
  tenders: Tender[];
  at: string;
}

/** The till's shift: opened on the till, or carried on from the server. */
export interface LocalShift {
  id: string;
  /** The business's shift number, once the server has it (0 until then). */
  number: number;
  registerId: string;
  registerName: string;
  openedBy: { id: string; name: string };
  openedAt: string;
  floatCents: string;
  movements: Array<{ id: string; kind: 'pay_in' | 'pay_out'; cents: string; reason: string; at: string; by: string | null }>;
  remote: RemoteSale[];
  closed: null | { by: string; at: string; countedCents: string; expectedCents: string; detail: Record<string, number> | null; note: string | null };
  /** Carried on from the server: its report when the till took it over (sales before then are in it). */
  baseline: ShiftReport | null;
}

export interface HeldSaleRecord { id: string; at: string; label: string; total: string; count: number; sale: unknown; heldBy?: string | null }

/** A person who signed in on this till online, so they can sign in without the server for a while. */
export interface RememberedPin {
  user: { id: string; name: string; role: Role };
  permissions: Permission[];
  salt: string;
  hash: string;
  iterations: number;
  savedAt: string;
}
