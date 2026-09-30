import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('admin saves and reloads professionals with no agreements or working days', { skip: !databaseUrl }, async (t) => {
  assert.match(new URL(databaseUrl).pathname, /test/i);
  const schema = `admin_professional_edit_${randomBytes(8).toString('hex')}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(databaseUrl);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = isolated.href;
  process.env.EMAIL_DRY_RUN = 'true';
  process.env.BOOTSTRAP_ADMIN_EMAIL = '';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = '';
  let handler;
  const server = createServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_PUBLIC_URL = base;
  const { initDb, query, pool } = await import('../src/db.mjs');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  });
  await initDb();
  const { handleAdminApi } = await import('../src/admin-api.mjs');
  const { sendJson } = await import('../src/http.mjs');
  const { createSessionToken } = await import('../src/security.mjs');
  handler = async (request, response) => {
    if (!await handleAdminApi(request, response, new URL(request.url, base))) sendJson(response, 404, {});
  };
  const admin = (await query(`INSERT INTO users (name,email,role,password_hash)
    VALUES ('Admin test','admin-edit@example.test','admin','not-a-password') RETURNING *`)).rows[0];
  const session = createSessionToken(admin);
  const headers = { Cookie: `reku_admin_session=${session.token}`, Origin: base, 'X-CSRF-Token': session.csrf };
  const serviceId = Number((await query("INSERT INTO services (name,duration_minutes,cost_amount) VALUES ('Prueba',30,100) RETURNING id")).rows[0].id);
  const agreementId = Number((await query("INSERT INTO agreements (name,slug,type) VALUES ('Prueba','professional-edit-test','Pago') RETURNING id")).rows[0].id);
  const availability = [{ day_of_week: 1, start_time: '09:00', end_time: '18:00' }];
  const fields = {
    name: 'Profesional de prueba', email: 'edit-fisio@example.test', active: 'true',
    service_ids: JSON.stringify([serviceId]), agreement_ids: JSON.stringify([agreementId]),
    availability: JSON.stringify(availability), account_password: '',
  };
  const save = async (path, values, method = 'PUT') => {
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) form.set(key, value);
    const response = await fetch(base + path, { method, headers, body: form });
    return { status: response.status, body: await response.json() };
  };
  const created = await save('/api/admin/professionals', { ...fields, account_password: 'Synthetic-test-password-2026!' }, 'POST');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.professional.id;
  const path = `/api/admin/professionals/${id}`;
  const reload = async () => {
    const response = await fetch(base + '/api/admin/professionals', { headers });
    assert.equal(response.status, 200);
    return (await response.json()).professionals.find((professional) => professional.id === id);
  };

  await t.test('removing all agreements preserves working days and persists after reload', async () => {
    assert.equal((await save(path, { ...fields, agreement_ids: '[]' })).status, 200);
    const saved = await reload();
    assert.deepEqual(saved.agreements, []);
    assert.deepEqual(saved.availability, availability);
    assert.equal(saved.has_user, true);
    assert.equal(saved.active, true);
    assert.equal(saved.services[0].id, serviceId);
  });
  await t.test('removing all days preserves agreements and persists after reload', async () => {
    assert.equal((await save(path, { ...fields, availability: '[]' })).status, 200);
    const saved = await reload();
    assert.equal(saved.agreements[0].id, agreementId);
    assert.deepEqual(saved.availability, []);
  });
  await t.test('both selections can be cleared together and configured again later', async () => {
    assert.equal((await save(path, { ...fields, agreement_ids: '[]', availability: '[]' })).status, 200);
    const cleared = await reload();
    assert.deepEqual(cleared.agreements, []);
    assert.deepEqual(cleared.availability, []);
    assert.equal((await query('SELECT * FROM professional_agreements WHERE professional_id=$1', [id])).rowCount, 0);
    assert.equal((await query('SELECT * FROM professional_availability WHERE professional_id=$1', [id])).rowCount, 0);
    assert.equal((await save(path, fields)).status, 200);
    assert.deepEqual((await reload()).availability, availability);
  });
  await t.test('invalid supplied selections or times fail without clearing saved data', async () => {
    for (const invalid of [
      { agreement_ids: '{bad' }, { availability: 'null' }, { agreement_ids: '[-1]' },
      { availability: JSON.stringify([{ day_of_week: 1, start_time: '18:00', end_time: '09:00' }]) },
    ]) {
      assert.equal((await save(path, { ...fields, ...invalid })).status, 422);
      const saved = await reload();
      assert.equal(saved.agreements[0].id, agreementId);
      assert.deepEqual(saved.availability, availability);
    }
  });
  await t.test('a new professional can also start without agreements or working days', async () => {
    const result = await save('/api/admin/professionals', {
      ...fields, email: 'empty-fisio@example.test', agreement_ids: '[]', availability: '[]',
      account_password: 'Synthetic-test-password-2026!',
    }, 'POST');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(result.body.professional.agreements, []);
    assert.deepEqual(result.body.professional.availability, []);
  });
});
