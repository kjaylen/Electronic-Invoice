/**
 * The QuickBooks Web Connector service (SOAP, POST /v1/qbwc).
 *
 * The Web Connector runs next to QuickBooks Desktop or QuickBooks Point of
 * Sale on the business's PC. Every few minutes it signs in here with the
 * connector's user name and password, asks what to do (sendRequestXML), runs
 * each qbXML request in QuickBooks and hands back the answer
 * (receiveResponseXML), until we say there is nothing more.
 *
 * A session goes step by step:
 *   QuickBooks Desktop: invoices changed since the last pull, then sales
 *     receipts (both in pages), the items and customers they mention (item
 *     types, customers' TIN and email), then the write-back of BTS details
 *     (the number in "Other", the details in the memo) for what was issued.
 *   QuickBooks POS: sales receipts changed since the last pull.
 * What was read waits as "staged" until the session has everything, then
 * becomes "new" for the worker to issue (src/connectors/imports.ts).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import type { Queryable } from '../db/database.ts';
import { tokenHash, verifyPassword } from '../db/users.ts';
import {
  all, customerQuery, esc, itemQuery, kid, parseXml, posReceiptQuery, qbposxml, qbxml, readCustomers, readItems, readMods, readPosReceipts, readTxns,
  txnMod, txnQuery, txt, type PosReceipt, type QbTxn,
} from './qbxml.ts';

const NS = 'http://developer.intuit.com/';
const SESSION_MS = 60 * 60_000;
const BATCH = 50;
const WRITEBACK_BATCH = 20;

/** A connection as the code reads it: its start day as text (a Postgres date otherwise arrives as a Date at local midnight). */
export const LINK_SELECT = `select id, tenant_id, kind, name, username, password_hash, owner_id, file_id, status, settings, sync_from::text as sync_from, cursor,
  company_name, last_seen_at, last_error, created_by, created_at, removed_at, config, secret_encrypted, certificate_pem, certificate_expires_at, next_poll_at from connector_links`;

export interface ConnectorLink {
  id: string;
  tenant_id: string;
  kind: 'qbd' | 'qbpos' | 'netsuite';
  name: string;
  /** The Web Connector's sign-in (QuickBooks only). */
  username: string | null;
  password_hash: string | null;
  status: 'active' | 'paused';
  settings: ConnectorSettings;
  sync_from: string;
  cursor: { invoice?: string; sales_receipt?: string; pos_receipt?: string; netsuite?: string; itemTypes?: Record<string, { name: string; type: string }> };
  /** NetSuite: the account, the integration's client ID, the certificate ID and the write-back fields. */
  config: import('./netsuite.ts').NetSuiteConfig;
  secret_encrypted: string | null;
  certificate_pem: string | null;
  certificate_expires_at: Date | null;
}
export interface ConnectorSettings {
  /** QuickBooks sales tax code → GST category. */
  taxCodes?: Record<string, 'S' | 'Z' | 'E'>;
  /** QuickBooks sales tax code → exemption reason (for exempt ones). */
  exemptions?: Record<string, string>;
  /** Which documents are picked up (sales receipts are NetSuite's cash sales). */
  pull?: { invoices?: boolean; salesReceipts?: boolean; creditMemos?: boolean };
  /** Issue even when QuickBooks charged a different tax than the GST worked out here. */
  issueOnTaxMismatch?: boolean;
}

type Step = 'invoices' | 'receipts' | 'items' | 'customers' | 'release' | 'writeback' | 'pos' | 'done';
interface SessionState {
  step: Step;
  iteratorId?: string;
  maxModified?: string;
  picked: number;
  written: number;
  pendingItems?: string[];
  pendingCustomers?: string[];
  writeback?: Array<{ importId: string; requestId: string }>;
}

// ---------- SOAP ----------

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const reply = (method: string, result: string) => envelope(`<${method}Response xmlns="${NS}"><${method}Result>${result}</${method}Result></${method}Response>`);
const strings = (values: string[]) => values.map((v) => `<string>${esc(v)}</string>`).join('');

