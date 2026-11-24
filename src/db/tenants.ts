/**
 * Tenants (the businesses we issue for) and their BTS certificates.
 */

import { randomUUID } from 'node:crypto';
import { assertCertificateUsable, loadSigningCredentials, parseCertificate, type SigningCredentials } from '../engine/certificate.ts';
import type { BtsEnvironment } from '../engine/transport.ts';
import { BELIZE_DISTRICTS, type DistrictCode, type Supplier } from '../engine/ubl.ts';
import type { Database, Queryable } from './database.ts';
import type { KeyProtector } from './keystore.ts';

export interface NewTenant {
  legalName: string;
  tradeName?: string;
  tin: string;
  address: { street: string; additionalStreet?: string; city: string; districtCode: DistrictCode };
  contact: { telephone: string; email: string };
  environment: BtsEnvironment;
  /** The business's web address: app.example.bz/<slug>. Made from the name when not given. */
  slug?: string;
}

export interface TenantContext {
  tenantId: string;
  environment: BtsEnvironment;
  supplier: Supplier;
  certificateId: string;
  credentials: SigningCredentials;
}

export class TenantError extends Error {
  override name = 'TenantError';
}

interface TenantRow {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tin: string;
  street: string;
  additional_street: string | null;
  city: string;
  district_code: DistrictCode;
  telephone: string;
  email: string;
  environment: BtsEnvironment;
}

// ---------- business addresses (slugs) ----------

/** First path segments the app itself uses, so no business can take them. */
export const RESERVED_SLUGS = new Set([
  'v1', 'd', 'a', 'api', 'app', 'admin', 'assets', 'static', 'health', 'signup', 'login', 'logout', 'register', 'new', 'www', 'mail',
  'help', 'support', 'docs', 'status', 'about', 'pricing', 'terms', 'privacy', 'security', 'settings', 'account', 'businesses',
  'developers', 'legal', 'billing', 'plans', 'webhooks', 'shop', 'store', 'checkout', 'pay', 'receivables', 'q', 'quote', 'quotes', 'recurring',
]);
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** "Corner Store Ltd." -> "corner-store-ltd" */
export function slugify(name: string): string {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s.length >= 3 ? s : `${s || 'business'}-bz`.replace(/^-/, '');
}

/** Why a slug cannot be used, or null when it is a valid address (not checking whether it is taken). */
export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug)) return 'Use 3 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit';
  if (RESERVED_SLUGS.has(slug)) return 'This address is reserved; choose another';
  return null;
}

export async function slugTaken(db: Queryable, slug: string, exceptTenantId?: string): Promise<boolean> {
  return (await db.query('select 1 from tenants where slug = $1 and id is distinct from $2', [slug, exceptTenantId ?? null])).rows.length > 0;
}

/** A free address based on `base`: base, base-2, base-3, ... */
export async function freeSlug(db: Queryable, base: string): Promise<string> {
  const root = slugProblem(base) ? slugify(base) : base;
  const start = RESERVED_SLUGS.has(root) ? `${root}-bz` : root;
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? start : `${start.slice(0, 36)}-${i}`;
    if (!(await slugTaken(db, candidate))) return candidate;
  }
  return `${start.slice(0, 30)}-${randomUUID().slice(0, 6)}`;
}

