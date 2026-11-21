/**
 * Teammates: who belongs to a business, and invitations to join it.
 *
 * Invitation tokens are 32 random bytes, sent by email (or shared by the
 * owner); only their SHA-256 is stored. A business always keeps at least one
 * owner.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { AccountError, normalizeEmail, type Role, tokenHash } from './users.ts';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

const iso = (v: string | Date) => new Date(v).toISOString();

export async function teamMembers(db: Database, tenantId: string): Promise<TeamMember[]> {
  const rows = (await db.query<{ user_id: string; name: string; email: string; role: Role; created_at: string | Date }>(
    `select m.user_id, u.name, u.email, m.role, m.created_at from memberships m join users u on u.id = m.user_id
     where m.tenant_id = $1 order by m.created_at`,
    [tenantId],
  )).rows;
  return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, joinedAt: iso(r.created_at) }));
}

export async function pendingInvitations(db: Database, tenantId: string): Promise<Invitation[]> {
  const rows = (await db.query<{ id: string; tenant_id: string; email: string; role: Role; created_at: string | Date; expires_at: string | Date }>(
    `select id, tenant_id, email, role, created_at, expires_at from invitations
     where tenant_id = $1 and accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc`,
    [tenantId],
  )).rows;
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, email: r.email, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) }));
}

/** Invite someone by email. A newer invitation to the same address replaces the older one. */
export async function createInvitation(db: Database, input: { tenantId: string; email: string; role: Role; invitedBy: string }): Promise<Invitation & { token: string }> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('Enter a valid email address');
  const member = await db.query(
    'select 1 from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and lower(u.email) = $2', [input.tenantId, email],
  );
  if (member.rows.length) throw new AccountError('This person is already on the team');
  await db.query('update invitations set revoked_at = now() where tenant_id = $1 and email = $2 and accepted_at is null and revoked_at is null', [input.tenantId, email]);
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.query(
    'insert into invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $4, $5, $6, $7)',
    [id, input.tenantId, email, input.role, tokenHash(token), input.invitedBy, expiresAt.toISOString()],
  );
  return { id, tenantId: input.tenantId, email, role: input.role, createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(), token };
}

export interface InvitationDetails extends Invitation {
  businessName: string;
  invitedByName: string;
}

/** A usable invitation (not accepted, revoked or expired) for this token. */
export async function findInvitation(db: Database, token: string): Promise<InvitationDetails | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = (await db.query<{ id: string; tenant_id: string; email: string; role: Role; created_at: string | Date; expires_at: string | Date; business: string; invited_by_name: string }>(
    `select i.id, i.tenant_id, i.email, i.role, i.created_at, i.expires_at, coalesce(t.trade_name, t.legal_name) as business, u.name as invited_by_name
     from invitations i join tenants t on t.id = i.tenant_id join users u on u.id = i.invited_by
     where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`,
    [tokenHash(token)],
  )).rows[0];
  if (!r) return null;
  return { id: r.id, tenantId: r.tenant_id, email: r.email, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), businessName: r.business, invitedByName: r.invited_by_name };
}

/** Accept: the person joins the business with the invited role. Returns false if the invitation was used meanwhile. */
export async function acceptInvitation(db: Database, invitation: Invitation, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const claimed = await tx.query('update invitations set accepted_at = now() where id = $1 and accepted_at is null and revoked_at is null returning id', [invitation.id]);
    if (!claimed.rows.length) return false;
    // Never downgrade someone who is already an owner.
    await tx.query(
      `insert into memberships (user_id, tenant_id, role) values ($1, $2, $3)
       on conflict (user_id, tenant_id) do update set role = case when memberships.role = 'owner' then 'owner' else excluded.role end`,
      [userId, invitation.tenantId, invitation.role],
    );
    return true;
  });
}

export async function revokeInvitation(db: Database, tenantId: string, id: string): Promise<boolean> {
  const r = await db.query('update invitations set revoked_at = now() where id = $1 and tenant_id = $2 and accepted_at is null and revoked_at is null returning id', [id, tenantId]);
  return r.rows.length > 0;
}

async function ownerCount(db: Database, tenantId: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from memberships where tenant_id = $1 and role = 'owner'`, [tenantId])).rows[0]!.n;
}

/** Change a teammate's role. Refuses to leave the business without an owner. */
export async function setMemberRole(db: Database, tenantId: string, userId: string, role: Role): Promise<'ok' | 'not_found' | 'last_owner'> {
  return db.transaction(async (tx) => {
    // Lock the business's memberships so two owners demoting each other at once cannot leave none.
    const rows = (await tx.query<{ user_id: string; role: Role }>('select user_id, role from memberships where tenant_id = $1 for update', [tenantId])).rows;
    const current = rows.find((r) => r.user_id === userId);
    if (!current) return 'not_found';
    if (current.role === 'owner' && role !== 'owner' && rows.filter((r) => r.role === 'owner').length <= 1) return 'last_owner';
    await tx.query('update memberships set role = $3 where tenant_id = $1 and user_id = $2', [tenantId, userId, role]);
    return 'ok';
  });
}

export async function removeMember(db: Database, tenantId: string, userId: string): Promise<'ok' | 'not_found' | 'last_owner'> {
  return db.transaction(async (tx) => {
    const rows = (await tx.query<{ user_id: string; role: Role }>('select user_id, role from memberships where tenant_id = $1 for update', [tenantId])).rows;
    const current = rows.find((r) => r.user_id === userId);
    if (!current) return 'not_found';
    if (current.role === 'owner' && rows.filter((r) => r.role === 'owner').length <= 1) return 'last_owner';
    await tx.query('delete from memberships where tenant_id = $1 and user_id = $2', [tenantId, userId]);
    return 'ok';
  });
}

export { ownerCount };
