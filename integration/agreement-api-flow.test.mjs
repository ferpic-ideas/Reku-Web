import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import vm from 'node:vm';
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { request as httpRequest } from 'node:http';
import test from "node:test";
import pg from "pg";
import { encryptBotReport } from '../src/consultation-bot-report-storage.mjs';
import { config } from '../src/config.mjs';
import { hashPassword } from '../src/security.mjs';
import { patientCommunicationsSql } from '../src/agreement-policy.mjs';
import { consultationStatusSql } from '../src/consultation-status.mjs';
import { escapeHtml } from '../src/http.mjs';
import { googleCalendarTemplateUrl } from '../src/appointment-calendar.mjs';
import { testArtroDemo } from './artro-demo-flow.mjs';

const { Pool } = pg;
const root = fileURLToPath(new URL("../", import.meta.url));
const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha256 = async (value) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(String(value)).digest("hex");
};

const makeToken = () => `rku_ag_${randomBytes(32).toString("base64url")}`;

const futureDate = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertTestDatabase = (databaseUrl) => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for API integration tests");
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  assert.match(
    databaseName,
    /test/i,
    `Refusing to reset database without "test" in its name: ${databaseName}`,
  );
  assert.notEqual(databaseName, "reku_web");
};

const reservePort = async () => {
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
};

const waitForServer = async (baseUrl, serverProcess, output) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Test server exited early (${serverProcess.exitCode})\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child is still starting or applying migrations.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for test server\n${output()}`);
};

const stopServer = async (serverProcess) => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    delay(3_000).then(() => {
      if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
    }),
  ]);
};

const apiRequest = async (
  baseUrl,
  path,
  { token, method = "GET", body, headers = {}, rawBody } = {},
) => {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}/api/partners/v1${path}`, {
    method,
    headers: requestHeaders,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: response.status, headers: response.headers, json };
};

const assertApiHeaders = (result) => {
  assert.equal(result.headers.get("x-api-version"), "2026-08-01");
  assert.match(result.headers.get("x-request-id") || "", requestIdPattern);
  assert.equal(result.headers.get("cache-control"), "no-store");
};

const assertApiError = (result, status, code) => {
  assert.equal(result.status, status);
  assert.equal(result.json.error?.code, code);
  assert.match(result.json.error?.request_id || "", requestIdPattern);
  assertApiHeaders(result);
};