/** Answer one Web Connector call. */
export async function handleQbwc(db: Queryable, xml: string): Promise<string> {
  let call: Element | null = null;
  try {
    const root = parseXml(xml);
    const body = all(root, 'Body')[0] ?? kid(root, 'Body');
    call = body ? (Array.from(body.childNodes).find((n) => n.nodeType === 1) as Element | undefined) ?? null : null;
  } catch {
    call = null;
  }
  if (!call) return envelope('<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Not a Web Connector call</faultstring></soap:Fault>');
  const method = call.localName ?? call.nodeName;
  const arg = (name: string) => txt(call, name) ?? '';
  switch (method) {
    case 'serverVersion':
      return reply('serverVersion', '1.0');
    case 'clientVersion':
      // Any Web Connector 2.x is fine.
      return reply('clientVersion', '');
    case 'authenticate':
      return reply('authenticate', strings(await authenticate(db, arg('strUserName'), arg('strPassword'))));
    case 'sendRequestXML':
      return reply('sendRequestXML', esc(await sendRequest(db, arg('ticket'), arg('strHCPResponse'))));
    case 'receiveResponseXML':
      return reply('receiveResponseXML', String(await receiveResponse(db, arg('ticket'), arg('response'), arg('hresult'), arg('message'))));
    case 'connectionError':
      await failSession(db, arg('ticket'), arg('message') || 'QuickBooks could not open the company file');
      return reply('connectionError', 'done');
    case 'getLastError':
      return reply('getLastError', esc(await lastError(db, arg('ticket'))));
    case 'closeConnection':
      return reply('closeConnection', esc(await closeSession(db, arg('ticket'))));
    default:
      return envelope(`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown method ${esc(method)}</faultstring></soap:Fault>`);
  }
}

// ---------- sessions ----------

async function authenticate(db: Queryable, username: string, password: string): Promise<string[]> {
  const link = (await db.query<ConnectorLink>(`${LINK_SELECT} where username = $1 and removed_at is null`, [username.trim().toLowerCase()])).rows[0];
  if (!link || link.kind === 'netsuite' || !link.password_hash || !(await verifyPassword(password, link.password_hash))) return ['', 'nvu'];
  if (link.status === 'paused') return ['', 'none'];
  const ticket = randomBytes(32).toString('base64url');
  const first: Step = link.kind === 'qbpos' ? 'pos' : link.settings.pull?.invoices === false ? 'receipts' : 'invoices';
  const state: SessionState = { step: first, picked: 0, written: 0 };
  await db.query('insert into connector_sessions (ticket_hash, link_id, state, expires_at) values ($1, $2, $3, $4)', [tokenHash(ticket), link.id, JSON.stringify(state), new Date(Date.now() + SESSION_MS).toISOString()]);
  await db.query('delete from connector_sessions where expires_at < now()');
  // Write-backs QuickBooks turned away last time (changed meanwhile) are tried again.
  await db.query("update connector_imports set writeback_error = null where link_id = $1 and writeback = 'pending'", [link.id]);
  // "" = use the company file QuickBooks has open.
  return [ticket, ''];
}

async function loadSession(db: Queryable, ticket: string): Promise<{ link: ConnectorLink; state: SessionState } | null> {
  const r = (await db.query<{ state: SessionState; link_id: string }>('select state, link_id from connector_sessions where ticket_hash = $1 and expires_at > now()', [tokenHash(ticket)])).rows[0];
  if (!r) return null;
  const link = (await db.query<ConnectorLink>(`${LINK_SELECT} where id = $1 and removed_at is null`, [r.link_id])).rows[0];
  return link ? { link, state: r.state } : null;
}
const saveState = (db: Queryable, ticket: string, state: SessionState) =>
  db.query('update connector_sessions set state = $2 where ticket_hash = $1', [tokenHash(ticket), JSON.stringify(state)]);

async function failSession(db: Queryable, ticket: string, message: string) {
  const s = await loadSession(db, ticket);
  await db.query('update connector_sessions set last_error = $2 where ticket_hash = $1', [tokenHash(ticket), message]);
  if (s) await db.query('update connector_links set last_error = $2, last_seen_at = now() where id = $1', [s.link.id, message.slice(0, 500)]);
}

async function lastError(db: Queryable, ticket: string): Promise<string> {
  return (await db.query<{ last_error: string | null }>('select last_error from connector_sessions where ticket_hash = $1', [tokenHash(ticket)])).rows[0]?.last_error ?? 'No error';
}

async function closeSession(db: Queryable, ticket: string): Promise<string> {
  const s = await loadSession(db, ticket);
  await db.query('delete from connector_sessions where ticket_hash = $1', [tokenHash(ticket)]);
  if (!s) return 'Done';
  await db.query('update connector_links set last_seen_at = now() where id = $1', [s.link.id]);
  return `Done: ${s.state.picked} document(s) picked up for BTS, ${s.state.written} updated in QuickBooks.`;
}

