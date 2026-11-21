/**
 * Background worker: finishes work that cannot complete inside a request.
 *
 * Each tick finds the businesses with unfinished documents and, per business:
 *   - resumePending: normal-mode documents left pending (crash, certificate fixed)
 *   - catchUpContingency: sends the contingency queue, closes the period when BTS
 *     answers, and reconciles superseded originals (cancelling any BTS authorized)
 *
 * A failure for one business never stops the others. Ticks never overlap within
 * a process. With several server instances, run the worker in just one of them
 * (or move it to a queue); overlapping runs are safe but wasteful.
 */

import { catchUpContingency, resumePending, type PipelineDeps } from '../pipeline/issue.ts';

export interface WorkerTickResult {
  tenants: number;
  resumed: number;
  delivered: number;
  reconciled: number;
  failures: Array<{ tenantId: string; error: string }>;
}

export interface WorkerOptions {
  /** Leave a pending document alone for this long before retrying it (an in-flight request may still settle it). Default 60 s. */
  pendingAgeMs?: number;
  /** Businesses processed at once. Default 4. */
  concurrency?: number;
  onError?: (tenantId: string, error: unknown) => void;
}

export async function tenantsWithWork(deps: PipelineDeps): Promise<string[]> {
  const rows = (
    await deps.db.query<{ tenant_id: string }>(
      `select tenant_id from documents where status in ('pending', 'contingency_pending')
       union select tenant_id from documents where status = 'superseded' and coalesce(status_detail->>'resolution', '') = ''
       union select tenant_id from contingency_periods where ended_at is null`,
    )
  ).rows;
  return rows.map((r) => r.tenant_id);
}

export async function runWorkerOnce(deps: PipelineDeps, options: WorkerOptions = {}): Promise<WorkerTickResult> {
  const tenants = await tenantsWithWork(deps);
  const result: WorkerTickResult = { tenants: tenants.length, resumed: 0, delivered: 0, reconciled: 0, failures: [] };
  const queue = [...tenants];
  const work = async () => {
    for (let tenantId = queue.shift(); tenantId; tenantId = queue.shift()) {
      try {
        const resumed = await resumePending(deps, tenantId, { olderThanMs: options.pendingAgeMs ?? 60_000 });
        result.resumed += resumed.filter((r) => r.status !== 'pending').length;
        const caught = await catchUpContingency(deps, tenantId);
        result.delivered += caught.delivered.length;
        result.reconciled += caught.reconciled.filter((r) => r.resolution !== 'unresolved').length;
      } catch (e) {
        result.failures.push({ tenantId, error: (e as Error).message });
        options.onError?.(tenantId, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, Math.max(tenants.length, 1)) }, work));
  return result;
}

/** Run the worker every intervalMs until stopped. */
export function startWorker(deps: PipelineDeps, options: WorkerOptions & { intervalMs?: number; onTick?: (r: WorkerTickResult) => void } = {}) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      options.onTick?.(await runWorkerOnce(deps, options));
    } catch (e) {
      options.onError?.('*', e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, options.intervalMs ?? 60_000);
  timer.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
