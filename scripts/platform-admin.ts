/**
 * Manage platform console staff from the command line (there is no sign-up).
 *
 *   npm run platform-admin -- add you@example.com "Your Name"   create; prints a generated password once
 *   npm run platform-admin -- reset you@example.com             new password, signs out everywhere
 *   npm run platform-admin -- disable you@example.com           (and: enable)
 *   npm run platform-admin -- list
 *
 * Uses DATABASE_URL. Set PLATFORM_ADMIN_PASSWORD to choose the password
 * instead of generating one. The console is at <PUBLIC_URL>/admin.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, pgDatabase } from '../src/db/database.ts';
import { createPlatformAdmin, listPlatformAdmins, setPlatformAdminPassword, setPlatformAdminStatus } from '../src/db/platform.ts';

const [command, email, ...nameParts] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !command) {
  console.error('Usage: npm run platform-admin -- add|reset|disable|enable|list [email] ["Name"]   (needs DATABASE_URL)');
  process.exit(1);
}

/** 20 readable characters, no look-alikes. */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{5})(?=.)/g, '$1-');
}

const db = pgDatabase(new pg.Pool({ connectionString: url, max: 2 }));
try {
  await migrate(db);
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? generatePassword();
  switch (command) {
    case 'add': {
      if (!email || !nameParts.length) throw new Error('Give an email and a name: add you@example.com "Your Name"');
      const a = await createPlatformAdmin(db, { email, name: nameParts.join(' '), password });
      console.log(`Created platform admin ${a.email}.`);
      if (!process.env.PLATFORM_ADMIN_PASSWORD) console.log(`Password (shown once): ${password}`);
      break;
    }
    case 'reset':
      if (!email || !(await setPlatformAdminPassword(db, email, password))) throw new Error(`No platform admin ${email ?? ''}`);
      console.log(`New password for ${email}${process.env.PLATFORM_ADMIN_PASSWORD ? ' set' : ` (shown once): ${password}`}. All their sessions were signed out.`);
      break;
    case 'disable':
    case 'enable':
      if (!email || !(await setPlatformAdminStatus(db, email, command === 'disable' ? 'disabled' : 'active'))) throw new Error(`No platform admin ${email ?? ''}`);
      console.log(`${email} ${command}d.`);
      break;
    case 'list':
      for (const a of await listPlatformAdmins(db)) console.log(`${a.status === 'active' ? ' ' : 'x'} ${a.email}  ${a.name}  last sign-in: ${a.lastLoginAt ?? 'never'}`);
      break;
    default:
      throw new Error(`Unknown command ${command}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
