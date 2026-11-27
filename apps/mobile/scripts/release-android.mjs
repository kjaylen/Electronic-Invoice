/**
 * The Android release (run after `npm run sync`; `npm run release:android` does both):
 *
 *   node scripts/release-android.mjs [--to <server's TILL_DOWNLOADS_DIR>]
 *
 * Builds the signed bundle for Google Play (.aab) and the signed APK for installing from the server,
 * into release/:
 *   Floreo-Till-<version>.aab     upload to Google Play
 *   Floreo-Till-<version>.apk     what a till downloads when it is not installed from Google Play
 *   android.json                  { version, versionCode, file, sha256 }: tells tills it is there
 * With --to, the APK and then android.json are copied into that folder (android.json last, so no till
 * is told about a file that is not there yet).
 *
 * Signing: android/keystore.properties or FLOREO_ANDROID_* variables (README.md). Without them the
 * build stops: an unsigned APK cannot be installed, and one signed with a stray debug key could never
 * be updated by the real one.
 */

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const android = join(root, 'android');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
const versionCode = major * 10000 + minor * 100 + patch;
const toIndex = process.argv.indexOf('--to');
const to = toIndex > 0 ? process.argv[toIndex + 1] : null;

if (!existsSync(join(android, 'keystore.properties')) && !process.env.FLOREO_ANDROID_STORE_FILE) {
  console.error('No release key: create android/keystore.properties or set FLOREO_ANDROID_STORE_FILE and the other FLOREO_ANDROID_* variables (see README.md).');
  process.exit(1);
}

// By its full path: the Windows shell does not look in the current folder for gradlew.bat.
if (process.platform === 'win32') execSync(`"${join(android, 'gradlew.bat')}" bundleRelease assembleRelease`, { cwd: android, stdio: 'inherit' });
else execFileSync('./gradlew', ['bundleRelease', 'assembleRelease'], { cwd: android, stdio: 'inherit' });

const outputs = join(android, 'app', 'build', 'outputs');
const apk = join(outputs, 'apk', 'release', 'app-release.apk');
const aab = join(outputs, 'bundle', 'release', 'app-release.aab');
if (!existsSync(apk)) {
  console.error('No signed APK was made (app-release.apk): check the signing settings.');
  process.exit(1);
}
const release = join(root, 'release');
mkdirSync(release, { recursive: true });
const apkName = `Floreo-Till-${version}.apk`;
copyFileSync(apk, join(release, apkName));
if (existsSync(aab)) copyFileSync(aab, join(release, `Floreo-Till-${version}.aab`));
const sha256 = createHash('sha256').update(readFileSync(apk)).digest('hex');
writeFileSync(join(release, 'android.json'), `${JSON.stringify({ version, versionCode, file: apkName, sha256 }, null, 2)}\n`);
console.log(`Built ${apkName} (versionCode ${versionCode}) in release/`);

if (to) {
  const dest = resolve(to);
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(release, apkName), join(dest, apkName));
  copyFileSync(join(release, 'android.json'), join(dest, 'android.json'));
  console.log(`Published to ${dest}`);
}