const seedFixture = async (pool) => {
  const agreements = await pool.query(`
    INSERT INTO agreements (name, slug, subdomain_prefix, cobranded, type)
    VALUES
      ('API Test Principal', 'api-test-principal', 'api-test-principal', FALSE, 'Pago'),
      ('API Test Aislado', 'api-test-aislado', 'api-test-aislado', FALSE, 'Pago')
    RETURNING id, slug
  `);
  const primaryAgreementId = Number(agreements.rows[0].id);
  const isolatedAgreementId = Number(agreements.rows[1].id);
  const service = await pool.query(`
    INSERT INTO services (name, duration_minutes, cost_amount, active)
    VALUES ('Evaluación API', 60, 25000, TRUE)
    RETURNING id
  `);
  const serviceId = Number(service.rows[0].id);
  const professionals = await pool.query(`
    INSERT INTO professionals (name, email, specialty, active)
    VALUES
      ('Profesional API Uno', 'api-fisio-uno@example.test', 'Test', TRUE),
      ('Profesional API Dos', 'api-fisio-dos@example.test', 'Test', TRUE)
    RETURNING id
  `);
  const professionalIds = professionals.rows.map((row) => Number(row.id));
  for (const professionalId of professionalIds) {
    await pool.query(
      `INSERT INTO professional_services (professional_id, service_id) VALUES ($1, $2)`,
      [professionalId, serviceId],
    );
    await pool.query(
      `
        INSERT INTO professional_agreements (professional_id, agreement_id)
        VALUES ($1, $2), ($1, $3)
      `,
      [professionalId, primaryAgreementId, isolatedAgreementId],
    );
    await pool.query(
      `
        INSERT INTO professional_availability
          (professional_id, day_of_week, start_time, end_time)
        SELECT $1, day, '09:00'::time, '18:00'::time
        FROM generate_series(1, 7) AS day
      `,
      [professionalId],
    );
  }

  const primaryToken = makeToken();
  const isolatedToken = makeToken();
  const rateLimitToken = makeToken();
  const credentials = [
    [primaryAgreementId, "Principal", primaryToken],
    [isolatedAgreementId, "Aislado", isolatedToken],
    [primaryAgreementId, "Rate limit", rateLimitToken],
  ];
  const credentialIds = [];
  for (const [agreementId, name, token] of credentials) {
    const inserted = await pool.query(
      `
        INSERT INTO agreement_api_credentials
          (agreement_id, name, token_hash, token_prefix)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [agreementId, name, await sha256(token), token.slice(0, 18)],
    );
    credentialIds.push(Number(inserted.rows[0].id));
  }

  return {
    primaryAgreementId,
    isolatedAgreementId,
    serviceId,
    professionalIds,
    primaryToken,
    isolatedToken,
    rateLimitToken,
    credentialIds,
  };
};

test("agreement API completes its full HTTP lifecycle against PostgreSQL", async (t) => {
  assertTestDatabase(testDatabaseUrl);
  const pool = new Pool({ connectionString: testDatabaseUrl, ssl: false, max: 8 });
  const runtimeRoot = await mkdtemp(join(tmpdir(), "reku-api-test-"));
  let serverProcess;
  let childOutput = "";

  t.after(async () => {
    await stopServer(serverProcess);
    await pool.end();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const port = await reservePort();
  // A hostname (rather than an IP literal) also permits testing agreement subdomains.
  const baseUrl = `http://localhost:${port}`;
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      APP_ENV: "test",
      APP_PUBLIC_URL: baseUrl,
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl,
      DATABASE_SSL_MODE: "disable",
      SESSION_SECRET: "api-test-session-secret-with-at-least-32-characters",
      SESSION_SECURE: "false",
      SETTINGS_ENCRYPTION_KEY: "api-test-settings-key-with-at-least-32-characters",
      CONSULTATION_BOT_MODE: 'test',
      CONSULTATION_BOT_REPORT_KEY: 'synthetic-report-key-for-integration-only-2026',
      EMAIL_DRY_RUN: "true",
      BOOKING_EMAIL_VERIFICATION_ENABLED: "true",
      PUBLIC_UPLOAD_ROOT: join(runtimeRoot, "public"),
      PRIVATE_UPLOAD_ROOT: join(runtimeRoot, "private"),
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
      GOOGLE_INTEGRATION_ENCRYPTION_KEY: "",
      REHUB_CLIENT_ID: "",
      REHUB_PUBLIC_KEY_BASE64: "",
      REHUB_PUBLIC_KEY_PATH: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
      RESEND_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-20_000);
  };
  serverProcess.stdout.on("data", capture);
  serverProcess.stderr.on("data", capture);
  await waitForServer(baseUrl, serverProcess, () => childOutput);

  const fixture = await seedFixture(pool);
  const dateOne = futureDate(14);
  const dateTwo = futureDate(15);

  await t.test("rejects missing credentials with the documented envelope", async () => {
    const result = await apiRequest(baseUrl, "/agreement");
    assertApiError(result, 401, "unauthorized");
  });

  await t.test("discovers agreement, services, professionals and availability", async () => {
    const agreement = await apiRequest(baseUrl, "/agreement", {
      token: fixture.primaryToken,
    });
    assert.equal(agreement.status, 200);
    assert.equal(agreement.json.data.id, fixture.primaryAgreementId);
    assert.equal(agreement.json.data.email_verification_required, false);
    assert.equal(agreement.json.data.email_verification_responsibility, 'integrator');
    assert.deepEqual(agreement.json.data.capabilities, [
      "availability",
      "hold",
      "create",
      "list",
      "reschedule",
      "cancel",
    ]);
    assertApiHeaders(agreement);

    const services = await apiRequest(baseUrl, "/services", {
      token: fixture.primaryToken,
    });
    assert.equal(services.status, 200);
    assert.deepEqual(services.json.data.map((item) => item.id), [fixture.serviceId]);
    assert.equal(services.json.data[0].settlement_amount, 25000);

    const professionals = await apiRequest(
      baseUrl,
      `/professionals?service_id=${fixture.serviceId}`,
      { token: fixture.primaryToken },
    );
    assert.equal(professionals.status, 200);
    assert.deepEqual(
      professionals.json.data.map((item) => item.id).sort((a, b) => a - b),
      [...fixture.professionalIds].sort((a, b) => a - b),
    );

    const availability = await apiRequest(
      baseUrl,
      `/availability?service_id=${fixture.serviceId}&date=${dateOne}`,
      { token: fixture.primaryToken },
    );
    assert.equal(availability.status, 200);
    assert.equal(availability.json.data.days[0].date, dateOne);
    assert.ok(availability.json.data.days[0].slots.length >= 4);
    assertApiHeaders(availability);
  });

  const availabilityOne = await apiRequest(
    baseUrl,
    `/availability?service_id=${fixture.serviceId}&date=${dateOne}`,
    { token: fixture.primaryToken },
  );
  const primarySlot = availabilityOne.json.data.days[0].slots[0];
  const concurrentSlot = availabilityOne.json.data.days[0].slots.find(
    (slot) =>
      slot.start_time !== primarySlot.start_time &&
      slot.professional.id === primarySlot.professional.id,
  );
  assert.ok(primarySlot && concurrentSlot);

  let primaryHoldId = "";
  await t.test("holds a slot for ten minutes and removes it from availability", async () => {
    const holdPayload = {
      service_id: fixture.serviceId,
      professional_id: primarySlot.professional.id,
      date: dateOne,
      start_time: primarySlot.start_time,
    };
    const held = await apiRequest(baseUrl, "/holds", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-main-001" },
      body: holdPayload,
    });
    assert.equal(held.status, 201);
    assert.match(held.json.data.id, /^hold_[a-f0-9]{32}$/);
    assert.equal(held.json.data.status, "active");
    assert.equal(held.json.data.schedule.date, dateOne);
    assert.equal(held.json.data.schedule.start_time, primarySlot.start_time);
    assert.equal(held.json.data.professional.id, primarySlot.professional.id);
    const ttlMilliseconds = new Date(held.json.data.expires_at).getTime() - Date.now();
    assert.ok(ttlMilliseconds > 9 * 60_000 && ttlMilliseconds <= 10 * 60_000);
    primaryHoldId = held.json.data.id;

    const replay = await apiRequest(baseUrl, "/holds", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-main-001" },
      body: holdPayload,
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(replay.json.data.id, primaryHoldId);

    const availability = await apiRequest(
      baseUrl,
      `/availability?service_id=${fixture.serviceId}&date=${dateOne}&professional_id=${primarySlot.professional.id}`,
      { token: fixture.primaryToken },
    );
    assert.equal(availability.status, 200);
    assert.ok(
      !availability.json.data.days[0].slots.some(
        (slot) => slot.start_time === primarySlot.start_time,
      ),
    );

    const competing = await apiRequest(baseUrl, "/holds", {
      token: fixture.isolatedToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-competing-001" },
      body: holdPayload,
    });
    assertApiError(competing, 409, "slot_unavailable");
  });

  const createPayload = {
    external_id: "external-main-001",
    hold_id: primaryHoldId,
    payment_reference: "partner-payment-001",
    patient: {
      first_name: "Paciente",
      last_name: "Integración",
      email: "patient-api-main@example.test",
      phone: "+54 11 5555 0001",
    },
  };
  let publicAppointmentId = "";

  await t.test("creates one paid appointment and replays the same idempotent request", async () => {
    const created = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "create-main-001" },
      body: createPayload,
    });
    assert.equal(created.status, 201);
    assert.match(created.json.data.id, /^apt_[a-f0-9]{32}$/);
    assert.equal(created.json.data.external_id, createPayload.external_id);
    assert.equal(created.json.data.status, "confirmed");
    assert.equal(created.json.data.consultation_required, false);
    assert.equal(created.json.data.consultation_status, 'not_applicable');
    assert.match(created.json.data.links.manage_url, /\/turnos\/#manage=[A-Za-z0-9_-]{43}$/);
    assert.match(created.json.data.links.waiting_room_url, /view=videollamada#manage=/);
    assert.ok(Date.parse(created.json.data.links.expires_at) > Date.now());
    assert.equal(created.json.data.links.questionnaire_url, undefined);
    assert.equal(created.json.data.payment.status, "paid");
    assert.equal(created.json.data.payment.reference, createPayload.payment_reference);
    assert.equal(created.json.data.settlement.amount, 25000);
    assert.equal(created.json.data.settlement.billable, true);
    assert.equal(created.headers.get("idempotent-replayed"), null);
    assertApiHeaders(created);
    publicAppointmentId = created.json.data.id;

    const replay = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "create-main-001" },
      body: createPayload,
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(replay.json.data.id, publicAppointmentId);
    assert.deepEqual(replay.json, created.json);
    const stored = (await pool.query("SELECT response_body FROM agreement_api_idempotency WHERE idempotency_key='create-main-001'")).rows[0].response_body;
    assert.equal(stored.data.links, undefined);
    assert.match(stored.data.links_encrypted, /^v1\./);
    assert.ok(!JSON.stringify(stored).includes(created.json.data.links.manage_url));

    const rawToken = new URL(created.json.data.links.manage_url).hash.slice('#manage='.length);
    const appointment = (await pool.query('SELECT id FROM appointments WHERE agreement_api_public_id=$1', [publicAppointmentId])).rows[0];
    const access = (await pool.query('SELECT id FROM patient_appointment_access_links WHERE token_hash=$1', [await sha256(rawToken)])).rows[0];
    assert.ok(access, 'Returned token really grants this appointment access');
    const session = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO patient_appointment_sessions (token_hash,access_link_id,appointment_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(session), access.id, appointment.id]);
    const headers = { Cookie: `${config.patientAppointmentSessionCookieName}=${session}` };
    const managed = await (await fetch(`${baseUrl}/api/booking/manage/appointment`, { headers })).json();
    assert.equal(managed.appointment.consultation_status, 'not_applicable');
    assert.equal(managed.appointment.triage_url, '');
    assert.equal((await fetch(`${baseUrl}/api/booking/manage/consultation`, { headers, redirect: 'manual' })).status, 409);

    const count = await pool.query(
      `SELECT COUNT(*)::int AS count FROM appointments WHERE agreement_api_external_id = $1`,
      [createPayload.external_id],
    );
    assert.equal(count.rows[0].count, 1);
  });

  await t.test("rejects changed idempotent payloads and duplicate external ids", async () => {
    const changed = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "create-main-001" },
      body: { ...createPayload, external_id: "external-changed-001" },
    });
    assertApiError(changed, 409, "idempotency_conflict");

    const freeSlot = availabilityOne.json.data.days[0].slots.find(
      (slot) =>
        slot.professional.id === primarySlot.professional.id &&
        ![primarySlot.start_time, concurrentSlot.start_time].includes(slot.start_time),
    );
    assert.ok(freeSlot);
    const held = await apiRequest(baseUrl, "/holds", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-duplicate-external-001" },
      body: {
        service_id: fixture.serviceId,
        professional_id: freeSlot.professional.id,
        date: dateOne,
        start_time: freeSlot.start_time,
      },
    });
    assert.equal(held.status, 201);
    const duplicate = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "create-duplicate-external-001" },
      body: { ...createPayload, hold_id: held.json.data.id },
    });
    assertApiError(duplicate, 409, "external_id_conflict");
  });

  await t.test("serializes concurrent holds so only one can protect the slot", async () => {
    const holdPayload = {
      service_id: fixture.serviceId,
      professional_id: concurrentSlot.professional.id,
      date: dateOne,
      start_time: concurrentSlot.start_time,
    };
    const results = await Promise.all([
      apiRequest(baseUrl, "/holds", {
        token: fixture.primaryToken,
        method: "POST",
        headers: { "Idempotency-Key": "concurrent-hold-001" },
        body: holdPayload,
      }),
      apiRequest(baseUrl, "/holds", {
        token: fixture.primaryToken,
        method: "POST",
        headers: { "Idempotency-Key": "concurrent-hold-002" },
        body: holdPayload,
      }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(results.find((result) => result.status === 409).json.error.code, "slot_unavailable");
    const winningHold = results.find((result) => result.status === 201).json.data.id;
    const confirmed = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "concurrent-confirm-001" },
      body: {
        ...createPayload,
        hold_id: winningHold,
        external_id: "external-concurrent-winner",
        patient: {
          ...createPayload.patient,
          email: "patient-api-concurrent@example.test",
        },
      },
    });
    assert.equal(confirmed.status, 201);
    const count = await pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM appointments
        WHERE professional_id = $1 AND appointment_date = $2::date AND start_time = $3::time
      `,
      [concurrentSlot.professional.id, dateOne, concurrentSlot.start_time],
    );
    assert.equal(count.rows[0].count, 1);
  });

  await t.test("automatically releases an expired hold and only returns 409 if another client took it", async () => {
    const availability = await apiRequest(
      baseUrl,
      `/availability?service_id=${fixture.serviceId}&date=${dateOne}&professional_id=${primarySlot.professional.id}`,
      { token: fixture.primaryToken },
    );
    assert.equal(availability.status, 200);
    const [freeAfterExpiry, takenAfterExpiry] = availability.json.data.days[0].slots;
    assert.ok(freeAfterExpiry && takenAfterExpiry);

    const expiring = await apiRequest(baseUrl, "/holds", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-expire-free-001" },
      body: {
        service_id: fixture.serviceId,
        professional_id: freeAfterExpiry.professional.id,
        date: dateOne,
        start_time: freeAfterExpiry.start_time,
      },
    });
    assert.equal(expiring.status, 201);
    await pool.query(
      `UPDATE agreement_api_holds SET expires_at = NOW() - INTERVAL '1 second' WHERE public_id = $1`,
      [expiring.json.data.id],
    );

    const releasedAvailability = await apiRequest(
      baseUrl,
      `/availability?service_id=${fixture.serviceId}&date=${dateOne}&professional_id=${freeAfterExpiry.professional.id}`,
      { token: fixture.primaryToken },
    );
    assert.ok(
      releasedAvailability.json.data.days[0].slots.some(
        (slot) => slot.start_time === freeAfterExpiry.start_time,
      ),
    );

    const confirmedAfterExpiry = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "confirm-expired-free-001" },
      body: {
        ...createPayload,
        hold_id: expiring.json.data.id,
        external_id: "external-expired-free",
        patient: {
          ...createPayload.patient,
          email: "patient-api-expired-free@example.test",
        },
      },
    });
    assert.equal(confirmedAfterExpiry.status, 201);

    const oldHold = await apiRequest(baseUrl, "/holds", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-expire-taken-001" },
      body: {
        service_id: fixture.serviceId,
        professional_id: takenAfterExpiry.professional.id,
        date: dateOne,
        start_time: takenAfterExpiry.start_time,
      },
    });
    assert.equal(oldHold.status, 201);
    await pool.query(
      `UPDATE agreement_api_holds SET expires_at = NOW() - INTERVAL '1 second' WHERE public_id = $1`,
      [oldHold.json.data.id],
    );

    const replacement = await apiRequest(baseUrl, "/holds", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "hold-replacement-001" },
      body: {
        service_id: fixture.serviceId,
        professional_id: takenAfterExpiry.professional.id,
        date: dateOne,
        start_time: takenAfterExpiry.start_time,
      },
    });
    assert.equal(replacement.status, 201);

    const tooLate = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "confirm-expired-taken-001" },
      body: {
        ...createPayload,
        hold_id: oldHold.json.data.id,
        external_id: "external-expired-taken",
        patient: {
          ...createPayload.patient,
          email: "patient-api-expired-taken@example.test",
        },
      },
    });
    assertApiError(tooLate, 409, "slot_unavailable");
    assert.equal(tooLate.json.error.detail.hold_expired, true);
  });

  await t.test("gets and lists only appointments owned by the authenticated agreement", async () => {
    const detail = await apiRequest(baseUrl, `/appointments/${publicAppointmentId}`, {
      token: fixture.primaryToken,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.id, publicAppointmentId);
    assert.equal(detail.json.data.patient.email, createPayload.patient.email);

    const list = await apiRequest(
      baseUrl,
      `/appointments?external_id=${encodeURIComponent(createPayload.external_id)}&page=1&limit=1`,
      { token: fixture.primaryToken },
    );
    assert.equal(list.status, 200);
    assert.equal(list.json.data.length, 1);
    assert.equal(list.json.data[0].id, publicAppointmentId);
    assert.equal(list.json.pagination.total, 1);

    const isolated = await apiRequest(baseUrl, `/appointments/${publicAppointmentId}`, {
      token: fixture.isolatedToken,
    });
    assertApiError(isolated, 404, "appointment_not_found");
  });

  await t.test('patient buttons and professional reports reflect durable questionnaire completion', async () => {
    const row = (await pool.query('SELECT * FROM appointments WHERE agreement_api_external_id = $1', [createPayload.external_id])).rows[0];
    // Emulate a historical Web booking; new API bookings have no questionnaire.
    await pool.query('UPDATE appointments SET consultation_required = TRUE WHERE id = $1', [row.id]);
    const token = randomBytes(32).toString('base64url');
    const link = (await pool.query("INSERT INTO patient_appointment_access_links (token_hash, appointment_id, expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day') RETURNING id", [await sha256(token), row.id])).rows[0];
    const sessionToken = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO patient_appointment_sessions (token_hash, access_link_id, appointment_id, expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(sessionToken), link.id, row.id]);
    const headers = { Cookie: `${config.patientAppointmentSessionCookieName}=${sessionToken}` };
    const getManaged = async () => (await fetch(`${baseUrl}/api/booking/manage/appointment`, { headers })).json();
    // Patient-owned studies are listed and can be opened/removed only with this
    // appointment's private session. Use synthetic files, never real records.
    const upload = new FormData();
    upload.append('documents', new Blob(['%PDF-1.4 synthetic study'], { type: 'application/pdf' }), 'Estudio de prueba.pdf');
    upload.set('links_json', JSON.stringify(['https://example.test/estudio/uno']));
    const uploaded = await fetch(`${baseUrl}/api/booking/manage/documents`, { method: 'POST', headers: { ...headers, Origin: baseUrl }, body: upload });
    assert.equal(uploaded.status, 201);
    const sent = (await uploaded.json()).documents;
    assert.equal(sent.length, 2);
    const file = sent.find(item => item.kind === 'file');
    const externalLink = sent.find(item => item.kind === 'link');
    assert.equal(file.url, `/api/booking/manage/documents/${file.id}`);
    assert.equal(externalLink.url, 'https://example.test/estudio/uno');
    assert.ok(!JSON.stringify(sent).includes('storage_path'));
    assert.equal((await getManaged()).appointment.documents.length, 2);
    const documentUrl = `${baseUrl}${file.url}`;
    const opened = await fetch(documentUrl, { headers });
    assert.equal(opened.status, 200);
    assert.match(opened.headers.get('content-disposition'), /^inline;/);
    assert.match(opened.headers.get('cache-control'), /private, no-store/);
    assert.equal(await opened.text(), '%PDF-1.4 synthetic study');
    assert.equal((await fetch(documentUrl, { method: 'HEAD', headers })).status, 200);
    assert.equal((await fetch(documentUrl)).status, 401);
    assert.equal((await fetch(documentUrl, { method: 'DELETE', headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(documentUrl, { method: 'DELETE', headers })).status, 403);
    const otherAppointment = (await pool.query('SELECT id FROM appointments WHERE id <> $1 LIMIT 1', [row.id])).rows[0];
    const foreignToken = randomBytes(32).toString('base64url');
    const foreignLink = (await pool.query("INSERT INTO patient_appointment_access_links (token_hash, appointment_id, expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day') RETURNING id", [await sha256(foreignToken), otherAppointment.id])).rows[0];
    await pool.query("INSERT INTO patient_appointment_sessions (token_hash,access_link_id,appointment_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(foreignToken), foreignLink.id, otherAppointment.id]);
    const foreignHeaders = { Cookie: `${config.patientAppointmentSessionCookieName}=${foreignToken}`, Origin: baseUrl };
    assert.equal((await fetch(documentUrl, { headers: foreignHeaders })).status, 404);
    assert.equal((await fetch(documentUrl, { method: 'DELETE', headers: foreignHeaders })).status, 404);
    const staffDocument = (await pool.query("INSERT INTO appointment_documents (appointment_id, kind, external_url, uploaded_by) VALUES ($1,'link','https://example.test/professional','professional') RETURNING id", [row.id])).rows[0];
    assert.equal((await getManaged()).appointment.documents.length, 2);
    assert.equal((await fetch(`${baseUrl}/api/booking/manage/documents/${staffDocument.id}`, { method: 'DELETE', headers: { ...headers, Origin: baseUrl } })).status, 404);
    const storedFile = (await pool.query('SELECT storage_path FROM appointment_documents WHERE id=$1', [file.id])).rows[0];
    assert.equal((await fetch(documentUrl, { method: 'DELETE', headers: { ...headers, Origin: baseUrl } })).status, 200);
    assert.equal((await fetch(documentUrl, { headers })).status, 404);
    await assert.rejects(access(join(runtimeRoot, 'private', storedFile.storage_path)), { code: 'ENOENT' });
    assert.equal((await fetch(`${baseUrl}/api/booking/manage/documents/${externalLink.id}`, { method: 'DELETE', headers: { ...headers, Origin: baseUrl } })).status, 200);
    assert.equal((await getManaged()).appointment.documents.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='patient.appointment.document.deleted' AND detail->>'appointment_id'=$1", [String(row.id)])).rows[0].n, 2);
    const pending = await getManaged();
    assert.equal(pending.appointment.consultation_status, 'pending');
    assert.equal(pending.appointment.triage_url, '/api/booking/manage/consultation');
    const redirected = await fetch(`${baseUrl}${pending.appointment.triage_url}`, { headers, redirect: 'manual' });
    assert.equal(redirected.status, 303);
    assert.match(redirected.headers.get('location'), /\/bot#appointment=[A-Za-z0-9_-]{43}$/);
    const previousKey = process.env.CONSULTATION_BOT_REPORT_KEY;
    let encrypted;
    try {
      process.env.CONSULTATION_BOT_REPORT_KEY = 'synthetic-report-key-for-integration-only-2026';
      encrypted = encryptBotReport(Buffer.from('%PDF-1.4 synthetic appointment report'), row.id);
    } finally {
      if (previousKey === undefined) delete process.env.CONSULTATION_BOT_REPORT_KEY;
      else process.env.CONSULTATION_BOT_REPORT_KEY = previousKey;
    }
    await pool.query("INSERT INTO consultation_bot_usage (appointment_id, completed_at, report_encrypted) VALUES ($1,NOW(),$2)", [row.id, encrypted]);
    const internalReHubUrl = 'https://patient.rehub.cloud/opentriage/internal-synthetic';
    await pool.query('UPDATE appointments SET triage_url=$2 WHERE id=$1', [row.id, internalReHubUrl]);
    const completed = await getManaged();
    assert.equal(completed.appointment.consultation_status, 'completed');
    assert.equal(completed.appointment.triage_url, '');
    const partnerCompleted = await apiRequest(baseUrl, '/appointments/' + publicAppointmentId, { token: fixture.primaryToken });
    assert.equal(partnerCompleted.json.data.consultation_status, 'completed');
    assert.doesNotMatch(JSON.stringify(partnerCompleted.json), /internal-synthetic|report_encrypted|consultation_report_url/);
    const stale = await fetch(`${baseUrl}/api/booking/manage/consultation`, { headers, redirect: 'manual' });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('location'), null);
    for (const professionalId of fixture.professionalIds) {
      const profToken = randomBytes(32).toString('base64url');
      const profLink = (await pool.query("INSERT INTO professional_access_links (token_hash, professional_id, expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day') RETURNING id", [await sha256(profToken), professionalId])).rows[0];
      await pool.query("INSERT INTO professional_sessions (token_hash, professional_id, access_link_id, expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(profToken), professionalId, profLink.id]);
      const profHeaders = { Cookie: `${config.professionalSessionCookieName}=${profToken}` };
      const reportUrl = `${baseUrl}/api/professional/appointments/${row.id}/consultation-report`;
      const report = await fetch(reportUrl, { headers: profHeaders });
      if (professionalId === Number(row.professional_id)) {
        assert.equal(report.status, 200);
        assert.equal(await report.text(), '%PDF-1.4 synthetic appointment report');
        assert.equal((await fetch(reportUrl, { method: 'HEAD', headers: profHeaders })).status, 200);
        const listing = await (await fetch(`${baseUrl}/api/professional/appointments`, { headers: profHeaders })).json();
        const appointment = listing.appointments.find(item => item.id === Number(row.id));
        assert.equal(appointment.consultation_status, 'completed');
        assert.match(appointment.triage_url, /\/consultation-report$/);
        assert.equal(appointment.consultation_report_url, appointment.triage_url);
        assert.ok(!JSON.stringify(listing).includes(internalReHubUrl));
        const accountEmail = 'report-professional@example.test';
        const password = 'Local-report-test-password-2026!';
        await pool.query("INSERT INTO users (email,name,password_hash,role,professional_id) VALUES ($1,'Profesional de prueba',$2,'professional',$3)", [accountEmail, await hashPassword(password), professionalId]);
        const login = await fetch(`${baseUrl}/api/professional/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email: accountEmail, password }) });
        assert.equal(login.status, 200);
        const loginData = await login.json();
        const accountHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: baseUrl, 'X-CSRF-Token': loginData.csrf_token };
        assert.equal((await fetch(reportUrl, { headers: accountHeaders })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/admin/appointments/${row.id}/consultation-report`, { headers: accountHeaders })).status, 403);
        const patientsResponse = await fetch(`${baseUrl}/api/professional/patients`, { headers: accountHeaders });
        assert.equal(patientsResponse.status, 200);
        const patients = await patientsResponse.json();
        const patient = patients.patients.find(item => item.id === Number(row.patient_id));
        assert.equal(patient.consultation_status, 'completed');
        assert.ok(patient.consultation_reports.some(item => Number(item.appointment_id) === Number(row.id)));
        const reminder = await fetch(`${baseUrl}/api/professional/appointments/${row.id}/triage-reminder`, { method: 'POST', headers: accountHeaders });
        assert.equal(reminder.status, 409);
        assert.equal((await pool.query('SELECT triage_reminder_count FROM appointments WHERE id=$1', [row.id])).rows[0].triage_reminder_count, 0);
      } else assert.equal(report.status, 404);
    }
    assert.equal((await fetch(`${baseUrl}/api/professional/appointments/${row.id}/consultation-report`)).status, 401);
    const adminPdfUrl = `${baseUrl}/api/admin/appointments/${row.id}/consultation-report`;
    assert.equal((await fetch(adminPdfUrl)).status, 401);
    const adminEmail = 'report-admin@example.test';
    const adminPassword = 'Local-admin-report-test-2026!';
    await pool.query("INSERT INTO users (email,name,password_hash,role) VALUES ($1,'Admin de prueba',$2,'admin')", [adminEmail, await hashPassword(adminPassword)]);
    const adminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email: adminEmail, password: adminPassword }) });
    assert.equal(adminLogin.status, 200);
    const adminHeaders = { Cookie: adminLogin.headers.get('set-cookie').split(';')[0] };
    const adminReport = await fetch(adminPdfUrl, { headers: adminHeaders });
    assert.equal(adminReport.status, 200);
    assert.equal(adminReport.headers.get('content-type'), 'application/pdf');
    assert.match(adminReport.headers.get('cache-control'), /no-store/);
    assert.equal(await adminReport.text(), '%PDF-1.4 synthetic appointment report');
    assert.equal((await fetch(adminPdfUrl, { method: 'HEAD', headers: adminHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/appointments/99999999/consultation-report`, { headers: adminHeaders })).status, 404);
    const adminListing = await (await fetch(`${baseUrl}/api/admin/appointments`, { headers: adminHeaders })).json();
    const adminAppointment = adminListing.appointments.find(item => item.id === Number(row.id));
    assert.equal(adminAppointment.rehub_triage_url, internalReHubUrl);
    assert.equal(adminAppointment.consultation_report_url, new URL(adminPdfUrl).pathname);
  });

  await t.test("updates and replays a future appointment", async () => {
    const availability = await apiRequest(
      baseUrl,
      `/availability?service_id=${fixture.serviceId}&date=${dateTwo}&professional_id=${primarySlot.professional.id}`,
      { token: fixture.primaryToken },
    );
    assert.equal(availability.status, 200);
    const nextSlot = availability.json.data.days[0].slots[0];
    assert.ok(nextSlot);
    const updatePayload = {
      date: dateTwo,
      start_time: nextSlot.start_time,
      patient: {
        ...createPayload.patient,
        phone: "+54 11 5555 0099",
      },
    };
    const updated = await apiRequest(baseUrl, `/appointments/${publicAppointmentId}`, {
      token: fixture.primaryToken,
      method: "PATCH",
      headers: { "Idempotency-Key": "update-main-001" },
      body: updatePayload,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.schedule.date, dateTwo);
    assert.equal(updated.json.data.patient.phone, updatePayload.patient.phone);
    assert.equal(updated.json.data.settlement.amount, 25000);

    const replay = await apiRequest(baseUrl, `/appointments/${publicAppointmentId}`, {
      token: fixture.primaryToken,
      method: "PATCH",
      headers: { "Idempotency-Key": "update-main-001" },
      body: updatePayload,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(replay.json, updated.json);
  });

  await t.test("validates malformed writes and unknown routes", async () => {
    const missingKey = await apiRequest(baseUrl, "/appointments", {
      token: fixture.isolatedToken,
      method: "POST",
      body: createPayload,
    });
    assertApiError(missingKey, 400, "idempotency_key_required");

    const wrongType = await apiRequest(baseUrl, "/appointments", {
      token: fixture.isolatedToken,
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": "wrong-type-001" },
      rawBody: "not-json",
    });
    assertApiError(wrongType, 415, "unsupported_media_type");

    const malformed = await apiRequest(baseUrl, "/appointments", {
      token: fixture.isolatedToken,
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "bad-json-001" },
      rawBody: "{not-json",
    });
    assertApiError(malformed, 400, "invalid_json");

    const invalid = await apiRequest(baseUrl, "/appointments", {
      token: fixture.isolatedToken,
      method: "POST",
      headers: { "Idempotency-Key": "validation-001" },
      body: { ...createPayload, external_id: "bad space", date: "2026-99-99" },
    });
    assertApiError(invalid, 422, "validation_error");

    const missingHold = await apiRequest(baseUrl, "/appointments", {
      token: fixture.isolatedToken,
      method: "POST",
      headers: { "Idempotency-Key": "missing-hold-001" },
      body: {
        external_id: "missing-hold",
        patient: createPayload.patient,
      },
    });
    assertApiError(missingHold, 422, "validation_error");

    const tooLarge = await apiRequest(baseUrl, "/appointments", {
      token: fixture.isolatedToken,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "too-large-001",
      },
      rawBody: JSON.stringify({ padding: "x".repeat(110_000) }),
    });
    assertApiError(tooLarge, 413, "payload_too_large");

    const unknown = await apiRequest(baseUrl, "/does-not-exist", {
      token: fixture.isolatedToken,
    });
    assertApiError(unknown, 404, "endpoint_not_found");
  });

  await t.test("cancels idempotently and prevents later edits", async () => {
    const cancelPayload = { reason: "Cancelación de integración" };
    const cancelled = await apiRequest(
      baseUrl,
      `/appointments/${publicAppointmentId}/cancel`,
      {
        token: fixture.primaryToken,
        method: "POST",
        headers: { "Idempotency-Key": "cancel-main-001" },
        body: cancelPayload,
      },
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.data.status, "cancelled");
    assert.equal(cancelled.json.data.settlement.billable, false);
    assert.equal(cancelled.json.data.cancellation.reason, cancelPayload.reason);

    const replay = await apiRequest(
      baseUrl,
      `/appointments/${publicAppointmentId}/cancel`,
      {
        token: fixture.primaryToken,
        method: "POST",
        headers: { "Idempotency-Key": "cancel-main-001" },
        body: cancelPayload,
      },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");

    const editCancelled = await apiRequest(baseUrl, `/appointments/${publicAppointmentId}`, {
      token: fixture.primaryToken,
      method: "PATCH",
      headers: { "Idempotency-Key": "edit-cancelled-001" },
      body: { payment_reference: "must-not-change" },
    });
    assertApiError(editCancelled, 409, "appointment_not_editable");

    const list = await apiRequest(baseUrl, "/appointments?status=cancelled", {
      token: fixture.primaryToken,
    });
    assert.equal(list.status, 200);
    assert.ok(list.json.data.some((item) => item.id === publicAppointmentId));
  });

  await t.test("revokes credentials and enforces the real persistent rate limit", async () => {
    await pool.query(
      `UPDATE agreement_api_credentials SET active = FALSE, revoked_at = NOW() WHERE id = $1`,
      [fixture.credentialIds[1]],
    );
    const revoked = await apiRequest(baseUrl, "/agreement", {
      token: fixture.isolatedToken,
    });
    assertApiError(revoked, 401, "unauthorized");

    const rateLimitIp = "198.51.100.77";
    await pool.query(
      `
        INSERT INTO public_rate_limits
          (scope, key_hash, bucket_started_at, hit_count, updated_at)
        VALUES ($1, $2, date_trunc('second', NOW()), 119, NOW())
      `,
      [
        "agreement-api.credential-ip.read.minute",
        await sha256(`${fixture.credentialIds[2]}:${rateLimitIp}`),
      ],
    );

    const allowed = await apiRequest(baseUrl, "/agreement", {
      token: fixture.rateLimitToken,
      headers: { "X-Forwarded-For": rateLimitIp },
    });
    assert.equal(allowed.status, 200);

    const blocked = await apiRequest(baseUrl, "/agreement", {
      token: fixture.rateLimitToken,
      headers: { "X-Forwarded-For": rateLimitIp },
    });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get("retry-after") || "", /^\d+$/);
    assert.equal(blocked.json.error.code, "rate_limited");
  });

  await t.test('agreement direct treatment and medical orders work end to end with private access', async () => {
    const adminEmail = 'order-admin@example.test';
    const password = 'Local-medical-order-test-2026!';
    await pool.query("INSERT INTO users (email,name,password_hash,role) VALUES ($1,'Admin órdenes',$2,'admin')", [adminEmail, await hashPassword(password)]);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email: adminEmail, password }) });
    assert.equal(login.status, 200);
    const loginData = await login.json();
    const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: baseUrl, 'X-CSRF-Token': loginData.csrf_token };
    const service = (await pool.query("INSERT INTO services (name,duration_minutes,cost_amount,active) VALUES ('Tratamiento de prueba',30,0,TRUE) RETURNING id")).rows[0];
    const settings = { name: 'Acuerdo órdenes', slug: 'ordenes-test', type: 'Pago', cobranded: 'false', direct_treatment: 'true', treatment_service_id: String(service.id), medical_order_required: 'true' };
    const agreementForm = values => { const form = new FormData(); Object.entries(values).forEach(([key, value]) => form.set(key, value)); return form; };
    const invalidService = await fetch(`${baseUrl}/api/admin/agreements`, { method: 'POST', headers: adminHeaders, body: agreementForm({ ...settings, treatment_service_id: '9999999' }) });
    assert.equal(invalidService.status, 422);
    const saved = await fetch(`${baseUrl}/api/admin/agreements`, { method: 'POST', headers: adminHeaders, body: agreementForm(settings) });
    assert.equal(saved.status, 201);
    const agreement = (await saved.json()).agreement;
    assert.equal(agreement.subdomain_prefix, agreement.slug);
    assert.equal(agreement.direct_treatment, true);
    assert.equal(agreement.medical_order_required, true);
    assert.equal(agreement.treatment_service_id, Number(service.id));
    assert.equal(agreement.access_mode, 'web');
    assert.equal(agreement.email_verification_required, true);
    for (const professionalId of fixture.professionalIds) {
      await pool.query('INSERT INTO professional_services (professional_id,service_id) VALUES ($1,$2)', [professionalId, service.id]);
      await pool.query('INSERT INTO professional_agreements (professional_id,agreement_id) VALUES ($1,$2)', [professionalId, agreement.id]);
    }
    const publicAgreement = await (await fetch(`${baseUrl}/api/booking/agreement?form=${agreement.slug}`)).json();
    assert.equal(publicAgreement.agreement.medical_order_required, true);
    assert.equal(publicAgreement.agreement.direct_treatment, true);
    const values = { agreement_slug: agreement.slug, nombre: 'Ana', apellido: 'Prueba', telefono: '1155551111', email: 'medical-order@example.test' };
    const missing = await fetch(`${baseUrl}/api/booking/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify(values) });
    assert.equal(missing.status, 422);
    assert.match((await missing.json()).errors.medical_order, /orden médica/);
    const orderForm = content => { const form = agreementForm(values); form.append('medical_order', new Blob([content], { type: 'application/pdf' }), 'orden.pdf'); return form; };
    const wrongOrigin = await fetch(`${baseUrl}/api/booking/intake`, { method: 'POST', headers: { Origin: 'https://wrong.example' }, body: orderForm('%PDF-1.4 synthetic') });
    assert.equal(wrongOrigin.status, 403);
    const forged = await fetch(`${baseUrl}/api/booking/intake`, { method: 'POST', headers: { Origin: baseUrl }, body: orderForm('<script>Not a PDF</script>') });
    assert.equal(forged.status, 422);
    // The patient submits from the agreement subdomain, not the canonical site.
    const agreementOrigin = new URL(baseUrl);
    agreementOrigin.hostname = `ordenes-test.${agreementOrigin.hostname}`;
    assert.equal(agreementOrigin.hostname, 'ordenes-test.localhost');
    // Native fetch overrides Host; send the browser-equivalent host via HTTP directly.
    const uploadRequest = new Request(`${baseUrl}/api/booking/intake`, {
      method: 'POST', body: orderForm('%PDF-1.4 synthetic medical order'),
    });
    const uploadBytes = Buffer.from(await uploadRequest.arrayBuffer());
    const intake = await new Promise((resolve, reject) => {
      const request = httpRequest(uploadRequest.url, { method: 'POST', headers: {
        Origin: agreementOrigin.origin, Host: agreementOrigin.host,
        'Content-Type': uploadRequest.headers.get('content-type'),
        'Content-Length': uploadBytes.length,
      } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      request.on('error', reject);
      request.end(uploadBytes);
    });
    assert.equal(intake.status, 202);
    const intakeRow = (await pool.query('SELECT id FROM patient_intakes WHERE email=$1', [values.email])).rows[0];
    const orderRow = (await pool.query('SELECT * FROM patient_intake_medical_orders WHERE patient_intake_id=$1', [intakeRow.id])).rows[0];
    assert.ok(orderRow.storage_path.startsWith('intakes/'));
    await access(join(runtimeRoot, 'private', orderRow.storage_path));
    // Set a synthetic known verification token, then exercise the real verification endpoint.
    const verifyToken = randomBytes(32).toString('base64url');
    await pool.query('UPDATE patient_intake_verifications SET token_hash=$2 WHERE patient_intake_id=$1', [intakeRow.id, await sha256(verifyToken)]);
    const verified = await fetch(`${baseUrl}/api/booking/intake/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ verification_token: verifyToken }) });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).agreement.direct_treatment, true);
    const bookingHeaders = { Cookie: verified.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; '), 'Content-Type': 'application/json', Origin: baseUrl };
    const choices = await (await fetch(`${baseUrl}/api/booking/services`, { headers: bookingHeaders })).json();
    assert.deepEqual(choices.services.map(item => item.id), [Number(service.id)]);
    const date = futureDate(40);
    const slots = await (await fetch(`${baseUrl}/api/booking/slots?service_id=${service.id}&professional_id=first_available&date=${date}`, { headers: bookingHeaders })).json();
    const booking = { service_id: Number(service.id), date, start_time: slots.slots[0], first_available: true };
    assert.ok(booking.start_time);
    const wrongService = await fetch(`${baseUrl}/api/booking/appointments`, { method: 'POST', headers: bookingHeaders, body: JSON.stringify({ ...booking, service_id: fixture.serviceId }) });
    assert.equal(wrongService.status, 422);
    // Legacy/direct links cannot bypass the required order at booking time.
    const bypassToken = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO booking_access_links (token_hash,agreement_id,expires_at,patient_email) VALUES ($1,$2,NOW()+INTERVAL '1 day','bypass@example.test')", [await sha256(bypassToken), agreement.id]);
    const bypass = await fetch(`${baseUrl}/api/booking/appointments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Booking-Token': bypassToken, Origin: baseUrl }, body: JSON.stringify(booking) });
    assert.equal(bypass.status, 422);
    assert.match((await bypass.json()).error, /orden médica/);
    const booked = await fetch(`${baseUrl}/api/booking/appointments`, { method: 'POST', headers: bookingHeaders, body: JSON.stringify(booking) });
    assert.equal(booked.status, 201);
    const appointment = (await booked.json()).appointment;
    const document = (await pool.query('SELECT * FROM appointment_documents WHERE appointment_id=$1', [appointment.id])).rows[0];
    assert.equal(document.purpose, 'medical_order');
    assert.equal(document.storage_path, orderRow.storage_path);
    const listing = await (await fetch(`${baseUrl}/api/admin/appointments`, { headers: adminHeaders })).json();
    const adminDocument = listing.appointments.find(item => item.id === appointment.id).documents.find(item => item.id === Number(document.id));
    assert.match(adminDocument.name, /Orden médica/);
    const adminFile = await fetch(`${baseUrl}${adminDocument.url}`, { headers: adminHeaders });
    assert.equal(adminFile.status, 200);
    assert.equal(await adminFile.text(), '%PDF-1.4 synthetic medical order');
    assert.equal((await fetch(`${baseUrl}${adminDocument.url}`)).status, 401);
    for (const professionalId of fixture.professionalIds) {
      const profToken = randomBytes(32).toString('base64url');
      const profLink = (await pool.query("INSERT INTO professional_access_links (token_hash,professional_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day') RETURNING id", [await sha256(profToken), professionalId])).rows[0];
      await pool.query("INSERT INTO professional_sessions (token_hash,professional_id,access_link_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(profToken), professionalId, profLink.id]);
      const headers = { Cookie: `${config.professionalSessionCookieName}=${profToken}` };
      const url = `${baseUrl}/api/professional/appointment-documents/${document.id}`;
      assert.equal((await fetch(url, { headers })).status, professionalId === appointment.professional_id ? 200 : 404);
      if (professionalId === appointment.professional_id) {
        const listed = await (await fetch(`${baseUrl}/api/professional/appointments`, { headers })).json();
        assert.match(listed.appointments.find(item => item.id === appointment.id).documents[0].name, /Orden médica/);
        assert.equal((await fetch(url, { method: 'HEAD', headers })).status, 200);
      }
    }
    const patientToken = randomBytes(32).toString('base64url');
    const patientLink = (await pool.query("INSERT INTO patient_appointment_access_links (token_hash,appointment_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day') RETURNING id", [await sha256(patientToken), appointment.id])).rows[0];
    await pool.query("INSERT INTO patient_appointment_sessions (token_hash,access_link_id,appointment_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(patientToken), patientLink.id, appointment.id]);
    const patientHeaders = { Cookie: `${config.patientAppointmentSessionCookieName}=${patientToken}`, Origin: baseUrl };
    const patientListing = await (await fetch(`${baseUrl}/api/booking/manage/appointment`, { headers: patientHeaders })).json();
    assert.equal(patientListing.appointment.documents[0].can_delete, false);
    assert.equal((await fetch(`${baseUrl}/api/booking/manage/documents/${document.id}`, { method: 'DELETE', headers: patientHeaders })).status, 404);
    const updated = await fetch(`${baseUrl}/api/admin/agreements/${agreement.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm({ ...settings, direct_treatment: 'false', medical_order_required: 'false' }) });
    assert.equal(updated.status, 200);
    const next = (await updated.json()).agreement;
    assert.equal(next.direct_treatment, false);
    assert.equal(next.treatment_service_id, null);
    assert.equal(next.medical_order_required, false);
    const optional = await fetch(`${baseUrl}/api/booking/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ ...values, email: 'optional-order@example.test' }) });
    assert.equal(optional.status, 202);

    const payrollSettings = { ...settings, name: 'Nómina identificador', slug: 'nomina-identificador', subdomain_prefix: 'nomina-identificador', type: 'Nomina', direct_treatment: 'false', medical_order_required: 'false', identifier_label: 'DNI' };
    const payrollCreated = await fetch(`${baseUrl}/api/admin/agreements`, { method: 'POST', headers: adminHeaders, body: agreementForm(payrollSettings) });
    assert.equal(payrollCreated.status, 201);
    const payroll = (await payrollCreated.json()).agreement;
    assert.equal(payroll.identifier_label, 'DNI');
    const payrollUpdate = { ...payrollSettings, identifier_label: 'Número de cliente', subdomain_prefix: 'ignored-legacy-prefix' };
    const edited = await fetch(`${baseUrl}/api/admin/agreements/${payroll.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm(payrollUpdate) });
    assert.equal(edited.status, 200);
    const editedAgreement = (await edited.json()).agreement;
    assert.equal(editedAgreement.identifier_label, 'Número de cliente');
    assert.equal(editedAgreement.subdomain_prefix, editedAgreement.slug);
    for (const path of [`/api/booking/agreement?form=${payroll.slug}`, `/api/public/agreements/${payroll.slug}`]) {
      assert.equal((await (await fetch(`${baseUrl}${path}`)).json()).agreement.identifier_label, 'Número de cliente');
    }
    const tooLong = await fetch(`${baseUrl}/api/admin/agreements/${payroll.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm({ ...payrollUpdate, identifier_label: 'x'.repeat(81) }) });
    assert.equal(tooLong.status, 422);
    const blank = await fetch(`${baseUrl}/api/admin/agreements/${payroll.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm({ ...payrollUpdate, identifier_label: '' }) });
    assert.equal(blank.status, 200);
    assert.equal((await blank.json()).agreement.identifier_label, '');
    const paid = await fetch(`${baseUrl}/api/admin/agreements/${payroll.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm({ ...payrollUpdate, type: 'Pago' }) });
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).agreement.identifier_label, '');
    for (const slug of ['www', 'x'.repeat(64)]) {
      const invalidSlug = await fetch(`${baseUrl}/api/admin/agreements/${payroll.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm({ ...payrollUpdate, slug }) });
      assert.equal(invalidSlug.status, 422);
    }
    const renamed = await fetch(`${baseUrl}/api/admin/agreements/${payroll.id}`, { method: 'PUT', headers: adminHeaders, body: agreementForm({ ...payrollUpdate, slug: 'nomina-nueva' }) });
    assert.equal(renamed.status, 200);
    const renamedAgreement = (await renamed.json()).agreement;
    assert.equal(renamedAgreement.slug, 'nomina-nueva');
    assert.equal(renamedAgreement.subdomain_prefix, 'nomina-nueva');
  });

  await t.test("partners support Nomina, direct treatment, private orders and idempotency", async () => {
    const agreementId = Number((await pool.query(`INSERT INTO agreements
      (name, slug, subdomain_prefix, type, direct_treatment, treatment_service_id, medical_order_required, identifier_label)
      VALUES ('Nómina API', 'nomina-api', 'nomina-api', 'Nomina', TRUE, $1, TRUE, 'Legajo') RETURNING id`, [fixture.serviceId])).rows[0].id);
    await pool.query(`INSERT INTO professional_agreements (professional_id, agreement_id) VALUES ($1, $2)`, [fixture.professionalIds[0], agreementId]);
    await pool.query(`INSERT INTO nomina_entries (agreement_id, identificador, identificador_normalized) VALUES ($1, 'Leg-123', 'leg-123'), ($2, 'Otro-999', 'otro-999')`, [agreementId, fixture.isolatedAgreementId]);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email: 'report-admin@example.test', password: 'Local-admin-report-test-2026!' }) });
    assert.equal(login.status, 200);
    const loginData = await login.json();
    const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: baseUrl, 'X-CSRF-Token': loginData.csrf_token };
    const credentials = await fetch(`${baseUrl}/api/admin/agreements/${agreementId}/api-credentials`, { headers: adminHeaders });
    assert.equal((await credentials.json()).agreement.api_available, true);
    const issued = await fetch(`${baseUrl}/api/admin/agreements/${agreementId}/api-credentials`, { method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test nómina' }) });
    assert.equal(issued.status, 201);
    const token = (await issued.json()).token;
    const agreement = await apiRequest(baseUrl, '/agreement', { token });
    assert.equal(agreement.status, 200);
    assert.equal(agreement.json.data.type, 'Nomina');
    assert.equal(agreement.json.data.slug, 'nomina-api');
    assert.equal(agreement.json.data.identifier_label, 'Legajo');
    assert.equal(agreement.json.data.medical_order_required, true);
    assert.equal(agreement.json.data.direct_treatment, true);
    const services = await apiRequest(baseUrl, '/services', { token });
    assert.deepEqual(services.json.data.map(row => [row.id, row.settlement_amount]), [[fixture.serviceId, 0]]);
    assertApiError(await apiRequest(baseUrl, '/availability?service_id=999999&date=' + futureDate(21), { token }), 422, 'service_not_available');
    const availability = await apiRequest(baseUrl, '/availability?professional_id=999999&date=' + futureDate(21), { token });
    assert.equal(availability.status, 200);
    const slot = availability.json.data.days[0].slots[0];
    assert.ok(slot);
    const hold = await apiRequest(baseUrl, '/holds', { token, method: 'POST', headers: { 'Idempotency-Key': 'nomina-hold-001' }, body: { date: futureDate(21), start_time: slot.start_time, professional_id: 999999 } });
    assert.equal(hold.status, 201);
    const payload = { external_id: 'nomina-001', hold_id: hold.json.data.id, payment_reference: 'ignored', patient: { first_name: 'Prueba', last_name: 'Nómina', email: 'nomina-api@example.test', phone: '+5491160000000', identifier: 'LEG-123' } };
    const jsonCreate = (body, key) => apiRequest(baseUrl, '/appointments', { token, method: 'POST', body, headers: { 'Idempotency-Key': key } });
    assertApiError(await jsonCreate(payload, 'nomina-no-order'), 422, 'medical_order_required');
    assertApiError(await jsonCreate({ ...payload, medical_order: 'fake.pdf' }, 'nomina-fake-json'), 422, 'invalid_medical_order');
    const upload = async (body, key, bytes = '%PDF-1.4\nsynthetic medical order\n%%EOF') => {
      const form = new FormData();
      form.set('payload', JSON.stringify(body));
      form.set('medical_order', new Blob([bytes], { type: 'application/pdf' }), 'orden.pdf');
      return apiRequest(baseUrl, '/appointments', { token, method: 'POST', rawBody: form, headers: { 'Idempotency-Key': key } });
    };
    assertApiError(await upload(payload, 'nomina-invalid-file', 'not a PDF'), 415, 'invalid_medical_order');
    assertApiError(await upload({ ...payload, patient: { ...payload.patient, identifier: '' } }, 'nomina-missing-id'), 422, 'identifier_required');
    assertApiError(await upload({ ...payload, patient: { ...payload.patient, identifier: 'Otro-999' } }, 'nomina-other-id'), 422, 'identifier_not_eligible');
    const created = await upload(payload, 'nomina-create-001');
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const data = created.json.data;
    assert.deepEqual(data.payment, { status: 'nomina', provider: 'nomina', reference: '' });
    assert.deepEqual(data.settlement, { amount: 0, currency: 'ARS', billable: false });
    assert.deepEqual(data.medical_order, { required: true, received: true });
    assert.equal(data.patient.identifier, 'LEG-123');
    assert.equal(data.consultation_status, 'not_applicable');
    assert.equal(data.agreement_type, 'Nomina');
    const replay = await upload(payload, 'nomina-create-001');
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(replay.json, created.json);
    assertApiError(await upload(payload, 'nomina-create-001', '%PDF-1.4 changed'), 409, 'idempotency_conflict');
    const documents = await pool.query(`SELECT document.*, appointment.medical_order_required FROM appointment_documents document JOIN appointments appointment ON appointment.id=document.appointment_id WHERE appointment.agreement_api_public_id=$1`, [data.id]);
    assert.equal(documents.rows.length, 1);
    assert.equal(documents.rows[0].purpose, 'medical_order');
    assert.equal(documents.rows[0].medical_order_required, true);
    const fetched = await apiRequest(baseUrl, '/appointments/' + data.id, { token });
    assert.deepEqual(fetched.json.data.medical_order, data.medical_order);
    assert.doesNotMatch(JSON.stringify(fetched.json), /storage_path|rehub|report_encrypted|consultation_report_url/);
    assertApiError(await apiRequest(baseUrl, '/appointments/' + data.id, { token: fixture.primaryToken }), 404, 'appointment_not_found');
    const adminList = await (await fetch(`${baseUrl}/api/admin/appointments`, { headers: adminHeaders })).json();
    const adminAppointment = adminList.appointments.find(row => Number(row.id) === Number(documents.rows[0].appointment_id));
    assert.equal(adminAppointment.identificador, 'LEG-123');
    const doc = adminAppointment.documents.find(row => row.purpose === 'medical_order');
    assert.ok(doc);
    assert.equal((await fetch(`${baseUrl}${doc.url}`, { headers: adminHeaders })).status, 200);
    assert.notEqual((await fetch(`${baseUrl}${doc.url}`)).status, 200);
    assertApiError(await apiRequest(baseUrl, '/appointments/' + data.id, { token, method: 'PATCH', headers: { 'Idempotency-Key': 'nomina-identity-change' }, body: { patient: { ...payload.patient, email: 'other@example.test' } } }), 409, 'patient_identity_not_editable');
    const patched = await apiRequest(baseUrl, '/appointments/' + data.id, { token, method: 'PATCH', headers: { 'Idempotency-Key': 'nomina-update-001' }, body: { date: futureDate(22) } });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.deepEqual(patched.json.data.settlement, data.settlement);
    assert.equal(patched.json.data.medical_order.received, true);
    const cancelled = await apiRequest(baseUrl, '/appointments/' + data.id + '/cancel', { token, method: 'POST', headers: { 'Idempotency-Key': 'nomina-cancel-001' }, body: { reason: 'Prueba finalizada' } });
    assert.equal(cancelled.status, 200);
    const stored = (await pool.query(`SELECT refund_status FROM appointments WHERE agreement_api_public_id=$1`, [data.id])).rows[0];
    assert.equal(stored.refund_status, 'not_required');
    await pool.query(`UPDATE agreements SET medical_order_required=FALSE WHERE id=$1`, [agreementId]);
    const optionalHold = await apiRequest(baseUrl, '/holds', { token, method: 'POST', headers: { 'Idempotency-Key': 'nomina-optional-hold' }, body: { date: futureDate(24), start_time: slot.start_time } });
    assert.equal(optionalHold.status, 201);
    const optional = await jsonCreate({ ...payload, external_id: 'nomina-optional', hold_id: optionalHold.json.data.id }, 'nomina-optional-create');
    assert.equal(optional.status, 201);
    assert.equal(optional.json.data.medical_order.received, false);
    assert.equal(optional.json.data.payment.status, 'nomina');
    // A later change to Pago must not retroactively bill old Nómina reservations.
    await pool.query(`UPDATE agreements SET type='Pago', medical_order_required=FALSE, direct_treatment=FALSE WHERE id=$1`, [agreementId]);
    const snapshotPatch = await apiRequest(baseUrl, '/appointments/' + optional.json.data.id, { token, method: 'PATCH', headers: { 'Idempotency-Key': 'nomina-snapshot-patch' }, body: { date: futureDate(25) } });
    assert.equal(snapshotPatch.status, 200);
    assert.equal(snapshotPatch.json.data.payment.status, 'nomina');
    assert.deepEqual(snapshotPatch.json.data.settlement, data.settlement);
    const period = futureDate(25).slice(0, 7);
    const settlement = await fetch(`${baseUrl}/api/admin/settlements/preview?agreement_id=${agreementId}&month=${period}`, { headers: adminHeaders });
    assert.equal(settlement.status, 200, await settlement.clone().text());
    assert.equal(JSON.stringify(await settlement.json()).includes(optional.json.data.id), false);
    const plainHold = await apiRequest(baseUrl, '/holds', { token, method: 'POST', headers: { 'Idempotency-Key': 'paid-new-hold' }, body: { service_id: fixture.serviceId, date: futureDate(23), start_time: slot.start_time } });
    const plainCreated = await jsonCreate({ ...payload, external_id: 'paid-after-nomina', hold_id: plainHold.json.data.id, patient: { ...payload.patient, identifier: '' } }, 'paid-after-nomina');
    assert.equal(plainCreated.status, 201);
    assert.equal(plainCreated.json.data.payment.status, 'paid');
    assert.equal(plainCreated.json.data.medical_order.required, false);
    assert.equal(plainCreated.json.data.medical_order.received, false);
  });

  await t.test("persists lifecycle invariants without duplicate side effects", async () => {
    const appointment = await pool.query(
      `
        SELECT status, payment_status, payment_provider, refund_status,
               reschedule_count, patient_id,
               patient_notified_at IS NOT NULL AS patient_notified,
               professional_notified_at IS NOT NULL AS professional_notified
        FROM appointments
        WHERE agreement_api_public_id = $1
      `,
      [publicAppointmentId],
    );
    assert.deepEqual(
      {
        status: appointment.rows[0].status,
        payment_status: appointment.rows[0].payment_status,
        payment_provider: appointment.rows[0].payment_provider,
        refund_status: appointment.rows[0].refund_status,
        reschedule_count: Number(appointment.rows[0].reschedule_count),
        patient_linked: Boolean(appointment.rows[0].patient_id),
        patient_notified: appointment.rows[0].patient_notified,
        professional_notified: appointment.rows[0].professional_notified,
      },
      {
        status: "cancelled",
        payment_status: "agreement_api_paid",
        payment_provider: "agreement_api",
        refund_status: "external_management",
        reschedule_count: 1,
        patient_linked: true,
        patient_notified: true,
        professional_notified: true,
      },
    );
    const idempotency = await pool.query(
      `
        SELECT idempotency_key, COUNT(*)::int AS count
        FROM agreement_api_idempotency
        WHERE idempotency_key IN ('create-main-001', 'update-main-001', 'cancel-main-001')
        GROUP BY idempotency_key
      `,
    );
    assert.equal(idempotency.rows.length, 3);
    assert.ok(idempotency.rows.every((row) => row.count === 1));
  });

  await t.test('API policy persists, preserves web assets and never skips internal ReHub or professional notices', async () => {
    const row = (await pool.query("SELECT * FROM appointments WHERE agreement_id=$1 AND status='confirmed' AND consultation_required=FALSE LIMIT 1", [fixture.primaryAgreementId])).rows[0];
    assert.ok(row);
    const login = await fetch(`${baseUrl}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ email: 'report-admin@example.test', password: 'Local-admin-report-test-2026!' }) });
    const loginData = await login.json();
    const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: baseUrl, 'X-CSRF-Token': loginData.csrf_token };
    await pool.query("UPDATE agreements SET logo_path='test-preserved-logo.png', pdf_path='test-preserved.pdf', payment_evaluation_url='https://example.test/pay' WHERE id=$1", [row.agreement_id]);
    const form = new FormData();
    for (const [key,value] of Object.entries({ name: 'API Test Principal', slug: 'api-test-principal', type: 'Pago', access_mode: 'api', communication_sender: 'integrator', cobranded: 'true', email_verification_required: 'true', remove_pdf: 'true', payment_evaluation_url: 'https://example.test/ignored' })) form.set(key,value);
    const saved = await fetch(`${baseUrl}/api/admin/agreements/${row.agreement_id}`, { method: 'PUT', headers: adminHeaders, body: form });
    assert.equal(saved.status, 200, await saved.clone().text());
    const agreement = (await saved.json()).agreement;
    assert.equal(agreement.access_mode, 'api');
    assert.equal(agreement.communication_sender, 'integrator');
    assert.equal(agreement.email_verification_required, false);
    assert.equal(agreement.cobranded, true);
    assert.equal(agreement.logo_path, 'test-preserved-logo.png');
    assert.equal(agreement.pdf_path, 'test-preserved.pdf');
    assert.equal(agreement.payment_evaluation_url, 'https://example.test/pay');
    assert.equal(agreement.api_available, true);
    const refusedIntake = await fetch(`${baseUrl}/api/booking/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ agreement_slug: agreement.slug, nombre: 'Persona', apellido: 'Prueba', email: 'policy-intake@example.test', telefono: '1155550000' }) });
    assert.equal(refusedIntake.status, 403, 'API email-verification bypass must not expose unauthenticated Web booking');

    const roomToken = randomBytes(32).toString('base64url');
    const roomLink = (await pool.query("INSERT INTO patient_appointment_access_links (token_hash,appointment_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day') RETURNING id", [await sha256(roomToken), row.id])).rows[0];
    await pool.query("INSERT INTO patient_appointment_sessions (token_hash,access_link_id,appointment_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')", [await sha256(roomToken), roomLink.id, row.id]);
    const brandedRoom = await (await fetch(`${baseUrl}/api/booking/manage/appointment`, { headers: { Cookie: `${config.patientAppointmentSessionCookieName}=${roomToken}` } })).json();
    assert.equal(brandedRoom.appointment.agreement.cobranded, true);
    assert.equal(brandedRoom.appointment.agreement.logo_url, '/uploads/test-preserved-logo.png');
    assert.equal(brandedRoom.appointment.consultation_status, 'not_applicable');

    const source = await readFile(new URL('../src/appointment-notifications.mjs', import.meta.url), 'utf8');
    const messages = [], assigned = [];
    const context = {
      config, escapeHtml, googleCalendarTemplateUrl, patientCommunicationsSql, consultationStatusSql,
      query: pool.query.bind(pool), recordAudit: async () => {},
      readAppointmentConsultationStatus: async () => 'not_applicable',
      createPatientAppointmentAccessLink: async () => ({ url: 'https://example.test/manage', meet_url: 'https://example.test/sala', bot_url: '' }),
      createProfessionalAccessLink: async () => ({ url: 'https://example.test/profesional' }),
      isReHubConfigured: () => true,
      ensureAppointmentTriage: async id => {
        assigned.push(id);
        await pool.query('UPDATE appointments SET triage_url=$2 WHERE id=$1', [id,'https://patient.rehub.cloud/internal-test']);
        return { url: 'https://patient.rehub.cloud/internal-test' };
      },
      syncAppointmentToGoogleCalendar: async () => ({ status: 'not_connected' }),
      sendEmail: async message => { messages.push(message); return { id: 'synthetic' }; },
    };
    vm.runInNewContext(source.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport /g, '') + '\nglobalThis.actions = { notifyConfirmedAppointment, notifyPatientAppointmentFollowup, notifyPatientForPendingPayment, notifyPatientForCancellation, notifyPatientTriageReminder };', context);
    await pool.query('UPDATE appointments SET patient_notified_at=NULL, professional_notified_at=NULL WHERE id=$1', [row.id]);
    const result = await context.actions.notifyConfirmedAppointment(row.id);
    assert.equal(result.patient.skipped, true);
    assert.equal(result.professional.ok, true, result.professional.error);
    assert.deepEqual(assigned, [row.id]);
    assert.ok(messages.length === 1 && messages[0].to !== row.patient_email);
    assert.equal((await pool.query('SELECT triage_url FROM appointments WHERE id=$1',[row.id])).rows[0].triage_url, 'https://patient.rehub.cloud/internal-test');
    await assert.rejects(context.actions.notifyPatientTriageReminder(row.id, row.professional_id), /TRIAGE_REMINDER_NOT_AVAILABLE/);
    // Exercise each patient claim against the real database; no provider calls.
    await pool.query("UPDATE appointments SET appointment_date=(NOW() AT TIME ZONE $2 + INTERVAL '1 hour')::date, start_time=(NOW() AT TIME ZONE $2 + INTERVAL '1 hour')::time, end_time=(NOW() AT TIME ZONE $2 + INTERVAL '2 hours')::time, patient_followup_notified_at=NULL WHERE id=$1", [row.id, config.googleCalendarTimeZone]);
    assert.equal((await context.actions.notifyPatientAppointmentFollowup(row.id)).skipped, true);
    await pool.query("UPDATE appointments SET status='pending_payment', pending_payment_notified_at=NULL WHERE id=$1", [row.id]);
    assert.equal((await context.actions.notifyPatientForPendingPayment(row.id)).skipped, true);
    await pool.query("UPDATE appointments SET status='cancelled', patient_cancellation_notified_at=NULL WHERE id=$1", [row.id]);
    assert.equal((await context.actions.notifyPatientForCancellation(row.id)).skipped, true);
    assert.equal(messages.length, 1);
    await pool.query("UPDATE appointments SET status='confirmed' WHERE id=$1", [row.id]);
    await pool.query("UPDATE agreements SET communication_sender='reku' WHERE id=$1", [row.agreement_id]);
    await context.actions.notifyConfirmedAppointment(row.id);
    const patientMail = messages.find(message => message.to === row.patient_email);
    assert.ok(patientMail);
    assert.doesNotMatch(patientMail.html, /Completar cuestionario|Cuestionario previo/);
    await assert.rejects(context.actions.notifyPatientTriageReminder(row.id, row.professional_id), /TRIAGE_REMINDER_NOT_AVAILABLE/);
  });

  await t.test('protected Artro demo uses real API and isolates sessions through create, replay, reschedule and cancel', async () => {
    await testArtroDemo({ pool, baseUrl, fixture });
  });

  await t.test('Web agreement can explicitly skip email verification without an API bypass', async () => {
    await pool.query("UPDATE agreements SET access_mode='web', communication_sender='reku', email_verification_required=FALSE WHERE id=$1", [fixture.isolatedAgreementId]);
    const result = await fetch(`${baseUrl}/api/booking/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ agreement_slug: 'api-test-aislado', nombre: 'Persona', apellido: 'Prueba', email: 'web-no-verification@example.test', telefono: '1155552222' }) });
    assert.equal(result.status, 201, await result.clone().text());
    const payload = await result.json();
    assert.equal(payload.verification_required, false);
    assert.ok(payload.booking_expires_at);
    assert.match(result.headers.get('set-cookie'), /reku_booking_access=/);
  });
});
