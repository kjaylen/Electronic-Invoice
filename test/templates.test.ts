/**
 * Templates (Liquid, like a Shopify theme): the sandboxed engine, the editor's API, what a saved
 * template must keep, emails sent through templates, images and the business logo (in emails,
 * PDFs, the store and till receipts), and store sections cleaned of anything unsafe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PNG } from 'pngjs';
import { buildApp } from '../src/api/app.ts';
import { createUser } from '../src/db/users.ts';
import { SUBMIT_PATHS } from '../src/engine/transport.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { renderReceipt } from '../src/render/pdf.ts';
import { assetName, assetType, imageSize } from '../src/templates/assets.ts';
import { htmlToText, parseTemplate, renderHtml, TemplateError } from '../src/templates/engine.ts';
import { samplePrintView } from '../src/templates/render.ts';
import { dither } from '../web/src/pos/logo.ts';
import { toEscPos, toHtml } from '../web/src/pos/ticket.ts';
import { AUTHORIZED, setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC_URL = 'https://app.example.test';

/** A small PNG: purple on the left, white on the right. */
function png(width = 40, height = 20): Buffer {
  const p = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = x < width / 2;
      p.data[i] = dark ? 0x6d : 255;
      p.data[i + 1] = dark ? 0x2d : 255;
      p.data[i + 2] = dark ? 0x93 : 255;
      p.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(p);
}

const imageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length;

interface Ctx { f: PipelineFixture; app: FastifyInstance; mail: ReturnType<typeof memoryMailer>; slug: string; owner: Record<string, string> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withApp(fn: (c: Ctx) => Promise<void>) {
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC_URL, mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@biz.example', role: 'owner', password: PASSWORD });
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: 'olive@biz.example', password: PASSWORD } });
  const owner = { ...CSRF, cookie: cookieFrom(login), 'x-business': slug };
  try {
    await fn({ f, app, mail, slug, owner });
  } finally {
    await app.close();
    await f.close();
  }
}

async function issueReceipt(c: Ctx): Promise<string> {
  c.f.bts.script(SUBMIT_PATHS['02'], AUTHORIZED);
  const doc = await c.app.inject({
    method: 'POST', url: '/v1/documents', headers: c.owner,
    payload: { type: '02', lines: [{ description: 'Cappuccino', quantity: '2', unitCode: 'H87', unitPrice: '6.50', gstCategory: 'S' }], payment: { meansCode: '10', terms: 'Paid' } },
  });
  assert.equal(doc.statusCode, 201, doc.body);
  return doc.json().id;
}

// ---------- the engine ----------

test('the engine escapes output, reads no files, sees no prototypes, and names the line of a mistake', async () => {
  assert.equal(await renderHtml('{{ x }}', { x: '<b>"hi"</b>' }), '&lt;b&gt;&#34;hi&#34;&lt;/b&gt;');
  assert.equal(await renderHtml('{{ x | raw }}', { x: '<b>ok</b>' }), '<b>ok</b>');
  assert.equal(await renderHtml('{{ x.constructor }}{{ x.__proto__ }}', { x: {} }), '');
  await assert.rejects(renderHtml("{% include 'secrets' %}", {}));
  await assert.rejects(renderHtml("{% render '../../etc/passwd' %}", {}));
  assert.equal(await renderHtml('{{ 1234.5 | money }} {{ "1250" | amount }} {{ 1 | pluralize: "day", "days" }}', {}), 'BZ$1,234.50 1,250.00 day');
  assert.throws(() => parseTemplate('<p>\n{{ x | shout }}</p>'), (e: TemplateError) => e.line === 2 && /shout/.test(e.message));
});

test('the editor sees where a whitespace-trimming Liquid comment ends', async () => {
  const { liquidSupport } = await import('../web/src/liquid-fix.ts');
  const { parser } = liquidSupport().language;
  for (const src of ['{%- comment -%}\nA note\n{%- endcomment -%}\n<p>{{ x }}</p>', '{% comment %}A note{% endcomment %}<p>{{ x }}</p>']) {
    const tree = parser.parse(src);
    assert.equal(tree.resolveInner(src.indexOf('note'), 1).name, 'CommentText', src);
    assert.equal(tree.resolveInner(src.indexOf('<p>') + 1, 1).name, 'TagName', src);
    assert.equal(tree.resolveInner(src.lastIndexOf('x'), 1).name, 'VariableName', src);
  }
  // {% raw %} keeps Liquid as text, up to a trimmed end tag too.
  const raw = '{%- raw -%}{{ kept }}{%- endraw -%}<p>{{ x }}</p>';
  const tree = parser.parse(raw);
  assert.notEqual(tree.resolveInner(raw.indexOf('kept'), 1).name, 'VariableName');
  assert.equal(tree.resolveInner(raw.lastIndexOf('x'), 1).name, 'VariableName');
});

