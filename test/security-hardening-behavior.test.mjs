import assert from "node:assert/strict";
import test from "node:test";
import { consumeRateLimit } from "../src/rate-limit.mjs";
import {
  decryptSecret,
  encryptSecret,
  isSecretEnvelope,
} from "../src/secret-envelope.mjs";
import { verifyPasswordOrDummy } from "../src/security.mjs";
import {
  decryptMercadoPagoSettingsFromStorage,
  encryptMercadoPagoSettingsForStorage,
} from "../src/mercado-pago.mjs";

test("secret envelopes authenticate both ciphertext and context", () => {
  const options = {
    material: "test-only-settings-key-with-more-than-32-characters",
    context: "mercado-pago:production:access_token",
  };
  const encrypted = encryptSecret("APP_USR-private", options);
  assert.equal(isSecretEnvelope(encrypted), true);
  assert.equal(decryptSecret(encrypted, options), "APP_USR-private");
  assert.throws(
    () => decryptSecret(encrypted, { ...options, context: "wrong-context" }),
    { message: "SECRET_DECRYPT_FAILED" },
  );
});

test("Mercado Pago storage encrypts every secret while preserving public identifiers", () => {
  const material =
    "test-only-settings-key-with-more-than-32-characters";
  const settings = {
    mode: "production",
    development: {},
    production: {
      public_key: "APP_USR-public",
      client_id: "client-123",
      access_token: "APP_USR-private",
      client_secret: "client-secret",
      webhook_secret: "webhook-secret",
    },
  };
  const stored = encryptMercadoPagoSettingsForStorage(settings, { material });
  assert.equal(stored.production.public_key, "APP_USR-public");
  assert.equal(stored.production.client_id, "client-123");
  assert.notEqual(stored.production.access_token, "APP_USR-private");
  assert.notEqual(stored.production.client_secret, "client-secret");
  assert.notEqual(stored.production.webhook_secret, "webhook-secret");
  const restored = decryptMercadoPagoSettingsFromStorage(stored, { material });
  assert.equal(restored.hadPlaintextSecrets, false);
  assert.equal(restored.settings.production.access_token, "APP_USR-private");
  assert.equal(restored.settings.production.client_secret, "client-secret");
  assert.equal(restored.settings.production.webhook_secret, "webhook-secret");
});

test("missing users take the password verification path and remain invalid", async () => {
  assert.equal(await verifyPasswordOrDummy("some-password", null), false);
});

test("persistent rate-limit buckets reject the first hit over the limit", async () => {
  let hitCount = 0;
  const queryImpl = async (sql) => {
    if (sql.includes("INSERT INTO public_rate_limits")) {
      hitCount += 1;
      return { rows: [{ hit_count: hitCount }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const consume = () =>
    consumeRateLimit(
      {
        scope: "test.login",
        key: "same-account",
        limit: 2,
        windowSeconds: 300,
        now: Date.UTC(2026, 7, 28, 12, 0, 0),
      },
      { queryImpl },
    );

  assert.equal((await consume()).count, 1);
  assert.equal((await consume()).count, 2);
  await assert.rejects(consume, { message: "RATE_LIMITED", statusCode: 429 });
});
