/**
 * Events raised by the code that makes the change (rather than by a database
 * trigger, like documents and orders): a product made, changed or archived,
 * an item's stock level changing, an online payment for an order failing.
 *
 * Written to the same outbox, in the caller's transaction when it has one,
 * so an event is recorded exactly when its change is.
 */

import type { Queryable } from '../db/database.ts';

export type EmittedEvent = 'product.created' | 'product.updated' | 'product.deleted' | 'stock.changed' | 'order.payment_failed';

export async function emitEvent(db: Queryable, tenantId: string, type: EmittedEvent, subjectId: string): Promise<void> {
  await db.query('insert into event_outbox (tenant_id, type, subject_id) values ($1, $2, $3)', [tenantId, type, subjectId]);
}