test('asset_url finds uploaded images by name, and says so when one is missing', async () => {
  assert.equal(await renderHtml(`<img src="{{ 'logo.png' | asset_url }}">`, { __assets: { 'logo.png': '/v1/assets/abc/logo.png' } }), '<img src="/v1/assets/abc/logo.png">');
  await assert.rejects(renderHtml(`{{ 'nope.png' | asset_url }}`, { __assets: {} }), /No image named "nope.png"/);
});

test('plain-text emails keep links and lose the markup', () => {
  const text = htmlToText('<p>Hello <b>Ana</b>,</p>\n  <table><tr><td>Total</td>\n<td>BZ$5.00</td></tr></table><a href="https://x.test/pay">Pay online</a><p><a href="https://x.test/a">https://x.test/a</a></p>');
  assert.equal(text, 'Hello Ana,\n\nTotal BZ$5.00\n\nPay online: https://x.test/pay\nhttps://x.test/a');
});

test('images are known by their bytes, measured, and named for Liquid', () => {
  const p = png(40, 20);
  assert.equal(assetType(p), 'image/png');
  assert.deepEqual(imageSize(p, 'image/png'), { width: 40, height: 20 });
  assert.equal(assetType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>')), 'image/svg+xml');
  assert.deepEqual(imageSize(Buffer.from('<svg viewBox="0 0 120 40"></svg>'), 'image/svg+xml'), { width: 120, height: 40 });
  assert.equal(assetType(Buffer.from('just text, not a picture')), null);
  assert.equal(assetName('My Logo (final).PNG', 'image/png'), 'my-logo-final.png');
  assert.equal(assetName('photo.jpeg', 'image/jpeg'), 'photo.jpg');
});

// ---------- the editor's API ----------

test('templates: list, open, save, preview, history and back to the default', async () => {
  await withApp(async (c) => {
    const list = await c.app.inject({ method: 'GET', url: '/v1/templates', headers: c.owner });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 15);
    assert.ok(list.json().data.every((t: { custom: boolean }) => !t.custom));

    const one = (await c.app.inject({ method: 'GET', url: '/v1/templates/email.document', headers: c.owner })).json();
    assert.equal(one.custom, false);
    assert.ok(!one.source.includes('\r'), 'plain newlines');
    assert.ok(one.variables.some((v: { name: string }) => v.name === 'business.logo'));

    // A mistake shows in the preview, with its line; the preview has nothing to show.
    const bad = (await c.app.inject({ method: 'POST', url: '/v1/templates/email.document/preview', headers: c.owner, payload: { source: '<p>\n{{ customer.name | shout }}</p>', subject: 'Hi' } })).json();
    assert.equal(bad.html, null);
    assert.equal(bad.problems[0].line, 2);

    const good = (await c.app.inject({ method: 'POST', url: '/v1/templates/email.document/preview', headers: c.owner, payload: { source: '<p>Hello {{ customer.name }}</p>', subject: 'For {{ customer.name }}' } })).json();
    assert.deepEqual(good.problems, []);
    assert.match(good.html, /Hello Island Logistics/);
    assert.equal(good.subject, 'For Island Logistics Ltd.');

    // Saving checks it the same way.
    const refused = await c.app.inject({ method: 'PUT', url: '/v1/templates/email.document', headers: c.owner, payload: { source: '{% if %}', subject: 'x' } });
    assert.equal(refused.statusCode, 422);
    assert.equal(refused.json().error.code, 'invalid_template');

    const saved = await c.app.inject({ method: 'PUT', url: '/v1/templates/email.document', headers: c.owner, payload: { source: one.source.replace('Please find attached', 'Here is'), subject: 'Your {{ document.type_name }} {{ document.number_display }}' } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().custom, true);

    // Emails go out through it.
    const id = await issueReceipt(c);
    const sent = await c.app.inject({ method: 'POST', url: `/v1/documents/${id}/email`, headers: c.owner, payload: { to: 'ana@example.com', message: 'Thank you!' } });
    assert.equal(sent.statusCode, 200, sent.body);
    const mail = c.mail.sent.at(-1)!;
    assert.match(mail.subject, /^Your Tax Receipt \d{3}-\d{9}$/);
    assert.match(mail.text, /Here is tax receipt/);
    assert.match(mail.text, /Thank you!/);
    assert.equal(mail.attachments?.length, 2);

    const versions = (await c.app.inject({ method: 'GET', url: '/v1/templates/email.document/versions', headers: c.owner })).json().data;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].savedBy, 'Olive');

    const reverted = await c.app.inject({ method: 'DELETE', url: '/v1/templates/email.document', headers: c.owner });
    assert.equal(reverted.json().custom, false);
    const after = (await c.app.inject({ method: 'GET', url: '/v1/templates/email.document/versions', headers: c.owner })).json().data;
    assert.deepEqual(after.map((v: { action: string }) => v.action), ['reverted', 'saved']);
    // The saved version can be opened again.
    const old = (await c.app.inject({ method: 'GET', url: `/v1/templates/email.document/versions/${after[1].id}`, headers: c.owner })).json();
    assert.match(old.source, /Here is/);

    // Only those who manage the business edit templates.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@biz.example', role: 'cashier', password: PASSWORD });
    const cashierLogin = await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: c.slug, login: 'cass@biz.example', password: PASSWORD } });
    const cashier = { ...CSRF, cookie: cookieFrom(cashierLogin), 'x-business': c.slug };
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/templates', headers: cashier })).statusCode, 403);
  });
});

