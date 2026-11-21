/** Shared setup for pipeline tests: a migrated database, two tenants with certificates, a fake BTS. */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { type Database, migrate, pgliteDatabase } from '../src/db/database.ts';
import { localKeyProtector } from '../src/db/keystore.ts';
import { addCertificate, createTenant, type NewTenant } from '../src/db/tenants.ts';
import type { LineInput } from '../src/engine/calc.ts';
import { cachingClientProvider, type CachingClientProvider } from '../src/pipeline/clients.ts';
import type { IssueRequest, PipelineDeps } from '../src/pipeline/issue.ts';
import { applicationResponse, startFakeBts, TEST_ROOT_CA, type FakeBts } from './fake-bts.ts';

const certs = new URL('./certs/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, certs), 'utf8');

export const TENANT_A: NewTenant = {
  legalName: 'Caribbean Fuel & Supply Ltd.',
  tradeName: 'CaribFuel',
  tin: '123456',
  address: { street: '12 Regent Street', city: 'Belize City', districtCode: '1' },
  contact: { telephone: '+501 222 3333', email: 'billing@caribfuel.example' },
  environment: 'test',
};
export const TENANT_B: NewTenant = {
  legalName: 'Other Business Ltd.',
  tin: '654321',
  address: { street: '3 Hummingbird Highway', city: 'Belmopan', districtCode: '2' },
  contact: { telephone: '+501 822 0000', email: 'office@other.example' },
  environment: 'test',
};

export const LINE: LineInput = { description: 'Phone charger', quantity: '2', unitCode: 'H87', unitPrice: '24.99', gstCategory: 'S' };

export function invoiceRequest(overrides: Partial<IssueRequest> = {}): IssueRequest {
  return {
    etdType: '01',
    customer: {
      name: 'Island Logistics Ltd.',
      tin: '777888',
      address: { street: '4 Mile Northern Highway', city: 'Belize City', districtName: 'Belize', districtCode: '1' },
    },
    lines: [LINE],
    payment: { meansCode: '30', dueDate: '2026-12-31', terms: 'Net 30' },
    ...overrides,
  };
}

/** A reply BTS would send for an authorized document (the referenced ETDUI is not checked by the client). */
export const AUTHORIZED = { status: 201, body: applicationResponse({ responseCode: '001', referencedEtdui: '0'.repeat(44) }) };
export const rejectedWith = (code: string, description: string) => ({
  status: 400,
  body: applicationResponse({ responseCode: '003', referencedEtdui: '0'.repeat(44), conditions: [{ code, description }] }),
});
export const queryReply = (code: '004' | '005') => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ GetDocument: { ResponseCode: code } }),
});

export interface PipelineFixture {
  db: Database;
  bts: FakeBts;
  clients: CachingClientProvider;
  deps: PipelineDeps;
  tenantA: string;
  tenantB: string;
  close(): Promise<void>;
}

export async function setupPipeline(db?: Database): Promise<PipelineFixture> {
  const database = db ?? pgliteDatabase(await PGlite.create());
  await migrate(database);
  const keys = localKeyProtector(randomBytes(32));
  const bts = await startFakeBts();
  const clients = cachingClientProvider({ baseUrl: bts.baseUrl, ca: TEST_ROOT_CA, timeoutMs: 2_000 });
  const tenantA = await createTenant(database, TENANT_A);
  const tenantB = await createTenant(database, TENANT_B);
  await addCertificate(database, keys, tenantA, { certificatePem: read('signer-123456.cert.pem'), privateKeyPem: read('signer-123456.key.pem') });
  await addCertificate(database, keys, tenantB, { certificatePem: read('signer-654321.cert.pem'), privateKeyPem: read('signer-654321.key.pem') });
  const deps: PipelineDeps = { db: database, keys, clients, delivery: { sleep: async () => {} } };
  return {
    db: database,
    bts,
    clients,
    deps,
    tenantA,
    tenantB,
    async close() {
      clients.closeAll();
      await bts.close();
      await database.close();
    },
  };
}

export const readCert = read;
