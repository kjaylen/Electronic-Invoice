/**
 * Deliverability: whether the domain email is sent from says, in DNS, that
 * this mail is really its own. Three TXT records decide whether a message
 * lands in the inbox or in spam:
 *
 *   SPF    at the domain itself: which servers may send for it
 *   DKIM   at <selector>._domainkey.<domain>: the key the sending server signs with
 *   DMARC  at _dmarc.<domain>: what a receiver should do when the two above fail
 *
 * The check reads them and says, in plain words, what is there and what to add.
 */

import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import { MAIL_PRESETS, type MailPreset } from './settings.ts';

export type ResolveTxt = (name: string) => Promise<string[][]>;

export interface DnsCheck {
  record: 'spf' | 'dkim' | 'dmarc';
  /** ok: in place. warning: there, but something to fix. missing: add it. unknown: could not tell. */
  status: 'ok' | 'warning' | 'missing' | 'unknown';
  /** The DNS name looked at. */
  name: string;
  /** What is there now. */
  found: string | null;
  /** What it means, and what to do. */
  message: string;
  /** A record to add, when one can be suggested. */
  suggestion: string | null;
}

/** The provider a mail server belongs to, from its name. */
export function presetForHost(host: string): MailPreset | null {
  const h = host.toLowerCase();
  if (/(^|\.)(gmail|googlemail|google)\.com$/.test(h)) return MAIL_PRESETS.find((p) => p.key === 'google') ?? null;
  if (/(^|\.)(office365|outlook|office)\.com$/.test(h)) return MAIL_PRESETS.find((p) => p.key === 'microsoft') ?? null;
  if (/(^|\.)zoho\.(com|eu|in|com\.au)$/.test(h)) return MAIL_PRESETS.find((p) => p.key === 'zoho') ?? null;
  if (/(^|\.)amazonaws\.com$/.test(h)) return MAIL_PRESETS.find((p) => p.key === 'ses') ?? null;
  return null;
}

const COMMON_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'zmail', 'zoho', 'k1', 'k2', 's1', 's2', 'mail', 'dkim', 'smtp', 'mta', 'key1'];

async function txt(resolve: ResolveTxt, name: string): Promise<{ records: string[]; failed: boolean }> {
  try {
    return { records: (await resolve(name)).map((chunks) => chunks.join('')), failed: false };
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    // No such name, or no TXT there: an answer. Anything else (a time-out, a broken resolver): no answer.
    return { records: [], failed: !['ENOTFOUND', 'ENODATA', 'ENXDOMAIN', 'NXDOMAIN'].includes(code) };
  }
}

