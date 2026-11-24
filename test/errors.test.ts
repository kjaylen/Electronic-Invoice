/**
 * Errors a developer can act on: a request that does not fit says which
 * field and what it must be, in one shape, whatever went wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { describeValidation } from '../src/api/validation-words.ts';
import { setupPipeline } from './pipeline-setup.ts';

test('validation findings in words', () => {
  const say = (keyword: string, instancePath: string, params: Record<string, unknown>, where = 'body') => describeValidation({ keyword, instancePath, params }, where);
  assert.equal(say('required', '', { missingProperty: 'fulfillment' }), 'fulfillment is required');
  assert.equal(say('required', '/customer', { missingProperty: 'phone' }), 'customer.phone is required');
  assert.equal(say('type', '/lines/0/quantity', { type: 'integer' }), 'lines[0].quantity must be a whole number');
  assert.equal(say('type', '/note', { type: ['string', 'null'] }), 'note must be text (in quotes) or null');
  assert.equal(say('enum', '/fulfillment', { allowedValues: ['delivery', 'pickup'] }), 'fulfillment must be one of: "delivery", "pickup"');
  assert.equal(say('additionalProperties', '', { additionalProperty: 'page' }, 'querystring'), 'query parameter page is not a parameter this request takes. Check its spelling against the API reference.');
  assert.equal(say('additionalProperties', '/customer', { additionalProperty: 'fullName' }), 'customer.fullName is not a field this request takes. Check its spelling against the API reference.');
  assert.equal(say('pattern', '/id', { pattern: '^[0-9a-fA-F-]{36}$' }, 'params'), 'in the address, id must be an id (36 characters, as this API gave it out)');
  assert.equal(say('pattern', '/unitPrice', { pattern: '^-?\\d{1,15}(\\.\\d{1,6})?$' }), 'unitPrice must be a decimal number written as text, like "24.99"');
  assert.equal(say('pattern', '/dueDate', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), 'dueDate must be a date like 2026-12-31');
  assert.equal(say('pattern', '/business/tin', { pattern: '^\\d{6}$' }), 'business.tin must be 6 digits');
  assert.equal(say('pattern', '/limit', { pattern: '^\\d{1,3}$' }, 'querystring'), 'query parameter limit must be a whole number (digits only)');
  assert.equal(say('pattern', '/customer/email', { pattern: '^$|^[^\\s@,;<>]+@[^\\s@,;<>]+\\.[^\\s@,;<>]+$' }), 'customer.email must be an email address');
  assert.equal(say('pattern', '/code', { pattern: '^[A-Z]{3}$' }), 'code is not in the form expected (^[A-Z]{3}$)');
  assert.equal(say('minLength', '/name', { limit: 1 }), 'name must not be empty');
  assert.equal(say('minLength', '/customer/phone', { limit: 7 }), 'customer.phone must be at least 7 characters');
  assert.equal(say('maxLength', '/note', { limit: 1000 }), 'note must be at most 1000 characters');
  assert.equal(say('minimum', '/lines/2/quantity', { limit: 1 }), 'lines[2].quantity must be at least 1');
  assert.equal(say('minItems', '/lines', { limit: 1 }), 'lines must have at least one item');
  assert.equal(say('minProperties', '', { limit: 1 }), 'the request body must have at least one field');
  assert.equal(describeValidation({ keyword: 'anyOf', instancePath: '/x', message: 'must match a schema in anyOf' }, 'body'), 'x must match a schema in anyOf');
});

test('the API says what is wrong with a request, in one shape', async () => {
  const f = await setupPipeline();
  const app = await buildApp({ pipeline: f.deps, cookieSecure: true });
  const slug = (await f.db.query<{ slug: string }>('select slug from tenants where id = $1', [f.tenantA])).rows[0]!.slug;
  const variantId = '00000000-0000-4000-8000-000000000000';
  const quote = `/v1/store/${slug}/quote`;
  const post = (payload: unknown) => app.inject({ method: 'POST', url: quote, payload: payload as object });
  try {
    const cases: Array<[() => Promise<LightMyRequestResponse>, number, string]> = [
      [() => app.inject({ method: 'GET', url: `/v1/store/${slug}/products?limit=abc` }), 400, 'query parameter limit must be a whole number (digits only)'],
      [() => app.inject({ method: 'GET', url: `/v1/store/${slug}/products?page=2` }), 400, 'query parameter page is not a parameter this request takes. Check its spelling against the API reference.'],
      [() => app.inject({ method: 'GET', url: `/v1/store/${slug}/products?sort=cheapest` }), 400, 'query parameter sort must be one of: "manual", "newest", "price_asc", "price_desc", "title", "best_selling"'],
      [() => post({ lines: [{ variantId, quantity: 1 }] }), 400, 'fulfillment is required'],
      [() => post({ lines: [{ variantId, quantity: '1' }], fulfillment: 'pickup' }), 400, 'lines[0].quantity must be a whole number'],
      [() => post({ lines: [{ variantId, quantity: 0 }], fulfillment: 'pickup' }), 400, 'lines[0].quantity must be at least 1'],
      [() => post({ lines: [{ variantId: 'tee-s', quantity: 1 }], fulfillment: 'pickup' }), 400, 'lines[0].variantId must be an id (36 characters, as this API gave it out)'],
      [() => post({ lines: [], fulfillment: 'pickup' }), 400, 'lines must have at least one item'],
      [() => post({ lines: [{ variantId, quantity: 1 }], fulfillment: 'post' }), 400, 'fulfillment must be one of: "delivery", "pickup"'],
      [() => post({ lines: [{ variantId, quantity: 1 }], fulfillment: 'pickup', coupon: 'X' }), 400, 'coupon is not a field this request takes. Check its spelling against the API reference.'],
      [() => app.inject({ method: 'POST', url: quote, payload: '{"lines": [', headers: { 'content-type': 'application/json' } }), 400, 'The body is not valid JSON'],
      [() => app.inject({ method: 'POST', url: quote, payload: 'lines=1', headers: { 'content-type': 'text/plain' } }), 400, 'The body must be a JSON object. Send JSON, with the header Content-Type: application/json'],
      [() => app.inject({ method: 'POST', url: quote, payload: 'lines=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 415, 'Send the body as JSON, with the header Content-Type: application/json'],
      [() => app.inject({ method: 'POST', url: quote, headers: { 'content-type': 'application/json' } }), 400, 'The body is empty.'],
      [() => app.inject({ method: 'GET', url: '/v1/store/Not_A_Store/products' }), 400, "in the address, slug must be a store's name as in its address (lower-case letters, digits and hyphens)"],
      [() => app.inject({ method: 'GET', url: `/v1/store/${slug}/cart` }), 404, `There is no GET /v1/store/${slug}/cart in this API. Check the address and the method against the reference at /docs.`],
      [() => app.inject({ method: 'DELETE', url: '/v1/nothing?x=1' }), 404, 'There is no DELETE /v1/nothing in this API.'],
    ];
    for (const [call, status, message] of cases) {
      const res = await call();
      const body = res.json() as { error: { code: string; message: string } };
      assert.equal(res.statusCode, status, JSON.stringify(body));
      assert.deepEqual(Object.keys(body), ['error']);
      assert.equal(body.error.code, status === 404 ? 'not_found' : 'invalid_request');
      assert.ok(body.error.message.startsWith(message), `"${body.error.message}" does not start with "${message}"`);
    }
    // The validator's own findings stay in details, for programs that read them.
    const details = (await post({ lines: [{ variantId, quantity: '1' }], fulfillment: 'pickup' })).json().error.details;
    assert.equal(details[0].instancePath, '/lines/0/quantity');
    assert.equal(details[0].keyword, 'type');
  } finally {
    await app.close();
    await f.close();
  }
});
