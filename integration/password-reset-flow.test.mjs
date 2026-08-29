import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import pg from "pg";
import {
  hashPassword,
  hashToken,
  verifyPassword,
} from "../src/security.mjs";

const { Pool } = pg;
const root = fileURLToPath(new URL("../", import.meta.url));
const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertTestDatabase = (databaseUrl) => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for password reset integration tests");
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
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
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
      // The server is still starting or applying migrations.
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

const request = async (
  baseUrl,
  path,
  { method = "GET", body, cookie = "", csrf = "", ip = "198.51.100.10" } = {},
) => {
  const headers = { "X-Forwarded-For": ip };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return {
    status: response.status,
    json,
    headers: response.headers,
    cookie: String(response.headers.get("set-cookie") || "").split(";")[0],
  };
};

const waitForRow = async (pool, sql, params = []) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await pool.query(sql, params);
    if (result.rows[0]) return result.rows[0];
    await delay(50);
  }
  throw new Error("Timed out waiting for password reset side effect");
};

test("admin and professional password recovery completes securely over HTTP", async (t) => {
  assertTestDatabase(testDatabaseUrl);
  const pool = new Pool({ connectionString: testDatabaseUrl, ssl: false, max: 8 });
  const runtimeRoot = await mkdtemp(join(tmpdir(), "reku-password-reset-test-"));
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
      SESSION_SECRET: "password-reset-test-session-secret-at-least-32-chars",
      SESSION_SECURE: "false",
      SETTINGS_ENCRYPTION_KEY: "password-reset-test-settings-key-at-least-32-chars",
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
    childOutput = `${childOutput}${chunk}`.slice(-30_000);
  };
  serverProcess.stdout.on("data", capture);
  serverProcess.stderr.on("data", capture);
  await waitForServer(baseUrl, serverProcess, () => childOutput);

  const adminOldPassword = "Admin-old-password-123";
  const professionalOldPassword = "Pro-old-password-123";
  const professional = await pool.query(
    `
      INSERT INTO professionals (name, email, active)
      VALUES ('Fisio Recuperación', 'reset-fisio@example.test', TRUE)
      RETURNING id
    `,
  );
  const accounts = await pool.query(
    `
      INSERT INTO users
        (email, name, password_hash, role, professional_id, is_active)
      VALUES
        ($1, 'Admin Recuperación', $2, 'admin', NULL, TRUE),
        ($3, 'Fisio Recuperación', $4, 'professional', $5, TRUE)
      RETURNING id, email, role, session_version
    `,
    [
      "reset-admin@example.test",
      await hashPassword(adminOldPassword),
      "reset-fisio@example.test",
      await hashPassword(professionalOldPassword),
      Number(professional.rows[0].id),
    ],
  );
  const admin = accounts.rows.find((row) => row.role === "admin");
  const professionalAccount = accounts.rows.find((row) => row.role === "professional");

  let oldAdminCookie = "";
  let oldProfessionalCookie = "";

  await t.test("creates authenticated sessions that will later be invalidated", async () => {
    const adminLogin = await request(baseUrl, "/api/admin/auth/login", {
      method: "POST",
      body: { email: admin.email, password: adminOldPassword },
    });
    assert.equal(adminLogin.status, 200);
    assert.match(adminLogin.cookie, /^reku_admin_session=/);
    oldAdminCookie = adminLogin.cookie;

    const professionalLogin = await request(baseUrl, "/api/professional/auth/login", {
      method: "POST",
      body: { email: professionalAccount.email, password: professionalOldPassword },
    });
    assert.equal(professionalLogin.status, 200);
    assert.match(professionalLogin.cookie, /^reku_admin_session=/);
    oldProfessionalCookie = professionalLogin.cookie;
  });

  let adminResetId;
  await t.test("returns the exact same response for existing, missing and wrong-portal accounts", async () => {
    const existing = await request(baseUrl, "/api/admin/auth/password-reset/request", {
      method: "POST",
      body: { email: admin.email },
      ip: "198.51.100.21",
    });
    const missing = await request(baseUrl, "/api/admin/auth/password-reset/request", {
      method: "POST",
      body: { email: "missing@example.test" },
      ip: "198.51.100.22",
    });
    const wrongPortal = await request(baseUrl, "/api/admin/auth/password-reset/request", {
      method: "POST",
      body: { email: professionalAccount.email },
      ip: "198.51.100.23",
    });
    assert.equal(existing.status, 202);
    assert.equal(missing.status, 202);
    assert.equal(wrongPortal.status, 202);
    assert.deepEqual(existing.json, missing.json);
    assert.deepEqual(existing.json, wrongPortal.json);
    assert.match(existing.json.message, /Si existe una cuenta habilitada/);

    const reset = await waitForRow(
      pool,
      `
        SELECT id, token_hash, sent_at, email_error
        FROM password_reset_tokens
        WHERE user_id = $1 AND audience = 'admin' AND sent_at IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `,
      [admin.id],
    );
    adminResetId = Number(reset.id);
    assert.match(reset.token_hash, /^[a-f0-9]{64}$/);
    assert.equal(reset.email_error, null);
    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM password_reset_tokens",
    );
    assert.equal(count.rows[0].count, 1);
  });

  const adminResetToken = "admin-reset-token-with-43-safe-characters-0001";
  const adminNewPassword = "Admin-new-password-456";
  await t.test("scopes the token, rejects password reuse and consumes it exactly once", async () => {
    await pool.query(
      "UPDATE password_reset_tokens SET token_hash = $1 WHERE id = $2",
      [hashToken(adminResetToken), adminResetId],
    );

    const crossPortal = await request(
      baseUrl,
      "/api/professional/auth/password-reset",
      {
        method: "POST",
        body: { token: adminResetToken, password: adminNewPassword },
        ip: "198.51.100.31",
      },
    );
    assert.equal(crossPortal.status, 400);

    const reusedPassword = await request(baseUrl, "/api/admin/auth/password-reset", {
      method: "POST",
      body: { token: adminResetToken, password: adminOldPassword },
      ip: "198.51.100.32",
    });
    assert.equal(reusedPassword.status, 422);
    assert.match(reusedPassword.json.error, /diferente/);

    const concurrent = await Promise.all([
      request(baseUrl, "/api/admin/auth/password-reset", {
        method: "POST",
        body: { token: adminResetToken, password: adminNewPassword },
        ip: "198.51.100.33",
      }),
      request(baseUrl, "/api/admin/auth/password-reset", {
        method: "POST",
        body: { token: adminResetToken, password: adminNewPassword },
        ip: "198.51.100.34",
      }),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 400]);
    const success = concurrent.find((result) => result.status === 200);
    assert.match(success.headers.get("set-cookie") || "", /Max-Age=0/);

    const reset = await pool.query(
      "SELECT used_at, revoked_at FROM password_reset_tokens WHERE id = $1",
      [adminResetId],
    );
    assert.ok(reset.rows[0].used_at);
    assert.equal(reset.rows[0].revoked_at, null);

    const account = await pool.query(
      "SELECT password_hash, session_version FROM users WHERE id = $1",
      [admin.id],
    );
    assert.equal(await verifyPassword(adminOldPassword, account.rows[0].password_hash), false);
    assert.equal(await verifyPassword(adminNewPassword, account.rows[0].password_hash), true);
    assert.equal(Number(account.rows[0].session_version), 2);
  });

  await t.test("invalidates old admin sessions and accepts only the new password", async () => {
    const oldSession = await request(baseUrl, "/api/admin/auth/me", {
      cookie: oldAdminCookie,
    });
    assert.equal(oldSession.status, 401);

    const oldLogin = await request(baseUrl, "/api/admin/auth/login", {
      method: "POST",
      body: { email: admin.email, password: adminOldPassword },
      ip: "198.51.100.41",
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request(baseUrl, "/api/admin/auth/login", {
      method: "POST",
      body: { email: admin.email, password: adminNewPassword },
      ip: "198.51.100.42",
    });
    assert.equal(newLogin.status, 200);

    const danglingRequest = await request(
      baseUrl,
      "/api/admin/auth/password-reset/request",
      {
        method: "POST",
        body: { email: admin.email },
        ip: "198.51.100.43",
      },
    );
    assert.equal(danglingRequest.status, 202);
    const danglingReset = await waitForRow(
      pool,
      `
        SELECT id
        FROM password_reset_tokens
        WHERE user_id = $1
          AND audience = 'admin'
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND sent_at IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `,
      [admin.id],
    );
    const manualChange = await request(baseUrl, "/api/admin/auth/change-password", {
      method: "POST",
      cookie: newLogin.cookie,
      csrf: newLogin.json.csrf_token,
      body: {
        current_password: adminNewPassword,
        new_password: "Admin-final-password-789",
      },
      ip: "198.51.100.44",
    });
    assert.equal(manualChange.status, 200);
    const revoked = await pool.query(
      "SELECT revoked_at FROM password_reset_tokens WHERE id = $1",
      [danglingReset.id],
    );
    assert.ok(revoked.rows[0].revoked_at);
  });

  await t.test("expires and completes a professional reset with the same protections", async () => {
    const requested = await request(
      baseUrl,
      "/api/professional/auth/password-reset/request",
      {
        method: "POST",
        body: { email: professionalAccount.email },
        ip: "198.51.100.51",
      },
    );
    assert.equal(requested.status, 202);
    const reset = await waitForRow(
      pool,
      `
        SELECT id
        FROM password_reset_tokens
        WHERE user_id = $1 AND audience = 'professional' AND sent_at IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `,
      [professionalAccount.id],
    );
    const token = "professional-reset-token-safe-characters-0001";
    await pool.query(
      `
        UPDATE password_reset_tokens
        SET token_hash = $1, expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = $2
      `,
      [hashToken(token), reset.id],
    );
    const expired = await request(baseUrl, "/api/professional/auth/password-reset", {
      method: "POST",
      body: { token, password: "Pro-new-password-456" },
      ip: "198.51.100.52",
    });
    assert.equal(expired.status, 400);

    await pool.query(
      "UPDATE password_reset_tokens SET expires_at = NOW() + INTERVAL '30 minutes' WHERE id = $1",
      [reset.id],
    );
    const weak = await request(baseUrl, "/api/professional/auth/password-reset", {
      method: "POST",
      body: { token, password: "short" },
      ip: "198.51.100.53",
    });
    assert.equal(weak.status, 422);

    const completed = await request(baseUrl, "/api/professional/auth/password-reset", {
      method: "POST",
      body: { token, password: "Pro-new-password-456" },
      ip: "198.51.100.54",
    });
    assert.equal(completed.status, 200);
    assert.match(completed.headers.get("set-cookie") || "", /Max-Age=0/);

    const oldSession = await request(baseUrl, "/api/professional/auth/me", {
      cookie: oldProfessionalCookie,
    });
    assert.equal(oldSession.status, 401);
    const oldLogin = await request(baseUrl, "/api/professional/auth/login", {
      method: "POST",
      body: { email: professionalAccount.email, password: professionalOldPassword },
      ip: "198.51.100.55",
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await request(baseUrl, "/api/professional/auth/login", {
      method: "POST",
      body: { email: professionalAccount.email, password: "Pro-new-password-456" },
      ip: "198.51.100.56",
    });
    assert.equal(newLogin.status, 200);
  });

  await t.test("rate limits recovery requests by IP with a Retry-After response", async () => {
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(
        await request(baseUrl, "/api/admin/auth/password-reset/request", {
          method: "POST",
          body: { email: `rate-${index}@example.test` },
          ip: "198.51.100.99",
        }),
      );
    }
    assert.deepEqual(results.map((result) => result.status), [202, 202, 202, 202, 202, 429]);
    assert.match(results[5].headers.get("retry-after") || "", /^\d+$/);
  });

  await t.test("persists the expected audit and token lifecycle invariants", async () => {
    const tokens = await pool.query(
      `
        SELECT
          audience,
          used_at IS NOT NULL AS used,
          revoked_at IS NOT NULL AS revoked,
          token_hash
        FROM password_reset_tokens
        ORDER BY id
      `,
    );
    assert.deepEqual(tokens.rows.map((row) => [row.audience, row.used, row.revoked]), [
      ["admin", true, false],
      ["admin", false, true],
      ["professional", true, false],
    ]);
    assert.ok(tokens.rows.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash)));

    const audit = await pool.query(
      `
        SELECT event_type, COUNT(*)::int AS count
        FROM audit_events
        WHERE event_type IN ('auth.password_reset_requested', 'auth.password_reset_completed')
        GROUP BY event_type
      `,
    );
    const counts = Object.fromEntries(audit.rows.map((row) => [row.event_type, row.count]));
    assert.equal(counts["auth.password_reset_completed"], 2);
    assert.equal(counts["auth.password_reset_requested"], 10);
  });
});