// ---------- the steps ----------

const STEPS: Record<ConnectorLink['kind'], Step[]> = {
  qbd: ['invoices', 'receipts', 'items', 'customers', 'release', 'writeback', 'done'],
  qbpos: ['pos', 'release', 'done'],
  netsuite: ['done'],
};
const nextStep = (link: ConnectorLink, step: Step): Step => {
  const steps = STEPS[link.kind];
  let next = steps[steps.indexOf(step) + 1] ?? 'done';
  if (next === 'receipts' && link.settings.pull?.salesReceipts === false) next = 'items';
  return next;
};
const percent = (link: ConnectorLink, step: Step) => {
  if (step === 'done') return 100;
  const steps = STEPS[link.kind];
  return Math.max(1, Math.min(99, Math.round((steps.indexOf(step) / (steps.length - 1)) * 100)));
};

async function sendRequest(db: Queryable, ticket: string, hcpResponse: string): Promise<string> {
  const s = await loadSession(db, ticket);
  if (!s) return '';
  const { link } = s;
  let { state } = s;
  // The first call carries the company's details.
  if (hcpResponse) {
    try {
      const name = txt(all(parseXml(hcpResponse), 'CompanyRet')[0], 'CompanyName');
      if (name) await db.query('update connector_links set company_name = $2 where id = $1', [link.id, name]);
    } catch {
      /* not needed */
    }
  }
  // Find the next step that has something to ask.
  for (let guard = 0; guard < 10; guard++) {
    const request = await requestFor(db, link, state);
    if (request) {
      await saveState(db, ticket, state);
      return request;
    }
    if (state.step === 'done') break;
    if (state.step === 'release') await release(db, link);
    state = { ...state, step: nextStep(link, state.step), iteratorId: undefined, maxModified: undefined };
  }
  await saveState(db, ticket, { ...state, step: 'done' });
  return '';
}

/** The request for this step, or null when the step has nothing to ask. */
async function requestFor(db: Queryable, link: ConnectorLink, state: SessionState): Promise<string | null> {
  const from = (kind: 'invoice' | 'sales_receipt' | 'pos_receipt') => link.cursor[kind] ?? `${link.sync_from}T00:00:00`;
  switch (state.step) {
    case 'invoices':
      return qbxml(txnQuery('Invoice', { from: from('invoice'), ...(state.iteratorId && { iteratorId: state.iteratorId }), max: BATCH }));
    case 'receipts':
      return qbxml(txnQuery('SalesReceipt', { from: from('sales_receipt'), ...(state.iteratorId && { iteratorId: state.iteratorId }), max: BATCH }));
    case 'pos':
      return qbposxml(posReceiptQuery({ from: from('pos_receipt'), ...(state.iteratorId && { iteratorId: state.iteratorId }), max: BATCH }));
    case 'items': {
      if (!state.pendingItems) {
        // Items the staged documents mention that we do not know yet.
        const known = link.cursor.itemTypes ?? {};
        const rows = (await db.query<{ id: string }>(
          `select distinct l->>'itemListId' as id from connector_imports i, jsonb_array_elements(i.payload->'lines') l
           where i.link_id = $1 and i.status = 'staged' and l->>'itemListId' is not null`, [link.id],
        )).rows;
        state.pendingItems = rows.map((r) => r.id).filter((id) => !known[id]);
      }
      const batch = state.pendingItems.slice(0, BATCH);
      return batch.length ? qbxml(itemQuery(batch)) : null;
    }
    case 'customers': {
      if (!state.pendingCustomers) {
        const rows = (await db.query<{ id: string }>(
          "select distinct payload->'customer'->>'listId' as id from connector_imports where link_id = $1 and status = 'staged' and payload->'customer'->>'listId' is not null", [link.id],
        )).rows;
        state.pendingCustomers = rows.map((r) => r.id);
      }
      const batch = state.pendingCustomers.slice(0, BATCH);
      return batch.length ? qbxml(customerQuery(batch)) : null;
    }
    case 'writeback': {
      const rows = (await db.query<{ id: string; source_type: 'invoice' | 'sales_receipt'; source_id: string; edit_sequence: string; payload: { memo?: string | null }; status: string; problem: string | null; doc_status: string | null; series_number: number | null; serial: string | null; etdui: string | null }>(
        `select i.id, i.source_type, i.source_id, i.edit_sequence, i.payload, i.status, i.problem, d.status as doc_status, d.series_number, d.serial::text as serial, d.etdui
         from connector_imports i left join documents d on d.id = i.document_id
         where i.link_id = $1 and i.writeback = 'pending' and i.source_type in ('invoice', 'sales_receipt') and i.edit_sequence is not null and i.writeback_error is null
         order by i.updated_at limit ${WRITEBACK_BATCH}`, [link.id],
      )).rows;
      if (!rows.length) return null;
      state.writeback = rows.map((r) => ({ importId: r.id, requestId: `wb-${r.id}` }));
      return qbxml(rows.map((r) => {
        const { memo, other } = writebackText(r);
        return txnMod(r.source_type === 'invoice' ? 'Invoice' : 'SalesReceipt', `wb-${r.id}`, r.source_id, r.edit_sequence, memo, other);
      }).join(''));
    }
    default:
      return null;
  }
}