export async function createTenant(db: Queryable, t: NewTenant): Promise<string> {
  if (!/^\d{6}$/.test(t.tin)) throw new TenantError('TIN must be 6 digits');
  if (!BELIZE_DISTRICTS[t.address.districtCode]) throw new TenantError('District code must be 1 to 6');
  let slug: string;
  if (t.slug) {
    const problem = slugProblem(t.slug);
    if (problem) throw new TenantError(`Address: ${problem}`);
    if (await slugTaken(db, t.slug)) throw new TenantError('Address: another business already uses this address');
    slug = t.slug;
  } else {
    slug = await freeSlug(db, slugify(t.tradeName ?? t.legalName));
  }
  const id = randomUUID();
  await db.query(
    `insert into tenants (id, legal_name, trade_name, tin, street, additional_street, city, district_code, telephone, email, environment, slug)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, t.legalName, t.tradeName ?? null, t.tin, t.address.street, t.address.additionalStreet ?? null, t.address.city, t.address.districtCode, t.contact.telephone, t.contact.email, t.environment, slug],
  );
  return id;
}

export async function tenantBySlug(db: Queryable, slug: string): Promise<{ id: string; slug: string; legalName: string; tradeName: string | null; environment: string; suspended: boolean; isClosed: boolean } | null> {
  const r = (await db.query<{ id: string; slug: string; legal_name: string; trade_name: string | null; environment: string; suspended: boolean; closed: boolean }>(
    'select id, slug, legal_name, trade_name, environment, suspended_at is not null as suspended, closed_at is not null as closed from tenants where slug = $1', [slug],
  )).rows[0];
  return r ? { id: r.id, slug: r.slug, legalName: r.legal_name, tradeName: r.trade_name, environment: r.environment, suspended: r.suspended, isClosed: r.closed } : null;
}

/**
 * Store a tenant's BTS certificate and private key. The key must match the
 * certificate, the certificate must carry the tenant's TIN and be valid now.
 * Any previously active certificate is retired.
 */
export async function addCertificate(
  db: Database,
  keys: KeyProtector,
  tenantId: string,
  input: { certificatePem: string; privateKeyPem: string; passphrase?: string },
  now: Date = new Date(),
): Promise<string> {
  const tenant = (await db.query<{ tin: string }>('select tin from tenants where id = $1', [tenantId])).rows[0];
  if (!tenant) throw new TenantError('Unknown tenant');
  const creds = loadSigningCredentials(input.privateKeyPem, input.certificatePem, input.passphrase);
  assertCertificateUsable(creds.certificate, { tin: tenant.tin, at: now });

  // Store the key unencrypted-PEM-inside-our-own-encryption, so a passphrase is not needed later.
  const keyPem = creds.key.export({ type: 'pkcs8', format: 'pem' }) as string;
  const encrypted = await keys.encrypt(Buffer.from(keyPem, 'utf8'), tenantId);
  const c = creds.certificate;
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(`update certificates set status = 'retired' where tenant_id = $1 and status = 'active'`, [tenantId]);
    await tx.query(
      `insert into certificates (id, tenant_id, certificate_pem, encrypted_key, subject_tin, serial_number, sha256, valid_from, valid_to, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
      [id, tenantId, input.certificatePem, encrypted, c.tin, c.serialNumber, c.sha256Base64, c.validFrom.toISOString(), c.validTo.toISOString()],
    );
  });
  return id;
}

/** Load what the pipeline needs to issue for a tenant: supplier details and decrypted credentials. */
export async function loadTenantContext(db: Database, keys: KeyProtector, tenantId: string): Promise<TenantContext> {
  const t = (await db.query<TenantRow>('select * from tenants where id = $1', [tenantId])).rows[0];
  if (!t) throw new TenantError('Unknown tenant');
  const cert = (
    await db.query<{ id: string; certificate_pem: string; encrypted_key: string }>(
      `select id, certificate_pem, encrypted_key from certificates where tenant_id = $1 and status = 'active'`,
      [tenantId],
    )
  ).rows[0];
  if (!cert) throw new TenantError('Tenant has no active BTS certificate');
  const keyPem = (await keys.decrypt(cert.encrypted_key, tenantId)).toString('utf8');
  const credentials = loadSigningCredentials(keyPem, cert.certificate_pem);
  // Defense in depth: the stored certificate must still belong to this tenant.
  if (parseCertificate(cert.certificate_pem).tin !== t.tin) throw new TenantError('Stored certificate TIN does not match the tenant');
  return {
    tenantId,
    environment: t.environment,
    certificateId: cert.id,
    credentials,
    supplier: {
      legalName: t.legal_name,
      ...(t.trade_name && { tradeName: t.trade_name }),
      tin: t.tin,
      address: {
        street: t.street,
        ...(t.additional_street && { additionalStreet: t.additional_street }),
        city: t.city,
        districtName: BELIZE_DISTRICTS[t.district_code],
        districtCode: t.district_code,
      },
      contact: { telephone: t.telephone, email: t.email },
    },
  };
}
