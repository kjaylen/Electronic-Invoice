/**
 * A check: one party's order at a table, a bar tab, or a quick sale. It is
 * the fold of its operations. This file is pure and is run unchanged by the
 * server and by every device, so a device with no connection keeps working
 * and reaches the same result once its operations arrive.
 *
 * The rule for two people on one check:
 *   - every item has its own id, made by the device that added it, so two
 *     people adding at once both keep their items;
 *   - every operation names the items it is about, and an operation applied
 *     twice (the same id) does nothing the second time;
 *   - an item goes to the kitchen once: the first `fire` that reaches it sends
 *     it, and any later one skips it. `apply` says which items an operation
 *     really sent, and tickets are printed from that answer only;
 *   - an operation that no longer makes sense (voiding what is already paid,
 *     editing what was sent) is refused with a reason and changes nothing.
 */

export type ItemStatus = 'held' | 'sent' | 'ready' | 'served' | 'void';
export const COURSES = ['Drinks', 'Starters', 'Mains', 'Desserts'] as const;

export interface Who { id: string; name: string }

export interface CheckModifier { groupId: string; optionId: string; name: string; priceCents: number; itemId?: string | null }

export interface CheckItem {
  id: string;
  itemId: string | null;
  name: string;
  category: string | null;
  unitCode: string;
  gst: 'S' | 'Z' | 'E';
  exemptionReasonCode?: string;
  /** One unit before modifiers, as priced when it was ordered. */
  unitCents: number;
  /** A happy-hour or other price that applied when it was ordered. */
  promo?: string;
  /** Whole-bill promotions it counts towards (pricing.ts). */
  tags: string[];
  quantity: number;
  modifiers: CheckModifier[];
  note?: string;
  /** Allergens and dietary tags of the item, for the server and the ticket. */
  allergens: string[];
  /** 0 is the table (shared); 1.. are the guests. */
  seat: number;
  /** 0 drinks, 1 starters, 2 mains, 3 desserts. */
  course: number;
  stationIds: string[];
  status: ItemStatus;
  addedBy: Who;
  addedAt: string;
  sentAt?: string;
  readyAt?: string;
  servedAt?: string;
  voided?: { at: string; by: Who; reason: string; approvedBy?: Who; afterSend: boolean };
  comp?: { at: string; by: Who; reason: string; approvedBy?: Who };
  /** A discount on this item: percent (0 to 100) or cents off the line. */
  discount?: { percent?: number; cents?: number; reason: string; by: Who; approvedBy?: Who };
  /** A price typed over the menu's. */
  priceOverride?: { fromCents: number; reason: string; by: Who; approvedBy?: Who };
  /** Shared between this many guests when the bill is split (1: not shared). */
  shares: number;
  /** Shares already paid, each with the receipt it went on. */
  paid: Array<{ shares: number; documentId: string; at: string; grossCents?: number; allowCents?: number; serviceCents?: number }>;
}

export interface CheckEvent { at: string; by: Who; type: string; note?: string; itemIds?: string[]; approvedBy?: Who }

export interface Check {
  id: string;
  kind: 'table' | 'tab' | 'quick';
  status: 'open' | 'paid' | 'closed' | 'merged';
  /** Where it is: a table of the floor plan, or nothing for a tab. */
  tableId: string | null;
  tableName: string | null;
  /** A tab's name ("Maria", "Bar 3"), or the party's. */
  name: string | null;
  /** A hotel room the tab runs on. */
  room: string | null;
  partySize: number;
  server: Who;
  openedAt: string;
  openedBy: Who;
  lastActivityAt: string;
  businessDate: string;
  guestId: string | null;
  reservationId: string | null;
  /** An allergy the guest told the server about: on every ticket. */
  allergy: string | null;
  /** Courses that wait for the server's word. */
  heldCourses: number[];
  /** null: the venue's rule decides; true or false: someone decided for this check. */
  serviceCharge: boolean | null;
  billRequestedAt: string | null;
  items: CheckItem[];
  events: CheckEvent[];
  /** Tips taken with this check's payments, in cents, by who served. */
  tips: Array<{ cents: number; means: string; documentId: string; server: Who }>;
  /** Operations already folded in (the last few hundred): the same one twice changes nothing. */
  applied: string[];
  /** Counts up with every operation that changed it. */
  version: number;
}

