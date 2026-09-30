import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { buildPushActivationUrl, requirePushActivationOrigin } from '../src/professional-push-activation.mjs';
import { config } from '../src/config.mjs';

const source = await readFile(new URL('../profesional/activation.js', import.meta.url), 'utf8');
const portalSource = await readFile(new URL('../profesional/app.js', import.meta.url), 'utf8');
const token = 'a'.repeat(43);
const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

async function activationPage({ permission = 'default', permissionAnswer = 'granted', ios = false,
  standalone = false, supported = true, fragment = `#activar=${token}`, used = false, active = false,
  existing = false, apiError = null, storageAvailable = true, chromeIos = false, clipboardAvailable = true } = {}) {
  const requests = [];
  const events = [];
  const elements = new Map();
  for (const id of ['activate-button', 'activation-message', 'activation-title', 'activation-description',
    'activation-name', 'activation-success', 'install-guide', 'install-browser-hint', 'copy-activation-link',
    'manual-copy-link', 'manual-copy-label', 'copy-link-message']) {
    elements.set(id, { hidden: !['activation-title', 'activation-description', 'activation-message'].includes(id),
      textContent: '', addEventListener(event, handler) { this[event] = handler; }, focus() {}, select() {} });
  }
  const storage = new Map();
  const browserSubscription = { toJSON: () => ({ endpoint: 'https://push.example.test/browser', keys: { p256dh: 'A'.repeat(88), auth: 'b'.repeat(22) } }) };
  let current = existing ? browserSubscription : null;
  const registration = { pushManager: {
    async getSubscription() { events.push('getSubscription'); return current; },
    async subscribe() { events.push('subscribe'); current = browserSubscription; return current; },
  } };
  const notification = { permission, answer: permissionAnswer, async requestPermission() { events.push('permission'); this.permission = this.answer; return this.answer; } };
  const clipboard = [];
  const navigator = { userAgent: ios ? chromeIos ? 'iPhone CriOS/143 Safari' : 'iPhone Safari' : 'Android Chrome', standalone,
    ...(clipboardAvailable ? { clipboard: { async writeText(value) { clipboard.push(value); } } } : {}),
    ...(supported ? { serviceWorker: {
      async register() { events.push('register'); return registration; }, ready: Promise.resolve(registration),
    } } : {}),
  };
  const location = { pathname: '/profesional/activar-notificaciones.html', hash: fragment, origin: 'https://www.reku.io' };
  const window = { location, matchMedia: () => ({ matches: standalone }), setTimeout, clearTimeout,
    ...(supported ? { PushManager: {}, Notification: notification } : {}),
    history: { replaceState(_state, _title, next) { location.hash = new URL(next, 'https://www.reku.io').hash; } },
  };
  const fetch = async (path, options) => {
    requests.push({ path, options, body: JSON.parse(options.body) });
    const result = path.endsWith('/subscribe') ? { ok: true } : { name: '<Fisio de prueba>', configured: true, public_key: 'AQID', used, active };
    return { ok: !apiError, status: apiError ? 401 : 200, json: async () => apiError ? { error: apiError } : result };
  };
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements.get(id) }, window, navigator, fetch,
    Notification: notification, URL, URLSearchParams, Uint8Array, AbortController, atob,
    sessionStorage: {
      setItem(key, value) { if (!storageAvailable) throw new Error('No storage'); storage.set(key, value); },
      getItem(key) { if (!storageAvailable) throw new Error('No storage'); return storage.get(key); },
      removeItem(key) { storage.delete(key); },
    },
  });
  await flush();
  return { requests, events, location, storage, notification, clipboard, element: (id) => elements.get(id),
    async click(id = 'activate-button') { await elements.get(id).click(); await flush(); } };
}

