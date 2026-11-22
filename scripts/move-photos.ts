/**
 * Move product photos from the database to object storage (S3_* settings),
 * in batches. Each photo is uploaded first, then its row switched to the
 * storage key and its bytes cleared, so a stop half-way loses nothing; run
 * it again to continue.
 *
 *   npm run move-photos              (add -- --dry-run to only count)
 *
 * Uses DATABASE_URL and the same S3_* variables as the server.
 */

import pg from 'pg';
import { migrate, pgDatabase } from '../src/db/database.ts';
import { objectStoreFromEnv, photoKey } from '../src/storage/objects.ts';

const dryRun = process.argv.includes('--dry-run');
const store = objectStoreFromEnv();
if (!process.env.DATABASE_URL || !store) {
  console.error('Set DATABASE_URL and the S3_* variables (S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).');
  process.exit(1);
}
const db = pgDatabase(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
try {
  await migrate(db);
  const total = (await db.query<{ n: number }>('select count(*)::int as n from product_images where storage_key is null')).rows[0]!.n;
  console.log(`${total} photo(s) in the database.`);
  if (!dryRun) {
    let moved = 0;
    for (;;) {
      const batch = (await db.query<{ id: string; tenant_id: string; content_type: string; data: Uint8Array }>(
        'select id, tenant_id, content_type, data from product_images where storage_key is null order by created_at limit 50',
      )).rows;
      if (!batch.length) break;
      for (const img of batch) {
        const key = photoKey(img.tenant_id, img.id, img.content_type);
        await store.put(key, Buffer.from(img.data), img.content_type);
        await db.query('update product_images set storage_key = $2, data = null where id = $1 and storage_key is null', [img.id, key]);
        moved++;
      }
      console.log(`Moved ${moved} of ${total}…`);
    }
    console.log('Done.');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
