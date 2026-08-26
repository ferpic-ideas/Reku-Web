import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";
import { one, query, recordAudit } from "./db.mjs";

const mpApiBase = "https://api.mercadopago.com";
const modes = ["development", "production"];
const secretFields = ["access_token", "client_secret", "webhook_secret"];

const normalizeMode = (value) =>
  modes.includes(String(value || "")) ? String(value) : config.appEnv === "production" ? "production" : "development";

const emptyCredentials = () => ({
  public_key: "",
  access_token: "",
  client_id: "",
  client_secret: "",
  webhook_secret: "",
});

const normalizeCredentials = (value = {}) => ({
  public_key: String(value.public_key || "").trim(),
  access_token: String(value.access_token || "").trim(),
  client_id: String(value.client_id || "").trim(),
  client_secret: String(value.client_secret || "").trim(),
  webhook_secret: String(value.webhook_secret || "").trim(),
});

export const normalizeMercadoPagoSettings = (value = {}) => {
  const legacyCredentials =
    value.public_key || value.access_token
      ? {
          public_key: value.public_key,
          access_token: value.access_token,
        }
      : {};

  return {
    mode: normalizeMode(value.mode || value.environment),
    development: normalizeCredentials(value.development || {}),
    production: normalizeCredentials(value.production || legacyCredentials),
  };
};

export const publicMercadoPagoSettings = (value = {}) => {
  const settings = normalizeMercadoPagoSettings(value);
  return {
    mode: settings.mode,
    development: {
      public_key: settings.development.public_key,
      client_id: settings.development.client_id,
      access_token_set: Boolean(settings.development.access_token),
      client_secret_set: Boolean(settings.development.client_secret),
      webhook_secret_set: Boolean(settings.development.webhook_secret),
    },
    production: {
      public_key: settings.production.public_key,
      client_id: settings.production.client_id,
      access_token_set: Boolean(settings.production.access_token),
      client_secret_set: Boolean(settings.production.client_secret),
      webhook_secret_set: Boolean(settings.production.webhook_secret),
    },
  };
};

export const mergeMercadoPagoSettingsPayload = (currentValue, payload = {}) => {
  const current = normalizeMercadoPagoSettings(currentValue);
  const next = {
    mode: normalizeMode(payload.mode || current.mode),
    development: { ...current.development },
    production: { ...current.production },
  };

  for (const mode of modes) {
    const incoming = payload[mode] || {};
    next[mode].public_key = String(incoming.public_key ?? next[mode].public_key).trim();
    next[mode].client_id = String(incoming.client_id ?? next[mode].client_id).trim();
    for (const field of secretFields) {
      const value = String(incoming[field] || "").trim();
      if (value) next[mode][field] = value;
    }
  }

  if (payload.public_key || payload.access_token) {
    next.production.public_key = String(payload.public_key || next.production.public_key).trim();
    const accessToken = String(payload.access_token || "").trim();
    if (accessToken) next.production.access_token = accessToken;
  }

  return next;
};

export const getMercadoPagoSettings = async () => {
  const row = await one("SELECT value FROM app_settings WHERE key = 'mercado_pago'");
  return normalizeMercadoPagoSettings(row?.value || {});
};

export const getActiveMercadoPagoCredentials = async () => {
  const settings = await getMercadoPagoSettings();
  const credentials = settings[settings.mode] || emptyCredentials();
  if (!credentials.access_token) {
    const error = new Error("MERCADO_PAGO_NOT_CONFIGURED");
    error.statusCode = 503;
    throw error;
  }
  return {
    mode: settings.mode,
    ...credentials,
  };
};

const parseMpResponse = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

