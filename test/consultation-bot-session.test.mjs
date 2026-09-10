import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { forgetConsultationSession, handleConsultationBot, welcomeMessages } from '../src/consultation-bot.mjs';

test('second welcome message explains AI audio transcription', () => {
  assert.equal(welcomeMessages.length, 2);
  assert.equal(welcomeMessages[1], 'Podés escribirlo o, si te resulta más cómodo, mandar un audio. Nosotros lo transcribimos a texto con ayuda de IA.');
});

test('reset forgets only the session for this cookie and host', () => {
  const store = new Map([['a', { host: 'ypf.reku.io', instanceId: 'old' }], ['b', { host: 'www.reku.io', instanceId: 'other' }]]);
  assert.equal(forgetConsultationSession(store, 'a', 'www.reku.io'), false);
  assert.equal(forgetConsultationSession(store, 'missing', 'ypf.reku.io'), false);
  assert.equal(forgetConsultationSession(store, 'a', 'ypf.reku.io'), true);
  assert.equal(store.size, 1);
  assert.ok(store.has('b'));
});
test('a delayed close cannot delete a newer tab session', () => {
  const store = new Map([['cookie', { host: 'ypf.reku.io', instanceId: 'new' }]]);
  assert.equal(forgetConsultationSession(store, 'cookie', 'ypf.reku.io', 'old'), false);
  assert.equal(store.size, 1);
  assert.equal(forgetConsultationSession(store, 'cookie', 'ypf.reku.io', 'new'), true);
  assert.equal(store.size, 0);
});
const request = async (method, path, body = {}, origin = 'https://www.reku.io') => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, headers: { host: 'www.reku.io', origin, cookie: 'reku_consultation_bot=legacy-token' } });
  let code, headers, data;
  await handleConsultationBot(req, { writeHead: (c, h) => { code = c; headers = h; }, end: text => { data = JSON.parse(text); } }, new URL('https://www.reku.io/api/bot/' + path));
  return { code, headers, data };
};
test('session recovery returns no history and reset expires the legacy cookie', async () => {
  const recovered = await request('GET', 'session');
  assert.equal(recovered.code, 200);
  assert.equal(recovered.data.session, null);
  const reset = await request('POST', 'reset');
  assert.equal(reset.code, 200);
  assert.equal(reset.data.session, null);
  assert.match(reset.headers['Set-Cookie'], /reku_consultation_bot=;.*Max-Age=0/);
  assert.match(reset.headers['Cache-Control'], /no-store/);
});
test('reset and close reject foreign origins; close requires an instance and never clears newer cookies', async () => {
  for (const path of ['reset', 'close']) assert.equal((await request('POST', path, { instanceId: 'old' }, 'https://evil.test')).code, 403);
  assert.equal((await request('POST', 'close')).code, 422);
  const closed = await request('POST', 'close', { instanceId: 'old' });
  assert.equal(closed.code, 200);
  assert.equal(closed.headers['Set-Cookie'], undefined);
});
