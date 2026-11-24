/**
 * The built web app's files: scripts and styles named after their content are
 * kept by browsers for good and sent compressed when a compressed copy was
 * made at build time (npm run web:compress); the page itself is always fresh.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { buildApp } from '../src/api/app.ts';
import { setupPipeline } from './pipeline-setup.ts';

test('built files: named-by-content assets are cached for good and sent compressed; the page is not', async () => {
  const web = mkdtempSync(join(tmpdir(), 'static-'));
  mkdirSync(join(web, 'assets'));
  const script = 'console.log("the app");'.repeat(200);
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>Floreo</title></head><body><div id="root"></div></body></html>');
  writeFileSync(join(web, 'assets', 'main-B2WdSyt3.js'), script);
  writeFileSync(join(web, 'assets', 'main-B2WdSyt3.js.br'), brotliCompressSync(Buffer.from(script)));
  writeFileSync(join(web, 'assets', 'plain-Ab12Cd34.css'), 'body{}');
  writeFileSync(join(web, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, webRoot: web });
  try {
    const compressed = await app.inject({ method: 'GET', url: '/assets/main-B2WdSyt3.js', headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(compressed.statusCode, 200);
    assert.equal(compressed.headers['content-encoding'], 'br');
    assert.equal(compressed.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(String(compressed.headers.vary), /accept-encoding/i);
    assert.equal(brotliDecompressSync(compressed.rawPayload).toString(), script);
    assert.ok(compressed.rawPayload.length < script.length / 5);

    // A browser that does not take Brotli, and a file with no compressed copy: the file as built, still cached for good.
    const plain = await app.inject({ method: 'GET', url: '/assets/main-B2WdSyt3.js' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body, script);
    assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');
    const css = await app.inject({ method: 'GET', url: '/assets/plain-Ab12Cd34.css', headers: { 'accept-encoding': 'br' } });
    assert.deepEqual([css.statusCode, css.headers['content-encoding'], css.body], [200, undefined, 'body{}']);

    // Files whose names do not change, and the page: asked for again each time.
    assert.doesNotMatch(String((await app.inject({ method: 'GET', url: '/favicon.svg' })).headers['cache-control']), /immutable/);
    const page = await app.inject({ method: 'GET', url: '/signup' });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(String(page.headers['cache-control'] ?? ''), /immutable/);
  } finally {
    await app.close();
    await f.close();
  }
});
