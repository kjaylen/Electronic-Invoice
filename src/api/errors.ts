/**
 * One error format for every API response:
 *   { "error": { "code": "invalid_document", "message": "...", "details": ... } }
 * Engine errors are mapped to HTTP statuses here, so routes can simply throw.
 *
 * A request that does not fit a route's schema answers 400 `invalid_request`
 * with a message in plain words that names the field (validation-words.ts);
 * `details` keeps the validator's own findings.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { describeValidation, type ValidationFinding } from './validation-words.ts';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);

/** Engine error classes whose messages are safe and useful to show the caller. */
const INVALID_DOCUMENT = new Set(['CalcError', 'UblError', 'EtduiError', 'EventError', 'XmlError', 'SequenceError']);

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const e = error as FastifyError & { btsCode?: number; name?: string; validationContext?: string };
  if (e?.validation) {
    const first = e.validation[0] as ValidationFinding | undefined;
    return new ApiError(400, 'invalid_request', first ? describeValidation(first, e.validationContext) : e.message, e.validation);
  }
  // What the server itself refuses before a route runs: a body that is not JSON, or not said to be.
  if (e?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return new ApiError(415, 'invalid_request', 'Send the body as JSON, with the header Content-Type: application/json');
  if (e?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') return new ApiError(400, 'invalid_request', 'The body is empty. Send JSON, or leave out the Content-Type header when there is nothing to send.');
  if (e?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new ApiError(413, 'invalid_request', 'The request body is too large');
  if (e?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || (e instanceof SyntaxError && e.statusCode === 400)) return new ApiError(400, 'invalid_request', 'The body is not valid JSON. Look for a missing quote, comma or bracket.');
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) return new ApiError(e.statusCode, 'invalid_request', e.message);
  switch (e?.name) {
    case 'CertificateError':
      return new ApiError(422, 'certificate_problem', e.message, e.btsCode ? { btsCode: e.btsCode } : undefined);
    case 'TenantError':
      if (/^Unknown/.test(e.message)) return notFound('Tenant');
      if (/^(Address|TIN|District)/.test(e.message)) return new ApiError(422, 'invalid_business', e.message);
      return new ApiError(409, 'tenant_not_ready', e.message);
    case 'PipelineError':
      return /^Unknown/.test(e.message) ? notFound('Document') : new ApiError(409, 'conflict', e.message);
    case 'PrintError':
      return new ApiError(409, 'not_printable', e.message);
    case 'PfxError':
      return new ApiError(422, 'certificate_problem', e.message);
    case 'AccountError':
      return new ApiError(422, 'invalid_account', e.message);
    case 'MailNotConfigured':
      return new ApiError(503, 'email_unavailable', 'Email is not set up on this server');
    case 'StoreError': {
      const code = (e as unknown as { code: string }).code;
      const status = code === 'not_found' || code === 'store_closed' ? 404 : code === 'invalid_order' ? 422 : 409;
      return new ApiError(status, code, e.message);
    }
    case 'GiftCardError': {
      const code = (e as unknown as { code: string }).code;
      return new ApiError(code === 'not_found' ? 404 : 422, code === 'not_found' ? 'gift_card_not_found' : `gift_card_${code}`, e.message);
    }
    case 'BuyerError': {
      const code = (e as unknown as { code: string }).code;
      return new ApiError(code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422, code, e.message);
    }
    case 'BillingError':
      return new ApiError(402, (e as unknown as { code: string }).code, e.message);
    case 'TwoFactorError':
      return new ApiError(422, (e as unknown as { code: string }).code, e.message);
    case 'KeystoreError':
      return new ApiError(500, 'internal_error', 'Internal error');
    default:
      if (e?.name && INVALID_DOCUMENT.has(e.name)) return new ApiError(422, 'invalid_document', e.message);
      return new ApiError(500, 'internal_error', 'Internal error');
  }
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const api = toApiError(error);
  if (api.status >= 500) request.log.error({ err: error }, 'request failed');
  return reply.code(api.status).send({ error: { code: api.code, message: api.message, ...(api.details !== undefined && { details: api.details }) } });
}
