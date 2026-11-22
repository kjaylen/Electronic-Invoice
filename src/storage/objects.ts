/**
 * Object storage for product photos: any S3-compatible service (AWS S3,
 * Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO), signed with AWS
 * Signature Version 4, no SDK. With a public base URL (a CDN in front of the
 * bucket), buyers' browsers load photos from the CDN directly.
 *
 * Without object storage configured, photos stay in the database (fine for
 * a small deployment and for development).
 *
 *   S3_ENDPOINT           https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, ...
 *   S3_REGION             us-east-1 (R2: auto)
 *   S3_BUCKET             the bucket
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 *   S3_PUBLIC_URL         optional: the CDN (or public bucket) URL objects are served from
 *   S3_FORCE_PATH_STYLE   "true" for MinIO and other path-style services
 */

import { createHash, createHmac } from 'node:crypto';

export interface ObjectStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** Where browsers can load the object directly, when a public URL is configured. */
  publicUrl(key: string): string | null;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
  fetch?: typeof fetch;
}

export class ObjectStoreError extends Error {
  override name = 'ObjectStoreError';
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
/** RFC 3986 encoding of each path segment, as SigV4 wants it. */
const encodePath = (path: string) => path.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/**
 * Sign a request (AWS Signature Version 4, service "s3"). Returns the headers
 * to send, including Authorization. `headers` keys must be lower case.
 */
export function signV4(request: { method: string; url: URL; headers: Record<string, string>; payloadHash: string }, creds: { accessKeyId: string; secretAccessKey: string; region: string }, now = new Date()): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, host: request.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': request.payloadHash };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...request.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [request.method, encodePath(decodeURIComponent(request.url.pathname)), query, canonicalHeaders, signedHeaders, request.payloadHash].join('\n');
  const scope = `${date}/${creds.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), creds.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export function s3Store(config: S3Config): ObjectStore {
  const doFetch = config.fetch ?? fetch;
  const endpoint = new URL(config.endpoint);
  const objectUrl = (key: string) => {
    const path = encodePath(key);
    return config.forcePathStyle
      ? new URL(`${endpoint.origin}/${config.bucket}/${path}`)
      : new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}/${path}`);
  };
  const send = async (method: string, key: string, body?: Buffer, contentType?: string) => {
    const url = objectUrl(key);
    const headers = signV4(
      { method, url, headers: contentType ? { 'content-type': contentType } : {}, payloadHash: sha256hex(body ?? '') },
      config,
    );
    delete headers.host;
    return doFetch(url, { method, headers, ...(body && { body: new Uint8Array(body) }) });
  };
  return {
    async put(key, data, contentType) {
      const res = await send('PUT', key, data, contentType);
      if (!res.ok) throw new ObjectStoreError(`Object storage refused the upload (${res.status})`);
    },
    async get(key) {
      const res = await send('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new ObjectStoreError(`Object storage refused the download (${res.status})`);
      return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    async delete(key) {
      const res = await send('DELETE', key);
      if (!res.ok && res.status !== 404) throw new ObjectStoreError(`Object storage refused the deletion (${res.status})`);
    },
    publicUrl(key) {
      return config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, '')}/${encodePath(key)}` : null;
    },
  };
}

/** From S3_* environment variables; undefined when S3_BUCKET is not set. */
export function objectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStore | undefined {
  if (!env.S3_BUCKET) return undefined;
  const missing = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new ObjectStoreError(`S3_BUCKET is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not`);
  return s3Store({
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION ?? 'us-east-1',
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    ...(env.S3_PUBLIC_URL && { publicBaseUrl: env.S3_PUBLIC_URL }),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  });
}

/** The key for a product photo. */
export const photoKey = (tenantId: string, imageId: string, contentType: string) =>
  `products/${tenantId}/${imageId}.${contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'}`;
