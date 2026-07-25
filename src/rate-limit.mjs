import { createHash } from "node:crypto";
import { query } from "./db.mjs";

let cleanupCounter = 0;

const hashKey = (value) =>
  createHash("sha256").update(String(value || "")).digest("hex");

const bucketStart = (windowSeconds, now = Date.now()) => {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now / windowMs) * windowMs);
};

export const consumeRateLimit = async ({
  scope,
  key,
  limit,
  windowSeconds,
  now,
}) => {
  const startedAt = bucketStart(windowSeconds, now);
  const result = await query(
    `
      INSERT INTO public_rate_limits
        (scope, key_hash, bucket_started_at, hit_count, updated_at)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (scope, key_hash, bucket_started_at)
      DO UPDATE SET
        hit_count = public_rate_limits.hit_count + 1,
        updated_at = NOW()
      RETURNING hit_count
    `,
    [scope, hashKey(key), startedAt],
  );

  cleanupCounter += 1;
  if (cleanupCounter >= 100) {
    cleanupCounter = 0;
    query(
      "DELETE FROM public_rate_limits WHERE bucket_started_at < NOW() - INTERVAL '7 days'",
    ).catch(() => {});
  }

  const count = Number(result.rows[0]?.hit_count || 0);
  if (count > limit) {
    const error = new Error("RATE_LIMITED");
    error.statusCode = 429;
    error.retryAfter = Math.max(
      1,
      Math.ceil((startedAt.getTime() + windowSeconds * 1000 - Date.now()) / 1000),
    );
    throw error;
  }

  return { count, limit, windowSeconds };
};

export const enforceIntakeRateLimits = async ({ clientIp, email, agreementSlug }) => {
  await Promise.all([
    consumeRateLimit({
      scope: "intake.ip.hour",
      key: clientIp,
      limit: 10,
      windowSeconds: 3600,
    }),
    consumeRateLimit({
      scope: "intake.email.hour",
      key: email,
      limit: 5,
      windowSeconds: 3600,
    }),
    consumeRateLimit({
      scope: "intake.agreement.day",
      key: agreementSlug || "unknown",
      limit: 300,
      windowSeconds: 86_400,
    }),
    consumeRateLimit({
      scope: "intake.global.day",
      key: "global",
      limit: 1000,
      windowSeconds: 86_400,
    }),
  ]);
};

export const enforceContactRateLimits = async ({ clientIp, email }) => {
  await Promise.all([
    consumeRateLimit({
      scope: "contact.ip.hour",
      key: clientIp,
      limit: 8,
      windowSeconds: 3600,
    }),
    consumeRateLimit({
      scope: "contact.email.hour",
      key: email,
      limit: 4,
      windowSeconds: 3600,
    }),
    consumeRateLimit({
      scope: "contact.global.day",
      key: "global",
      limit: 300,
      windowSeconds: 86_400,
    }),
  ]);
};

export const enforceWebhookRateLimits = async ({ clientIp, dataId }) => {
  await Promise.all([
    consumeRateLimit({
      scope: "mp-webhook.ip.minute",
      key: clientIp,
      limit: 120,
      windowSeconds: 60,
    }),
    consumeRateLimit({
      scope: "mp-webhook.payment.hour",
      key: dataId || "missing",
      limit: 20,
      windowSeconds: 3600,
    }),
  ]);
};
