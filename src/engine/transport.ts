/**
 * Mutual-TLS client for the BTS reception services (manual chapter 7).
 *
 *   Test        https://test.bz.efdrciat.org    (receptionEnv 02)
 *   Production  https://prod.bz.efdrciat.org    (receptionEnv 01)
 *
 *   POST api/invoice/v1 | taxreceipt/v1 | debitnote/v1 | creditnote/v1 | event/v1
 *        body: the signed XML, Content-Type application/xml
 *        201 authorized (with or without alerts), 400 rejected, 401 certificate/issuer, 500 server error
 *   POST api/document/v1   body: JSON with the ETDUI        200 found / not found
 *   POST api/status/v1     no body                          200
 *
 * Authentication is the taxpayer's BTS certificate on the TLS connection;
 * there is no API key. One client per taxpayer certificate: it keeps its own
 * keep-alive connection pool, so many tenants can send in parallel without
 * sharing connections or credentials.
 */

import { Agent, request } from 'node:https';
import { ETD_TYPES, type EtdType } from './etdui.ts';
import type { SigningCredentials } from './certificate.ts';
import {
  type ApplicationResponseInfo,
  type DocumentQueryInfo,
  parseApplicationResponse,
  parseDocumentQuery,
  parseSystemStatus,
  RESPONSE_CODES,
  type SystemStatusInfo,
} from './response.ts';

export type BtsEnvironment = 'test' | 'production';

export const BTS_BASE_URLS: Record<BtsEnvironment, string> = {
  test: 'https://test.bz.efdrciat.org',
  production: 'https://prod.bz.efdrciat.org',
};

/** The receptionEnv value a document must carry for each environment (BTS code 284). */
export const RECEPTION_ENV: Record<BtsEnvironment, '01' | '02'> = { test: '02', production: '01' };

export const SUBMIT_PATHS: Record<EtdType, string> = {
  [ETD_TYPES.TAX_INVOICE]: '/api/invoice/v1',
  [ETD_TYPES.TAX_RECEIPT]: '/api/taxreceipt/v1',
  [ETD_TYPES.DEBIT_NOTE]: '/api/debitnote/v1',
  [ETD_TYPES.CREDIT_NOTE]: '/api/creditnote/v1',
  [ETD_TYPES.EVENT]: '/api/event/v1',
};
export const DOCUMENT_QUERY_PATH = '/api/document/v1';
export const SYSTEM_STATUS_PATH = '/api/status/v1';

/** Replies larger than this are cut off. A query can return the full ETD plus events, still well under this. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export interface BtsClientOptions {
  environment: BtsEnvironment;
  /** The taxpayer's BTS certificate and key, used for mutual TLS. */
  credentials: SigningCredentials;
  /** Override the base URL (tests, a proxy). Defaults to the environment's URL. */
  baseUrl?: string;
  /** Extra CA certificates to trust, PEM. Defaults to the system trust store. */
  ca?: string | string[];
  /** Per-request timeout, from sending to the complete reply. Default 30 s. */
  timeoutMs?: number;
  /** JSON field carrying the ETDUI in a Document Query (the manual does not name it). Default "ETDUI". */
  documentQueryField?: string;
}

export type TransportErrorKind =
  /** Nothing was sent (DNS, connection refused, TLS handshake). Safe to retry. */
  | 'connect'
  /** The request may have reached BTS but no complete reply came back. Query before resending. */
  | 'timeout'
  /** The connection broke after sending. Query before resending. */
  | 'network';

export class TransportError extends Error {
  override name = 'TransportError';
  readonly kind: TransportErrorKind;
  readonly code: string | undefined;
  constructor(kind: TransportErrorKind, message: string, code?: string) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
}

export type SubmissionOutcome =
  | 'authorized'
  | 'authorized_with_alert'
  | 'rejected'
  /** 401: certificate or issuer not valid. Stop sending for this tenant. */
  | 'unauthorized'
  /** 500 (BTS code 999): retry with backoff, querying first. */
  | 'server_error'
  /** Any other reply. Treat like a server error. */
  | 'unexpected';

export interface SubmissionResponse {
  outcome: SubmissionOutcome;
  httpStatus: number;
  /** Parsed ApplicationResponse, when the reply carried one. */
  reply?: ApplicationResponseInfo;
  /** For an authorization: the reply's ETDUI, which is the authorization protocol number. */
  protocolNumber?: string;
  /** The reply exactly as received. Store it: it is part of the legal record. */
  rawBody: string;
  receivedAt: Date;
}

export interface DocumentQueryResponse extends DocumentQueryInfo {
  httpStatus: number;
  rawBody: string;
}

export interface SystemStatusResponse extends SystemStatusInfo {
  httpStatus: number;
  rawBody: string;
}