const mercadoPagoRequest = async (
  path,
  { accessToken, method = "GET", body, headers = {} } = {},
) => {
  const response = await fetch(`${mpApiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await parseMpResponse(response);
  if (!response.ok) {
    const error = new Error("MERCADO_PAGO_API_ERROR");
    error.statusCode = response.status >= 500 ? 502 : 422;
    error.mercadoPagoStatus = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
};

export const mercadoPagoRefundIdempotencyKey = (appointmentId) =>
  `reku-appointment-${Number(appointmentId)}-full-refund`;

export const createMercadoPagoFullRefund = async ({ appointmentId, paymentId }) => {
  const credentials = await getActiveMercadoPagoCredentials();
  const refund = await mercadoPagoRequest(
    `/v1/payments/${encodeURIComponent(String(paymentId))}/refunds`,
    {
      method: "POST",
      accessToken: credentials.access_token,
      headers: {
        "X-Idempotency-Key": mercadoPagoRefundIdempotencyKey(appointmentId),
      },
    },
  );
  return {
    id: refund.id ? String(refund.id) : "",
    payment_id: refund.payment_id ? String(refund.payment_id) : String(paymentId),
    amount: Number(refund.amount || 0),
    status: refund.status || "",
  };
};

const splitPatientName = (value) => {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return {
    name: parts.slice(0, -1).join(" ") || parts[0] || "",
    surname: parts.length > 1 ? parts.at(-1) : "",
  };
};

const compactObject = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));

const appointmentReference = (appointmentId) => `reku-appointment-${appointmentId}`;

export const appointmentIdFromExternalReference = (value) => {
  const match = String(value || "").match(/^reku-appointment-(\d+)$/);
  return match ? Number(match[1]) : null;
};

export const createMercadoPagoPreference = async ({
  appointment,
  service,
  professional,
  patient,
  returnAgendaUrl = `${config.appPublicUrl}/turnos/`,
}) => {
  const credentials = await getActiveMercadoPagoCredentials();
  const externalReference = appointmentReference(appointment.id);
  const returnUrl = (result) => {
    const params = new URLSearchParams({
      appointment_id: String(appointment.id),
      mp_return: result,
    });
    const url = new URL(returnAgendaUrl);
    url.search = params.toString();
    return url.toString();
  };
  const patientName = splitPatientName(patient.name);
  const unitPrice = Number(service.cost_amount || 0);
  const expirationDateFrom = new Date();
  const expirationDateTo = new Date(expirationDateFrom.getTime() + 30 * 60 * 1000);
  const preference = await mercadoPagoRequest("/checkout/preferences", {
    method: "POST",
    accessToken: credentials.access_token,
    body: {
      items: [
        {
          id: `service-${service.id}`,
          title: `Reku - ${service.name}`,
          description: `Turno con ${professional.name}`,
          category_id: "services",
          quantity: 1,
          currency_id: "ARS",
          unit_price: unitPrice,
        },
      ],
      payer: compactObject({
        name: patientName.name,
        surname: patientName.surname,
        email: patient.email,
        phone: patient.phone ? { number: patient.phone } : undefined,
      }),
      back_urls: {
        success: returnUrl("success"),
        failure: returnUrl("failure"),
        pending: returnUrl("pending"),
      },
      auto_return: "approved",
      expires: true,
      expiration_date_from: expirationDateFrom.toISOString(),
      expiration_date_to: expirationDateTo.toISOString(),
      external_reference: externalReference,
      notification_url: `${config.appPublicUrl}/api/booking/mercado-pago/webhook`,
      metadata: {
        appointment_id: Number(appointment.id),
        service_id: Number(service.id),
        professional_id: Number(professional.id),
        booking_access_link_id: Number(appointment.booking_access_link_id),
        patient_intake_id: appointment.patient_intake_id
          ? Number(appointment.patient_intake_id)
          : null,
      },
    },
  });

  const initPoint =
    credentials.mode === "development"
      ? preference.sandbox_init_point || preference.init_point
      : preference.init_point || preference.sandbox_init_point;

  if (!initPoint) {
    const error = new Error("MERCADO_PAGO_INIT_POINT_MISSING");
    error.statusCode = 502;
    throw error;
  }

  return {
    mode: credentials.mode,
    external_reference: externalReference,
    init_point: initPoint,
    preference_id: String(preference.id || ""),
    raw: preference,
  };
};

export const fetchMercadoPagoPayment = async (paymentId) => {
  const credentials = await getActiveMercadoPagoCredentials();
  return mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
    accessToken: credentials.access_token,
  });
};

const summarizePayment = (payment) => ({
  id: payment.id ? String(payment.id) : "",
  status: payment.status || "",
  status_detail: payment.status_detail || "",
  date_created: payment.date_created || "",
  date_approved: payment.date_approved || "",
  date_last_updated: payment.date_last_updated || "",
  transaction_amount: payment.transaction_amount ?? null,
  currency_id: payment.currency_id || "",
  external_reference: payment.external_reference || "",
  preference_id: payment.preference_id || "",
  payment_method_id: payment.payment_method_id || "",
  payment_type_id: payment.payment_type_id || "",
  live_mode: Boolean(payment.live_mode),
});

const appointmentStatusFromPayment = (paymentStatus) => {
  if (paymentStatus === "approved") return "confirmed";
  if (["rejected", "cancelled"].includes(paymentStatus)) return "payment_failed";
  if (["refunded", "charged_back"].includes(paymentStatus)) return "payment_reversed";
  return "pending_payment";
};

export const updateAppointmentFromMercadoPagoPayment = async (payment) => {
  const paymentId = payment.id ? String(payment.id) : "";
  const reference = String(payment.external_reference || "");
  const appointmentId =
    appointmentIdFromExternalReference(reference) || Number(payment.metadata?.appointment_id || 0);
  if (!appointmentId) {
    const error = new Error("APPOINTMENT_REFERENCE_MISSING");
    error.statusCode = 422;
    throw error;
  }

  const paymentStatus = String(payment.status || "unknown");
  const result = await query(
    `
      UPDATE appointments
      SET payment_id = COALESCE(NULLIF($1, ''), payment_id),
          payment_status = $2,
          payment_reference = COALESCE(NULLIF($1, ''), payment_reference),
          payment_external_reference = COALESCE(NULLIF($3, ''), payment_external_reference),
          payment_detail = $4::jsonb,
          status = CASE
            WHEN status = 'cancelled' THEN 'cancelled'
            WHEN payment_status = 'expired' AND $2 = 'approved' THEN 'cancelled'
            ELSE $5
          END,
          cancelled_at = CASE
            WHEN payment_status = 'expired' AND $2 = 'approved'
              THEN COALESCE(cancelled_at, NOW())
            ELSE cancelled_at
          END,
          cancellation_reason = CASE
            WHEN payment_status = 'expired' AND $2 = 'approved'
              THEN COALESCE(cancellation_reason, 'El pago se acreditó después de vencer la reserva.')
            ELSE cancellation_reason
          END,
          refund_status = CASE
            WHEN (status = 'cancelled' OR payment_status = 'expired')
              AND $2 = 'approved'
              AND refund_status <> 'approved'
              THEN 'pending'
            ELSE refund_status
          END,
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `,
    [
      paymentId,
      paymentStatus,
      reference,
      JSON.stringify(summarizePayment(payment)),
      appointmentStatusFromPayment(paymentStatus),
      appointmentId,
    ],
  );

  if (!result.rows[0]) {
    const error = new Error("APPOINTMENT_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  let appointment = result.rows[0];
  if (
    appointment.status === "cancelled" &&
    paymentStatus === "approved" &&
    appointment.refund_status !== "approved" &&
    paymentId
  ) {
    try {
      const refund = await createMercadoPagoFullRefund({
        appointmentId: appointment.id,
        paymentId,
      });
      const refunded = await query(
        `
          UPDATE appointments
          SET refund_status = 'approved',
              refund_id = $2,
              refund_amount = $3,
              refund_error = NULL,
              payment_status = 'refunded',
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [appointment.id, refund.id || null, refund.amount || Number(appointment.amount || 0)],
      );
      appointment = refunded.rows[0] || appointment;
      await recordAudit("appointment.refund.completed_after_payment_update", {
        detail: {
          appointment_id: Number(appointment.id),
          payment_id: paymentId,
          refund_id: refund.id || "",
        },
      });
    } catch (error) {
      const failed = await query(
        `
          UPDATE appointments
          SET refund_status = 'failed', refund_error = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [appointment.id, String(error.message || "No se pudo reembolsar.").slice(0, 500)],
      );
      appointment = failed.rows[0] || appointment;
      await recordAudit("appointment.refund.failed_after_payment_update", {
        detail: {
          appointment_id: Number(appointment.id),
          payment_id: paymentId,
          error: String(error.message || "MERCADO_PAGO_REFUND_FAILED").slice(0, 120),
        },
      });
    }
  }

  return appointment;
};

const parseSignatureHeader = (value) =>
  Object.fromEntries(
    String(value || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator === -1
          ? [part, ""]
          : [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );

export const verifyMercadoPagoWebhookSignature = ({ headers, dataId, secret }) => {
  if (!secret) return { configured: false, valid: false, fresh: false };

  const signature = parseSignatureHeader(headers["x-signature"]);
  const requestId = String(headers["x-request-id"] || "");
  const ts = signature.ts || "";
  const expectedHash = signature.v1 || "";
  if (!ts || !expectedHash) {
    return { configured: true, valid: false, fresh: false };
  }

  const timestampSeconds = Number(ts);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fresh =
    Number.isFinite(timestampSeconds) &&
    Math.abs(nowSeconds - timestampSeconds) <=
      config.mercadoPagoWebhookMaxAgeSeconds;
  if (!fresh) return { configured: true, valid: false, fresh: false };

  const manifest = [
    dataId ? `id:${dataId};` : "",
    requestId ? `request-id:${requestId};` : "",
    ts ? `ts:${ts};` : "",
  ].join("");
  const computedHash = createHmac("sha256", secret).update(manifest).digest("hex");
  const expected = Buffer.from(expectedHash, "hex");
  const computed = Buffer.from(computedHash, "hex");
  return {
    configured: true,
    valid: expected.length === computed.length && timingSafeEqual(expected, computed),
    fresh,
  };
};