test('customer emails in Spanish: the built-in text and subjects, Spanish dates, and back to English', async () => {
  await withApp(async (c) => {
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/templates', headers: c.owner })).json().emailLanguage, 'en');
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/templates/settings', headers: c.owner, payload: { emailLanguage: 'fr' } })).statusCode, 400);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/templates/settings', headers: c.owner, payload: { emailLanguage: 'es' } })).statusCode, 200);

    const doc = (await c.app.inject({ method: 'GET', url: '/v1/templates/email.document', headers: c.owner })).json();
    assert.equal(doc.lang, 'es');
    assert.match(doc.source, /Adjuntamos su/);
    assert.match(doc.subject, / de \{\{ business\.name \}\}$/);

    // The reminder previews in Spanish, dates included.
    const reminder = (await c.app.inject({ method: 'GET', url: '/v1/templates/email.reminder', headers: c.owner })).json();
    const preview = (await c.app.inject({ method: 'POST', url: '/v1/templates/email.reminder/preview', headers: c.owner, payload: { source: reminder.source, subject: reminder.subject } })).json();
    assert.deepEqual(preview.problems, []);
    assert.match(preview.subject, /^Vencida: factura 001-000000042 de /);
    assert.match(preview.text, /vencía el 19 de noviembre de 2026/);
    assert.match(preview.text, /3 días de atraso/);

    // A real email goes out in Spanish.
    const id = await issueReceipt(c);
    await c.app.inject({ method: 'POST', url: `/v1/documents/${id}/email`, headers: c.owner, payload: { to: 'ana@example.com' } });
    const es = c.mail.sent.at(-1)!;
    assert.match(es.subject, /^Recibo fiscal \d{3}-\d{9} de /);
    assert.match(es.text, /Adjuntamos su recibo fiscal/);
    assert.match(es.text, /de \w+ de 20\d\d/);
    assert.match(es.text, /El PDF es la copia impresa/);

    // Back to English.
    await c.app.inject({ method: 'PUT', url: '/v1/templates/settings', headers: c.owner, payload: { emailLanguage: 'en' } });
    await c.app.inject({ method: 'POST', url: `/v1/documents/${id}/email`, headers: c.owner, payload: { to: 'ana@example.com' } });
    assert.match(c.mail.sent.at(-1)!.subject, /^Tax Receipt \d{3}-\d{9} from /);
  });
});

