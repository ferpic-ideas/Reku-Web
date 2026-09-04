import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPasswordResetEmail,
  buildPasswordResetUrl,
  passwordResetGenericMessage,
  validatePasswordResetPassword,
} from "../src/password-resets.mjs";

test("password reset links keep the secret in a role-scoped URL fragment", () => {
  const token = "a".repeat(43);
  assert.equal(
    buildPasswordResetUrl({ audience: "admin", token }),
    `https://www.reku.io/admin/#reset-password=${token}`,
  );
  assert.equal(
    buildPasswordResetUrl({ audience: "professional", token }),
    `https://www.reku.io/profesional/#reset-password=${token}`,
  );
  assert.doesNotMatch(buildPasswordResetUrl({ audience: "admin", token }), /\?/);
});

test("password reset validation follows each portal policy and caps expensive inputs", () => {
  assert.equal(validatePasswordResetPassword("admin", "1234567890"), "1234567890");
  assert.throws(
    () => validatePasswordResetPassword("admin", "123456789"),
    { message: "PASSWORD_RESET_PASSWORD_INVALID", statusCode: 422 },
  );
  assert.equal(validatePasswordResetPassword("professional", "12345678"), "12345678");
  assert.throws(
    () => validatePasswordResetPassword("professional", "x".repeat(129)),
    { message: "PASSWORD_RESET_PASSWORD_INVALID", statusCode: 422 },
  );
});

test("password reset email escapes account data and explains expiry and single use", () => {
  const email = buildPasswordResetEmail({
    audience: "admin",
    name: '<img src=x onerror="alert(1)">',
    url: "https://www.reku.io/admin/#reset-password=safe&next=<script>",
  });
  assert.doesNotMatch(email.html, /<img|<script>/);
  assert.match(email.html, /&lt;img/);
  assert.match(email.html, /30 minutos/);
  assert.match(email.html, /sólo puede usarse una vez/);
  assert.match(passwordResetGenericMessage, /Si existe una cuenta habilitada/);
});

test("password reset persistence stores hashes and lifecycle fields, never raw tokens", async () => {
  const migration = await readFile(
    new URL("../migrations/019_password_resets.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(migration, /used_at TIMESTAMPTZ/);
  assert.match(migration, /revoked_at TIMESTAMPTZ/);
  assert.match(migration, /audience IN \('admin', 'professional'\)/);
  assert.match(migration, /AFTER UPDATE OF password_hash ON users/);
  assert.match(migration, /revoke_pending_password_resets_on_password_change/);
  assert.doesNotMatch(migration, /\btoken TEXT\b/);
});

test("admin and professional login screens expose scoped recovery flows", async () => {
  const [admin, professional] = await Promise.all([
    readFile(new URL("../admin/app.js", import.meta.url), "utf8"),
    readFile(new URL("../profesional/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /Olvidé mi contraseña/);
  assert.match(admin, /\/api\/admin\/auth\/password-reset\/request/);
  assert.match(admin, /\/api\/admin\/auth\/password-reset'/);
  assert.match(admin, /history\.replaceState/);
  assert.match(professional, /Olvidé mi contraseña/);
  assert.match(professional, /¿Querés sumarte a Reku\?/);
  assert.match(professional, /mobile-login-brand/);
  assert.match(professional, /\/api\/professional\/auth\/password-reset\/request/);
  assert.match(professional, /\/api\/professional\/auth\/password-reset'/);
  assert.match(professional, /history\.replaceState/);
});
