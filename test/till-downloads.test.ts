/**
 * The till apps' installers and updates from the server's TILL_DOWNLOADS_DIR: what /v1/pos/downloads
 * lists (read from electron-builder's update files and android.json), and the files themselves, with
 * the update files never cached.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/api/app.ts';
import { readTillDownloads } from '../src/api/till-downloads.ts';
import { setupPipeline } from './pipeline-setup.ts';

/** A release folder as electron-builder and scripts/release-android.mjs leave it. */
function releaseFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'till-downloads-'));
  writeFileSync(join(dir, 'latest.yml'), [
    'version: 1.2.0',
    'files:',
    '  - url: Floreo-Till-Setup-1.2.0.exe',
    '    sha512: abc==',
    '    size: 1000',
    'path: Floreo-Till-Setup-1.2.0.exe',
    'sha512: abc==',
    "releaseDate: '2026-11-27T10:00:00.000Z'",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'Floreo-Till-Setup-1.2.0.exe'), 'MZ the installer');
  writeFileSync(join(dir, 'latest-mac.yml'), ['version: 1.2.0', 'files:', '  - url: Floreo-Till-1.2.0.zip', '    sha512: z==', '  - url: Floreo-Till-1.2.0.dmg', '    sha512: d==', 'path: Floreo-Till-1.2.0.zip', ''].join('\n'));
  writeFileSync(join(dir, 'android.json'), JSON.stringify({ version: '1.2.0', versionCode: 10200, file: 'Floreo-Till-1.2.0.apk', sha256: 'f'.repeat(64) }));
  writeFileSync(join(dir, 'Floreo-Till-1.2.0.apk'), 'PK the app');
  return dir;
}

test('till downloads: what is in the folder is listed, with the Mac offered as its .dmg; nothing configured lists nothing', () => {
  const dir = releaseFolder();
  assert.deepEqual(readTillDownloads(dir), {
    windows: { version: '1.2.0', file: 'Floreo-Till-Setup-1.2.0.exe', url: '/downloads/till/Floreo-Till-Setup-1.2.0.exe' },
    mac: { version: '1.2.0', file: 'Floreo-Till-1.2.0.dmg', url: '/downloads/till/Floreo-Till-1.2.0.dmg' },
    android: { version: '1.2.0', versionCode: 10200, file: 'Floreo-Till-1.2.0.apk', url: '/downloads/till/Floreo-Till-1.2.0.apk' },
  });
  assert.deepEqual(readTillDownloads(undefined), {});
  assert.deepEqual(readTillDownloads(join(dir, 'nowhere')), {});

  // Android announced before its APK was copied: not offered. A file name that reaches out of the folder: not offered.
  const early = mkdtempSync(join(tmpdir(), 'till-downloads-'));
  writeFileSync(join(early, 'android.json'), JSON.stringify({ version: '1.3.0', versionCode: 10300, file: 'Floreo-Till-1.3.0.apk' }));
  writeFileSync(join(early, 'latest.yml'), 'version: 1.3.0\npath: ../../etc/passwd\n');
  assert.deepEqual(readTillDownloads(early), {});
});

test('till downloads: the list without signing in, the files served, the update files never cached', async () => {
  const dir = releaseFolder();
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, tillDownloads: dir });
  const bare = await buildApp({ pipeline: f.deps, cookieSecure: true });
  try {
    const list = await app.inject({ method: 'GET', url: '/v1/pos/downloads' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().windows.version, '1.2.0');

    const yml = await app.inject({ method: 'GET', url: '/downloads/till/latest.yml' });
    assert.equal(yml.statusCode, 200);
    assert.equal(yml.headers['cache-control'], 'no-cache');
    assert.match(yml.body, /^version: 1\.2\.0/);

    const exe = await app.inject({ method: 'GET', url: '/downloads/till/Floreo-Till-Setup-1.2.0.exe' });
    assert.deepEqual([exe.statusCode, exe.body, exe.headers['cache-control']], [200, 'MZ the installer', 'public, max-age=3600']);
    const apk = await app.inject({ method: 'GET', url: '/downloads/till/Floreo-Till-1.2.0.apk' });
    assert.equal(apk.headers['content-type'], 'application/vnd.android.package-archive');

    // No folder listing, nothing outside it.
    assert.ok([403, 404].includes((await app.inject({ method: 'GET', url: '/downloads/till/' })).statusCode));
    assert.notEqual((await app.inject({ method: 'GET', url: '/downloads/till/..%2F..%2Fpackage.json' })).statusCode, 200);

    // A server with no folder: an empty list, no files.
    assert.deepEqual((await bare.inject({ method: 'GET', url: '/v1/pos/downloads' })).json(), {});
    assert.equal((await bare.inject({ method: 'GET', url: '/downloads/till/latest.yml' })).statusCode, 404);
  } finally {
    await app.close();
    await bare.close();
    await f.close();
  }
});
