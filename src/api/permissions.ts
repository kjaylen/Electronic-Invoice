/**
 * Roles and what each may do. Fixed roles, so every business reads them the
 * same way; the web app shows the same table (web/src/permissions.ts).
 *
 *   owner       everything; the only role that can manage owners and admins
 *   admin       everything except managing owners and admins
 *   manager     issue all documents, cancel, send, catalog and products, online orders, payments, expenses, reports
 *   cashier     issue invoices and receipts, send them, handle online orders, record payments; read the catalog
 *   accountant  read documents and reports; record payments and expenses; download records
 *
 * For restaurants, bars and hotels (the hospitality module):
 *   supervisor  a server who can also approve voids, comps and discounts, and issue credit notes
 *   server      take orders at tables, send them, take payment
 *   bartender   the same, at the bar
 *   host        the floor, reservations and the waitlist; seats parties, takes no orders or money
 *   kitchen     the kitchen screen: see orders, mark them done, mark items sold out
 *   housekeeper rooms to clean and their status, nothing else
 *
 * API keys act for the business's software: they can issue, cancel, send,
 * manage the catalog and read reports, but never manage people or keys.
 */

import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

export const ROLES = ['owner', 'admin', 'manager', 'cashier', 'accountant', 'supervisor', 'server', 'bartender', 'host', 'kitchen', 'housekeeper'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'documents.issue', // tax invoices and receipts
  'documents.adjust', // credit and debit notes
  'documents.cancel',
  'documents.send',
  'catalog.manage', // add, edit, archive customers, items and products
  'orders.manage', // online orders: mark fulfilled, cancel unpaid ones
  'payments.record', // money received against invoices; statements and reminders to customers
  'expenses.manage', // suppliers, expenses and bills to pay, with their receipts
  'reports.view',
  'business.manage', // business details and the BTS certificate
  'users.manage',
  'apikeys.manage',
  'audit.view',
  'venue.orders', // open tables and tabs, take and send orders
  'venue.approve', // voids after sending, comps, discounts over the limit, reopening a bill
  'venue.floor', // seat parties, reservations, the waitlist, sections
  'venue.kitchen', // the kitchen screen: bump orders, mark items sold out
  'hotel.frontdesk', // bookings, check-in and check-out, folios
  'hotel.housekeeping', // room status and the cleaning list
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
export const ROLE_PERMISSIONS: Record<Role | 'api', ReadonlySet<Permission>> = {
  owner: ALL,
  admin: ALL,
  manager: new Set(['documents.issue', 'documents.adjust', 'documents.cancel', 'documents.send', 'catalog.manage', 'orders.manage', 'payments.record', 'expenses.manage', 'reports.view',
    'venue.orders', 'venue.approve', 'venue.floor', 'venue.kitchen', 'hotel.frontdesk', 'hotel.housekeeping']),
  cashier: new Set(['documents.issue', 'documents.send', 'orders.manage', 'payments.record', 'venue.orders', 'venue.floor', 'hotel.frontdesk']),
  supervisor: new Set(['documents.issue', 'documents.adjust', 'documents.send', 'payments.record', 'venue.orders', 'venue.approve', 'venue.floor', 'venue.kitchen']),
  server: new Set(['documents.issue', 'documents.send', 'payments.record', 'venue.orders']),
  bartender: new Set(['documents.issue', 'documents.send', 'payments.record', 'venue.orders']),
  host: new Set(['venue.floor']),
  kitchen: new Set(['venue.kitchen']),
  housekeeper: new Set(['hotel.housekeeping']),
  accountant: new Set(['reports.view', 'payments.record', 'expenses.manage']),
  api: new Set(['documents.issue', 'documents.adjust', 'documents.cancel', 'documents.send', 'catalog.manage', 'orders.manage', 'payments.record', 'expenses.manage', 'reports.view', 'business.manage']),
};

/** Higher can manage lower. Owners manage everyone; admins manage managers, cashiers and accountants. */
export const RANK: Record<Role, number> = { owner: 4, admin: 3, manager: 2, supervisor: 1, cashier: 1, accountant: 1, server: 1, bartender: 1, host: 1, kitchen: 1, housekeeper: 1 };

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
