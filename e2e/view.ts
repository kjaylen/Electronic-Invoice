/**
 * Look around the app as the browser tests left it: the demo server on the
 * tests' database and folder, without wiping them (npm run e2e does that).
 * Sign in at http://localhost:3110/corner-store/login as the owner in
 * e2e/app.spec.ts.
 *
 *   npm run e2e            (once, to make the business and its data)
 *   node e2e/view.ts
 */

import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const admin = new URL(process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://einvoicing:einvoicing@localhost:5432/einvoicing');
admin.pathname = `/${process.env.E2E_DATABASE_NAME ?? 'einvoicing_e2e'}`;

Object.assign(process.env, {
  DATABASE_URL: admin.toString(),
  DEMO_DIR: `${root}.demo-e2e`,
  PORT: process.env.VIEW_PORT ?? '3110',
  DEMO_BTS_PORT: process.env.VIEW_BTS_PORT ?? '8643',
  DEMO_MAIL_PORT: process.env.VIEW_MAIL_PORT ?? '3135',
  DEMO_MAIL_VIEW_PORT: process.env.VIEW_MAIL_VIEW_PORT ?? '3190',
});
await import('../scripts/demo.ts');
