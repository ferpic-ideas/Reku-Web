import { createHash } from "node:crypto";
import { query } from "./db.mjs";

let cleanupCounter = 0;

const hashKey = (value) =>
  createHash("sha256").update(String(value || "")).digest("hex");

const bucketStart = (windowSeconds, now = Date.now()) => {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now / windowMs) * windowMs);
};

export const intakeRateLimitPolicy = Object.freeze({
  ip: Object.freeze({ limit: 30, windowSeconds: 3600 }),
  email: Object.freeze({ limit: 20, windowSeconds: 3600 }),
  agreement: Object.freeze({ limit: 300, windowSeconds: 86_400 }),
  global: Object.freeze({ limit: 1000, windowSeconds: 86_400 }),
});

export const rateLimitRetryMessage = (retryAfterSeconds) => {
  const minutes = Math.max(1, Math.ceil(Number(retryAfterSeconds || 60) / 60));
  return `Demasiadas solicitudes. Probá nuevamente en ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`;
};

export const consumeRateLimit = async ({
  scope,
  key,
  limit,
  windowSeconds,
  now,
}, { queryImpl = query } = {}) => {
  const currentTime = now ?? Date.now();
  const startedAt = bucketStart(1, currentTime);
  const windowStartedAt = new Date(currentTime - windowSeconds * 1000);
  const result = await queryImpl(
    `
      WITH current_bucket AS (
        INSERT INTO public_rate_limits
          (scope, key_hash, bucket_started_at, hit_count, updated_at)
        VALUES ($1, $2, $3, 1, NOW())
        ON CONFLICT (scope, key_hash, bucket_started_at)
        DO UPDATE SET
          hit_count = public_rate_limits.hit_count + 1,
          updated_at = NOW()
        RETURNING hit_count
      )
      SELECT
        current_bucket.hit_count
          + COALESCE(SUM(previous.hit_count), 0)::int AS hit_count,
        MIN(COALESCE(previous.bucket_started_at, $3::timestamptz)) AS oldest_bucket
      FROM current_bucket
      LEFT JOIN public_rate_limits previous
        ON previous.scope = $1
       AND previous.key_hash = $2
       AND previous.bucket_started_at >= $4
       AND previous.bucket_started_at <> $3
      GROUP BY current_bucket.hit_count
    `,
    [scope, hashKey(key), startedAt, windowStartedAt],
  );

  cleanupCounter += 1;
  if (cleanupCounter >= 100) {
    cleanupCounter = 0;
    queryImpl(
      "DELETE FROM public_rate_limits WHERE bucket_started_at < NOW() - INTERVAL '7 days'",
    ).catch(() => {});
  }

  const count = Number(result.rows[0]?.hit_count || 0);
  if (count > limit) {
    const error = new Error("RATE_LIMITED");
    error.statusCode = 429;
    const oldestBucket = new Date(result.rows[0]?.oldest_bucket || startedAt).getTime();
    error.retryAfter = Math.max(
      1,
      Math.ceil((oldestBucket + windowSeconds * 1000 - currentTime) / 1000),
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
      ...intakeRateLimitPolicy.ip,
    }),
    consumeRateLimit({
      scope: "intake.email.hour",
      key: email,
      ...intakeRateLimitPolicy.email,
    }),
    consumeRateLimit({
      scope: "intake.agreement.day",
      key: agreementSlug || "unknown",
      ...intakeRateLimitPolicy.agreement,
    }),
    consumeRateLimit({
      scope: "intake.global.day",
      key: "global",
      ...intakeRateLimitPolicy.global,
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

export const enforcePaymentReturnRateLimits = async ({ clientIp, appointmentId }) => {
  await Promise.all([
    consumeRateLimit({
      scope: "mp-return.ip.minute",
      key: clientIp,
      limit: 30,
      windowSeconds: 60,
    }),
    consumeRateLimit({
      scope: "mp-return.appointment.hour",
      key: appointmentId || "missing",
      limit: 15,
      windowSeconds: 3600,
    }),
  ]);
};
