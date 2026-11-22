/**
 * Roles and what each may do. Fixed roles, so every business reads them the
 * same way; the web app shows the same table (web/src/permissions.ts).
 *
 *   owner       everything; the only role that can manage owners and admins
 *   admin       everything except managing owners and admins
 *   manager     issue all documents, cancel, send, catalog, reports
 *   cashier     issue invoices and receipts, send them; read the catalog
 *   accountant  read documents and reports; download records
 *
 * API keys act for the business's software: they can issue, cancel, send,
 * manage the catalog and read reports, but never manage people or keys.
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

export const ROLES = ['owner', 'admin', 'manager', 'cashier', 'accountant'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'documents.issue', // tax invoices and receipts
  'documents.adjust', // credit and debit notes
  'documents.cancel',
  'documents.send',
  'catalog.manage', // add, edit, archive customers and items
  'reports.view',
  'business.manage', // business details and the BTS certificate
  'users.manage',
  'apikeys.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
export const ROLE_PERMISSIONS: Record<Role | 'api', ReadonlySet<Permission>> = {
  owner: ALL,
  admin: ALL,
  manager: new Set(['documents.issue', 'documents.adjust', 'documents.cancel', 'documents.send', 'catalog.manage', 'reports.view']),
  cashier: new Set(['documents.issue', 'documents.send']),
  accountant: new Set(['reports.view']),
  api: new Set(['documents.issue', 'documents.adjust', 'documents.cancel', 'documents.send', 'catalog.manage', 'reports.view', 'business.manage']),
};

/** Higher can manage lower. Owners manage everyone; admins manage managers, cashiers and accountants. */
export const RANK: Record<Role, number> = { owner: 4, admin: 3, manager: 2, cashier: 1, accountant: 1 };

export function can(principal: Role | 'api', permission: Permission): boolean {
  return ROLE_PERMISSIONS[principal].has(permission);
}

/** May `actor` create, change or deactivate an account with role `target`? */
export function canManageRole(actor: Role, target: Role): boolean {
  return actor === 'owner' || (RANK[actor] > RANK[target] && can(actor, 'users.manage'));
}

export function requirePermission(request: FastifyRequest, permission: Permission) {
  if (!can(request.principal, permission)) {
    throw new ApiError(403, 'forbidden', 'Your role does not allow this. Ask an owner or admin of this business.');
  }
}

/** Routes about people (users, keys, the activity log) are for signed-in people only, never API keys. */
export function requirePersonWith(request: FastifyRequest, permission: Permission) {
  if (request.principal === 'api') throw new ApiError(403, 'forbidden', 'This is managed in the web app, not with an API key');
  requirePermission(request, permission);
}
