import webpush from "web-push";
import { config } from "./config.mjs";
import { query, recordAudit } from "./db.mjs";

const keyPattern = /^[A-Za-z0-9_-]+$/;

export const isWebPushConfigured = () =>
  Boolean(config.webPushVapidPublicKey && config.webPushVapidPrivateKey);

if (isWebPushConfigured()) {
  webpush.setVapidDetails(
    config.webPushVapidSubject,
    config.webPushVapidPublicKey,
    config.webPushVapidPrivateKey,
  );
}

const invalidSubscription = () => {
  const error = new Error("PUSH_SUBSCRIPTION_INVALID");
  error.statusCode = 422;
  return error;
};

export const normalizePushSubscription = (input = {}) => {
  const endpoint = normalizePushEndpoint(input.endpoint);
  const p256dh = String(input.keys?.p256dh || "").trim();
  const auth = String(input.keys?.auth || "").trim();
  if (
    p256dh.length < 40 ||
    p256dh.length > 256 ||
    auth.length < 8 ||
    auth.length > 128 ||
    !keyPattern.test(p256dh) ||
    !keyPattern.test(auth)
  ) {
    throw invalidSubscription();
  }
  return { endpoint, keys: { p256dh, auth } };
};

export function normalizePushEndpoint(value) {
  const endpoint = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw invalidSubscription();
  }
  if (parsed.protocol !== "https:" || endpoint.length > 4096) {
    throw invalidSubscription();
  }
  return endpoint;
}

const normalizeDeviceKind = (value) =>
  String(value || "").trim().toLowerCase() === "mobile" ? "mobile" : "desktop";

const cleanDeviceLabel = (value, deviceKind) =>
  String(value || (deviceKind === "mobile" ? "Teléfono" : "Computadora"))
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 80);

const mapDevice = (row) => ({
  id: Number(row.id),
  label: row.device_label,
  kind: row.device_kind,
  created_at: row.created_at,
  last_seen_at: row.last_seen_at,
  last_success_at: row.last_success_at,
});

export const getProfessionalPushStatus = async (professionalId) => {
  const result = await query(
    `
      SELECT id, device_label, device_kind, created_at, last_seen_at, last_success_at
      FROM professional_push_subscriptions
      WHERE professional_id = $1
        AND active = TRUE
      ORDER BY device_kind DESC, COALESCE(last_success_at, last_seen_at) DESC, id DESC
    `,
    [professionalId],
  );
  const devices = result.rows.map(mapDevice);
  return {
    configured: isWebPushConfigured(),
    public_key: isWebPushConfigured() ? config.webPushVapidPublicKey : "",
    active_devices: devices.length,
    active_mobile_devices: devices.filter((item) => item.kind === "mobile").length,
    devices,
  };
};

export const saveProfessionalPushSubscription = async ({
  professionalId,
  userId,
  subscription,
  deviceLabel,
  deviceKind,
  userAgent,
}) => {
  if (!isWebPushConfigured()) {
    const error = new Error("PUSH_NOT_CONFIGURED");
    error.statusCode = 503;
    throw error;
  }
  const normalized = normalizePushSubscription(subscription);
  const kind = normalizeDeviceKind(deviceKind);
  const result = await query(
    `
      INSERT INTO professional_push_subscriptions (
        professional_id,
        user_id,
        endpoint,
        p256dh,
        auth,
        device_label,
        device_kind,
        user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        device_label = EXCLUDED.device_label,
        device_kind = EXCLUDED.device_kind,
        user_agent = EXCLUDED.user_agent,
        active = TRUE,
        disabled_at = NULL,
        failure_count = 0,
        last_failure_at = NULL,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE professional_push_subscriptions.professional_id = EXCLUDED.professional_id
      RETURNING id
    `,
    [
      professionalId,
      userId,
      normalized.endpoint,
      normalized.keys.p256dh,
      normalized.keys.auth,
      cleanDeviceLabel(deviceLabel, kind),
      kind,
      String(userAgent || "").slice(0, 500),
    ],
  );
  if (!result.rows[0]) {
    const error = new Error("PUSH_SUBSCRIPTION_CONFLICT");
    error.statusCode = 409;
    throw error;
  }
  await recordAudit("professional.push.subscription_saved", {
    actorUserId: userId,
    detail: {
      professional_id: Number(professionalId),
      subscription_id: Number(result.rows[0].id),
      device_kind: kind,
    },
  });
  return getProfessionalPushStatus(professionalId);
};

