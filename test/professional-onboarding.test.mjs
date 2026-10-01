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
  const navigator = { userAgent: options.ua ?? android, platform: options.platform || '', maxTouchPoints: options.touch || 0, standalone: !!options.iosStandalone };
  const window = {
    location: { hash: options.invite ? '#invite=invitation-test-token' : '', search: '', pathname: '/profesional/' },
    navigator, history: { replaceState: (...args) => history.push(args[2]) },
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
    else if (path.endsWith('/notifications/push')) payload = { push: { configured: options.pushConfigured !== false, active_mobile_devices: options.devices ?? 1 } };
    return { ok: status < 400, status, json: async () => payload };
  };
  vm.runInNewContext(source, { window, document, navigator, fetch, AbortController, FormData, URLSearchParams, console, Intl });
  await flush();
  return {
    get html() { return html; }, requests, history, events, media, document,
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
  assert.match((await portal({ ua: ios })).html, /id="install-app-button"/);
  assert.match((await portal({ ua: 'Macintosh', platform: 'MacIntel', touch: 5 })).html, /id="install-app-button"/);
  for (const options of [{ calendar: false }, { reauthorize: true }, { devices: 0 }, { pushConfigured: false }, { ua: 'Macintosh', touch: 0 }, { standalone: true }, { ua: ios, iosStandalone: true }]) {
    assert.doesNotMatch((await portal(options)).html, /id="install-app-button"/, JSON.stringify(options));
  }
});

test('manual instructions match Android, Safari and Chrome on iOS; dismiss and Escape work', async () => {
  for (const [ua, instructions] of [[android, /Instalar app/], [ios, /Abrir como app web/], [ios.replace('Version/18.0', 'CriOS/130.0'), /Ver más/]]) {
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
