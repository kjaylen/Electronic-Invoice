/** Roles as people see them. The server decides; this only shapes the screens (same table as src/api/permissions.ts). */

import type { Role } from './api';

export const ROLE_ORDER: Role[] = ['owner', 'admin', 'manager', 'cashier', 'accountant'];
/** Roles of the hospitality module: offered only to restaurants, bars and hotels. */
export const VENUE_ROLES: Role[] = ['supervisor', 'server', 'bartender', 'host', 'kitchen', 'housekeeper'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  accountant: 'Accountant',
  supervisor: 'Supervisor',
  server: 'Server',
  bartender: 'Bartender',
  host: 'Host',
  kitchen: 'Kitchen',
  housekeeper: 'Housekeeper',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Everything, including managing owners and admins.',
  admin: 'Everything except managing owners and admins: users, business details, certificate, API keys, activity.',
  manager: 'Issue all documents including credit and debit notes, cancel, send, manage customers and items, record payments and expenses, see reports.',
  cashier: 'Issue and send tax invoices and receipts, and record payments. Can add a customer while selling.',
  accountant: 'Documents, reports and downloads; records payments received and expenses.',
  supervisor: 'Takes orders and payment like a server, and approves voids, comps and discounts with their PIN.',
  server: 'Opens tables, takes and sends orders, takes payment.',
  bartender: 'Runs bar tabs and quick sales, takes payment.',
  host: 'The floor, reservations and the waitlist. Seats parties; takes no orders or money.',
  kitchen: 'The kitchen screen: sees orders, marks them done, marks items sold out.',
  housekeeper: 'The rooms to clean and their status.',
};

const RANK: Record<Role, number> = { owner: 4, admin: 3, manager: 2, supervisor: 1, cashier: 1, accountant: 1, server: 1, bartender: 1, host: 1, kitchen: 1, housekeeper: 1 };

/** Roles the person may give to others. */
export function assignableRoles(actor: Role, venue = false): Role[] {
  const all = venue ? [...ROLE_ORDER, ...VENUE_ROLES] : ROLE_ORDER;
  if (actor === 'owner') return all;
  if (actor === 'admin') return all.filter((r) => RANK[r] < RANK.admin);
  return [];
}
