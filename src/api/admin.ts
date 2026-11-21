/** Onboarding routes, behind the admin token. */

import type { FastifyInstance } from 'fastify';
import { createApiKey, revokeApiKey } from '../db/apikeys.ts';
import { addCertificate, createTenant, type NewTenant } from '../db/tenants.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { notFound } from './errors.ts';
import { certificateSchema, tenantSchema, uuid } from './schemas.ts';

const tenantParams = { type: 'object', required: ['tenantId'], properties: { tenantId: uuid } } as const;

export function registerAdminRoutes(app: FastifyInstance, deps: PipelineDeps) {
  const { db, keys } = deps;
  const exists = async (tenantId: string) => (await db.query('select 1 from tenants where id = $1', [tenantId])).rows.length === 1;

  app.post<{ Body: NewTenant }>('/tenants', { schema: { body: tenantSchema } }, async (request, reply) => {
    const duplicate = await db.query('select 1 from tenants where tin = $1 and environment = $2', [request.body.tin, request.body.environment]);
    if (duplicate.rows.length) {
      return reply.code(409).send({ error: { code: 'conflict', message: 'A business with this TIN already exists in this environment' } });
    }
    const id = await createTenant(db, request.body);
    return reply.code(201).send({ id });
  });

  app.post<{ Params: { tenantId: string }; Body: { certificatePem: string; privateKeyPem: string; passphrase?: string } }>(
    '/tenants/:tenantId/certificate',
    { schema: { params: tenantParams, body: certificateSchema } },
    async (request, reply) => {
      if (!(await exists(request.params.tenantId))) throw notFound('Tenant');
      const id = await addCertificate(db, keys, request.params.tenantId, request.body);
      return reply.code(201).send(await certificateSummary(deps, request.params.tenantId, id));
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { name: string } }>(
    '/tenants/:tenantId/api-keys',
    { schema: { params: tenantParams, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 100 } } } } },
    async (request, reply) => {
      if (!(await exists(request.params.tenantId))) throw notFound('Tenant');
      const key = await createApiKey(db, request.params.tenantId, request.body.name);
      // The key is shown once and never stored.
      return reply.code(201).send({ id: key.id, name: request.body.name, prefix: key.prefix, key: key.key });
    },
  );

  app.delete<{ Params: { tenantId: string; keyId: string } }>(
    '/tenants/:tenantId/api-keys/:keyId',
    { schema: { params: { type: 'object', required: ['tenantId', 'keyId'], properties: { tenantId: uuid, keyId: uuid } } } },
    async (request, reply) => {
      if (!(await revokeApiKey(db, request.params.tenantId, request.params.keyId))) throw notFound('API key');
      return reply.code(204).send();
    },
  );
}

export async function certificateSummary(deps: PipelineDeps, tenantId: string, certificateId?: string) {
  const row = (
    await deps.db.query<{ id: string; subject_tin: string; serial_number: string; valid_from: string | Date; valid_to: string | Date; status: string }>(
      `select id, subject_tin, serial_number, valid_from, valid_to, status from certificates
       where tenant_id = $1 and ${certificateId ? 'id = $2' : "status = 'active'"}`,
      certificateId ? [tenantId, certificateId] : [tenantId],
    )
  ).rows[0];
  if (!row) return null;
  const validTo = new Date(row.valid_to);
  return {
    id: row.id,
    tin: row.subject_tin,
    serialNumber: row.serial_number,
    validFrom: new Date(row.valid_from).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
    status: row.status,
  };
}
