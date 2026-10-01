import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../profesional/app.js', import.meta.url), 'utf8');
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

async function portal(options = {}) {
  let html = '';
  const events = new Map();
  const nodes = new Map();
  const requests = [];
  const pushEvents = [];
  const clipboard = [];
  let deviceActive = options.currentActive !== false;
  const subscription = { endpoint: 'https://push.example.test/this-phone', toJSON: () => ({ endpoint: 'https://push.example.test/this-phone', keys: { p256dh: 'test', auth: 'test' } }), async unsubscribe() { pushEvents.push('unsubscribe'); currentSubscription = null; } };
  let currentSubscription = options.existingSubscription || deviceActive ? subscription : null;
  const registration = { pushManager: {
    async getSubscription() { pushEvents.push('getSubscription'); return currentSubscription; },
    async subscribe() { pushEvents.push('subscribe'); currentSubscription = subscription; return subscription; },
  } };
  const notification = { permission: options.permission || 'granted', answer: options.permissionAnswer || 'granted',
    async requestPermission() { pushEvents.push('permission'); this.permission = this.answer; return this.answer; } };
  const pushPayload = () => ({ configured: options.pushConfigured !== false, public_key: 'AQID', active_mobile_devices: deviceActive ? options.devices ?? 1 : options.devices ?? 0 });
  const history = [];
  const media = { matches: !!options.standalone, addEventListener: (name, fn) => events.set(`media:${name}`, fn) };
  const app = { className: '', get innerHTML() { return html; }, set innerHTML(value) { html = value; nodes.clear(); }, querySelectorAll: () => [] };
  const document = {
    hidden: false,
    getElementById(id) {
      if (id === 'professional-portal') return app;
      if (!html.includes(`id="${id}"`)) return null;
      if (!nodes.has(id)) nodes.set(id, { addEventListener(name, handler) { this[name] = handler; }, focus() { document.activeElement = this; } });
      return nodes.get(id);
    },
    querySelector: () => null,
    addEventListener: (name, fn) => events.set(`document:${name}`, fn),
  };
  const navigator = { userAgent: options.ua ?? android, platform: options.platform || '', maxTouchPoints: options.touch || 0, standalone: !!options.iosStandalone,
    clipboard: { async writeText(text) { clipboard.push(text); } },
    ...(options.supported === false ? {} : { serviceWorker: { async register() { pushEvents.push('worker'); return registration; }, ready: Promise.resolve(registration) } }),
  };
  const window = {
    location: { hash: options.invite ? '#invite=invitation-test-token' : '', search: options.search || '', pathname: '/profesional/', origin: 'https://www.reku.io' },
    ...(options.supported === false ? {} : { Notification: notification, PushManager: {} }),
    atob, navigator, history: { replaceState: (...args) => history.push(args[2]) },
    matchMedia: () => media,
    addEventListener: (name, fn) => events.set(name, fn),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, requestAnimationFrame: fn => fn(),
  };
  const fetch = async (path, request) => {
    requests.push({ path, ...request });
    let status = 200;
    let payload = {};
    if (path.endsWith('/invitations/status')) {
      status = options.invite === 'invalid' ? 401 : 200;
      payload = status === 401 ? { code: 'PROFESSIONAL_INVITATION_INVALID', error: 'La invitación venció o no es válida.' } : { status: options.invite };
    } else if (path.endsWith('/invitations/accept')) {
      status = 409;
      payload = { code: 'PROFESSIONAL_INVITATION_USED', error: 'Tu cuenta ya está activada.' };
    } else if (path.endsWith('/auth/me')) payload = { user: { name: 'Fisio' }, professional: { name: 'Fisio' }, csrf_token: 'test-csrf' };
    else if (path.endsWith('/profile')) payload = { profile: { name: 'Fisio' }, services: [] };
    else if (path.endsWith('/integrations/google')) payload = { google: { available: true, connected: options.calendar !== false, needs_meet_reauthorization: !!options.reauthorize } };
    else if (path.endsWith('/notifications/push')) payload = { push: pushPayload() };
    else if (path.endsWith('/subscriptions/check')) payload = { active: deviceActive };
    else if (path.endsWith('/subscriptions')) {
      deviceActive = request.method !== 'DELETE';
      if (options.saveError) { deviceActive = false; status = 503; payload = { error: 'No pudimos guardar este teléfono. Reintentá.' }; }
      else payload = { push: pushPayload() };
    } else if (path.endsWith('/push/test')) payload = { push: pushPayload(), ok: !options.testError, message: options.testError ? 'No se pudo enviar la prueba.' : 'Prueba enviada.' };
    else if (path.endsWith('/activation-email')) payload = { message: 'Enlace enviado por mail.' };
    return { ok: status < 400, status, json: async () => payload };
  };
  vm.runInNewContext(source, { window, document, navigator, fetch, AbortController, FormData, URLSearchParams, URL, Notification: notification, console, Intl });
  await flush();
  await flush();
  return {
    get html() { return html; }, requests, history, events, media, document, notification, pushEvents, clipboard,
    click: async id => { const node = document.getElementById(id); assert.ok(node?.click, id); await node.click({ currentTarget: node, target: node }); await flush(); },
  };
}

