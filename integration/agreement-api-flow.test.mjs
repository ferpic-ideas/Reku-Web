import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import pg from "pg";

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  const baseUrl = `http://127.0.0.1:${port}`;
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
    assert.deepEqual(agreement.json.data.capabilities, [
      "availability",
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

  const createPayload = {
    external_id: "external-main-001",
    service_id: fixture.serviceId,
    professional_id: primarySlot.professional.id,
    date: dateOne,
    start_time: primarySlot.start_time,
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
    const duplicate = await apiRequest(baseUrl, "/appointments", {
      token: fixture.primaryToken,
      method: "POST",
      headers: { "Idempotency-Key": "create-duplicate-external-001" },
      body: { ...createPayload, start_time: freeSlot.start_time },
    });
    assertApiError(duplicate, 409, "external_id_conflict");
  });

  await t.test("serializes concurrent bookings so only one wins the slot", async () => {
    const concurrentPayload = (suffix) => ({
      ...createPayload,
      external_id: `external-concurrent-${suffix}`,
      start_time: concurrentSlot.start_time,
      patient: {
        ...createPayload.patient,
        email: `patient-api-concurrent-${suffix}@example.test`,
      },
    });
    const results = await Promise.all([
      apiRequest(baseUrl, "/appointments", {
        token: fixture.primaryToken,
        method: "POST",
        headers: { "Idempotency-Key": "concurrent-request-001" },
        body: concurrentPayload("a"),
      }),
      apiRequest(baseUrl, "/appointments", {
        token: fixture.primaryToken,
        method: "POST",
        headers: { "Idempotency-Key": "concurrent-request-002" },
        body: concurrentPayload("b"),
      }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(results.find((result) => result.status === 409).json.error.code, "slot_unavailable");
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

    const statuses = [];
    for (let index = 0; index < 121; index += 1) {
      const result = await apiRequest(baseUrl, "/agreement", {
        token: fixture.rateLimitToken,
      });
      statuses.push(result.status);
      if (result.status === 429) {
        assert.match(result.headers.get("retry-after") || "", /^\d+$/);
        assert.equal(result.json.error.code, "rate_limited");
      }
    }
    assert.equal(statuses.filter((status) => status === 200).length, 120);
    assert.equal(statuses.filter((status) => status === 429).length, 1);
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
});