export const disableProfessionalPushSubscription = async ({
  professionalId,
  userId,
  subscriptionId,
  endpoint,
}) => {
  const normalizedEndpoint = endpoint ? normalizePushEndpoint(endpoint) : "";
  const result = await query(
    `
      UPDATE professional_push_subscriptions
      SET active = FALSE,
          disabled_at = NOW(),
          updated_at = NOW()
      WHERE professional_id = $1
        AND active = TRUE
        AND (
          ($2::BIGINT IS NOT NULL AND id = $2)
          OR ($3::TEXT <> '' AND endpoint = $3)
        )
      RETURNING id
    `,
    [professionalId, subscriptionId || null, normalizedEndpoint],
  );
  await recordAudit("professional.push.subscription_disabled", {
    actorUserId: userId,
    detail: {
      professional_id: Number(professionalId),
      subscription_ids: result.rows.map((row) => Number(row.id)),
    },
  });
  return getProfessionalPushStatus(professionalId);
};

export const isProfessionalPushSubscriptionActive = async ({
  professionalId,
  endpoint,
}) => {
  const normalizedEndpoint = normalizePushEndpoint(endpoint);
  const result = await query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM professional_push_subscriptions
        WHERE professional_id = $1
          AND endpoint = $2
          AND active = TRUE
      ) AS active
    `,
    [professionalId, normalizedEndpoint],
  );
  return Boolean(result.rows[0]?.active);
};

const markPushSuccess = (id) =>
  query(
    `
      UPDATE professional_push_subscriptions
      SET last_success_at = NOW(),
          last_seen_at = NOW(),
          last_failure_at = NULL,
          failure_count = 0,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id],
  );

const markPushFailure = (id, expired) =>
  query(
    `
      UPDATE professional_push_subscriptions
      SET last_failure_at = NOW(),
          failure_count = failure_count + 1,
          active = CASE WHEN $2 THEN FALSE ELSE active END,
          disabled_at = CASE WHEN $2 THEN NOW() ELSE disabled_at END,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, expired],
  );

export const sendPushToProfessional = async (
  professionalId,
  payload,
  { actorUserId = null, eventType = "professional.push.sent" } = {},
) => {
  if (!isWebPushConfigured()) {
    return { configured: false, attempted: 0, delivered: 0, expired: 0 };
  }
  const result = await query(
    `
      SELECT id, endpoint, p256dh, auth
      FROM professional_push_subscriptions
      WHERE professional_id = $1
        AND active = TRUE
    `,
    [professionalId],
  );
  let delivered = 0;
  let expired = 0;
  await Promise.all(
    result.rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          JSON.stringify(payload),
          { TTL: 300, urgency: "high" },
        );
        delivered += 1;
        await markPushSuccess(row.id);
      } catch (error) {
        const isExpired = [404, 410].includes(Number(error?.statusCode));
        if (isExpired) expired += 1;
        await markPushFailure(row.id, isExpired);
      }
    }),
  );
  try {
    await recordAudit(eventType, {
      actorUserId,
      detail: {
        professional_id: Number(professionalId),
        attempted: result.rows.length,
        delivered,
        expired,
      },
    });
  } catch {
    // El envío ya se completó; una falla de auditoría no debe repetirlo.
  }
  return {
    configured: true,
    attempted: result.rows.length,
    delivered,
    expired,
  };
};
