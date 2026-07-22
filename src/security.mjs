import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.mjs";
import { parseCookies } from "./http.mjs";

const scrypt = promisify(scryptCallback);
const loginAttempts = new Map();

const base64url = (value) => Buffer.from(value).toString("base64url");

export const createCsrfToken = () => randomBytes(32).toString("base64url");

export const hashPassword = async (password) => {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${key.toString("base64url")}`;
};

export const verifyPassword = async (password, storedHash) => {
  const [scheme, n, r, p, salt, hash] = String(storedHash || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;

  const key = await scrypt(password, salt, Buffer.from(hash, "base64url").length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  const expected = Buffer.from(hash, "base64url");
  return expected.length === key.length && timingSafeEqual(expected, key);
};

const signPayload = (payload) =>
  createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");

export const createSessionToken = (user) => {
  const csrf = createCsrfToken();
  const payload = base64url(
    JSON.stringify({
      sub: String(user.id),
      email: user.email,
      role: user.role,
      sv: Number(user.session_version || 1),
      csrf,
      exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
    }),
  );
  return { token: `${payload}.${signPayload(payload)}`, csrf };
};

export const readSessionToken = (token) => {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || signPayload(payload) !== signature) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.sub || Number(data.exp) < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
};

export const sessionCookie = (token) => {
  const parts = [
    `${config.sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${config.sessionTtlSeconds}`,
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};

export const clearSessionCookie = () => {
  const parts = [
    `${config.sessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};

export const readSessionFromRequest = (request) => {
  const cookies = parseCookies(request);
  return readSessionToken(cookies[config.sessionCookieName]);
};

export const enforceCsrf = (request, sessionPayload) => {
  const csrf = request.headers["x-csrf-token"];
  if (!csrf || csrf !== sessionPayload?.csrf) {
    const error = new Error("CSRF_REQUIRED");
    error.statusCode = 403;
    throw error;
  }
};

export const enforceLoginRateLimit = (clientIp, email) => {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const limit = 10;
  const keys = [`ip:${clientIp}`, `email:${String(email).toLowerCase()}`];

  for (const key of keys) {
    const attempts = (loginAttempts.get(key) || []).filter(
      (timestamp) => now - timestamp < windowMs,
    );
    attempts.push(now);
    loginAttempts.set(key, attempts);
    if (attempts.length > limit) {
      const error = new Error("RATE_LIMITED");
      error.statusCode = 429;
      throw error;
    }
  }
};

export const hashToken = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
