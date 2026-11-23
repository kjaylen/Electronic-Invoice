/**
 * A store on the business's own domain (shop.example.bz).
 *
 * The business adds the domain, then creates two DNS records:
 *   CNAME  shop.example.bz             → STORE_DOMAIN_TARGET (our host for stores)
 *   TXT    _floreo.shop.example.bz → the verification token
 * and presses Verify. Once verified, requests for that host show the store.
 *
 * Certificates: put a proxy with on-demand TLS in front (Caddy's
 * `on_demand_tls { ask https://app.example.bz/v1/domains/check }`), which
 * asks GET /v1/domains/check?domain=… before issuing one; only verified
 * domains get a certificate.
 */

import { randomBytes } from 'node:crypto';
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import type { Queryable } from '../db/database.ts';

export class DomainError extends Error {
  override name = 'DomainError';
}

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function checkDomain(domain: string, platformHosts: string[]): string {
  const d = normalizeDomain(domain);
  if (!DOMAIN.test(d)) throw new DomainError('Enter a domain like shop.example.bz');
  if (platformHosts.some((h) => d === h || d.endsWith(`.${h}`))) throw new DomainError('Use a domain you own, not one of ours');
  return d;
}

export interface DomainRow {
  domain: string;
  tenant_id: string;
  verification_token: string;
  verified_at: Date | string | null;
  created_at: Date | string;
}

export const txtName = (domain: string) => `_floreo.${domain}`;

export function domainJson(r: DomainRow, target: string | undefined) {
  return {
    domain: r.domain,
    verified: Boolean(r.verified_at),
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    records: [
      { type: 'CNAME', name: r.domain, value: target ?? '(ask us for the store host)' },
      { type: 'TXT', name: txtName(r.domain), value: r.verification_token },
    ],
    url: `https://${r.domain}/shop`,
  };
}

export async function addDomain(db: Queryable, tenantId: string, domain: string): Promise<DomainRow> {
  const taken = (await db.query<{ tenant_id: string }>('select tenant_id from store_domains where domain = $1', [domain])).rows[0];
  if (taken && taken.tenant_id !== tenantId) throw new DomainError('Another store already uses this domain');
  if (taken) return (await db.query<DomainRow>('select * from store_domains where domain = $1', [domain])).rows[0]!;
  const count = (await db.query<{ n: number }>('select count(*)::int as n from store_domains where tenant_id = $1', [tenantId])).rows[0]!.n;
  if (count >= 3) throw new DomainError('A store can have up to 3 domains');
  const token = `floreo-verify=${randomBytes(16).toString('hex')}`;
  await db.query('insert into store_domains (domain, tenant_id, verification_token) values ($1, $2, $3)', [domain, tenantId, token]);
  return (await db.query<DomainRow>('select * from store_domains where domain = $1', [domain])).rows[0]!;
}

/** Look for the TXT record; mark the domain verified when it is there. */
export async function verifyDomain(db: Queryable, tenantId: string, domain: string, resolveTxt: (name: string) => Promise<string[][]> = dnsResolveTxt): Promise<DomainRow> {
  const row = (await db.query<DomainRow>('select * from store_domains where domain = $1 and tenant_id = $2', [domain, tenantId])).rows[0];
  if (!row) throw new DomainError('Add the domain first');
  if (row.verified_at) return row;
  let records: string[][] = [];
  try {
    records = await resolveTxt(txtName(domain));
  } catch {
    throw new DomainError(`No TXT record found at ${txtName(domain)} yet. DNS changes can take up to an hour.`);
  }
  if (!records.some((parts) => parts.join('') === row.verification_token)) {
    throw new DomainError(`The TXT record at ${txtName(domain)} does not have the right value yet`);
  }
  return (await db.query<DomainRow>('update store_domains set verified_at = now() where domain = $1 returning *', [domain])).rows[0]!;
}

/** Verified domain → store address, cached briefly so every page request does not hit the database. */
export function domainCache(db: Queryable, ttlMs = 30_000) {
  let map = new Map<string, string>();
  let loadedAt = 0;
  let loading: Promise<void> | null = null;
  const load = async () => {
    const rows = (await db.query<{ domain: string; slug: string }>('select d.domain, t.slug from store_domains d join tenants t on t.id = d.tenant_id where d.verified_at is not null')).rows;
    map = new Map(rows.map((r) => [r.domain, r.slug]));
    loadedAt = Date.now();
  };
  return {
    async slugFor(host: string): Promise<string | undefined> {
      const h = host.toLowerCase().replace(/:\d+$/, '');
      if (Date.now() - loadedAt > ttlMs) {
        loading ??= load().finally(() => (loading = null));
        await loading;
      }
      return map.get(h);
    },
    invalidate() {
      loadedAt = 0;
    },
  };
}