const STATUS_WORDS: Record<string, string> = {
  authorized: 'authorized', authorized_with_alert: 'authorized', contingency_pending: 'issued offline, sending', pending: 'waiting for BTS', rejected: 'rejected', cancelled: 'cancelled',
};

/** What goes back into QuickBooks: the BTS number (printable "Other" field) and the details at the end of the memo. */
export function writebackText(r: { payload: { memo?: string | null }; status: string; problem: string | null; doc_status: string | null; series_number: number | null; serial: string | null; etdui: string | null }): { memo: string; other: string } {
  const base = (r.payload.memo ?? '').replace(/\s*\[BTS [^\]]*\]\s*$/, '').trim();
  let tag: string;
  let other: string;
  if (r.status === 'issued' && r.serial !== null && r.series_number !== null) {
    const number = `${String(r.series_number).padStart(3, '0')}-${r.serial.padStart(9, '0')}`;
    tag = `[BTS ${number} · ${STATUS_WORDS[r.doc_status ?? ''] ?? r.doc_status} · ETDUI ${r.etdui}]`;
    other = number;
  } else {
    tag = `[BTS not authorized: ${(r.problem ?? 'see Floreo').slice(0, 300)}. Fix it and save; it is sent again.]`;
    other = 'BTS: not authorized';
  }
  return { memo: [base, tag].filter(Boolean).join(' '), other };
}

/** QuickBooks Desktop documents (and POS receipts) are staged; they become "new" once the session has what they need. */
async function release(db: Queryable, link: ConnectorLink) {
  await db.query("update connector_imports set status = 'new', updated_at = now() where link_id = $1 and status = 'staged'", [link.id]);
}

