/** Roles as people see them. The server decides; this only shapes the screens (same table as src/api/permissions.ts). */

import type { Role } from './api';

export const ROLE_ORDER: Role[] = ['owner', 'admin', 'manager', 'cashier', 'accountant'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  accountant: 'Accountant',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Everything, including managing owners and admins.',
  admin: 'Everything except managing owners and admins: users, business details, certificate, API keys, activity.',
  manager: 'Issue all documents including credit and debit notes, cancel, send, manage customers and items, see reports.',
  cashier: 'Issue and send tax invoices and receipts. Can add a customer while selling.',
  accountant: 'Read-only: documents, reports and downloads.',
};

const RANK: Record<Role, number> = { owner: 4, admin: 3, manager: 2, cashier: 1, accountant: 1 };

/** Roles the person may give to others. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === 'owner') return ROLE_ORDER;
  if (actor === 'admin') return ROLE_ORDER.filter((r) => RANK[r] < RANK.admin);
  return [];
}