test('used invitation opens login immediately without submitting a password or using the token as a session', async () => {
  const page = await portal({ invite: 'used' });
  assert.match(page.html, /id="login-form"/);
  assert.match(page.html, /Tu cuenta ya está activada/);
  assert.doesNotMatch(page.html, /id="invitation-form"/);
  assert.deepEqual(page.history, ['/profesional/']);
  assert.deepEqual(page.requests.map(r => r.path), ['/api/professional/invitations/status']);
});

test('pending invitation still activates; a simultaneous redemption redirects to login', async () => {
  const page = await portal({ invite: 'pending' });
  assert.match(page.html, /id="invitation-form"/);
  const form = page.document.getElementById('invitation-form');
  await form.submit({ preventDefault() {}, currentTarget: { password: { value: 'sample-password' }, password_confirmation: { value: 'sample-password' } } });
  assert.match(page.html, /id="login-form"/);
  assert.deepEqual(page.history, ['/profesional/']);
});

test('expired invitations are not misrepresented as already activated accounts', async () => {
  const page = await portal({ invite: 'invalid' });
  assert.match(page.html, /La invitación venció/);
  assert.doesNotMatch(page.html, /Tu cuenta ya está activada/);
  assert.deepEqual(page.history, []);
});

test('installation suggestion requires mobile browser, calendar and a connected phone', async () => {
  assert.match((await portal()).html, /id="install-app-button"/);
  assert.doesNotMatch((await portal({ ua: ios })).html, /id="install-app-button"/);
  assert.doesNotMatch((await portal({ ua: 'Macintosh', platform: 'MacIntel', touch: 5 })).html, /id="install-app-button"/);
  for (const options of [{ calendar: false }, { reauthorize: true }, { devices: 0, currentActive: false }, { devices: 2, currentActive: false }, { pushConfigured: false }, { ua: 'Macintosh', touch: 0 }, { standalone: true }, { ua: ios, iosStandalone: true }]) {
    assert.doesNotMatch((await portal(options)).html, /id="install-app-button"/, JSON.stringify(options));
  }
});

test('Android installation instructions support dismissal and Escape', async () => {
  for (const [ua, instructions] of [[android, /Instalar app/]]) {
    const page = await portal({ ua });
    await page.click('install-app-button');
    assert.match(page.html, /role="dialog"/);
    assert.match(page.html, instructions);
    assert.equal(page.document.activeElement, page.document.getElementById('close-install-app-button'));
    page.events.get('document:keydown')({ key: 'Escape' });
    assert.doesNotMatch(page.html, /id="install-app-title"/);
    await page.click('dismiss-install-app-button');
    assert.doesNotMatch(page.html, /id="install-app-button"/);
  }
});

