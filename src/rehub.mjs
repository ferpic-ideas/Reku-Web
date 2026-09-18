import {
  constants,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "./config.mjs";
import { resolveReHubSettings } from "./rehub-settings.mjs";

const TRIAGE_ACTION = "/patient/triage/assign";
let publicKeyPromise = null;
let publicKeyConfiguration = null;

const reHubError = (message, statusCode = 502) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export const isReHubConfigured = (settings = resolveReHubSettings()) =>
  Boolean(
    settings.baseUrl && settings.clientId &&
      (settings.publicKeyBase64 || settings.publicKeyPath),
  );

const loadConfiguredPublicKey = async (settings) => {
  if (!isReHubConfigured(settings)) {
    throw reHubError("REHUB_NOT_CONFIGURED", 503);
  }
  const configuration = JSON.stringify([settings.mode, settings.publicKeyBase64, settings.publicKeyPath]);
  if (!publicKeyPromise || publicKeyConfiguration !== configuration) {
    publicKeyConfiguration = configuration;
    publicKeyPromise = (async () => {
      const pem = settings.publicKeyBase64
        ? Buffer.from(settings.publicKeyBase64, "base64")
        : await readFile(settings.publicKeyPath);
      return createPublicKey(pem);
    })().catch((error) => {
      publicKeyPromise = null;
      throw reHubError(
        error.message === "REHUB_NOT_CONFIGURED"
          ? error.message
          : "REHUB_PUBLIC_KEY_INVALID",
        error.statusCode || 503,
      );
    });
  }
  return publicKeyPromise;
};

export const buildEncryptedReHubBody = ({
  data,
  publicKey,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomBytes(16).toString("hex"),
  action = TRIAGE_ACTION,
}) => {
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new TypeError("timestamp must be a positive Unix timestamp");
  }
  if (!/^[a-f0-9]{32}$/i.test(nonce)) {
    throw new TypeError("nonce must contain 32 hexadecimal characters");
  }
  const payload = {
    data,
    timestamp,
    nonce: nonce.toLowerCase(),
    action,
  };
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  return {
    encryptedHex: encrypted.toString("hex"),
    payload,
  };
};

const assertTriageUrl = (value) => {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw reHubError("REHUB_INVALID_RESPONSE");
  }
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "rehub.cloud" || url.hostname.endsWith(".rehub.cloud"))
  ) {
    throw reHubError("REHUB_INVALID_RESPONSE");
  }
  return url.toString();
};

export const requestPatientTriage = async ({
  name,
  familyName,
  patientExternalId,
  center,
  settings = resolveReHubSettings(),
  lang = config.rehubTriageLang,
  baseUrl = settings.baseUrl,
  clientId = settings.clientId,
  publicKey = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = config.rehubTimeoutMs,
} = {}) => {
  if (!baseUrl || !clientId || (!publicKey && !isReHubConfigured(settings))) {
    throw reHubError("REHUB_NOT_CONFIGURED", 503);
  }
  if (!patientExternalId) {
    throw new TypeError("patientExternalId is required");
  }
  if (!String(center || "").trim()) {
    throw new TypeError("center is required");
  }

  const data = Object.fromEntries(
    Object.entries({
      name: String(name || "").trim(),
      familyName: String(familyName || "").trim(),
      patientExternalId: String(patientExternalId).trim(),
      center: String(center || "").trim(),
      lang: String(lang || "").trim(),
    }).filter(([, value]) => value),
  );
  const key = publicKey || (await loadConfiguredPublicKey(settings));
  let encryptedHex;
  try {
    ({ encryptedHex } = buildEncryptedReHubBody({ data, publicKey: key }));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw reHubError("REHUB_ENCRYPTION_FAILED");
  }

  const endpoint = new URL(
    `${String(baseUrl).replace(/\/+$/, "")}${TRIAGE_ACTION}`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs));
  timeout.unref?.();

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error", // Never forward the client credential to a redirect target.
      headers: {
        "Content-Type": "application/json",
        "client-id": clientId,
      },
      body: JSON.stringify({ data: encryptedHex }),
      signal: controller.signal,
    });
  } catch (error) {
    throw reHubError(
      error.name === "AbortError" ? "REHUB_TIMEOUT" : "REHUB_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = reHubError(
      response.status === 400
        ? "REHUB_REQUEST_REJECTED"
        : response.status === 404
          ? "REHUB_CLIENT_NOT_FOUND"
          : "REHUB_UNAVAILABLE",
    );
    error.rehubStatus = response.status;
    throw error;
  }

  return { url: assertTriageUrl(responseBody.url) };
};