function certificatePem(base64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export class BtsClient {
  readonly environment: BtsEnvironment;
  readonly baseUrl: URL;
  private readonly agent: Agent;
  private readonly timeoutMs: number;
  private readonly queryField: string;

  constructor(options: BtsClientOptions) {
    this.environment = options.environment;
    this.baseUrl = new URL(options.baseUrl ?? BTS_BASE_URLS[options.environment]);
    if (this.baseUrl.protocol !== 'https:') throw new Error('BTS base URL must use https');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.queryField = options.documentQueryField ?? 'ETDUI';
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 8,
      minVersion: 'TLSv1.2',
      // The key is exported only into the TLS context of this agent; it is never logged or returned.
      key: options.credentials.key.export({ type: 'pkcs8', format: 'pem' }) as string,
      cert: certificatePem(options.credentials.certificate.derBase64),
      ...(options.ca !== undefined && { ca: options.ca }),
    });
  }

  /** Send a signed ETD or event to its reception service. */
  async submit(etdType: EtdType, signedXml: string): Promise<SubmissionResponse> {
    const path = SUBMIT_PATHS[etdType];
    if (!path) throw new Error(`Unknown document type ${etdType}`);
    const http = await this.post(path, 'application/xml; charset=utf-8', signedXml);
    return interpretSubmission(http);
  }

  /** Ask BTS whether it holds a document, and its status (004 to 007). */
  async queryDocument(etdui: string): Promise<DocumentQueryResponse> {
    if (!/^\d{44}$/.test(etdui)) throw new Error('ETDUI must be 44 digits');
    const http = await this.post(DOCUMENT_QUERY_PATH, 'application/json', JSON.stringify({ [this.queryField]: etdui }));
    if (http.status === 401) throw new TransportError('connect', 'Document Query refused the certificate (401)');
    return { ...parseDocumentQuery(http.body), httpStatus: http.status, rawBody: http.body };
  }

  /** Whether the reception service is operating (008) or not (009). */
  async systemStatus(): Promise<SystemStatusResponse> {
    const http = await this.post(SYSTEM_STATUS_PATH, 'application/json', '');
    if (http.status === 401) throw new TransportError('connect', 'System Status refused the certificate (401)');
    return { ...parseSystemStatus(http.body), httpStatus: http.status, rawBody: http.body };
  }

  /** Close pooled connections. Call when the tenant's client is no longer needed. */
  close(): void {
    this.agent.destroy();
  }

  private post(path: string, contentType: string, body: string): Promise<HttpReply> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl.href.endsWith('/') ? this.baseUrl : `${this.baseUrl.href}/`);
    const payload = Buffer.from(body, 'utf8');
    return new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      const fail = (err: TransportError) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const req = request(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: {
            'Content-Type': contentType,
            'Content-Length': payload.length,
            Accept: 'application/xml, application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) {
              req.destroy();
              fail(new TransportError('network', `Reply exceeded ${MAX_REPLY_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', (e: NodeJS.ErrnoException) => fail(new TransportError('network', e.message, e.code)));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        fail(new TransportError(sent ? 'timeout' : 'connect', `No reply from BTS within ${this.timeoutMs} ms`, 'ETIMEDOUT'));
      }, this.timeoutMs);
      req.on('finish', () => {
        sent = true;
      });
      req.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(new TransportError(sent ? 'network' : 'connect', e.message, e.code));
      });
      req.end(payload);
    });
  }
}

/** Map an HTTP reply from a reception service to an outcome. */
export function interpretSubmission(http: HttpReply): SubmissionResponse {
  const base = { httpStatus: http.status, rawBody: http.body, receivedAt: new Date() };
  let reply: ApplicationResponseInfo | undefined;
  try {
    reply = http.body.trim().startsWith('<') ? parseApplicationResponse(http.body) : undefined;
  } catch {
    reply = undefined;
  }
  const withReply = reply ? { reply } : {};

  if (http.status === 401) return { outcome: 'unauthorized', ...withReply, ...base };
  if (http.status >= 500) return { outcome: 'server_error', ...withReply, ...base };
  if (!reply) return { outcome: 'unexpected', ...base };

  // The body is authoritative: a 201 must say 001/002, a 400 must say 003.
  if (http.status === 201 && (reply.responseCode === RESPONSE_CODES.AUTHORIZED || reply.responseCode === RESPONSE_CODES.AUTHORIZED_WITH_ALERT)) {
    return {
      outcome: reply.responseCode === RESPONSE_CODES.AUTHORIZED ? 'authorized' : 'authorized_with_alert',
      reply,
      ...(reply.responseUuid && { protocolNumber: reply.responseUuid }),
      ...base,
    };
  }
  if (reply.responseCode === RESPONSE_CODES.REJECTED || http.status === 400) {
    return { outcome: 'rejected', reply, ...base };
  }
  return { outcome: 'unexpected', reply, ...base };
}
