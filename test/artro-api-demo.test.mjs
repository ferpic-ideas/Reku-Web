import test from 'node:test';
import assert from 'node:assert/strict';
import { demoRoute, demoQuery, demoCookie, demoIdempotencyKey } from '../src/artro-api-demo.mjs';
import { resolveStaticPath, resolveStaticRequestPath } from '../src/http.mjs';

test('demo exposes only the example adapter routes, not arbitrary proxy targets', () => {
  for (const [method, path] of [['GET','/agreement'],['GET','/services'],['POST','/holds'],['GET','/appointments'],['PATCH',`/appointments/apt_${'a'.repeat(32)}`]]) assert.equal(demoRoute(method,path),true);
  for (const [method,path] of [['DELETE','/appointments'],['POST','/agreement'],['GET','https://artro.com.ar/'],['GET','//evil.test'],['GET','/../admin'],['GET','/appointments/123']]) assert.equal(Boolean(demoRoute(method,path)),false);
});
test('demo only forwards explicit query parameters and session-scoped idempotency keys', () => {
  assert.equal(demoQuery(new URLSearchParams('service_id=2&date=2026-10-01')), 'service_id=2&date=2026-10-01');
  assert.throws(() => demoQuery(new URLSearchParams('url=https://evil.test')));
  assert.throws(() => demoQuery(new URLSearchParams('service_id=2&service_id=3')));
  const key = 'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+ 'a'.repeat(12);
  assert.notEqual(demoIdempotencyKey('a'.repeat(64),key),demoIdempotencyKey('b'.repeat(64),key));
  assert.throws(() => demoIdempotencyKey('a'.repeat(64), 'short'));
  assert.match(demoCookie('synthetic'), /Path=\/test; HttpOnly; SameSite=Strict/);
});
test('test URL maps only to demo assets, never the unit test or server source directories', async () => {
  assert.equal(resolveStaticRequestPath('/test'), '/test/index.html');
  assert.match(await resolveStaticPath('/test/index.html'), /artro-demo\/index.html$/);
  assert.equal(await resolveStaticPath('/test/artro-api-demo.test.mjs'), null);
  assert.equal(await resolveStaticPath('/test/../src/artro-api-demo.mjs'), null);
  assert.equal(await resolveStaticPath('/artro-demo/index.html'), null);
});
