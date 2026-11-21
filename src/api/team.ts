/**
 * Teammates (web app sessions only): see who is on the team, invite people
 * by email, change roles, remove people. Owners manage; anyone can leave.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createInvitation, pendingInvitations, removeMember, revokeInvitation, setMemberRole, teamMembers } from '../db/team.ts';
import type { Role } from '../db/users.ts';
import { simpleHtml } from '../mail/mailer.ts';
import type { PipelineDeps } from '../pipeline/issue.ts';
import { publicLink, type ServerContext } from './context.ts';
import { ApiError, notFound } from './errors.ts';
import { uuid } from './schemas.ts';

const requireSession = (request: FastifyRequest) => {
  if (request.principal === 'api') throw new ApiError(403, 'forbidden', 'Teammates are managed in the web app');
};
const requireOwnerSession = (request: FastifyRequest) => {
  if (request.principal !== 'owner') throw new ApiError(403, 'forbidden', 'Only an owner of this business can manage the team');
};
const role = { type: 'string', enum: ['owner', 'member'] } as const;

export function registerTeamRoutes(app: FastifyInstance, deps: PipelineDeps, ctx: ServerContext) {
  const { db } = deps;

  app.get('/team', async (request) => {
    requireSession(request);
    return {
      members: await teamMembers(db, request.tenantId),
      invitations: request.principal === 'owner' ? await pendingInvitations(db, request.tenantId) : [],
    };
  });

  app.post<{ Body: { email: string; role: Role } }>(
    '/team/invitations',
    { schema: { body: { type: 'object', required: ['email', 'role'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3, maxLength: 254 }, role } } } },
    async (request, reply) => {
      requireOwnerSession(request);
      publicLink(ctx, '/');
      const inv = await createInvitation(db, { tenantId: request.tenantId, email: request.body.email, role: request.body.role, invitedBy: request.userId });
      const link = publicLink(ctx, `/invite?token=${inv.token}`);
      const names = (await db.query<{ business: string; inviter: string }>(
        `select coalesce(t.trade_name, t.legal_name) as business, u.name as inviter from tenants t, users u where t.id = $1 and u.id = $2`,
        [request.tenantId, request.userId],
      )).rows[0]!;
      let emailSent = false;
      if (ctx.mailConfigured) {
        try {
          await ctx.mailer.send({
            to: inv.email,
            subject: `${names.inviter} invited you to ${names.business}`,
            text: `${names.inviter} invited you to issue electronic tax documents for ${names.business} on eInvoicing.\n\nAccept the invitation here (the link works for 7 days):\n${link}`,
            html: simpleHtml({
              heading: `Join ${names.business}`,
              paragraphs: [`${names.inviter} invited you to issue electronic tax documents for ${names.business} on eInvoicing.`, 'The link works for 7 days.'],
              button: { label: 'Accept the invitation', url: link },
            }),
          });
          emailSent = true;
        } catch (e) {
          request.log.error({ err: e }, 'invitation email failed');
        }
      }
      const { token: _token, ...invitation } = inv;
      // The link is returned to the owner too, so it can be shared another way (WhatsApp, in person).
      return reply.code(201).send({ invitation, inviteUrl: link, emailSent });
    },
  );

  app.delete<{ Params: { id: string } }>('/team/invitations/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    requireOwnerSession(request);
    if (!(await revokeInvitation(db, request.tenantId, request.params.id))) throw notFound('Invitation');
    return reply.code(204).send();
  });

  const lastOwner = () => new ApiError(409, 'last_owner', 'A business needs at least one owner. Make someone else an owner first.');

  app.patch<{ Params: { userId: string }; Body: { role: Role } }>(
    '/team/members/:userId',
    { schema: { params: { type: 'object', required: ['userId'], properties: { userId: uuid } }, body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role } } } },
    async (request) => {
      requireOwnerSession(request);
      const r = await setMemberRole(db, request.tenantId, request.params.userId, request.body.role);
      if (r === 'not_found') throw notFound('Teammate');
      if (r === 'last_owner') throw lastOwner();
      return { members: await teamMembers(db, request.tenantId) };
    },
  );

  app.delete<{ Params: { userId: string } }>('/team/members/:userId', { schema: { params: { type: 'object', required: ['userId'], properties: { userId: uuid } } } }, async (request, reply) => {
    requireSession(request);
    if (request.params.userId !== request.userId) requireOwnerSession(request);
    const r = await removeMember(db, request.tenantId, request.params.userId);
    if (r === 'not_found') throw notFound('Teammate');
    if (r === 'last_owner') throw lastOwner();
    return reply.code(204).send();
  });
}
