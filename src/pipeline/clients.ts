/**
 * One BtsClient per tenant certificate, reused across documents so each
 * tenant keeps a warm mutual-TLS connection pool. A renewed certificate gets
 * a fresh client automatically, because the cache key is the certificate.
 */

import { BtsClient, type BtsClientOptions } from '../engine/transport.ts';
import type { TenantContext } from '../db/tenants.ts';
import type { ClientProvider } from './issue.ts';

export interface CachingClientProvider extends ClientProvider {
  closeAll(): void;
  readonly size: number;
}

export function cachingClientProvider(options: Omit<BtsClientOptions, 'environment' | 'credentials'> = {}): CachingClientProvider {
  const clients = new Map<string, BtsClient>();
  return {
    get(ctx) {
      const key = `${ctx.environment}:${ctx.credentials.certificate.sha256Base64}`;
      let client = clients.get(key);
      if (!client) {
        client = new BtsClient({ ...options, environment: ctx.environment, credentials: ctx.credentials });
        clients.set(key, client);
      }
      return client;
    },
    closeAll() {
      for (const c of clients.values()) c.close();
      clients.clear();
    },
    get size() {
      return clients.size;
    },
  };
}