export type OpType =
  | 'open' | 'add' | 'edit' | 'remove' | 'fire' | 'holdCourse' | 'void' | 'comp' | 'discount' | 'price' | 'ready' | 'served'
  | 'move' | 'transfer' | 'moveItems' | 'merge' | 'party' | 'service' | 'share' | 'requestBill' | 'pay' | 'clean' | 'close' | 'reopen' | 'allergy';

export interface Op {
  id: string;
  checkId: string;
  type: OpType;
  at: string;
  by: Who;
  payload: Record<string, unknown>;
}

export interface Store { get(id: string): Check | undefined; put(check: Check): void }

export interface Applied {
  ok: boolean;
  /** Why not, in words for the person who tried. */
  reason?: string;
  /** The same operation had already been applied. */
  duplicate?: boolean;
  /** Items this operation sent to the kitchen (print these, and only these). */
  sent: string[];
  /** Items this operation took back after they were sent (a follow-up ticket). */
  voided: string[];
  /** Checks it changed. */
  touched: string[];
}

const no = (reason: string): Applied => ({ ok: false, reason, sent: [], voided: [], touched: [] });
const live = (i: CheckItem) => i.status !== 'void';
export const paidShares = (i: CheckItem) => i.paid.reduce((a, p) => a + p.shares, 0);
export const fullyPaid = (i: CheckItem) => paidShares(i) >= i.shares;
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const who = (v: unknown): Who | undefined => (v && typeof v === 'object' && typeof (v as Who).id === 'string' ? { id: (v as Who).id, name: str((v as Who).name, 80) } : undefined);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What has to be decided by a supervisor (the server checks the approver's rights). */
export function needsApproval(check: Check, op: Op, discountLimitPercent: number): boolean {
  const chosen = ids(op.payload.itemIds);
  if (op.type === 'void') return check.items.some((i) => chosen.includes(i.id) && i.status !== 'held' && i.status !== 'void');
  if (op.type === 'comp' || op.type === 'reopen') return true;
  if (op.type === 'price') return true;
  if (op.type === 'discount') {
    const percent = Number(op.payload.percent ?? 0);
    if (percent > discountLimitPercent) return true;
    const cents = Number(op.payload.cents ?? 0);
    if (!cents) return false;
    const base = check.items.filter((i) => chosen.includes(i.id)).reduce((a, i) => a + lineCents(i), 0);
    return base > 0 && cents * 100 > base * discountLimitPercent;
  }
  if (op.type === 'service') return op.payload.on === false;
  return false;
}

/** One unit with its modifiers. */
export const unitWithModifiers = (i: CheckItem) => i.unitCents + i.modifiers.reduce((a, m) => a + m.priceCents, 0);
/** The line before any discount. */
export const lineCents = (i: CheckItem) => unitWithModifiers(i) * i.quantity;

function newItem(raw: Record<string, unknown>, op: Op): CheckItem | null {
  const id = str(raw.id, 60);
  const name = str(raw.name, 120);
  const quantity = Number(raw.quantity ?? 1);
  const unitCents = Number(raw.unitCents);
  if (!id || !name || !Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isInteger(unitCents) || unitCents < 0) return null;
  const modifiers = (Array.isArray(raw.modifiers) ? raw.modifiers : []).flatMap((m: Record<string, unknown>) => {
    const price = Number(m?.priceCents ?? 0);
    return m && str(m.name, 80) && Number.isInteger(price) ? [{ groupId: str(m.groupId, 60), optionId: str(m.optionId, 60), name: str(m.name, 80), priceCents: price, ...(typeof m.itemId === 'string' && { itemId: m.itemId }) }] : [];
  });
  const seat = Number(raw.seat ?? 0);
  const course = Number(raw.course ?? 2);
  return {
    id, name, quantity, unitCents, modifiers,
    itemId: typeof raw.itemId === 'string' ? raw.itemId : null,
    category: str(raw.category, 80) || null,
    unitCode: str(raw.unitCode, 8) || 'H87',
    gst: raw.gst === 'Z' || raw.gst === 'E' ? raw.gst : 'S',
    ...(str(raw.exemptionReasonCode, 20) && { exemptionReasonCode: str(raw.exemptionReasonCode, 20) }),
    ...(str(raw.promo, 60) && { promo: str(raw.promo, 60) }),
    tags: ids(raw.tags).slice(0, 8),
    ...(str(raw.note, 200) && { note: str(raw.note, 200) }),
    allergens: ids(raw.allergens).slice(0, 20),
    seat: Number.isInteger(seat) && seat >= 0 && seat <= 99 ? seat : 0,
    course: Number.isInteger(course) && course >= 0 && course <= 3 ? course : 2,
    stationIds: ids(raw.stationIds).slice(0, 6),
    status: 'held', addedBy: op.by, addedAt: op.at, shares: 1, paid: [],
  };
}

function settle(check: Check, at: string) {
  // Everything that is not void is paid: the party is done (a table then waits to be cleaned).
  const open = check.items.filter(live);
  if (check.status === 'open' && open.length > 0 && open.every(fullyPaid)) {
    check.status = check.kind === 'table' ? 'paid' : 'closed';
    check.events.push({ at, by: { id: '', name: '' }, type: 'paid' });
  }
}

/**
 * Fold one operation into the store. Never throws: an operation that cannot
 * be applied is answered with `ok: false` and a reason, and nothing changes.
 */
export function apply(store: Store, op: Op): Applied {
  const p = op.payload ?? {};
  if (op.type === 'open') {
    const existing = store.get(op.checkId);
    if (existing) return { ok: true, duplicate: true, sent: [], voided: [], touched: [] };
    const kind = p.kind === 'tab' || p.kind === 'quick' ? p.kind : 'table';
    const partySize = Number(p.partySize ?? 1);
    const check: Check = {
      id: op.checkId, kind, status: 'open',
      tableId: kind === 'table' ? str(p.tableId, 60) || null : null,
      tableName: kind === 'table' ? str(p.tableName, 40) || null : null,
      name: str(p.name, 60) || null, room: str(p.room, 20) || null,
      partySize: Number.isInteger(partySize) && partySize >= 1 && partySize <= 200 ? partySize : 1,
      server: who(p.server) ?? op.by, openedAt: op.at, openedBy: op.by, lastActivityAt: op.at,
      businessDate: str(p.businessDate, 10), guestId: str(p.guestId, 60) || null, reservationId: str(p.reservationId, 60) || null,
      allergy: str(p.allergy, 200) || null, heldCourses: [], serviceCharge: null, billRequestedAt: null,
      items: [], events: [{ at: op.at, by: op.by, type: 'opened' }], tips: [], applied: [op.id], version: 1,
    };
    if (kind === 'table' && !check.tableId) return no('Choose a table');
    store.put(check);
    return { ok: true, sent: [], voided: [], touched: [check.id] };
  }

  const before = store.get(op.checkId);
  if (!before) return no('That check is not open on this device yet');
  if (before.applied.includes(op.id)) return { ok: true, duplicate: true, sent: [], voided: [], touched: [] };
  // Work on a copy: a refused operation leaves nothing behind.
  const check: Check = JSON.parse(JSON.stringify(before));
  const chosen = ids(p.itemIds);
  const picked = () => check.items.filter((i) => chosen.includes(i.id));
  const approvedBy = who(p.approvedBy);
  const reason = str(p.reason, 200);
  const log = (type: string, extra: Partial<CheckEvent> = {}) => check.events.push({ at: op.at, by: op.by, type, ...(reason && { note: reason }), ...(approvedBy && { approvedBy }), ...extra });
  const result: Applied = { ok: true, sent: [], voided: [], touched: [check.id] };
  const closed = check.status === 'closed' || check.status === 'merged';
  if (closed && op.type !== 'reopen') return no(check.status === 'merged' ? 'This check was merged into another' : 'This check is closed');

  switch (op.type) {
    case 'add': {
      const added = (Array.isArray(p.items) ? p.items : []).map((raw) => newItem(raw as Record<string, unknown>, op)).filter((i): i is CheckItem => i !== null);
      if (!added.length) return no('Nothing to add');
      if (check.status === 'paid') check.status = 'open';
      for (const item of added) if (!check.items.some((i) => i.id === item.id)) check.items.push(item);
      break;
    }
    case 'edit': {
      const item = check.items.find((i) => i.id === str(p.itemId, 60));
      if (!item) return no('That item is no longer on the check');
      // Seat and course can change any time (who gets it, when it goes); what it is, only before it is sent.
      const what = p.quantity !== undefined || p.modifiers !== undefined || p.note !== undefined;
      if (what && item.status !== 'held') return no(`${item.name} was already sent: void it and order again`);
      if (p.quantity !== undefined) {
        const q = Number(p.quantity);
        if (!Number.isInteger(q) || q < 1 || q > 999) return no('A quantity from 1 up');
        item.quantity = q;
      }
      if (Array.isArray(p.modifiers)) {
        const again = newItem({ ...item, modifiers: p.modifiers }, op);
        if (again) item.modifiers = again.modifiers;
      }
      if (p.note !== undefined) { if (str(p.note, 200)) item.note = str(p.note, 200); else delete item.note; }
      if (p.seat !== undefined && Number.isInteger(Number(p.seat))) item.seat = Math.max(0, Math.min(99, Number(p.seat)));
      if (p.course !== undefined && [0, 1, 2, 3].includes(Number(p.course)) && item.status === 'held') item.course = Number(p.course);
      break;
    }
    case 'remove': {
      // Before it is sent an item just comes off; nobody has made anything.
      const gone = picked().filter((i) => i.status === 'held');
      if (!gone.length) return no('Only items not yet sent can be removed; void the others');
      check.items = check.items.filter((i) => !gone.includes(i));
      log('removed', { itemIds: gone.map((i) => i.id), note: gone.map((i) => `${i.quantity} x ${i.name}`).join(', ') });
      break;
    }
    case 'fire': {
      // Named items, or a course, or everything that is not on hold.
      const course = p.course === undefined ? null : Number(p.course);
      const going = check.items.filter((i) => i.status === 'held' && (chosen.length ? chosen.includes(i.id) : course !== null ? i.course === course : !check.heldCourses.includes(i.course)));
      for (const i of going) {
        i.status = 'sent';
        i.sentAt = op.at;
        result.sent.push(i.id);
      }
      if (course !== null) check.heldCourses = check.heldCourses.filter((c) => c !== course);
      // Nothing left to send is not an error: someone else got there first.
      if (going.length) log('sent', { itemIds: result.sent });
      break;
    }
    case 'holdCourse': {
      const course = Number(p.course);
      if (![0, 1, 2, 3].includes(course)) return no('No such course');
      check.heldCourses = p.hold === false ? check.heldCourses.filter((c) => c !== course) : [...new Set([...check.heldCourses, course])];
      break;
    }
    case 'void': {
      const items = picked().filter(live);
      if (!items.length) return no('Nothing to void');
      if (items.some((i) => paidShares(i) > 0)) return no('That is already paid for: refund it from the receipt instead');
      if (!reason && items.some((i) => i.status !== 'held')) return no('Say why it is voided');
      for (const i of items) {
        const afterSend = i.status !== 'held';
        if (afterSend) result.voided.push(i.id);
        i.status = 'void';
        i.voided = { at: op.at, by: op.by, reason: reason || 'Not sent', afterSend, ...(approvedBy && { approvedBy }) };
      }
      log('voided', { itemIds: items.map((i) => i.id) });
      break;
    }
    case 'comp': {
      const items = picked().filter(live);
      if (!items.length) return no('Nothing to comp');
      if (!reason) return no('Say why it is on the house');
      if (items.some((i) => paidShares(i) > 0)) return no('That is already paid for');
      for (const i of items) {
        if (p.undo === true) delete i.comp;
        else i.comp = { at: op.at, by: op.by, reason, ...(approvedBy && { approvedBy }) };
      }
      log(p.undo === true ? 'comp removed' : 'comped', { itemIds: items.map((i) => i.id) });
      break;
    }
    case 'discount': {
      const items = (chosen.length ? picked() : check.items).filter((i) => live(i) && paidShares(i) === 0);
      if (!items.length) return no('Nothing to discount');
      const percent = Number(p.percent ?? 0);
      const cents = Number(p.cents ?? 0);
      if (percent === 0 && cents === 0) { for (const i of items) delete i.discount; log('discount removed', { itemIds: items.map((i) => i.id) }); break; }
      if (!reason) return no('Say why the discount is given');
      if (percent && (percent < 0 || percent > 100)) return no('A percentage from 1 to 100');
      if (cents && (!Number.isInteger(cents) || cents < 0)) return no('An amount in cents');
      // An amount is spread over the items by value, the last taking the odd cents.
      const base = items.reduce((a, i) => a + lineCents(i), 0);
      if (cents > base) return no('More than the items cost');
      let left = cents;
      items.forEach((i, n) => {
        const share = cents ? (n === items.length - 1 ? left : Math.floor((cents * lineCents(i)) / base)) : 0;
        left -= share;
        i.discount = { ...(percent ? { percent } : { cents: share }), reason, by: op.by, ...(approvedBy && { approvedBy }) };
      });
      log('discounted', { itemIds: items.map((i) => i.id), note: `${percent ? `${percent}%` : `${(cents / 100).toFixed(2)}`}: ${reason}` });
      break;
    }
    case 'price': {
      const item = check.items.find((i) => i.id === str(p.itemId, 60));
      const cents = Number(p.unitCents);
      if (!item || !live(item)) return no('That item is no longer on the check');
      if (!Number.isInteger(cents) || cents < 0) return no('A price in cents');
      if (!reason) return no('Say why the price is changed');
      if (paidShares(item) > 0) return no('That is already paid for');
      item.priceOverride = { fromCents: item.priceOverride?.fromCents ?? item.unitCents, reason, by: op.by, ...(approvedBy && { approvedBy }) };
      item.unitCents = cents;
      delete item.promo;
      item.tags = [];
      log('price changed', { itemIds: [item.id], note: `${item.name}: ${reason}` });
      break;
    }
    case 'ready': {
      for (const i of picked()) if (i.status === 'sent') { i.status = 'ready'; i.readyAt = op.at; }
      break;
    }
    case 'served': {
      const course = p.course === undefined ? null : Number(p.course);
      for (const i of check.items) {
        if ((i.status === 'sent' || i.status === 'ready') && (chosen.length ? chosen.includes(i.id) : course === null || i.course === course)) { i.status = 'served'; i.servedAt = op.at; }
      }
      break;
    }
    case 'move': {
      const tableId = str(p.tableId, 60);
      if (!tableId) return no('Choose a table');
      log('moved', { note: `${check.tableName ?? check.name ?? 'Tab'} to ${str(p.tableName, 40)}` });
      check.kind = 'table';
      check.tableId = tableId;
      check.tableName = str(p.tableName, 40) || null;
      break;
    }
    case 'transfer': {
      const to = who(p.server);
      if (!to) return no('Choose who takes it');
      log('transferred', { note: `${check.server.name} to ${to.name}` });
      check.server = to;
      break;
    }
    case 'moveItems':
    case 'merge': {
      const target = store.get(str(p.toCheckId, 60));
      if (!target || target.id === check.id) return no('Choose another open check');
      if (target.status === 'closed' || target.status === 'merged') return no('That check is closed');
      const moving = op.type === 'merge' ? check.items : picked();
      if (op.type === 'moveItems' && !moving.length) return no('Choose the items to move');
      if (moving.some((i) => live(i) && paidShares(i) > 0 && !fullyPaid(i))) return no('An item is part paid: finish its payment first');
      const dest: Check = JSON.parse(JSON.stringify(target));
      const label = (c: Check) => c.tableName ?? c.name ?? 'a tab';
      for (const i of moving) dest.items.push(i);
      check.items = check.items.filter((i) => !moving.includes(i));
      if (dest.status === 'paid' && moving.some((i) => live(i) && !fullyPaid(i))) dest.status = 'open';
      dest.events.push({ at: op.at, by: op.by, type: op.type === 'merge' ? 'merged in' : 'items in', note: `from ${label(check)}`, itemIds: moving.map((i) => i.id) });
      if (op.type === 'merge') {
        dest.partySize += check.partySize;
        dest.tips.push(...check.tips);
        check.tips = [];
        check.status = 'merged';
        log('merged', { note: `into ${label(dest)}` });
      } else log('items out', { note: `to ${label(dest)}`, itemIds: moving.map((i) => i.id) });
      dest.lastActivityAt = op.at;
      dest.version += 1;
      // The destination remembers the operation too: applied again from there, it does nothing.
      dest.applied = [...dest.applied, op.id].slice(-400);
      store.put(dest);
      result.touched.push(dest.id);
      break;
    }
    case 'party': {
      const size = Number(p.partySize);
      if (!Number.isInteger(size) || size < 1 || size > 200) return no('How many guests?');
      check.partySize = size;
      if (p.name !== undefined) check.name = str(p.name, 60) || null;
      if (p.guestId !== undefined) check.guestId = str(p.guestId, 60) || null;
      break;
    }
    case 'allergy': {
      check.allergy = str(p.allergy, 200) || null;
      log('allergy', { note: check.allergy ?? 'cleared' });
      break;
    }
    case 'service': {
      check.serviceCharge = p.on === null ? null : p.on === true;
      log(p.on === false ? 'service charge removed' : 'service charge set');
      break;
    }
    case 'share': {
      const ways = Number(p.ways);
      if (!Number.isInteger(ways) || ways < 1 || ways > 20) return no('Shared between 1 and 20 guests');
      const items = picked().filter(live);
      if (items.some((i) => paidShares(i) > 0)) return no('That item is already part paid');
      for (const i of items) i.shares = ways;
      break;
    }
    case 'requestBill': {
      check.billRequestedAt = p.cancel === true ? null : op.at;
      break;
    }
    case 'pay': {
      // Shares of items that went on a receipt: [{ itemId, shares }].
      const documentId = str(p.documentId, 60);
      if (!documentId) return no('A payment needs its receipt');
      const parts = (Array.isArray(p.items) ? p.items : []) as Array<{ itemId?: string; shares?: number; grossCents?: number; allowCents?: number; serviceCents?: number }>;
      for (const part of parts) {
        const item = check.items.find((i) => i.id === part.itemId);
        const shares = Number(part.shares ?? 0);
        if (!item || !live(item) || !Number.isInteger(shares) || shares < 1) continue;
        // Never more than is left: a payment that arrives twice by two routes counts once.
        const left = item.shares - paidShares(item);
        const cents = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
        if (left > 0 && !item.paid.some((x) => x.documentId === documentId)) {
          item.paid.push({ shares: Math.min(shares, left), documentId, at: op.at, ...(cents(part.grossCents) !== undefined && { grossCents: cents(part.grossCents), allowCents: cents(part.allowCents) ?? 0, serviceCents: cents(part.serviceCents) ?? 0 }) });
        }
      }
      const tip = Number(p.tipCents ?? 0);
      if (Number.isInteger(tip) && tip > 0 && !check.tips.some((t) => t.documentId === documentId)) check.tips.push({ cents: tip, means: str(p.tipMeans, 4) || '48', documentId, server: check.server });
      log('paid', { note: str(p.summary, 120), itemIds: parts.map((x) => String(x.itemId)) });
      settle(check, op.at);
      break;
    }
    case 'clean': {
      if (check.status !== 'paid') return no('The table still has an open bill');
      check.status = 'closed';
      break;
    }
    case 'close': {
      // Nothing left to pay (everything void, or nothing ordered): the table is given up.
      if (check.items.some((i) => live(i) && !fullyPaid(i) && !i.comp)) return no('There are items still to pay');
      if (check.items.some((i) => live(i) && i.comp && !fullyPaid(i))) log('closed with comps', { itemIds: check.items.filter((i) => live(i) && i.comp).map((i) => i.id) });
      check.status = 'closed';
      log('closed');
      break;
    }
    case 'reopen': {
      if (!reason) return no('Say why the bill is reopened');
      check.status = 'open';
      check.billRequestedAt = null;
      log('reopened');
      break;
    }
    default:
      return no('Unknown operation');
  }
  check.lastActivityAt = op.at;
  check.version += 1;
  check.applied = [...check.applied, op.id].slice(-400);
  store.put(check);
  return result;
}

// ---------- what the floor shows ----------

export type TableState = 'free' | 'reserved' | 'seated' | 'ordered' | 'sent' | 'mains' | 'bill' | 'paid';

/** A table's state from its check: the furthest stage reached. */
export function tableState(check: Check | undefined): TableState {
  if (!check || check.status === 'closed' || check.status === 'merged') return 'free';
  if (check.status === 'paid') return 'paid';
  if (check.billRequestedAt) return 'bill';
  const items = check.items.filter(live);
  if (!items.length) return 'seated';
  if (items.some((i) => i.course === 2 && i.status === 'served')) return 'mains';
  if (items.some((i) => i.status !== 'held')) return 'sent';
  return 'ordered';
}

/** Something from the kitchen is waiting to be carried out. */
export const hasReady = (check: Check) => check.items.some((i) => i.status === 'ready');

/** A store in memory, for a device and for tests. */
export function memoryStore(initial: Check[] = []): Store & { all(): Check[] } {
  const map = new Map(initial.map((c) => [c.id, c]));
  return { get: (id) => map.get(id), put: (c) => void map.set(c.id, c), all: () => [...map.values()] };
}
