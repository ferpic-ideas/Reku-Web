import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";
import { parseCookies } from "./http.mjs";

const tokenPurpose = "booking-email-verification";

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const signPayload = (payload) =>
  createHmac("sha256", config.sessionSecret)
    .update(`${tokenPurpose}.${payload}`)
    .digest("base64url");

const signaturesMatch = (provided, expected) => {
  const providedBuffer = Buffer.from(String(provided || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
};

export const createPatientEmailVerificationToken = (
  email,
  {
    now = Date.now(),
    ttlSeconds = config.bookingVerifiedEmailTtlSeconds,
  } = {},
) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return "";
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: tokenPurpose,
      email: normalizedEmail,
      exp: Math.floor(now / 1000) + Math.max(60, Number(ttlSeconds) || 0),
    }),
  ).toString("base64url");
  return `${payload}.${signPayload(payload)}`;
};

export const readPatientEmailVerificationToken = (
  token,
  { now = Date.now() } = {},
) => {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return "";
  if (!signaturesMatch(signature, signPayload(payload))) return "";

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = normalizeEmail(data.email);
    if (
      data.v !== 1 ||
      data.purpose !== tokenPurpose ||
      !email ||
      Number(data.exp) <= Math.floor(now / 1000)
    ) {
      return "";
    }
    return email;
  } catch {
    return "";
  }
};

export const readPatientEmailVerificationFromRequest = (request, options = {}) => {
  const cookies = parseCookies(request);
  return readPatientEmailVerificationToken(
    cookies[config.bookingVerifiedEmailCookieName],
    options,
  );
};

export const patientEmailVerificationCookie = (email, { now = Date.now() } = {}) => {
  const token = createPatientEmailVerificationToken(email, { now });
  const maxAge = Math.max(60, Number(config.bookingVerifiedEmailTtlSeconds) || 0);
  const parts = [
    `${config.bookingVerifiedEmailCookieName}=${encodeURIComponent(token)}`,
    "Path=/api/booking",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};

export const shouldReusePatientEmailVerification = ({
  submittedEmail,
  rememberedEmail,
  hasPriorAppointment,
}) =>
  Boolean(hasPriorAppointment) &&
  normalizeEmail(submittedEmail) !== "" &&
  normalizeEmail(submittedEmail) === normalizeEmail(rememberedEmail);