export async function checkDeliverability(
  domain: string,
  options: { resolveTxt?: ResolveTxt; host?: string | null; selector?: string | null } = {},
): Promise<{ domain: string; provider: string | null; checks: DnsCheck[] }> {
  const resolve = options.resolveTxt ?? dnsResolveTxt;
  const preset = options.host ? presetForHost(options.host) : null;
  const d = domain.toLowerCase();
  const later = 'The domain’s records could not be read just now. Try again in a minute.';

  // SPF
  const spfLookup = await txt(resolve, d);
  const spfRecords = spfLookup.records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  const include = preset?.spfInclude ?? null;
  const spfSuggestion = `v=spf1 ${include ? `include:${include} ` : ''}~all`;
  let spf: DnsCheck;
  if (spfLookup.failed) spf = { record: 'spf', status: 'unknown', name: d, found: null, message: later, suggestion: null };
  else if (!spfRecords.length) {
    spf = {
      record: 'spf', status: 'missing', name: d, found: null, suggestion: spfSuggestion,
      message: include
        ? `There is no SPF record. Add a TXT record at ${d} that lists ${preset!.name} as allowed to send for you.`
        : `There is no SPF record. Add a TXT record at ${d} that lists your mail server as allowed to send for you. Your mail provider tells you what to put between “v=spf1” and “~all”.`,
    };
  } else if (spfRecords.length > 1) {
    spf = { record: 'spf', status: 'warning', name: d, found: spfRecords.join('  |  '), suggestion: null, message: 'There are two SPF records. Receivers ignore both when there is more than one: merge them into a single record with every “include:” in it.' };
  } else {
    const record = spfRecords[0]!;
    if (/\+all\b/i.test(record)) spf = { record: 'spf', status: 'warning', name: d, found: record, suggestion: null, message: 'The SPF record ends in “+all”, which lets anyone send as your domain. End it with “~all” or “-all”.' };
    else if (include && !record.toLowerCase().includes(include.toLowerCase())) {
      spf = { record: 'spf', status: 'warning', name: d, found: record, suggestion: `include:${include}`, message: `There is an SPF record, but it does not mention ${preset!.name}. Add “include:${include}” to it, before the “all” at the end.` };
    } else spf = { record: 'spf', status: 'ok', name: d, found: record, suggestion: null, message: include ? `In place, and it lists ${preset!.name}.` : 'In place. Make sure it lists the mail server you send through.' };
  }

  // DKIM: the name depends on the provider, so the usual ones are tried, and any the person gives.
  const asked = options.selector?.trim().toLowerCase().replace(/\._domainkey.*$/, '') || null;
  const selectors = [...new Set([...(asked && /^[a-z0-9._-]{1,63}$/.test(asked) ? [asked] : []), ...(preset?.dkimSelectors ?? []), ...COMMON_SELECTORS])];
  let dkim: DnsCheck | null = null;
  let dkimFailed = false;
  for (const s of selectors) {
    const name = `${s}._domainkey.${d}`;
    const r = await txt(resolve, name);
    dkimFailed ||= r.failed;
    const record = r.records.find((x) => /(^|;)\s*(v=DKIM1|k=rsa|p=)/i.test(x));
    if (record) {
      const empty = /(^|;)\s*p=\s*(;|$)/i.test(record);
      dkim = empty
        ? { record: 'dkim', status: 'warning', name, found: record.slice(0, 120), suggestion: null, message: 'A DKIM record is there, but its key is empty (switched off). Turn DKIM signing on again at your mail provider and copy the new record.' }
        : { record: 'dkim', status: 'ok', name, found: `${record.slice(0, 80)}…`, suggestion: null, message: `In place (the key named “${s}”).` };
      break;
    }
  }
  dkim ??= dkimFailed
    ? { record: 'dkim', status: 'unknown', name: `…._domainkey.${d}`, found: null, message: later, suggestion: null }
    : {
        record: 'dkim', status: asked ? 'missing' : 'unknown', name: `${asked ?? 'selector'}._domainkey.${d}`, found: null, suggestion: null,
        message: asked
          ? `No DKIM key was found named “${asked}”. Turn DKIM signing on at your mail provider, add the record it gives you, and check the name.`
          : 'No DKIM key was found under the usual names. Turn DKIM signing on at your mail provider: it gives you a record to add, and the record’s name starts with a word called the selector. Enter that word below to check it.',
      };

  // DMARC
  const dmarcName = `_dmarc.${d}`;
  const dmarcLookup = await txt(resolve, dmarcName);
  const dmarcRecord = dmarcLookup.records.find((r) => /^v=DMARC1/i.test(r.trim())) ?? null;
  const dmarcSuggestion = `v=DMARC1; p=none; rua=mailto:postmaster@${d}`;
  let dmarc: DnsCheck;
  if (dmarcLookup.failed) dmarc = { record: 'dmarc', status: 'unknown', name: dmarcName, found: null, message: later, suggestion: null };
  else if (!dmarcRecord) {
    dmarc = { record: 'dmarc', status: 'missing', name: dmarcName, found: null, suggestion: dmarcSuggestion, message: `There is no DMARC record. Gmail and Yahoo expect one. Add a TXT record at ${dmarcName}. “p=none” only asks for reports and blocks nothing, so it is safe to start with.` };
  } else {
    const policy = /(^|;)\s*p=\s*([a-z]+)/i.exec(dmarcRecord)?.[2]?.toLowerCase() ?? '';
    dmarc = ['none', 'quarantine', 'reject'].includes(policy)
      ? { record: 'dmarc', status: 'ok', name: dmarcName, found: dmarcRecord, suggestion: null, message: policy === 'none' ? 'In place, in watch-only mode (p=none). Once SPF and DKIM both pass for a few weeks, “p=quarantine” protects your name better.' : `In place (p=${policy}).` }
      : { record: 'dmarc', status: 'warning', name: dmarcName, found: dmarcRecord, suggestion: dmarcSuggestion, message: 'A DMARC record is there, but it has no policy (p=none, p=quarantine or p=reject).' };
  }

  return { domain: d, provider: preset?.key ?? null, checks: [spf, dkim, dmarc] };
}
