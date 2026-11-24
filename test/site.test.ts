/**
 * The site builder: a store's site is a draft until published (customers see
 * only the published one), every saved site is checked (bad links, colours,
 * unknown sections dropped; custom code sanitized), versions can be restored,
 * staff preview a closed store. Collections gather products by hand or by
 * rules; the storefront filters, sorts and relates products; the contact form
 * emails the store.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { storePageMeta, storeSitemap } from '../src/commerce/seo.ts';
import { normalizeSite } from '../src/commerce/site.ts';
import { createUser } from '../src/db/users.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { setupPipeline, type PipelineFixture } from './pipeline-setup.ts';

const CSRF = { 'x-requested-with': 'etd-web' };
const PASSWORD = 'correct horse battery';
const PUBLIC = 'https://app.example.test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface Ctx { f: PipelineFixture; app: FastifyInstance; mail: ReturnType<typeof memoryMailer>; slug: string; owner: Record<string, string>; login: (email: string) => Promise<Record<string, string>> }

function cookieFrom(res: LightMyRequestResponse): string {
  const m = /(etd_s_[a-z0-9-]+)=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''));
  assert.ok(m, res.body);
  return `${m[1]}=${m[2]}`;
}

async function withStore(fn: (c: Ctx) => Promise<void>, options: { open?: boolean } = {}) {
  const f = await setupPipeline();
  const mail = memoryMailer();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true, publicUrl: PUBLIC, mailer: mail });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: CSRF, payload: { business: slug, login: email, password: PASSWORD } });
    return { ...CSRF, cookie: cookieFrom(res), 'x-business': slug };
  };
  await createUser(f.db, { tenantId: f.tenantA, name: 'Olive', email: 'olive@shop.example', role: 'owner', password: PASSWORD });
  const owner = await login('olive@shop.example');
  const opened = await app.inject({
    method: 'PUT', url: '/v1/store-settings', headers: owner,
    payload: { enabled: options.open ?? true, tagline: 'Fresh from Cayo', delivery: { enabled: false, zones: [] }, pickup: { enabled: true, instructions: '' }, payments: { bankTransfer: { enabled: true, instructions: '' }, cashOnDelivery: { enabled: false }, payAtPickup: { enabled: true } } },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  try {
    await fn({ f, app, mail, slug, owner, login });
  } finally {
    await app.close();
    await f.close();
  }
}

const product = async (c: Ctx, title: string, price: string, extra: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) => {
  const r = await c.app.inject({ method: 'POST', url: '/v1/products', headers: c.owner, payload: { title, status: 'active', variants: [{ price, gstCategory: 'S', ...variant }], ...extra } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};
const storeInfo = async (c: Ctx, headers: Record<string, string> = {}) => c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}`, headers });

test('site builder: a starting site from the store, drafts checked on save, publish, discard, versions, preview of a closed store', () =>
  withStore(async (c) => {
    // Before any change: the site made from the store's settings, live already.
    const first = (await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: c.owner })).json();
    assert.equal(first.changed, false);
    assert.equal(first.published, null);
    assert.deepEqual(first.draft.home.sections.map((s: { type: string }) => s.type), ['hero', 'template_section', 'product_grid']);
    assert.equal(first.draft.home.sections[0].settings.text, 'Fresh from Cayo');
    assert.ok(first.builder.sections.length >= 18);
    assert.ok(first.builder.presets.find((p: { key: string }) => p.key === 'boutique'));
    const live = (await storeInfo(c)).json();
    assert.equal(live.site.home.sections[0].settings.text, 'Fresh from Cayo');

    // A draft with mistakes and mischief: kept only what is allowed.
    const draft = structuredClone(first.draft);
    draft.theme.colors.primary = 'red; background:url(x)';
    draft.theme.colors.accent = '#AB12CD';
    draft.theme.fonts.heading = 'comic-sans';
    draft.header.menu.push({ label: 'Evil', link: { type: 'url', value: 'javascript:alert(1)' } }, { label: 'Facebook page', link: { type: 'url', value: 'https://facebook.com/shop' } });
    draft.home.sections.unshift(
      { type: 'not_a_section', settings: {} },
      { type: 'banner', settings: { text: 'x'.repeat(500), background: 'neon', buttonLink: { type: 'collection', value: 'Not A Handle!' } } },
      { type: 'custom_code', settings: { code: '<h2 onclick="steal()">Hi {{ store.name }}</h2><script>alert(1)</script>' } },
    );
    draft.pages = [{ slug: 'about', title: 'About us', sections: [{ type: 'rich_text', settings: { heading: 'Our story' } }, { type: 'template_section' }] }, { slug: 'about', title: 'Twice' }, { slug: 'Bad Slug', title: 'x' }];
    const saved = await c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers: c.owner, payload: { site: draft } });
    assert.equal(saved.statusCode, 200, saved.body);
    const d = saved.json().draft;
    assert.equal(saved.json().changed, true);
    assert.equal(d.theme.colors.primary, '#6d2d93', 'an invalid colour falls back');
    assert.equal(d.theme.colors.accent, '#ab12cd');
    assert.equal(d.theme.fonts.heading, 'inter-tight');
    assert.deepEqual(d.header.menu.slice(-2).map((m: { link: unknown }) => m.link), [{ type: 'home' }, { type: 'url', value: 'https://facebook.com/shop' }]);
    assert.deepEqual(d.home.sections.slice(0, 2).map((s: { type: string }) => s.type), ['banner', 'custom_code'], 'unknown sections dropped');
    assert.equal(d.home.sections[0].settings.text.length, 160);
    assert.equal(d.home.sections[0].settings.background, 'primary');
    assert.deepEqual(d.home.sections[0].settings.buttonLink, { type: 'collections' });
    assert.deepEqual(d.pages.map((p: { slug: string; sections: unknown[] }) => [p.slug, p.sections.length]), [['about', 1], ['about-2', 0], ['bad-slug', 0]], 'no page is dropped for its address: a taken one gets a number, a bad one is repaired; home-only sections dropped');
    assert.ok(d.home.sections.every((s: { id: string }) => /^[a-z0-9-]{4,40}$/.test(s.id)));

    // Not published yet: customers still see the old site.
    assert.equal((await storeInfo(c)).json().site.home.sections[0].type, 'hero');
    const published = await c.app.inject({ method: 'POST', url: '/v1/store-site/publish', headers: c.owner, payload: { note: 'Spring look' } });
    assert.equal(published.statusCode, 200, published.body);
    const site = (await storeInfo(c)).json().site;
    assert.equal(site.home.sections[0].type, 'banner');
    assert.equal(site.home.sections[1].settings.html, '<h2>Hi Test Business</h2>'.replace('Test Business', (await c.f.db.query<{ n: string }>('select coalesce(trade_name, legal_name) as n from tenants where id = $1', [c.f.tenantA])).rows[0]!.n), 'Liquid rendered, script and handler removed');
    assert.equal(site.pages[0].title, 'About us');

    // Change, then throw the change away.
    const again = structuredClone(d);
    again.home.sections = [];
    await c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers: c.owner, payload: { site: again } });
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: c.owner })).json().changed, true);
    const discarded = await c.app.inject({ method: 'POST', url: '/v1/store-site/discard', headers: c.owner, payload: {} });
    assert.equal(discarded.json().draft.home.sections.length, d.home.sections.length);

    // A second version; the first restored as the draft.
    again.theme.preset = 'bold';
    await c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers: c.owner, payload: { site: again } });
    await c.app.inject({ method: 'POST', url: '/v1/store-site/publish', headers: c.owner, payload: {} });
    const versions = (await c.app.inject({ method: 'GET', url: '/v1/store-site/versions', headers: c.owner })).json().data;
    assert.equal(versions.length, 2);
    assert.equal(versions[1].note, 'Spring look');
    const restored = await c.app.inject({ method: 'POST', url: `/v1/store-site/versions/${versions[1].id}/restore`, headers: c.owner, payload: {} });
    assert.equal(restored.json().draft.home.sections[0].type, 'banner');
    assert.equal(restored.json().changed, true);

    // A new section comes with its starting content.
    const faq = (await c.app.inject({ method: 'POST', url: '/v1/store-site/sections', headers: c.owner, payload: { type: 'faq' } })).json().section;
    assert.equal(faq.blocks.length, 3);
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/store-site/sections', headers: c.owner, payload: { type: 'nope' } })).statusCode, 422);

    // Custom code preview, and who may edit.
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/store-site/render', headers: c.owner, payload: { code: '<p style="color:red">{{ 1 | plus: 1 }}</p><iframe src="x"></iframe>' } })).json().html, '<p style="color:red">2</p>');
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@shop.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cass@shop.example');
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: cashier })).statusCode, 403);
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers: cashier, payload: { site: d } })).statusCode, 403);

    // A site that is too large is refused.
    const huge = structuredClone(d);
    huge.footer.text = 'x';
    huge.pages = Array.from({ length: 40 }, (_, i) => ({ slug: `p${i}`, title: 'x', sections: Array.from({ length: 30 }, () => ({ type: 'rich_text', settings: { text: 'y'.repeat(800) } })) }));
    assert.equal((await c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers: c.owner, payload: { site: huge } })).statusCode, 422);
  }));

test('site builder: the owner previews a closed store; buyers and other staff cannot', () =>
  withStore(async (c) => {
    assert.equal((await storeInfo(c)).statusCode, 404);
    assert.equal((await storeInfo(c, { 'x-site-preview': '1' })).statusCode, 404, 'no session');
    const preview = await storeInfo(c, { 'x-site-preview': '1', cookie: c.owner.cookie!, 'x-business': c.slug });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.ok(preview.json().site);
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Cass', email: 'cass@shop.example', role: 'cashier', password: PASSWORD });
    const cashier = await c.login('cass@shop.example');
    assert.equal((await storeInfo(c, { 'x-site-preview': '1', cookie: cashier.cookie!, 'x-business': c.slug })).statusCode, 404);
  }, { open: false }));

test('collections and the catalog: by hand or by rules, sorting, on sale, related products; "was" prices and badges; images in use; page titles and sitemap', () =>
  withStore(async (c) => {
    const mug = await product(c, 'Clay mug', '20.00', { badge: 'New', tags: ['kitchen', 'Kitchen', ' gifts '] }, { compareAtPrice: '30.00' });
    assert.equal(mug.badge, 'New');
    assert.deepEqual(mug.tags, ['kitchen', 'gifts']);
    assert.equal(mug.variants[0].compareAtPrice, '30.00');
    const beans = await product(c, 'Coffee beans', '10.00', { tags: ['coffee'] });
    const tee = await product(c, 'Island tee', '40.00', { tags: ['clothing'] });
    await c.f.db.query("update items set category = 'Kitchen' where product_id = any($1::uuid[])", [[mug.id, beans.id]]);

    const list = (q = '') => c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products${q}` }).then((r) => r.json().data as Array<{ handle: string; price: string; compareAt: string | null; badge: string | null }>);
    const cards = await list();
    const card = cards.find((x) => x.handle === mug.handle)!;
    assert.deepEqual([card.price, card.compareAt, card.badge], ['22.50', '33.75', 'New']);
    assert.deepEqual((await list('?sort=price_asc')).map((x) => x.handle), [beans.handle, mug.handle, tee.handle]);
    assert.deepEqual((await list('?onSale=1')).map((x) => x.handle), [mug.handle]);
    assert.deepEqual((await list(`?handles=${tee.handle},${mug.handle}`)).map((x) => x.handle), [tee.handle, mug.handle], 'in the order asked');
    assert.equal((await list(`?relatedTo=${mug.handle}&limit=2`))[0]!.handle, beans.handle, 'same category first');
    assert.deepEqual((await list('?q=gifts')).map((x) => x.handle), [mug.handle], 'tags are searched');

    // By hand, in the order picked.
    const picked = await c.app.inject({ method: 'POST', url: '/v1/collections', headers: c.owner, payload: { title: 'Staff picks', products: [tee.handle, mug.handle] } });
    assert.equal(picked.statusCode, 201, picked.body);
    assert.deepEqual([picked.json().handle, picked.json().productCount, picked.json().sort], ['staff-picks', 2, 'manual']);
    assert.deepEqual((await list('?collection=staff-picks')).map((x) => x.handle), [tee.handle, mug.handle]);

    // By rules: in the kitchen category, or on sale.
    const rules = { match: 'all', conditions: [{ field: 'category', op: 'is', value: 'kitchen' }, { field: 'price', op: 'lt', value: '25' }] };
    const preview = await c.app.inject({ method: 'POST', url: '/v1/collections/preview', headers: c.owner, payload: { rules } });
    assert.equal(preview.json().count, 2);
    const kitchen = await c.app.inject({ method: 'POST', url: '/v1/collections', headers: c.owner, payload: { title: 'Kitchen', rules, sort: 'price_desc', image: 'not-a-ref' } });
    assert.equal(kitchen.statusCode, 201, kitchen.body);
    assert.equal(kitchen.json().image, null);
    assert.deepEqual((await list('?collection=kitchen')).map((x) => x.handle), [mug.handle, beans.handle], 'its own order');
    assert.equal((await c.app.inject({ method: 'POST', url: '/v1/collections', headers: c.owner, payload: { title: 'Bad', rules: { match: 'all', conditions: [{ field: 'colour', op: 'is', value: 'red' }] } } })).statusCode, 422);

    // The storefront: published collections, and one with its products.
    await c.app.inject({ method: 'PUT', url: `/v1/collections/${picked.json().id}`, headers: c.owner, payload: { title: 'Staff picks', products: [mug.handle], published: false } });
    const shown = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/collections` })).json().data;
    assert.deepEqual(shown.map((x: { handle: string; productCount: number }) => [x.handle, x.productCount]), [['kitchen', 2]]);
    const one = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/collections/kitchen` })).json();
    assert.equal(one.products.length, 2);
    assert.equal((await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/collections/staff-picks` })).statusCode, 404, 'not published');

    // The product page: its "was" price and badge.
    const page = (await c.app.inject({ method: 'GET', url: `/v1/store/${c.slug}/products/${mug.handle}` })).json();
    assert.deepEqual([page.badge, page.variants[0].price, page.variants[0].compareAt], ['New', '22.50', '33.75']);

    // An image the site uses cannot be deleted.
    const img = await c.app.inject({ method: 'POST', url: '/v1/templates/assets', headers: c.owner, payload: { name: 'banner.png', dataBase64: PNG } });
    assert.equal(img.statusCode, 201, img.body);
    const site = (await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: c.owner })).json().draft;
    site.home.sections[0].settings.image = `a:${img.json().id}`;
    site.seo = { title: 'Cayo Coffee · Belize', description: 'Coffee roasted in San Ignacio.', image: `a:${img.json().id}` };
    site.pages = [{ slug: 'shipping', title: 'Shipping', seoDescription: 'How we deliver.', sections: [] }];
    await c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers: c.owner, payload: { site } });
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/v1/templates/assets/${img.json().id}`, headers: c.owner })).json().error.code, 'image_in_use');
    await c.app.inject({ method: 'POST', url: '/v1/store-site/publish', headers: c.owner, payload: {} });

    // What link previews and search engines see.
    const base = `${PUBLIC}/${c.slug}/shop`;
    const home = (await storePageMeta(c.f.db, c.slug, '', base))!;
    assert.deepEqual([home.title, home.description, home.image], ['Cayo Coffee · Belize', 'Coffee roasted in San Ignacio.', `${PUBLIC}/v1/assets/${img.json().id}`]);
    assert.equal((await storePageMeta(c.f.db, c.slug, 'collections/kitchen', base))!.title.startsWith('Kitchen · '), true);
    assert.equal((await storePageMeta(c.f.db, c.slug, 'pages/shipping', base))!.description, 'How we deliver.');
    assert.equal(await storePageMeta(c.f.db, c.slug, 'collections/staff-picks', base), null);
    const sitemap = (await storeSitemap(c.f.db, c.slug, base))!;
    assert.ok(sitemap.includes(`${base}/collections/kitchen`) && sitemap.includes(`${base}/pages/shipping`) && sitemap.includes(`${base}/all`));
    assert.ok(!sitemap.includes('staff-picks'));
  }));

test('the contact form emails the store (reply goes to the buyer); robots are ignored; it is rate limited', () =>
  withStore(async (c) => {
    const send = (body: Record<string, unknown>) => c.app.inject({ method: 'POST', url: `/v1/store/${c.slug}/contact`, payload: { name: 'Ana', email: 'ana@example.com', message: 'Do you have oat milk?', ...body } });
    const ok = await send({ phone: '+501 610 0001' });
    assert.equal(ok.statusCode, 200, ok.body);
    const mail = c.mail.sent.at(-1)!;
    assert.equal(mail.replyTo, 'ana@example.com');
    assert.match(mail.subject, /Message from your store: Ana/);
    assert.match(mail.text, /Phone: \+501 610 0001[\s\S]*Do you have oat milk\?/);
    const before = c.mail.sent.length;
    assert.equal((await send({ website: 'http://spam.example' })).statusCode, 200);
    assert.equal(c.mail.sent.length, before, 'the honeypot was filled: nothing sent');
    for (let i = 0; i < 4; i++) await send({});
    assert.equal((await send({})).statusCode, 429);
  }));

test('two people editing: a save on top of a draft someone else changed is refused, unless it says to replace it', () =>
  withStore(async (c) => {
    const put = (headers: Record<string, string>, payload: unknown) => c.app.inject({ method: 'PUT', url: '/v1/store-site/draft', headers, payload });
    const start = (await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: c.owner })).json();
    assert.equal(start.draftUpdatedAt, null);
    const mine = structuredClone(start.draft);
    mine.seo.title = 'Mine';
    const first = await put(c.owner, { site: mine });
    assert.equal(first.statusCode, 200, first.body);
    const base = first.json().draftUpdatedAt as string;

    // Someone else (another tab, another owner) saves in between.
    await createUser(c.f.db, { tenantId: c.f.tenantA, name: 'Ana', email: 'ana@shop.example', role: 'owner', password: PASSWORD });
    const ana = await c.login('ana@shop.example');
    const theirs = structuredClone(mine);
    theirs.seo.title = 'Theirs';
    assert.equal((await put(ana, { site: theirs, base })).statusCode, 200);

    // My next save was made on top of what I last saw: refused, and theirs is still there.
    mine.seo.title = 'Mine again';
    const refused = await put(c.owner, { site: mine, base });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error.code, 'draft_changed');
    assert.match(refused.json().error.message, /Ana changed the site/);
    assert.equal((await c.app.inject({ method: 'GET', url: '/v1/store-site', headers: c.owner })).json().draft.seo.title, 'Theirs');

    // Keeping mine anyway (no base), then carrying on from there.
    const forced = await put(c.owner, { site: mine });
    assert.equal(forced.statusCode, 200);
    mine.seo.title = 'Mine, later';
    assert.equal((await put(c.owner, { site: mine, base: forced.json().draftUpdatedAt })).statusCode, 200);
    // Discarding and restoring say when the draft changed, for the next save.
    await c.app.inject({ method: 'POST', url: '/v1/store-site/publish', headers: c.owner, payload: {} });
    const discarded = (await c.app.inject({ method: 'POST', url: '/v1/store-site/discard', headers: c.owner, payload: {} })).json();
    assert.equal((await put(c.owner, { site: mine, base: discarded.draftUpdatedAt })).statusCode, 200);
    assert.equal((await put(c.owner, { site: mine, base: 'yesterday' })).statusCode, 400);
  }));

test('normalizeSite keeps a site sound whatever it is given', () => {
  // Pages are kept whatever their address: made from the title, numbered when taken.
  const pages = normalizeSite({ pages: [{ slug: 'about', title: 'About' }, { slug: 'about', title: 'About (copy)' }, { slug: '', title: 'Envíos y Devoluciones' }, { title: '***' }, { slug: 'about-2', title: 'x' }] }).pages;
  assert.deepEqual(pages.map((p) => p.slug), ['about', 'about-2', 'envios-y-devoluciones', 'page', 'about-2-2']);

  assert.throws(() => normalizeSite('nope'));
  const s = normalizeSite({ theme: { preset: 'fresh', radius: 'huge', logoHeight: 500 }, social: { instagram: 'http://insecure.example', facebook: 'https://facebook.com/x' }, footer: { columns: Array.from({ length: 9 }, () => ({ title: 'c' })) } });
  assert.equal(s.theme.preset, 'fresh');
  assert.equal(s.theme.radius, 'large', "the preset's own value");
  assert.equal(s.theme.logoHeight, 96);
  assert.deepEqual([s.social.instagram, s.social.facebook], ['', 'https://facebook.com/x']);
  assert.equal(s.footer.columns.length, 4);
  assert.equal(s.product.relatedTitle, 'You may also like');
});