test('activation URLs keep the secret out of the path and query, and require same-origin JSON', () => {
  const url = new URL(buildPushActivationUrl(token));
  assert.equal(url.pathname, '/profesional/activar-notificaciones.html');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#activar=${token}`);
  const origin = new URL(config.appPublicUrl).origin;
  assert.doesNotThrow(() => requirePushActivationOrigin({ headers: { origin, 'content-type': 'application/json; charset=UTF-8' } }));
  for (const headers of [{}, { origin }, { origin: 'https://attacker.example.test', 'content-type': 'application/json' }, { origin, 'content-type': 'text/plain' }]) {
    assert.throws(() => requirePushActivationOrigin({ headers }), { statusCode: 403 });
  }
});

test('opening the link skips login and asks for permission only from the button', async () => {
  const page = await activationPage();
  assert.equal(page.requests.length, 1);
  assert.equal(page.element('activate-button').hidden, false);
  assert.equal(page.element('activation-name').textContent, '<Fisio de prueba>');
  assert.equal(page.events.includes('permission'), false);
  assert.equal(page.location.hash, '');
  await page.click();
  assert.equal(page.element('activation-success').hidden, false);
  assert.equal(page.events.filter(event => event === 'permission').length, 1);
  assert.ok(page.events.indexOf('permission') < page.events.indexOf('getSubscription'));
  assert.equal(page.requests[1].body.token, token);
  assert.equal(page.requests[1].body.device_kind, 'mobile');
  assert.equal(page.storage.size, 0);
  for (const request of page.requests) {
    assert.equal(request.options.credentials, 'omit');
    assert.match(request.path, /^\/api\/professional\/notifications\/push\/activation/);
  }
});

test('an already granted permission activates automatically; denial does not register a device', async () => {
  const granted = await activationPage({ permission: 'granted' });
  assert.equal(granted.element('activation-success').hidden, false);
  assert.equal(granted.events.includes('permission'), false);
  assert.equal(granted.requests.length, 2);
  const denied = await activationPage({ permissionAnswer: 'denied' });
  await denied.click();
  assert.match(denied.element('activation-message').textContent, /bloqueadas/);
  assert.equal(denied.requests.length, 1);
  assert.equal(denied.events.includes('subscribe'), false);
  assert.equal(denied.element('activation-success').hidden, true);
});

test('a dismissed prompt can be retried without consuming the personal link', async () => {
  const page = await activationPage({ permissionAnswer: 'default' });
  await page.click();
  assert.match(page.element('activation-message').textContent, /no concedió/);
  assert.equal(page.requests.length, 1);
  assert.equal(page.events.includes('subscribe'), false);
  page.notification.answer = 'granted';
  await page.click();
  assert.equal(page.requests[1].body.token, token);
  assert.equal(page.element('activation-success').hidden, false);
  assert.equal(page.events.filter(event => event === 'permission').length, 2);
});

test('blocked permission explains Android and iPhone settings and rechecks without prompting again', async () => {
  for (const ios of [false, true]) {
    const page = await activationPage({ ios, standalone: ios, permission: 'denied' });
    assert.equal(page.element('activate-button').textContent, 'Volver a comprobar');
    assert.match(page.element('activation-message').textContent, ios ? /Ajustes → Notificaciones/ : /Permisos → Notificaciones/);
    await page.click();
    assert.equal(page.requests.length, 1);
    assert.equal(page.events.includes('permission'), false);
    assert.equal(page.events.includes('subscribe'), false);
    page.notification.permission = 'granted';
    await page.click();
    assert.equal(page.element('activation-success').hidden, false);
    assert.equal(page.requests[1].body.token, token);
  }
});

test('Chrome on iPhone explains installation and copies the complete link for Safari, with a manual fallback', async () => {
  for (const clipboardAvailable of [true, false]) {
    const page = await activationPage({ ios: true, chromeIos: true, supported: false, clipboardAvailable });
    assert.match(page.element('install-browser-hint').textContent, /En Chrome, tocá Compartir/);
    await page.click('copy-activation-link');
    const url = new URL(clipboardAvailable ? page.clipboard[0] : page.element('manual-copy-link').value);
    assert.equal(url.origin, 'https://www.reku.io');
    assert.equal(url.pathname, '/profesional/activar-notificaciones.html');
    assert.equal(url.hash, `#activar=${token}`);
    if (!clipboardAvailable) assert.equal(page.element('manual-copy-label').hidden, false);
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.events, []);
  }
});

