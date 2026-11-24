/**
 * Idempotency-Key for requests that must not happen twice (placing a store
 * order): a retry with the same key and the same body gets the first answer
 * back (Idempotent-Replayed: true) and nothing is done again.
 *
 * Kept in the same table as the keys for issuing documents, under a scope so
 * the two never meet. The stored answer is encrypted: an order's answer
 * carries the buyer's link token, which is otherwise only kept as a hash.
 * Housekeeping deletes these after two days.
 */

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/database.ts';
import type { KeyProtector } from '../db/keystore.ts';
import { ApiError } from './errors.ts';

export const STORE_ORDER_SCOPE = 'store-order';

export interface Claim {
  /** Remember the answer, so a retry gets it back. */
  complete(status: number, body: unknown): Promise<void>;
  /** Nothing was done: free the key, so the corrected request can be sent with it. */
  release(): Promise<void>;
}

/** The request's Idempotency-Key, checked; undefined when it sent none. */
export function idempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers['idempotency-key'];
  if (key === undefined) return undefined;
  if (Array.isArray(key)) throw new ApiError(400, 'invalid_request', 'Send one Idempotency-Key header');
  if (key.length < 1 || key.length > 200) throw new ApiError(400, 'invalid_request', 'Idempotency-Key must be 1 to 200 characters');
  return key;
}

/**
 * Claim a key for this request. Returns the claim to finish, or null after
 * replaying the first answer on `reply` (the caller then returns it).
 */
export async function claimIdempotency(
  db: Queryable, keys: KeyProtector, reply: FastifyReply,
  input: { tenantId: string; scope: string; key: string; body: unknown },
): Promise<Claim | null> {
  const stored = `${input.scope}:${input.key}`;
  const context = `idempotency:${input.tenantId}:${input.scope}`;
  const requestHash = createHash('sha256').update(JSON.stringify(input.body ?? null)).digest('hex');
  const claimed = await db.query<{ key: string }>(
    `insert into idempotency_keys (tenant_id, key, request_hash, status) values ($1, $2, $3, 'in_progress') on conflict (tenant_id, key) do nothing returning key`,
    [input.tenantId, stored, requestHash],
  );
  if (claimed.rows.length === 0) {
    const prior = (await db.query<{ request_hash: string; status: string; response_code: number | null; response_body: { sealed?: string } | null }>(
      'select request_hash, status, response_code, response_body from idempotency_keys where tenant_id = $1 and key = $2', [input.tenantId, stored],
    )).rows[0];
    if (!prior || prior.status !== 'completed' || !prior.response_body?.sealed) throw new ApiError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed; wait a moment and send it again');
    if (prior.request_hash !== requestHash) throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Use a new key for each new order.');
    const body = (await keys.decrypt(prior.response_body.sealed, context)).toString('utf8');
    void reply.code(prior.response_code ?? 200).header('Idempotent-Replayed', 'true').type('application/json; charset=utf-8').send(body);
    return null;
  }
  return {
    async complete(status, body) {
      const sealed = await keys.encrypt(Buffer.from(JSON.stringify(body)), context);
      await db.query(
        `update idempotency_keys set status = 'completed', response_code = $3, response_body = $4, completed_at = now() where tenant_id = $1 and key = $2`,
        [input.tenantId, stored, status, JSON.stringify({ sealed })],
      );
    },
    async release() {
      await db.query(`delete from idempotency_keys where tenant_id = $1 and key = $2 and status = 'in_progress'`, [input.tenantId, stored]).catch(() => {});
    },
  };
}

/** Housekeeping: answers kept for retries are no use after two days. */
export async function sweepIdempotency(db: Queryable): Promise<void> {
  await db.query(`delete from idempotency_keys where key like $1 and created_at < now() - interval '2 days'`, [`${STORE_ORDER_SCOPE}:%`]);
}