async function receiveResponse(db: Queryable, ticket: string, response: string, hresult: string, message: string): Promise<number> {
  const s = await loadSession(db, ticket);
  if (!s) return -1;
  const { link, state } = s;
  if (hresult) {
    await failSession(db, ticket, `QuickBooks error ${hresult}: ${message}`);
    return -1;
  }
  try {
    switch (state.step) {
      case 'invoices':
      case 'receipts': {
        const kind = state.step === 'invoices' ? 'Invoice' : 'SalesReceipt';
        const r = readTxns(response, kind);
        if (r.status !== '0' && r.status !== '1') throw new Error(`${kind}Query: ${r.message}`);
        for (const t of r.items) {
          if (!state.maxModified || t.timeModified > state.maxModified) state.maxModified = t.timeModified;
          if (await stageQbTxn(db, link, t)) state.picked++;
        }
        if (r.iteratorId && r.remaining > 0) state.iteratorId = r.iteratorId;
        else {
          if (state.maxModified) await saveCursor(db, link, kind === 'Invoice' ? 'invoice' : 'sales_receipt', state.maxModified);
          state.step = nextStep(link, state.step);
          state.iteratorId = undefined;
          state.maxModified = undefined;
        }
        break;
      }
      case 'pos': {
        const r = readPosReceipts(response);
        if (r.status !== '0' && r.status !== '1') throw new Error(`SalesReceiptQuery: ${r.message}`);
        for (const p of r.items) {
          if (!state.maxModified || p.timeModified > state.maxModified) state.maxModified = p.timeModified;
          if (await stagePosReceipt(db, link, p)) state.picked++;
        }
        if (r.iteratorId && r.remaining > 0) state.iteratorId = r.iteratorId;
        else {
          if (state.maxModified) await saveCursor(db, link, 'pos_receipt', state.maxModified);
          state.step = nextStep(link, state.step);
          state.iteratorId = undefined;
          state.maxModified = undefined;
        }
        break;
      }
      case 'items': {
        const r = readItems(response);
        const types = { ...(link.cursor.itemTypes ?? {}) };
        for (const it of r.items) types[it.listId] = { name: it.name, type: it.type };
        // Asked for but not returned (deleted): remembered as "other" so we do not ask again.
        for (const id of (state.pendingItems ?? []).slice(0, BATCH)) types[id] ??= { name: '', type: 'other' };
        await db.query("update connector_links set cursor = jsonb_set(cursor, '{itemTypes}', $2::jsonb) where id = $1", [link.id, JSON.stringify(types)]);
        state.pendingItems = (state.pendingItems ?? []).slice(BATCH);
        if (!state.pendingItems.length) state.step = nextStep(link, state.step);
        break;
      }
      case 'customers': {
        const r = readCustomers(response);
        for (const c of r.items) {
          await db.query(
            `update connector_imports set payload = jsonb_set(payload, '{customer}', (payload->'customer') || $3::jsonb) where link_id = $1 and status = 'staged' and payload->'customer'->>'listId' = $2`,
            [link.id, c.listId, JSON.stringify({ name: c.name, companyName: c.companyName, email: c.email, phone: c.phone, tin: customerTin(c), address: c.billAddress })],
          );
        }
        state.pendingCustomers = (state.pendingCustomers ?? []).slice(BATCH);
        if (!state.pendingCustomers.length) state.step = nextStep(link, state.step);
        break;
      }
      case 'writeback': {
        const results = new Map(readMods(response).map((m) => [m.requestId, m]));
        for (const w of state.writeback ?? []) {
          const m = results.get(w.requestId);
          if (m && m.status === '0') {
            await db.query(
              `update connector_imports i set writeback = 'done', writeback_error = null, edit_sequence = coalesce($2, i.edit_sequence),
                 written_status = (select d.status from documents d where d.id = i.document_id), updated_at = now() where i.id = $1`,
              [w.importId, m.editSequence],
            );
            state.written++;
          } else if (m?.status === '3200') {
            // Changed in QuickBooks meanwhile: the next pull brings the new version; written then.
            await db.query("update connector_imports set writeback_error = 'Changed in QuickBooks since it was read; written next time' where id = $1", [w.importId]);
          } else {
            await db.query("update connector_imports set writeback = 'failed', writeback_error = $2, updated_at = now() where id = $1", [w.importId, m ? `QuickBooks: ${m.message}` : 'QuickBooks did not answer this update']);
          }
        }
        state.writeback = undefined;
        // More to write? Stay on this step.
        const more = (await db.query("select 1 from connector_imports where link_id = $1 and writeback = 'pending' and edit_sequence is not null and writeback_error is null limit 1", [link.id])).rows.length;
        if (!more) state.step = nextStep(link, state.step);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    await failSession(db, ticket, (e as Error).message);
    return -1;
  }
  await saveState(db, ticket, state);
  await db.query('update connector_links set last_error = null where id = $1', [link.id]);
  return percent(link, state.step);
}

async function saveCursor(db: Queryable, link: ConnectorLink, kind: 'invoice' | 'sales_receipt' | 'pos_receipt', value: string) {
  await db.query(`update connector_links set cursor = jsonb_set(cursor, '{${kind}}', to_jsonb($2::text)) where id = $1`, [link.id, value]);
}

/** A customer's TIN: a custom field called TIN (or Tax ID), else a six-digit resale number. */
export function customerTin(c: { custom: Record<string, string>; resaleNumber: string | null; accountNumber: string | null }): string | null {
  const named = Object.entries(c.custom).find(([k]) => /^(bts\s*)?(tin|tax\s*id)$/i.test(k.trim()))?.[1];
  for (const v of [named, c.resaleNumber]) {
    const digits = v?.replace(/\D/g, '');
    if (digits && /^\d{6}$/.test(digits)) return digits;
  }
  return null;
}

const cents = (v: string | null | undefined) => (v ? Math.round(Number(v) * 100) : null);

interface Existing { id: string; status: string; edit_sequence: string | null; document_id: string | null }

/** Keep a QuickBooks Desktop document for issuing (or note a change to one already issued). True when it is new work. */
async function stageQbTxn(db: Queryable, link: ConnectorLink, t: QbTxn): Promise<boolean> {
  if (!t.txnId || t.txnDate < link.sync_from || t.isPending) return false;
  const existing = (await db.query<Existing>('select id, status, edit_sequence, document_id from connector_imports where link_id = $1 and source_type = $2 and source_id = $3', [link.id, t.kind, t.txnId])).rows[0];
  const payload = { ...t };
  if (!existing) {
    await db.query(
      `insert into connector_imports (id, tenant_id, link_id, source_type, source_id, source_ref, edit_sequence, source_date, customer_name, total_cents, payload, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'staged')`,
      [randomUUID(), link.tenant_id, link.id, t.kind, t.txnId, t.refNumber, t.editSequence, t.txnDate, t.customer.name, cents(t.subtotal), JSON.stringify(payload)],
    );
    return true;
  }
  if (existing.edit_sequence === t.editSequence) return false; // Unchanged (or our own write-back).
  if (existing.status === 'issued' || existing.status === 'issuing') {
    // An authorized document cannot change: say so, keep what was issued.
    await db.query(
      "update connector_imports set edit_sequence = $2, payload = jsonb_set(payload, '{memo}', to_jsonb($3::text)), problem = $4, updated_at = now() where id = $1",
      [existing.id, t.editSequence, t.memo ?? '', 'Changed in QuickBooks after it was sent to BTS. An authorized document cannot change: if the amounts changed, issue a credit note or debit note here.'],
    );
    return false;
  }
  if (existing.status === 'skipped') {
    await db.query('update connector_imports set edit_sequence = $2, updated_at = now() where id = $1', [existing.id, t.editSequence]);
    return false;
  }
  // Not issued yet (new, rejected, needing attention): the corrected version replaces it.
  await db.query(
    `update connector_imports set edit_sequence = $2, payload = $3, source_ref = $4, source_date = $5, customer_name = $6, total_cents = $7, status = 'staged',
       problem = null, document_id = null, writeback = 'none', writeback_error = null, attempts = 0, updated_at = now() where id = $1`,
    [existing.id, t.editSequence, JSON.stringify(payload), t.refNumber, t.txnDate, t.customer.name, cents(t.subtotal)],
  );
  return true;
}

async function stagePosReceipt(db: Queryable, link: ConnectorLink, p: PosReceipt): Promise<boolean> {
  if (!p.txnId || (p.txnDate && p.txnDate < link.sync_from)) return false;
  const existing = (await db.query<Existing>("select id, status, edit_sequence, document_id from connector_imports where link_id = $1 and source_type = 'pos_receipt' and source_id = $2", [link.id, p.txnId])).rows[0];
  if (existing) return false; // POS receipts do not change once rung up.
  await db.query(
    `insert into connector_imports (id, tenant_id, link_id, source_type, source_id, source_ref, edit_sequence, source_date, customer_name, total_cents, payload, status)
     values ($1, $2, $3, 'pos_receipt', $4, $5, null, $6, null, $7, $8, 'staged')`,
    [randomUUID(), link.tenant_id, link.id, p.txnId, p.number, p.txnDate || null, cents(p.total), JSON.stringify(p)],
  );
  return true;
}

/** The .qwc file the business opens in the Web Connector (Add an application). */
export function qwcFile(link: { name: string; username: string; owner_id: string; file_id: string; kind: 'qbd' | 'qbpos' }, appUrl: string, businessName: string): string {
  return `<?xml version="1.0"?>
<QBWCXML>
  <AppName>${esc(`Floreo BTS - ${businessName} (${link.name})`.slice(0, 120))}</AppName>
  <AppID></AppID>
  <AppURL>${esc(appUrl)}</AppURL>
  <AppDescription>Sends your QuickBooks ${link.kind === 'qbpos' ? 'Point of Sale receipts' : 'invoices and sales receipts'} to the Belize Tax Service through Floreo${link.kind === 'qbd' ? ', and writes the BTS number back' : ''}.</AppDescription>
  <AppSupport>${esc(new URL('/docs', appUrl).toString())}</AppSupport>
  <UserName>${esc(link.username)}</UserName>
  <OwnerID>{${link.owner_id}}</OwnerID>
  <FileID>{${link.file_id}}</FileID>
  <QBType>${link.kind === 'qbpos' ? 'QBPOS' : 'QBFS'}</QBType>
  <Scheduler>
    <RunEveryNMinutes>5</RunEveryNMinutes>
  </Scheduler>
  <IsReadOnly>false</IsReadOnly>
</QBWCXML>
`;
}
