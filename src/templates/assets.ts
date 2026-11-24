/**
 * Images for templates: a business's logo and any picture it puts in an email, a printed
 * document or its store, used in Liquid as {{ 'banner.png' | asset_url }} and {{ business.logo }}.
 *
 * Where an image must load from decides its address:
 *   - printed documents (PDF): inlined as data: URLs, since the print browser has no network;
 *   - emails: the public address (PUBLIC_URL), or inlined when there is none (development);
 *   - the store and the editor's preview: the same-origin address.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSETS = 150;

export type AssetType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';
const EXTENSIONS: Record<AssetType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** The type from the file's first bytes; never the name or the browser's claim. */
export function assetType(data: Buffer): AssetType | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.length > 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = data.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if ((head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!--')) && /<svg[\s>]/.test(data.subarray(0, 4096).toString('utf8'))) return 'image/svg+xml';
  return null;
}

/** Width and height in pixels, when the format says (null otherwise). */
export function imageSize(data: Buffer, type: AssetType): { width: number; height: number } | null {
  try {
    if (type === 'image/png') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (type === 'image/gif') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) return null;
        const marker = data[i + 1]!;
        // Start-of-frame markers carry the size (not DHT 0xC4, JPG 0xC8, DAC 0xCC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
        i += 2 + data.readUInt16BE(i + 2);
      }
      return null;
    }
    if (type === 'image/webp') {
      const chunk = data.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b = data.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      return null;
    }
    const svg = /<svg\b[^>]*>/i.exec(data.toString('utf8'))?.[0] ?? '';
    const num = (attr: string) => Number(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(svg)?.[1]) || null;
    const box = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
    const width = num('width') ?? (box ? Number(box[1]) : null);
    const height = num('height') ?? (box ? Number(box[2]) : null);
    return width && height ? { width: Math.round(width), height: Math.round(height) } : null;
  } catch {
    return null;
  }
}

/** A file name Liquid can refer to: lowercase letters, digits, dots, dashes; the right extension. */
export function assetName(requested: string, type: AssetType): string {
  const base = requested.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'image';
  return `${base}.${EXTENSIONS[type]}`;
}

export interface AssetRow { id: string; name: string; content_type: AssetType; bytes: number; width: number | null; height: number | null; created_at: Date | string }

export async function listAssets(db: Queryable, tenantId: string): Promise<{ assets: AssetRow[]; logoId: string | null }> {
  const assets = (await db.query<AssetRow>('select id, name, content_type, bytes, width, height, created_at from template_assets where tenant_id = $1 order by created_at desc', [tenantId])).rows;
  const logoId = (await db.query<{ logo_asset_id: string | null }>('select logo_asset_id from tenants where id = $1', [tenantId])).rows[0]?.logo_asset_id ?? null;
  return { assets, logoId };
}

/** Store an image under a free name (logo.png, logo-2.png…). */
export async function addAsset(db: Queryable, tenantId: string, requestedName: string, data: Buffer, type: AssetType, userId: string | null): Promise<AssetRow> {
  const wanted = assetName(requestedName, type);
  const taken = new Set((await db.query<{ name: string }>('select name from template_assets where tenant_id = $1', [tenantId])).rows.map((r) => r.name));
  let name = wanted;
  for (let n = 2; taken.has(name); n++) name = wanted.replace(/(\.[a-z]+)$/, `-${n}$1`);
  const size = imageSize(data, type);
  const id = randomUUID();
  const row = (await db.query<AssetRow>(
    `insert into template_assets (id, tenant_id, name, content_type, bytes, width, height, data, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, name, content_type, bytes, width, height, created_at`,
    [id, tenantId, name, type, data.length, size?.width ?? null, size?.height ?? null, data, userId],
  )).rows[0]!;
  return row;
}

/** The public path of an image (its id is random; the name is only for people reading it). */
export const assetPath = (a: { id: string; name: string }) => `/v1/assets/${a.id}/${encodeURIComponent(a.name)}`;

export type AssetMode = { kind: 'inline' } | { kind: 'url'; base?: string };

/** What templates see: each image's address by name, and the logo's. */
export interface AssetMap { byName: Record<string, string>; logo: string | null }

const REFERENCE = /['"]([^'"\n]{1,80})['"]\s*\|\s*asset_url\b/g;

/** The images some templates refer to (by name, and the logo), addressed for where they will load. */
export async function assetMap(db: Queryable, tenantId: string, sources: Array<string | null | undefined>, mode: AssetMode): Promise<AssetMap> {
  const text = sources.filter(Boolean).join('\n');
  const names = [...new Set([...text.matchAll(REFERENCE)].map((m) => m[1]!))];
  const wantsLogo = /\blogo\b/.test(text);
  if (!names.length && !wantsLogo) return { byName: {}, logo: null };
  const inline = mode.kind === 'inline';
  const rows = (await db.query<{ id: string; name: string; content_type: string; data?: Buffer; is_logo: boolean }>(
    `select a.id, a.name, a.content_type${inline ? ', a.data' : ''}, (t.logo_asset_id = a.id) as is_logo
     from template_assets a join tenants t on t.id = a.tenant_id
     where a.tenant_id = $1 and (a.name = any($2::text[]) or ($3 and t.logo_asset_id = a.id))`,
    [tenantId, names, wantsLogo],
  )).rows;
  const address = (r: (typeof rows)[number]) => (inline
    ? `data:${r.content_type};base64,${Buffer.from(r.data!).toString('base64')}`
    : `${mode.base?.replace(/\/$/, '') ?? ''}${assetPath(r)}`);
  const byName: Record<string, string> = {};
  let logo: string | null = null;
  for (const r of rows) {
    const a = address(r);
    if (names.includes(r.name)) byName[r.name] = a;
    if (r.is_logo) logo = a;
  }
  return { byName, logo };
}

/** Emails: the public address when the server has one; inlined otherwise. */
export const emailAssets = (publicUrl: string | undefined): AssetMode => (publicUrl ? { kind: 'url', base: publicUrl } : { kind: 'inline' });

/** The logo's public path, or null (the till apps print it from here). */
export async function logoPath(db: Queryable, tenantId: string): Promise<string | null> {
  const r = (await db.query<{ id: string; name: string }>('select a.id, a.name from tenants t join template_assets a on a.id = t.logo_asset_id where t.id = $1', [tenantId])).rows[0];
  return r ? assetPath(r) : null;
}

/** The logo for the built-in PDF layouts, which take PNG and JPEG only. */
export async function logoForPdf(db: Queryable, tenantId: string): Promise<Buffer | undefined> {
  const r = (await db.query<{ data: Buffer; content_type: string }>(
    `select a.data, a.content_type from tenants t join template_assets a on a.id = t.logo_asset_id where t.id = $1`, [tenantId],
  )).rows[0];
  return r && (r.content_type === 'image/png' || r.content_type === 'image/jpeg') ? Buffer.from(r.data) : undefined;
}
