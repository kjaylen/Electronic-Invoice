/**
 * Deliver one signed ETD to BTS and settle its fate (manual 3.3.4 to 3.3.6, 7.3, 7.9).
 *
 * Rules from the spec and the manual:
 *   - Check what BTS would reject outright before sending: wrong environment
 *     (284), over 500 KB (210), a broken signature (240/241).
 *   - A missing reply is not a failure. Ask Document Query before resending;
 *     the first attempt may have been authorized.
 *   - A resend rejected with 255 ("ETDUI already authorized") means an earlier
 *     attempt succeeded.
 *   - 500 (code 999) and other failures: query, then retry with backoff.
 *   - 401: the certificate or issuer is not valid. Stop for this tenant.
 *   - Still unsettled after the last attempt: return "undetermined". The
 *     caller decides on contingency, which reissues under a new series and
 *     serial (3.3.6.4); the original ETDUI must keep being checked and
 *     cancelled if it later turns out to be authorized.
 *
 * Stateless. Storing the document before sending, and every reply after, is
 * the caller's job (the submit pipeline).
 */

import { DOMParser, type Element } from '@xmldom/xmldom';
import { type EtdType, parseEtdui } from './etdui.ts';
import { DUPLICATE_ETDUI_CODE, type Condition } from './response.ts';
import { type BtsClient, RECEPTION_ENV, type SubmissionResponse, TransportError } from './transport.ts';
import { MAX_DOCUMENT_BYTES } from './ubl.ts';
import { verifyDocumentSignature } from './verify.ts';

const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';

export interface DeliveryOptions {
  /** Total submission attempts. Default 3. */
  maxAttempts?: number;
  /** Wait before attempt 2, 3, ... (the last value repeats). Default 2 s, 8 s, 30 s. */
  backoffMs?: number[];
  /** Verify the signature before sending. Default true. */
  verifySignature?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AttemptLog {
  attempt: number;
  at: Date;
  /** "submitted" or "queried". */
  action: 'submitted' | 'queried';
  result: string;
  httpStatus?: number;
  /** The reply as received, when there was one. */
  rawBody?: string;
}

export type DeliveryOutcome =
  | {
      status: 'authorized' | 'authorized_with_alert';
      etdui: string;
      /** The authorization protocol (the reply's ETDUI), when BTS's reply was received. */
      protocolNumber?: string;
      /** Set when the authorization was learned from Document Query rather than a direct reply. */
      recoveredBy?: 'query' | 'duplicate';
      conditions: Condition[];
      response?: SubmissionResponse;
      attempts: AttemptLog[];
    }
  | { status: 'rejected'; etdui: string; conditions: Condition[]; response: SubmissionResponse; attempts: AttemptLog[] }
  | { status: 'certificate_problem'; etdui: string; response: SubmissionResponse; attempts: AttemptLog[] }
  | { status: 'undetermined'; etdui: string; reason: string; attempts: AttemptLog[] };

export class DeliveryError extends Error {
  override name = 'DeliveryError';
  readonly btsCode: number | undefined;
  constructor(message: string, btsCode?: number) {
    super(message);
    this.btsCode = btsCode;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read the ETDUI and type from a signed document. */
function identify(signedXml: string): { etdui: string; etdType: EtdType } {
  let root: Element | null = null;
  try {
    root = new DOMParser({ onError: () => {} }).parseFromString(signedXml, 'text/xml').documentElement;
  } catch {
    root = null;
  }
  const uuid = root && Array.from(root.childNodes).find((n) => (n as Element).namespaceURI === CBC && (n as Element).localName === 'UUID');
  const etdui = uuid?.textContent?.trim();
  if (!etdui) throw new DeliveryError('Document has no cbc:UUID');
  return { etdui, etdType: parseEtdui(etdui).etdType };
}

export async function deliver(client: BtsClient, signedXml: string, options: DeliveryOptions = {}): Promise<DeliveryOutcome> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoff = options.backoffMs ?? [2_000, 8_000, 30_000];
  const sleep = options.sleep ?? defaultSleep;
  const attempts: AttemptLog[] = [];

  // ---- checks before anything leaves the building ----
  const { etdui, etdType } = identify(signedXml);
  const env = parseEtdui(etdui).receptionEnv;
  if (env !== RECEPTION_ENV[client.environment]) {
    throw new DeliveryError(`Document is for reception environment ${env}, but this client sends to ${client.environment} (BTS code 284)`, 284);
  }
  if (Buffer.byteLength(signedXml, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new DeliveryError('Document is over the 500 KB BTS limit (code 210)', 210);
  }
  if (options.verifySignature ?? true) {
    const check = verifyDocumentSignature(signedXml);
    if (!check.valid) throw new DeliveryError(`Signature check failed before sending: ${check.errors.join('; ')}`, 241);
  }

  /** Ask BTS whether it already holds the document. Returns an outcome if it settles things. */
  const checkWithQuery = async (attempt: number, why: 'query' | 'duplicate'): Promise<DeliveryOutcome | undefined> => {
    try {
      const q = await client.queryDocument(etdui);
      attempts.push({ attempt, at: new Date(), action: 'queried', result: q.status, httpStatus: q.httpStatus, rawBody: q.rawBody });
      if (q.status === 'authorized' || q.status === 'authorized_with_alert') {
        return { status: q.status, etdui, recoveredBy: why, conditions: [], attempts };
      }
    } catch (e) {
      attempts.push({ attempt, at: new Date(), action: 'queried', result: `error: ${(e as Error).message}` });
    }
    return undefined;
  };

  let lastReason = 'no attempt made';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await sleep(backoff[Math.min(attempt - 2, backoff.length - 1)]!);
      // Before resending, make sure an earlier attempt did not already get through.
      const settled = await checkWithQuery(attempt, 'query');
      if (settled) return settled;
    }

    let response: SubmissionResponse;
    try {
      response = await client.submit(etdType, signedXml);
    } catch (e) {
      const err = e as TransportError;
      lastReason = err instanceof TransportError ? `${err.kind}: ${err.message}` : String(e);
      attempts.push({ attempt, at: new Date(), action: 'submitted', result: lastReason });
      continue;
    }
    attempts.push({ attempt, at: new Date(), action: 'submitted', result: response.outcome, httpStatus: response.httpStatus, rawBody: response.rawBody });
    const conditions = response.reply?.conditions ?? [];

    switch (response.outcome) {
      case 'authorized':
      case 'authorized_with_alert':
        return {
          status: response.outcome,
          etdui,
          ...(response.protocolNumber && { protocolNumber: response.protocolNumber }),
          conditions,
          response,
          attempts,
        };
      case 'rejected': {
        // 255 can also arrive on attempt 1, e.g. after a crash between sending and storing the reply.
        if (conditions.some((c) => c.code === DUPLICATE_ETDUI_CODE)) {
          const settled = await checkWithQuery(attempt, 'duplicate');
          if (settled) return settled;
        }
        return { status: 'rejected', etdui, conditions, response, attempts };
      }
      case 'unauthorized':
        return { status: 'certificate_problem', etdui, response, attempts };
      default:
        lastReason = `HTTP ${response.httpStatus} (${response.outcome})`;
    }
  }

  // One last look before giving up: the final attempt may have landed.
  const settled = await checkWithQuery(maxAttempts, 'query');
  if (settled) return settled;
  return { status: 'undetermined', etdui, reason: lastReason, attempts };
}
