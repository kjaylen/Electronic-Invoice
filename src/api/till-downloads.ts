/**
 * The till apps' installers and their updates, from a folder on the server (TILL_DOWNLOADS_DIR):
 *
 *   GET /downloads/till/<file>   the files as they are: the desktop app's update files (latest.yml,
 *                                latest-mac.yml, latest-linux.yml, written by electron-builder), its
 *                                installers, android.json and the Android APK (scripts/release-android.mjs)
 *   GET /v1/pos/downloads        what is there, for the tills and Settings → Tills:
 *                                { windows?, mac?, linux?, android? } each { version, file, url }
 *
 * A desktop till asks the server it is paired with for its updates, so staging's tills update from
 * staging and production's from production. Releasing is copying a new build into the folder; the
 * newest one there is the one offered (nothing is kept in the database).
 */

import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export type TillDownload = { version: string; file: string; url: string };
export type TillDownloads = { windows?: TillDownload; mac?: TillDownload; linux?: TillDownload; android?: TillDownload & { versionCode: number } };

export const TILL_DOWNLOADS_PREFIX = '/downloads/till/';
const SAFE_FILE = /^[\w][\w.+-]{0,150}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** The version and a file from one of electron-builder's latest*.yml files (a few known keys; no YAML library needed). */
function fromYml(dir: string, name: string, pick: (text: string) => string | undefined): TillDownload | undefined {
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
  const file = pick(text);
  if (!version || !VERSION.test(version) || !file || !SAFE_FILE.test(file)) return undefined;
  return { version, file, url: `${TILL_DOWNLOADS_PREFIX}${file}` };
}
const unquote = (s: string | undefined) => s?.trim().replace(/^['"]|['"]$/g, '');
const mainPath = (text: string) => unquote(/^path:\s*(.+)$/m.exec(text)?.[1]);
/** The first file listed with this ending (a Mac's .dmg to download; its update is the .zip). */
const listed = (ending: string) => (text: string) => [...text.matchAll(/^\s*-\s*url:\s*(.+)$/gm)].map((m) => unquote(m[1])).find((u) => u?.endsWith(ending)) ?? mainPath(text);

export function readTillDownloads(dir: string | undefined): TillDownloads {
  if (!dir || !existsSync(dir)) return {};
  const out: TillDownloads = {};
  const windows = fromYml(dir, 'latest.yml', mainPath);
  const mac = fromYml(dir, 'latest-mac.yml', listed('.dmg'));
  const linux = fromYml(dir, 'latest-linux.yml', mainPath);
  if (windows) out.windows = windows;
  if (mac) out.mac = mac;
  if (linux) out.linux = linux;
  try {
    const a = JSON.parse(readFileSync(join(dir, 'android.json'), 'utf8')) as { version?: unknown; versionCode?: unknown; file?: unknown };
    if (typeof a.version === 'string' && VERSION.test(a.version) && typeof a.file === 'string' && SAFE_FILE.test(a.file) && Number.isInteger(a.versionCode) && existsSync(join(dir, a.file))) {
      out.android = { version: a.version, versionCode: a.versionCode as number, file: a.file, url: `${TILL_DOWNLOADS_PREFIX}${a.file}` };
    }
  } catch { /* no Android build here */ }
  return out;
}

export async function registerTillDownloads(app: FastifyInstance, dir: string | undefined) {
  app.get('/v1/pos/downloads', async (_request, reply) => reply.header('Cache-Control', 'no-cache').send(readTillDownloads(dir)));
  if (!dir) return;
  await app.register(fastifyStatic, {
    root: dir,
    prefix: TILL_DOWNLOADS_PREFIX,
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: 'deny',
    setHeaders: (reply, path) => {
      // What is newest must never be cached; the installers carry their version in their names.
      if (/\.(yml|json)$/.test(path)) reply.header('Cache-Control', 'no-cache');
      else reply.header('Cache-Control', 'public, max-age=3600');
      if (path.endsWith('.apk')) reply.header('Content-Type', 'application/vnd.android.package-archive');
    },
  });
}
