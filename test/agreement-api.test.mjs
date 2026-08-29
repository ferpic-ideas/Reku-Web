import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  agreementApiTokenPrefix,
  createAgreementApiToken,
  enforceAgreementApiRateLimit,
  stableJson,
} from "../src/agreement-api.mjs";
import { hashToken } from "../src/security.mjs";

test("agreement API tokens are high-entropy, identifiable and stored only as hashes", () => {
  const first = createAgreementApiToken();
  const second = createAgreementApiToken();
  assert.match(first, /^rku_ag_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(agreementApiTokenPrefix(first), first.slice(0, 18));
  assert.doesNotMatch(hashToken(first), /rku_ag_/);
  assert.equal(hashToken(first).length, 64);
});

test("idempotency payload hashing is independent of object key order", () => {
  assert.equal(
    stableJson({ patient: { email: "a@b.com", name: "Ana" }, service_id: 2 }),
    stableJson({ service_id: 2, patient: { name: "Ana", email: "a@b.com" } }),
  );
});

test("agreement API applies a stricter write rate limit", async () => {
  const identity = `${Date.now()}-${Math.random()}`;
  const buckets = new Map();
  const consume = async ({ scope, key, limit }) => {
    const bucketKey = `${scope}:${key}`;
    const count = (buckets.get(bucketKey) || 0) + 1;
    buckets.set(bucketKey, count);
    if (count > limit) {
      const error = new Error("RATE_LIMITED");
      error.statusCode = 429;
      error.retryAfter = 30;
      throw error;
    }
  };
  for (let index = 0; index < 30; index += 1) {
    await enforceAgreementApiRateLimit(
      {
        credentialId: identity,
        clientIp: "127.0.0.1",
        mutation: true,
      },
      { consume },
    );
  }
  await assert.rejects(
    () =>
      enforceAgreementApiRateLimit(
        {
          credentialId: identity,
          clientIp: "127.0.0.1",
          mutation: true,
        },
        { consume },
      ),
    (error) => error.statusCode === 429 && error.retryAfter > 0,
  );
});

test("partner API schema isolates credentials, external ids and settlement snapshots", async () => {
  const migration = await readFile(
    new URL("../migrations/016_agreement_partner_api.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE \(credential_id, idempotency_key\)/);
  assert.match(migration, /appointments_agreement_api_external_id_key/);
  assert.match(migration, /booking_channel = 'agreement_api'/);
  assert.match(migration, /snapshot JSONB NOT NULL/);
});

test("public documentation and Admin expose the complete agreement API workflow", async () => {
  const [html, openapiText, admin] = await Promise.all([
    readFile(new URL("../integraciones/api/index.html", import.meta.url), "utf8"),
    readFile(new URL("../integraciones/api/openapi.json", import.meta.url), "utf8"),
    readFile(new URL("../admin/app.js", import.meta.url), "utf8"),
  ]);
  const openapi = JSON.parse(openapiText);
  assert.match(html, /Idempotency-Key/);
  assert.match(html, /pagado por el acuerdo/);
  assert.ok(openapi.paths["/appointments"].post);
  assert.ok(openapi.paths["/appointments/{appointmentId}"].patch);
  assert.ok(openapi.paths["/appointments/{appointmentId}/cancel"].post);
  assert.match(admin, /Liquidaciones/);
  assert.match(admin, /Copiá este token ahora/);
  assert.match(admin, /No se volverá a mostrar completo/i);
});