test('printed documents must keep the BTS block', async () => {
  await withApp(async (c) => {
    const receipt = (await c.app.inject({ method: 'GET', url: '/v1/templates/document.receipt', headers: c.owner })).json();
    const without = await c.app.inject({ method: 'PUT', url: '/v1/templates/document.receipt', headers: c.owner, payload: { source: receipt.source.replace(/\{%-?\s*bts[^%]*%\}/g, '') } });
    assert.equal(without.statusCode, 422);
    assert.match(without.json().error.message, /Keep \{% bts %\}/);
    const kept = await c.app.inject({ method: 'PUT', url: '/v1/templates/document.receipt', headers: c.owner, payload: { source: receipt.source.replace('</body>', '<p>Follow us @cayocoffee</p></body>') } });
    assert.equal(kept.statusCode, 200, kept.body);
    // The preview carries the QR code (an inline SVG) and the ETDUI.
    const preview = (await c.app.inject({ method: 'POST', url: '/v1/templates/document.receipt/preview', headers: c.owner, payload: { source: kept.json().source } })).json();
    assert.match(preview.html, /<svg/);
    assert.match(preview.html, /ETDUI/);
    assert.match(preview.html, /Follow us/);
  });
});

// ---------- images and the logo ----------

test('images: upload, the first becomes the logo, served safely, used in emails, PDFs and till receipts', async () => {
  await withApp(async (c) => {
    const notImage = await c.app.inject({ method: 'POST', url: '/v1/templates/assets', headers: c.owner, payload: { name: 'x.png', dataBase64: Buffer.from('hello, I am text').toString('base64') } });
    assert.equal(notImage.statusCode, 422);

    const id = await issueReceipt(c);
    const before = await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/pdf?format=receipt`, headers: c.owner });
    const plainImages = imageCount(before.rawPayload);

    const up = await c.app.inject({ method: 'POST', url: '/v1/templates/assets', headers: c.owner, payload: { name: 'Brand Mark.png', dataBase64: png().toString('base64') } });
    assert.equal(up.statusCode, 201, up.body);
    const logo = up.json();
    assert.equal(logo.name, 'brand-mark.png');
    assert.equal(logo.logo, true);
    assert.deepEqual([logo.width, logo.height], [40, 20]);
    const second = (await c.app.inject({ method: 'POST', url: '/v1/templates/assets', headers: c.owner, payload: { name: 'Brand Mark.png', dataBase64: png(10, 10).toString('base64') } })).json();
    assert.equal(second.name, 'brand-mark-2.png');
    assert.equal(second.logo, false);

    // Public by its random id, as an image that can run nothing.
    const served = await c.app.inject({ method: 'GET', url: logo.url });
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.match(String(served.headers['content-security-policy']), /sandbox/);
    assert.match(String(served.headers['cache-control']), /immutable/);

    // The built-in PDF layout prints it.
    const withLogo = await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/pdf?format=receipt`, headers: c.owner });
    assert.ok(imageCount(withLogo.rawPayload) > plainImages);
    const sheet = await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/pdf`, headers: c.owner });
    assert.ok(imageCount(sheet.rawPayload) > plainImages);

    // The default email shows it, from the public address.
    await c.app.inject({ method: 'POST', url: `/v1/documents/${id}/email`, headers: c.owner, payload: { to: 'ana@example.com' } });
    assert.ok(c.mail.sent.at(-1)!.html!.includes(`${PUBLIC_URL}${logo.url}`));

    // Till receipts get its address.
    const view = (await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/view`, headers: c.owner })).json();
    assert.equal(view.logo, logo.url);

    // A template can use any image by name; deleting one in use is refused.
    const doc = (await c.app.inject({ method: 'GET', url: '/v1/templates/email.document', headers: c.owner })).json();
    const put = await c.app.inject({ method: 'PUT', url: '/v1/templates/email.document', headers: c.owner, payload: { source: doc.source.replace('</body>', `<img src="{{ 'brand-mark-2.png' | asset_url }}" alt=""></body>`), subject: doc.subject } });
    assert.equal(put.statusCode, 200, put.body);
    await c.app.inject({ method: 'POST', url: `/v1/documents/${id}/email`, headers: c.owner, payload: { to: 'ana@example.com' } });
    assert.ok(c.mail.sent.at(-1)!.html!.includes(`${PUBLIC_URL}${second.url}`));
    const inUse = await c.app.inject({ method: 'DELETE', url: `/v1/templates/assets/${second.id}`, headers: c.owner });
    assert.equal(inUse.statusCode, 409);
    assert.equal(inUse.json().error.code, 'image_in_use');
    // A missing name is a problem when saving.
    const missing = await c.app.inject({ method: 'PUT', url: '/v1/templates/email.document', headers: c.owner, payload: { source: `{{ 'nope.png' | asset_url }}`, subject: 'x' } });
    assert.equal(missing.statusCode, 422);

    // No logo: back to plain.
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/templates/logo', headers: c.owner, payload: { assetId: null } })).statusCode, 200);
    const plain = await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/pdf?format=receipt`, headers: c.owner });
    assert.equal(imageCount(plain.rawPayload), plainImages);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/documents/${id}/view`, headers: c.owner })).json().logo, null);
    // Deleting the logo image clears the logo.
    await c.app.inject({ method: 'PUT', url: '/v1/templates/logo', headers: c.owner, payload: { assetId: logo.id } });
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/templates/assets/${logo.id}`, headers: c.owner })).statusCode, 204);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/templates/assets', headers: c.owner })).json().logoId, null);
  });
});

test('a logo pdfkit cannot read is left out rather than breaking the receipt', async () => {
  const pv = samplePrintView({ name: 'Cayo', legal_name: 'Cayo', trade_name: null, tin: '123456', address_lines: ['San Ignacio'], telephone: '1', email: 'a@b.c', slug: 'cayo' }, true);
  const corrupt = Buffer.concat([png().subarray(0, 30), Buffer.from('garbage')]);
  const pdf = await renderReceipt(pv, { draft: true, logo: corrupt });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const good = await renderReceipt(pv, { draft: true, logo: png() });
  assert.ok(imageCount(good) > imageCount(pdf));
});

test('the store shows its theme, cleaned of scripts and handlers, with the logo', async () => {
  await withApp(async (c) => {
    const open = await c.app.inject({
      method: 'PUT', url: '/v1/store-settings', headers: c.owner,
      payload: { enabled: true, pickup: { enabled: true, instructions: 'Ring the bell' }, payments: { payAtPickup: { enabled: true } } },
    });
    assert.equal(open.statusCode, 200, open.body);
    await c.app.inject({ method: 'POST', url: '/v1/templates/assets', headers: c.owner, payload: { name: 'logo.png', dataBase64: png().toString('base64') } });
    const saved = await c.app.inject({
      method: 'PUT', url: '/v1/templates/store.home', headers: c.owner,
      payload: { source: '<script>alert(1)</script><p onclick="steal()">Hi from {{ store.name }}</p><a href="javascript:alert(2)">x</a><img src="{{ store.logo }}" alt="">' },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    await c.app.inject({ method: 'PUT', url: '/v1/templates/store.theme', headers: c.owner, payload: { source: '.shop-hero { color: red; } </style><script>x</script> @import url(https://evil.test/a.css);' } });

    const store = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}` })).json();
    assert.match(store.theme.home, /Hi from /);
    assert.doesNotMatch(store.theme.home, /script|onclick|javascript:/i);
    assert.match(store.theme.home, /<img src="\/v1\/assets\/[0-9a-f-]{36}\/logo\.png"/);
    assert.match(store.theme.css, /\.shop-hero/);
    assert.doesNotMatch(store.theme.css, /<\/?style|@import/i);
    assert.equal(store.theme.announcement, '');
  });
});

// ---------- till receipts ----------

test('till receipts print the logo as a raster picture, and as an image on system printers', () => {
  // 16 x 2: left half black, right half white.
  const rgba = new Uint8Array(16 * 2 * 4);
  for (let i = 0; i < 32; i++) {
    const black = i % 16 < 8;
    rgba.set(black ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  }
  const bits = dither(rgba, 16, 2);
  assert.deepEqual([...bits], [0xff, 0x00, 0xff, 0x00]);

  const ticket = [{ kind: 'image' as const, width: 16, height: 2, bits, src: 'data:image/png;base64,AAAA' }, { kind: 'text' as const, text: 'Cayo Coffee' }];
  const bytes = toEscPos(ticket, { paperWidth: 80, codepage: 'ascii', qr: 'native', cut: true });
  const raster = [0x1d, 0x76, 0x30, 0, 2, 0, 2, 0, 0xff, 0x00, 0xff, 0x00];
  const at = bytes.findIndex((_, i) => raster.every((b, j) => bytes[i + j] === b));
  assert.ok(at > 0, 'GS v 0 with the dots');
  assert.match(toHtml(ticket, { paperWidth: 80 }), /<img src="data:image\/png;base64,AAAA"/);
});
