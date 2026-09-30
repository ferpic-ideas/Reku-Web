import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import pg from 'pg';
import webpush from 'web-push';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('personal push links activate exactly one device without granting a portal session', { skip: !databaseUrl }, async (t) => {
  assert.match(new URL(databaseUrl).pathname, /test/i);
  const schema = `push_activation_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(databaseUrl);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const vapid = webpush.generateVAPIDKeys();
  process.env.DATABASE_URL = isolated.href;
  process.env.APP_PUBLIC_URL = base;
  process.env.EMAIL_DRY_RUN = 'true';
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.BOOTSTRAP_ADMIN_EMAIL = '';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = '';
  const { initDb, query, pool } = await import('../src/db.mjs');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await initDb();
  const { handleProfessionalApi } = await import('../src/professional-api.mjs');
  const { serveStatic, sendJson, resolveStaticRequestPath } = await import('../src/http.mjs');
  const { createPushActivationLink } = await import('../src/professional-push-activation.mjs');
  const { revokeProfessionalAccess } = await import('../src/professional-links.mjs');
  const { createSessionToken, hashToken } = await import('../src/security.mjs');
  handler = async (req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/api/')) {
      if (!await handleProfessionalApi(req, res, url)) sendJson(res, 404, {});
    } else await serveStatic(req, res, resolveStaticRequestPath(url.pathname));
  };
  const professional = (await query("INSERT INTO professionals (name,email) VALUES ('Fisio prueba','push@example.test') RETURNING id")).rows[0];
  const user = (await query(`INSERT INTO users (name,email,role,professional_id,password_hash)
    VALUES ('Fisio prueba','push@example.test','professional',$1,'not-a-password') RETURNING *`, [professional.id])).rows[0];
  const another = (await query("INSERT INTO professionals (name,email) VALUES ('Otro','other@example.test') RETURNING id")).rows[0];
  const anotherUser = (await query(`INSERT INTO users (name,email,role,professional_id,password_hash)
    VALUES ('Otro','other@example.test','professional',$1,'not-a-password') RETURNING *`, [another.id])).rows[0];
  const request = async (path, body, extra = {}) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, json: await response.json() };
  };
  const api = '/api/professional/notifications/push/activation';
  const tokenOf = (link) => new URLSearchParams(new URL(link.url).hash.slice(1)).get('activar');
  const newLink = async (id = user.id) => {
    const link = await createPushActivationLink(id);
    return { ...link, token: tokenOf(link) };
  };
  const subscription = (id) => ({ endpoint: `https://push.example.test/${id}`, keys: { p256dh: 'A'.repeat(88), auth: 'b'.repeat(22) } });
  let link;

  await t.test('email request creates a personal link; landing page and metadata work without cookies', async () => {
    const session = createSessionToken(user);
    const email = await request('/api/professional/notifications/push/activation-email', {}, {
      Cookie: `reku_admin_session=${session.token}`, 'X-CSRF-Token': session.csrf,
    });
    assert.equal(email.status, 200);
    assert.equal((await query('SELECT * FROM professional_push_activation_links')).rowCount, 1);
    assert.doesNotMatch(JSON.stringify(email.json), /token|activation_link/);
    link = await newLink();
    assert.equal(new URL(link.url).search, '');
    assert.equal(new URL(link.url).pathname, '/profesional/activar-notificaciones.html');
    const stored = (await query('SELECT * FROM professional_push_activation_links WHERE id=$1', [link.id])).rows[0];
    assert.equal(stored.token_hash, hashToken(link.token));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(link.token));
    const page = await fetch(link.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Permitir notificaciones/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const info = await request(api, { token: link.token });
    assert.equal(info.status, 200);
    assert.equal(info.json.name, user.name);
    assert.equal(info.json.public_key, vapid.publicKey);
    assert.equal(info.headers.get('set-cookie'), null);
    assert.equal((await query('SELECT used_at FROM professional_push_activation_links WHERE id=$1', [link.id])).rows[0].used_at, null);
  });
  await t.test('activation assigns the link owner, ignores account IDs and unrelated login cookies', async () => {
    const otherSession = createSessionToken(anotherUser);
    const result = await request(api + '/subscribe', {
      token: link.token, subscription: subscription('first'), professional_id: another.id, user_id: anotherUser.id,
      device_kind: 'mobile', device_label: 'Android de prueba',
    }, { Cookie: `reku_admin_session=${otherSession.token}` });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('set-cookie'), null);
    const saved = (await query('SELECT * FROM professional_push_subscriptions')).rows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].professional_id, professional.id);
    assert.equal(saved[0].user_id, user.id);
    assert.equal(saved[0].device_kind, 'mobile');
    assert.equal((await request(api, { token: link.token, subscription: subscription('first') })).json.active, true);
    assert.equal((await request(api + '/subscribe', { token: link.token, subscription: subscription('first') })).status, 200);
    assert.equal((await request(api + '/subscribe', { token: link.token, subscription: subscription('second') })).status, 409);
    assert.equal((await query('SELECT * FROM professional_push_subscriptions')).rowCount, 1);
  });
  await t.test('the capability does not authenticate the portal or authorize other notification actions', async () => {
    for (const path of ['/auth/me', '/patients', '/appointments', '/notifications/push']) {
      const response = await fetch(base + '/api/professional' + path, {
        headers: { Authorization: `Bearer ${link.token}`, Cookie: `reku_admin_session=${link.token}; reku_professional_session=${link.token}` },
      });
      assert.equal(response.status, 401, path);
    }
    for (const path of ['/test', '/subscriptions', '/activation-email']) {
      assert.equal((await request('/api/professional/notifications/push' + path, { token: link.token, subscription: subscription('extra') })).status, 401);
    }
    assert.equal((await request(api, { token: link.token }, { Origin: 'https://other.example.test' })).status, 403);
    assert.equal((await fetch(base + api)).status, 405);
  });
  await t.test('invalid and expired tokens, disabled accounts and revoked access are rejected', async () => {
    assert.equal((await request(api, { token: 'z'.repeat(43) })).status, 401);
    assert.equal((await request(api, { token: '<bad>' })).status, 401);
    const expired = await newLink();
    await query("UPDATE professional_push_activation_links SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [expired.id]);
    assert.equal((await request(api + '/subscribe', { token: expired.token, subscription: subscription('expired') })).status, 401);
    const pending = await newLink();
    await query('UPDATE users SET is_active=FALSE WHERE id=$1', [user.id]);
    assert.equal((await request(api, { token: pending.token })).status, 401);
    await query('UPDATE users SET is_active=TRUE, session_version=session_version+1 WHERE id=$1', [user.id]);
    assert.equal((await request(api, { token: pending.token })).status, 401);
    const revoked = await newLink();
    await revokeProfessionalAccess(professional.id);
    assert.equal((await request(api, { token: revoked.token })).status, 401);
    const inactive = await newLink();
    await query('UPDATE professionals SET active=FALSE WHERE id=$1', [professional.id]);
    assert.equal((await request(api, { token: inactive.token })).status, 401);
    await query('UPDATE professionals SET active=TRUE WHERE id=$1', [professional.id]);
  });
  await t.test('concurrent redemptions register one device and failed saves do not consume the link', async () => {
    const raced = await newLink();
    const results = await Promise.all(['race-a', 'race-b'].map(id => request(api + '/subscribe', { token: raced.token, subscription: subscription(id) })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await query("SELECT * FROM professional_push_subscriptions WHERE endpoint LIKE '%race-%'")).rowCount, 1);
    const conflict = await newLink(anotherUser.id);
    assert.equal((await request(api + '/subscribe', { token: conflict.token, subscription: subscription('first') })).status, 409);
    assert.equal((await query('SELECT used_at FROM professional_push_activation_links WHERE id=$1', [conflict.id])).rows[0].used_at, null);
    assert.equal((await request(api + '/subscribe', { token: conflict.token, subscription: { ...subscription('invalid'), keys: {} } })).status, 422);
    assert.equal((await request(api + '/subscribe', { token: conflict.token, subscription: subscription('other') })).status, 200);
  });
  await t.test('reusing a completed link never reactivates a device explicitly disabled later', async () => {
    const single = await newLink();
    assert.equal((await request(api + '/subscribe', { token: single.token, subscription: subscription('disabled') })).status, 200);
    await query("UPDATE professional_push_subscriptions SET active=FALSE WHERE endpoint=$1", [subscription('disabled').endpoint]);
    assert.equal((await request(api + '/subscribe', { token: single.token, subscription: subscription('disabled') })).status, 409);
    assert.equal((await request(api, { token: single.token, subscription: subscription('disabled') })).json.active, false);
    const audits = (await query("SELECT detail FROM audit_events WHERE event_type LIKE 'professional.push.%'")).rows;
    assert.doesNotMatch(JSON.stringify(audits), /endpoint|p256dh|token_hash|https:\/\/push/);
    assert.ok(audits.length > 0);
  });
  await t.test('activation from the authenticated portal still requires CSRF and returns device status', async () => {
    const session = createSessionToken(anotherUser);
    const path = '/api/professional/notifications/push/subscriptions';
    const body = { subscription: subscription('regular-portal'), device_kind: 'mobile' };
    const headers = { Cookie: `reku_admin_session=${session.token}` };
    assert.equal((await request(path, body, headers)).status, 403);
    const saved = await request(path, body, { ...headers, 'X-CSRF-Token': session.csrf });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.push.configured, true);
    assert.equal(saved.json.push.active_mobile_devices, 1);
    assert.doesNotMatch(JSON.stringify(saved.json), /endpoint|p256dh/);
  });
});
