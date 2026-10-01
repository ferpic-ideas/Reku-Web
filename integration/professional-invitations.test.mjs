import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('professional invitations distinguish used links without granting access twice', { skip: !databaseUrl }, async (t) => {
  assert.match(new URL(databaseUrl).pathname, /test/i);
  const schema = `invitations_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(databaseUrl);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.DATABASE_URL = isolated.href;
  process.env.APP_PUBLIC_URL = base;
  process.env.EMAIL_DRY_RUN = 'true';
  process.env.BOOTSTRAP_ADMIN_EMAIL = '';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = '';
  const { initDb, query, pool, tx } = await import('../src/db.mjs');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await initDb();
  const { handleProfessionalApi } = await import('../src/professional-api.mjs');
  const { createProfessionalInvitation } = await import('../src/professional-invitations.mjs');
  const { sendJson } = await import('../src/http.mjs');
  handler = async (req, res) => {
    if (!await handleProfessionalApi(req, res, new URL(req.url, base))) sendJson(res, 404, {});
  };
  const api = '/api/professional/invitations';
  const post = async (path, body) => {
    const response = await fetch(base + api + path, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie'), json: await response.json() };
  };
  let counter = 0;
  const invite = async () => {
    const email = `invitation-${++counter}@example.test`;
    const professional = (await query('INSERT INTO professionals (name,email) VALUES ($1,$2) RETURNING id', ['Fisio prueba', email])).rows[0];
    const user = (await query(`INSERT INTO users (name,email,role,professional_id,password_hash,is_active)
      VALUES ('Fisio prueba',$1,'professional',$2,'unactivated',FALSE) RETURNING id`, [email, professional.id])).rows[0];
    const link = await tx(client => createProfessionalInvitation(client, { professionalId: professional.id, userId: user.id, email }));
    return { ...link, userId: user.id, professionalId: professional.id, token: new URLSearchParams(new URL(link.url).hash.slice(1)).get('invite') };
  };
  const snapshot = async (link) => (await query('SELECT password_hash,is_active,session_version FROM users WHERE id=$1', [link.userId])).rows[0];
  let completed;
  await t.test('status lookup is anonymous, read-only and returns no account details', async () => {
    completed = await invite();
    const before = await snapshot(completed);
    const result = await post('/status', { token: completed.token });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { status: 'pending' });
    assert.equal(result.cookie, null);
    assert.deepEqual(await snapshot(completed), before);
    assert.equal((await query('SELECT accepted_at FROM professional_invitations WHERE id=$1', [completed.id])).rows[0].accepted_at, null);
    assert.equal((await fetch(base + api + '/status')).status, 405);
  });
  await t.test('used links remain identifiable after expiration and cannot reset credentials or sign in', async () => {
    const accepted = await post('/accept', { token: completed.token, password: 'Initial-test-pass-123' });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.cookie);
    const before = await snapshot(completed);
    await query("UPDATE professional_invitations SET expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1", [completed.id]);
    const status = await post('/status', { token: completed.token });
    assert.deepEqual(status.json, { status: 'used' });
    assert.equal(status.cookie, null);
    const duplicate = await post('/accept', { token: completed.token, password: 'Different-test-pass-456' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.code, 'PROFESSIONAL_INVITATION_USED');
    assert.equal(duplicate.cookie, null);
    assert.deepEqual(await snapshot(completed), before);
  });
  await t.test('expired, revoked, malformed and unknown links stay invalid', async () => {
    for (const token of ['', '<invalid>', 'x'.repeat(43)]) {
      const result = await post('/status', { token });
      assert.equal(result.status, 401);
      assert.equal(result.json.code, 'PROFESSIONAL_INVITATION_INVALID');
    }
    for (const alteration of ["expires_at=NOW()-INTERVAL '1 second'", 'revoked_at=NOW()']) {
      const link = await invite();
      await query(`UPDATE professional_invitations SET ${alteration} WHERE id=$1`, [link.id]);
      assert.equal((await post('/status', { token: link.token })).status, 401);
      assert.equal((await post('/accept', { token: link.token, password: 'Valid-test-pass-123' })).status, 401);
      assert.equal((await snapshot(link)).is_active, false);
    }
  });
  await t.test('disabled professionals and mismatched owners cannot be activated', async () => {
    const disabled = await invite();
    await query('UPDATE professionals SET active=FALSE WHERE id=$1', [disabled.professionalId]);
    assert.equal((await post('/status', { token: disabled.token })).status, 401);
    const mismatch = await invite();
    await query('UPDATE professional_invitations SET user_id=$1 WHERE id=$2', [completed.userId, mismatch.id]);
    assert.equal((await post('/status', { token: mismatch.token })).status, 401);
    assert.equal((await post('/accept', { token: mismatch.token, password: 'Valid-test-pass-123' })).status, 401);
  });
  await t.test('two simultaneous activations create only one session', async () => {
    const link = await invite();
    const results = await Promise.all([1, 2].map(i => post('/accept', { token: link.token, password: `Concurrent-test-pass-${i}` })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(results.filter(r => r.cookie).length, 1);
    assert.equal(results.find(r => r.status === 409).json.code, 'PROFESSIONAL_INVITATION_USED');
    assert.equal((await snapshot(link)).session_version, 2);
  });
});
