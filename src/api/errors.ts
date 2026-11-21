/**
 * One error format for every API response:
 *   { "error": { "code": "invalid_document", "message": "...", "details": ... } }
 * Engine errors are mapped to HTTP statuses here, so routes can simply throw.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

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
  const e = error as FastifyError & { btsCode?: number; name?: string };
  if (e?.validation) return new ApiError(400, 'invalid_request', e.message, e.validation);
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) return new ApiError(e.statusCode, 'invalid_request', e.message);
  switch (e?.name) {
    case 'CertificateError':
      return new ApiError(422, 'certificate_problem', e.message, e.btsCode ? { btsCode: e.btsCode } : undefined);
    case 'TenantError':
      return /^Unknown/.test(e.message) ? notFound('Tenant') : new ApiError(409, 'tenant_not_ready', e.message);
    case 'PipelineError':
      return /^Unknown/.test(e.message) ? notFound('Document') : new ApiError(409, 'conflict', e.message);
    case 'PrintError':
      return new ApiError(409, 'not_printable', e.message);
    case 'PfxError':
      return new ApiError(422, 'certificate_problem', e.message);
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