test('iPhone preserves the email fragment for Home Screen installation and activates without shared storage', async () => {
  const safari = await activationPage({ ios: true, supported: false, storageAvailable: false });
  assert.equal(safari.location.hash, `#activar=${token}`);
  assert.equal(safari.element('install-guide').hidden, false);
  assert.equal(safari.element('activate-button').hidden, true);
  assert.deepEqual(safari.events, []);
  const installed = await activationPage({ ios: true, standalone: true, storageAvailable: false });
  await installed.click();
  assert.equal(installed.element('activation-success').hidden, false);
  assert.equal(installed.requests[1].body.device_kind, 'mobile');
  const manifest = JSON.parse(await readFile(new URL('../profesional/activation.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, undefined, 'installation must retain the document URL with its activation fragment');
  assert.equal(manifest.id, '/profesional/');
  assert.equal(manifest.scope, '/profesional/');
  assert.equal(manifest.display, 'standalone');
});

test('a completed link confirms only its existing subscription, without subscribing again', async () => {
  const page = await activationPage({ used: true, active: true, existing: true, permission: 'granted' });
  assert.equal(page.element('activation-success').hidden, false);
  assert.equal(page.requests.length, 2);
  assert.ok(page.requests[1].body.subscription);
  assert.equal(page.events.includes('subscribe'), false);
  const otherDevice = await activationPage({ used: true });
  assert.match(otherDevice.element('activation-message').textContent, /ya se usó/);
  assert.equal(otherDevice.element('activate-button').hidden, true);
});

test('missing and invalid links explain recovery without falling back to login', async () => {
  const missing = await activationPage({ fragment: '' });
  assert.equal(missing.requests.length, 0);
  assert.match(missing.element('activation-message').textContent, /enlace personal/);
  const expired = await activationPage({ apiError: 'El enlace venció.' });
  assert.equal(expired.element('activate-button').hidden, true);
  assert.equal(expired.element('activation-message').textContent, 'El enlace venció.');
  assert.equal(expired.requests.length, 1);
});

test('portal requests permission synchronously before waiting for its worker and never subscribes on refusal', async () => {
  const start = portalSource.indexOf('async function handlePushEnable()');
  const end = portalSource.indexOf('async function handlePushTest()', start);
  assert.ok(start >= 0 && end > start);
  for (const permission of ['default', 'denied', 'granted']) {
    for (const answer of permission === 'default' ? ['default', 'denied', 'granted'] : [permission]) {
      const events = [];
      const state = { push: { busy: false, public_key: 'AQID' } };
      const registration = { pushManager: {
        async getSubscription() { return null; },
        async subscribe() { events.push('subscribe'); return { toJSON: () => ({ endpoint: 'https://push.example.test/browser' }) }; },
      } };
      const enable = vm.runInNewContext(`(${portalSource.slice(start, end).trim()})`, {
        state, isIosDevice: () => false, isStandaloneApp: () => false, isMobileDevice: () => true,
        pushSupported: () => true, pushPermissionError: value => `Permission: ${value}`, render() {},
        Notification: { permission, async requestPermission() { events.push('permission'); return answer; } },
        async ensurePushServiceWorker() { events.push('worker'); return registration; },
        urlBase64ToUint8Array: () => new Uint8Array(), pushDeviceLabel: () => 'Android',
        async api() { events.push('save'); return { push: {} }; },
        async updatePushState() { state.push.busy = false; }, async handlePushTest() { events.push('test'); },
      });
      const pending = enable();
      assert.deepEqual(events, permission === 'default' ? ['permission'] : [], 'request must happen within the original click call');
      await pending;
      if (answer === 'granted') {
        assert.deepEqual(events, [...(permission === 'default' ? ['permission'] : []), 'worker', 'subscribe', 'save', 'test']);
      } else {
        assert.equal(events.includes('worker'), false);
        assert.equal(events.includes('save'), false);
        assert.equal(state.push.message, `Permission: ${answer}`);
      }
      assert.equal(state.push.busy, false);
    }
  }
});
