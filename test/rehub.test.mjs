import assert from "node:assert/strict";
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import test from "node:test";
import {
  buildEncryptedReHubBody,
  requestPatientTriage,
} from "../src/rehub.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
});

const decryptBody = (encryptedHex) =>
  JSON.parse(
    privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encryptedHex, "hex"),
    ).toString("utf8"),
  );

test("ReHub payload uses RSA OAEP SHA-256 and the documented action", () => {
  const { encryptedHex } = buildEncryptedReHubBody({
    data: {
      name: "Ana",
      familyName: "Pérez",
      patientExternalId: "REKU-APT-000123",
      lang: "es",
    },
    publicKey,
    timestamp: 1_787_046_797,
    nonce: "1a2170d6a74ef6d3e0d1e9e13af6c59d",
  });
  const payload = decryptBody(encryptedHex);

  assert.deepEqual(payload, {
    data: {
      name: "Ana",
      familyName: "Pérez",
      patientExternalId: "REKU-APT-000123",
      lang: "es",
    },
    timestamp: 1_787_046_797,
    nonce: "1a2170d6a74ef6d3e0d1e9e13af6c59d",
    action: "/patient/triage/assign",
  });
});

test("ReHub request posts the encrypted data envelope to the full triage endpoint", async () => {
  let captured;
  const result = await requestPatientTriage({
    name: "Ana",
    familyName: "Pérez",
    patientExternalId: "REKU-APT-000123",
    lang: "es",
    baseUrl: "https://api.example.test/dev2",
    clientId: "test-client",
    publicKey,
    timeoutMs: 2_000,
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            url: "https://patient-dev2.rehub.cloud/opentriage/example",
          };
        },
      };
    },
  });

  assert.equal(
    captured.url,
    "https://api.example.test/dev2/patient/triage/assign",
  );
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["client-id"], "test-client");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  const requestBody = JSON.parse(captured.options.body);
  assert.deepEqual(Object.keys(requestBody), ["data"]);
  const encryptedHex = requestBody.data;
  assert.equal(typeof encryptedHex, "string");
  assert.match(encryptedHex, /^[a-f0-9]+$/);
  assert.equal(
    decryptBody(encryptedHex).data.patientExternalId,
    "REKU-APT-000123",
  );
  assert.equal(
    result.url,
    "https://patient-dev2.rehub.cloud/opentriage/example",
  );
});

test("ReHub response URL must stay on HTTPS rehub.cloud", async () => {
  await assert.rejects(
    requestPatientTriage({
      patientExternalId: "REKU-APT-000123",
      baseUrl: "https://api.example.test/dev2",
      clientId: "test-client",
      publicKey,
      timeoutMs: 2_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { url: "https://malicious.example/collect" };
        },
      }),
    }),
    /REHUB_INVALID_RESPONSE/,
  );
});