test('native installation is requested only on click and only once; dismissed prompts fall back to instructions', async () => {
  const page = await portal();
  let prompts = 0;
  let prevented = false;
  page.events.get('beforeinstallprompt')({ preventDefault() { prevented = true; }, prompt: async () => prompts++, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prevented, true);
  assert.equal(prompts, 0);
  await page.click('install-app-button');
  assert.equal(prompts, 1);
  assert.match(page.html, /Podés instalarla más adelante/);
  await page.click('done-install-app-button');
  await page.click('install-app-button');
  assert.equal(prompts, 1);
});

test('accepted installs, appinstalled and standalone transitions hide the suggestion', async () => {
  const accepted = await portal();
  accepted.events.get('beforeinstallprompt')({ preventDefault() {}, prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  await accepted.click('install-app-button');
  assert.doesNotMatch(accepted.html, /id="install-app-button"/);
  const page = await portal();
  await page.click('install-app-button');
  page.events.get('appinstalled')();
  assert.doesNotMatch(page.html, /id="install-app-(?:button|title)"/);
  const installed = await portal();
  installed.media.matches = true;
  installed.events.get('media:change')();
  assert.doesNotMatch(installed.html, /id="install-app-button"/);
});

test('desktop sends the personal link; it never requests notification permission for the computer', async () => {
  const page = await portal({ ua: 'Macintosh', currentActive: false, devices: 0 });
  assert.match(page.html, /Enviarme el link al celular/);
  assert.match(page.html, /por mail.*desde tu celular/);
  assert.doesNotMatch(page.html, /id="push-enable-button"/);
  await page.click('push-activation-email-button');
  assert.equal(page.requests.filter(r => r.path.endsWith('/activation-email')).length, 1);
  assert.equal(page.pushEvents.includes('permission'), false);
  assert.match(page.html, /Enlace enviado por mail/);
});

test('Android browser and installed app activate this phone directly and keep confirmation visible', async () => {
  for (const standalone of [false, true]) {
    const page = await portal({ currentActive: false, standalone, permission: 'default' });
    assert.match(page.html, /id="push-enable-button"[^>]*>Activar notificaciones/);
    assert.doesNotMatch(page.html, /Enviarme el link|push-activation-email-button|Abrí esta página|Agregar a pantalla/);
    assert.match(page.html, standalone ? /Reku ya está abierta como app/ : /Ya estás en tu celular/);
    assert.equal(page.pushEvents.includes('permission'), false);
    page.pushEvents.length = 0;
    await page.click('push-enable-button');
    assert.equal(page.pushEvents[0], 'permission');
    assert.equal(page.requests.filter(r => r.path.endsWith('/activation-email')).length, 0);
    const saved = page.requests.filter(r => r.path.endsWith('/subscriptions') && r.method === 'POST');
    assert.equal(saved.length, 1);
    assert.equal(JSON.parse(saved[0].body).device_kind, 'mobile');
    assert.equal(saved[0].headers['X-CSRF-Token'], 'test-csrf');
    assert.match(page.html, /ya están activas en este teléfono/);
    assert.match(page.html, /Prueba enviada/);
    assert.match(page.html, /id="push-test-button"/);
    assert.doesNotMatch(page.html, /id="push-enable-button"/);
  }
});

test('iPhone browser explains only installation; the already opened iPhone app activates directly', async () => {
  for (const options of [{ ua: ios }, { ua: ios.replace('Version/18.0', 'CriOS/130.0') }, { ua: 'Macintosh', platform: 'MacIntel', touch: 5 }]) {
    const page = await portal({ ...options, currentActive: false, supported: false });
    assert.match(page.html, /Agregar a pantalla de inicio/);
    assert.match(page.html, /Si ya la instalaste, abrila desde su ícono/);
    assert.doesNotMatch(page.html, /Enviarme el link|Abrí esta página en Safari o Chrome/);
    if (options.ua.includes('CriOS')) assert.match(page.html, /Ver más/);
    const requestCount = page.requests.length;
    await page.click('push-enable-button');
    assert.equal(page.requests.length, requestCount);
    assert.deepEqual(page.pushEvents, []);
    assert.equal(page.document.activeElement, page.document.getElementById('push-setup-guide'));
  }
  const installed = await portal({ ua: ios, iosStandalone: true, currentActive: false, permission: 'default' });
  assert.match(installed.html, /Reku ya está abierta como app/);
  assert.doesNotMatch(installed.html, /Agregar a pantalla|ícono nuevo|Enviarme el link/);
  await installed.click('push-enable-button');
  assert.equal(installed.pushEvents.filter(e => e === 'permission').length, 1);
  assert.match(installed.html, /ya están activas en este teléfono/);
});

test('another connected phone does not hide activation of the current phone or suggest installation prematurely', async () => {
  const page = await portal({ currentActive: false, devices: 2, permission: 'default' });
  assert.match(page.html, /Ya tenés otro teléfono conectado/);
  assert.match(page.html, /id="push-enable-button"/);
  assert.doesNotMatch(page.html, /id="install-app-button"|Falta activar al menos/);
});

test('already active phones offer a test and disable action without reactivation or email', async () => {
  for (const options of [{}, { ua: ios, iosStandalone: true }]) {
    const page = await portal({ ...options, search: '?module=profile' });
    assert.match(page.html, /ya están activas en este teléfono/);
    assert.match(page.html, /id="push-test-button"/);
    assert.match(page.html, /Desactivar en este dispositivo/);
    assert.doesNotMatch(page.html, /id="push-enable-button"|Enviarme el link|push-setup-guide/);
  }
});

test('blocked permissions show relevant device settings and can be rechecked after enabling them', async () => {
  for (const options of [{}, { standalone: true }, { ua: ios, iosStandalone: true }]) {
    const page = await portal({ ...options, currentActive: false, permission: 'denied' });
    assert.match(page.html, /Volver a comprobar/);
    assert.match(page.html, options.ua === ios ? /Ajustes → Notificaciones → Reku/ : options.standalone ? /Aplicaciones → Reku → Notificaciones/ : /Configuración de sitios → Notificaciones/);
    await page.click('push-enable-button');
    assert.equal(page.pushEvents.includes('permission'), false);
    assert.equal(page.pushEvents.includes('subscribe'), false);
    page.notification.permission = 'granted';
    await page.click('push-enable-button');
    assert.equal(page.pushEvents.includes('permission'), false);
    assert.equal(page.pushEvents.filter(e => e === 'subscribe').length, 1);
    assert.match(page.html, /Prueba enviada/);
  }
});

test('dismissed permission can be retried and an already granted permission does not prompt again', async () => {
  const dismissed = await portal({ currentActive: false, permission: 'default', permissionAnswer: 'default' });
  await dismissed.click('push-enable-button');
  assert.match(dismissed.html, /No se concedió el permiso/);
  assert.equal(dismissed.pushEvents.includes('subscribe'), false);
  dismissed.notification.answer = 'granted';
  await dismissed.click('push-enable-button');
  assert.equal(dismissed.pushEvents.filter(e => e === 'permission').length, 2);
  assert.match(dismissed.html, /Prueba enviada/);
  const granted = await portal({ currentActive: false, permission: 'granted' });
  await granted.click('push-enable-button');
  assert.equal(granted.pushEvents.includes('permission'), false);
  assert.match(granted.html, /Prueba enviada/);
});

test('embedded or unsupported browsers explain recovery and copy only the clean portal address', async () => {
  for (const ua of [android, android + ' Instagram', ios + ' Instagram']) {
    const page = await portal({ currentActive: false, supported: false, ua });
    assert.doesNotMatch(page.html, /Enviarme el link/);
    assert.match(page.html, /Copiar dirección del portal/);
    if (ua.includes('iPhone')) assert.match(page.html, /Continuá en Safari/);
    const before = page.requests.length;
    await page.click('push-enable-button');
    await page.click('push-copy-portal-button');
    assert.deepEqual(page.clipboard, ['https://www.reku.io/profesional/']);
    assert.equal(page.requests.length, before);
    assert.deepEqual(page.pushEvents, []);
  }
  const oldIos = await portal({ ua: ios, iosStandalone: true, currentActive: false, supported: false });
  assert.match(oldIos.html, /Actualizá tu iPhone/);
  assert.match(oldIos.html, /16.4 o posterior/);
  assert.doesNotMatch(oldIos.html, /Agregar a pantalla|Enviarme el link/);
});

test('save and test errors remain visible without claiming a failed activation succeeded', async () => {
  const failed = await portal({ currentActive: false, saveError: true });
  await failed.click('push-enable-button');
  assert.match(failed.html, /No pudimos guardar este teléfono/);
  assert.doesNotMatch(failed.html, /ya están activas en este teléfono/);
  assert.match(failed.html, /id="push-enable-button"/);
  const failedTest = await portal({ currentActive: false, testError: true });
  await failedTest.click('push-enable-button');
  assert.match(failedTest.html, /ya están activas en este teléfono/);
  assert.match(failedTest.html, /No se pudo enviar la prueba/);
  assert.match(failedTest.html, /id="push-test-button"/);
});
