import { randomBytes, randomUUID } from "node:crypto";
import { one, query, recordAudit, tx } from "./db.mjs";
import { getClientIp, readBody, sendJson } from "./http.mjs";
import { hashToken } from "./security.mjs";
import {
  computeSlots,
  loadEligibleProfessionals,
  loadProfessional,
  loadService,
  professionalSupportsService,
} from "./booking-api.mjs";
import {
  notifyConfirmedAppointment,
  notifyPatientForCancellation,
} from "./appointment-notifications.mjs";
import {
  cancelGoogleCalendarAppointment,
  cancelGoogleCalendarEventForProfessional,
} from "./google-calendar.mjs";
import { config } from "./config.mjs";
import { consumeRateLimit } from "./rate-limit.mjs";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;
const externalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const publicIdPattern = /^apt_[a-f0-9]{32}$/;
const holdPublicIdPattern = /^hold_[a-f0-9]{32}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const agreementApiHoldMinutes = 10;

const apiError = (code, message, statusCode = 422, detail = undefined) => {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.publicMessage = message;
  error.detail = detail;
  return error;
};

const sendPartnerJson = (response, statusCode, payload, requestId, headers = {}) =>
  sendJson(response, statusCode, payload, {
    "X-Request-Id": requestId,
    "X-API-Version": "2026-08-01",
    ...headers,
  });

const safelyAfterCommit = async (label, callback) => {
  try {
    await callback();
  } catch (error) {
    console.error("Agreement API post-commit task failed", {
      task: label,
      error: String(error?.message || "POST_COMMIT_FAILED").slice(0, 160),
    });
  }
};

const parsePositiveInteger = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw apiError("validation_error", `${label} debe ser un entero positivo.`);
  }
  return parsed;
};

const validateDate = (value, label = "date") => {
  const text = String(value || "").trim();
  const parsed = new Date(`${text}T00:00:00Z`);
  if (
    !datePattern.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    throw apiError("validation_error", `${label} debe tener formato YYYY-MM-DD.`);
  }
  return text;
};

const validateTime = (value) => {
  const text = String(value || "").trim();
  const [hours, minutes] = text.split(":").map(Number);
  if (
    !timePattern.test(text) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw apiError("validation_error", "start_time debe tener formato HH:MM.");
  }
  return text;
};

const timeToMinutes = (value) => {
  const [hours, minutes] = String(value).slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
};

const minutesToTime = (value) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

const addMinutes = (time, minutes) => minutesToTime(timeToMinutes(time) + minutes);

const normalizePatient = (value, fallback = {}) => {
  const patient = value && typeof value === "object" ? value : fallback;
  const firstName = String(patient.first_name || "").trim().slice(0, 100);
  const lastName = String(patient.last_name || "").trim().slice(0, 100);
  const email = String(patient.email || "").trim().toLowerCase().slice(0, 254);
  const phone = String(patient.phone || "").trim().slice(0, 50);
  if (!firstName || !lastName || !emailPattern.test(email) || !phone) {
    throw apiError(
      "validation_error",
      "patient.first_name, patient.last_name, patient.email y patient.phone son obligatorios.",
    );
  }
  return {
    first_name: firstName,
    last_name: lastName,
    name: `${firstName} ${lastName}`.trim(),
    email,
    phone,
  };
};

const normalizeExternalId = (value) => {
  const externalId = String(value || "").trim();
  if (!externalIdPattern.test(externalId)) {
    throw apiError(
      "validation_error",
      "external_id es obligatorio y sólo admite letras, números, punto, guion, guion bajo y dos puntos (máximo 100).",
    );
  }
  return externalId;
};

const normalizePaymentReference = (value, fallback) =>
  String(value || fallback || "").trim().slice(0, 200);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
};

export const stableJson = (value) => JSON.stringify(stableValue(value));

export const createAgreementApiToken = () =>
  `rku_ag_${randomBytes(32).toString("base64url")}`;

export const agreementApiTokenPrefix = (token) => String(token).slice(0, 18);

export const enforceAgreementApiRateLimit = async ({
  credentialId,
  clientIp,
  mutation,
}, { consume = consumeRateLimit } = {}) => {
  const mode = mutation ? "write" : "read";
  const limits = [
    {
      scope: `agreement-api.credential.${mode}.minute`,
      key: credentialId,
      limit: mutation ? 60 : 240,
    },
    {
      scope: `agreement-api.credential-ip.${mode}.minute`,
      key: `${credentialId}:${clientIp || "unknown"}`,
      limit: mutation ? 30 : 120,
    },
  ];
  try {
    await Promise.all(
      limits.map((item) =>
        consume({ ...item, windowSeconds: 60 }),
      ),
    );
  } catch (cause) {
    if (cause.message !== "RATE_LIMITED") throw cause;
    const error = apiError(
      "rate_limited",
      "Se superó el límite de solicitudes. Reintentá más tarde.",
      429,
    );
    error.retryAfter = cause.retryAfter || 60;
    throw error;
  }
};

const readPartnerJson = async (request) => {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw apiError(
      "unsupported_media_type",
      "Las operaciones de escritura requieren Content-Type: application/json.",
      415,
    );
  }
  let body;
  try {
    body = await readBody(request, Math.min(config.maxBodyBytes, 100_000));
  } catch (error) {
    if (error.message === "PAYLOAD_TOO_LARGE") {
      throw apiError("payload_too_large", "El cuerpo supera el tamaño permitido.", 413);
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(body || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("bad");
    return parsed;
  } catch {
    throw apiError("invalid_json", "El cuerpo JSON no es válido.", 400);
  }
};

const bearerToken = (request) => {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || "";
};

const requireCredential = async (request) => {
  const token = bearerToken(request);
  if (!token || !token.startsWith("rku_ag_") || token.length < 40) {
    throw apiError("unauthorized", "Credencial inválida.", 401);
  }
  const credential = await one(
    `
      SELECT
        credential.id,
        credential.agreement_id,
        credential.name AS credential_name,
        agreement.name AS agreement_name,
        agreement.slug AS agreement_slug,
        agreement.type AS agreement_type,
        agreement.cobranded AS agreement_cobranded
      FROM agreement_api_credentials credential
      INNER JOIN agreements agreement ON agreement.id = credential.agreement_id
      WHERE credential.token_hash = $1
        AND credential.active = TRUE
        AND credential.revoked_at IS NULL
        AND agreement.deleted_at IS NULL
        AND agreement.type = 'Pago'
    `,
    [hashToken(token)],
  );
  if (!credential) throw apiError("unauthorized", "Credencial inválida.", 401);
  await query(
    `
      UPDATE agreement_api_credentials
      SET last_used_at = NOW()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')
    `,
    [credential.id],
  );
  return {
    ...credential,
    id: Number(credential.id),
    agreement_id: Number(credential.agreement_id),
  };
};

const idempotencyKey = (request) => {
  const key = String(request.headers["idempotency-key"] || "").trim();
  if (!idempotencyKeyPattern.test(key)) {
    throw apiError(
      "idempotency_key_required",
      "Enviá un Idempotency-Key único de entre 8 y 128 caracteres.",
      400,
    );
  }
  return key;
};

const idempotencyRequest = (request, payload) => {
  const key = idempotencyKey(request);
  const path = new URL(request.url, "http://localhost").pathname;
  return {
    key,
    path,
    requestHash: hashToken(`${request.method}:${path}:${stableJson(payload)}`),
  };
};

const lookupIdempotentResult = async ({ request, credential, payload }) => {
  const identity = idempotencyRequest(request, payload);
  const existing = await one(
    `
      SELECT request_hash, response_status, response_body, appointment_id
      FROM agreement_api_idempotency
      WHERE credential_id = $1 AND idempotency_key = $2
        AND expires_at > NOW()
    `,
    [credential.id, identity.key],
  );
  if (!existing) return null;
  if (existing.request_hash !== identity.requestHash) {
    throw apiError(
      "idempotency_conflict",
      "Ese Idempotency-Key ya fue usado con otra solicitud.",
      409,
    );
  }
  if (!existing.response_body) {
    throw apiError(
      "request_in_progress",
      "La solicitud con ese Idempotency-Key todavía está en proceso.",
      409,
    );
  }
  return {
    replay: true,
    statusCode: Number(existing.response_status),
    body: existing.response_body,
    appointmentId: existing.appointment_id ? Number(existing.appointment_id) : null,
  };
};

const runIdempotent = async ({ request, credential, payload, execute }) => {
  const identity = idempotencyRequest(request, payload);
  const { key, path, requestHash } = identity;

  return tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`agreement-api:${credential.id}:${key}`],
    );
    await client.query(
      `
        DELETE FROM agreement_api_idempotency
        WHERE credential_id = $1 AND idempotency_key = $2 AND expires_at <= NOW()
      `,
      [credential.id, key],
    );
    const existing = await client.query(
      `
        SELECT request_hash, response_status, response_body, appointment_id
        FROM agreement_api_idempotency
        WHERE credential_id = $1 AND idempotency_key = $2
        FOR UPDATE
      `,
      [credential.id, key],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw apiError(
          "idempotency_conflict",
          "Ese Idempotency-Key ya fue usado con otra solicitud.",
          409,
        );
      }
      if (!existing.rows[0].response_body) {
        throw apiError(
          "request_in_progress",
          "La solicitud con ese Idempotency-Key todavía está en proceso.",
          409,
        );
      }
      return {
        replay: true,
        statusCode: Number(existing.rows[0].response_status),
        body: existing.rows[0].response_body,
        appointmentId: existing.rows[0].appointment_id
          ? Number(existing.rows[0].appointment_id)
          : null,
      };
    }

    const inserted = await client.query(
      `
        INSERT INTO agreement_api_idempotency
          (credential_id, agreement_id, idempotency_key, request_method, request_path, request_hash)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [
        credential.id,
        credential.agreement_id,
        key,
        request.method,
        path,
        requestHash,
      ],
    );
    const result = await execute(client);
    await client.query(
      `
        UPDATE agreement_api_idempotency
        SET response_status = $2,
            response_body = $3::jsonb,
            appointment_id = $4,
            completed_at = NOW()
        WHERE id = $1
      `,
      [
        inserted.rows[0].id,
        result.statusCode,
        JSON.stringify(result.body),
        result.appointmentId || null,
      ],
    );
    return { ...result, replay: false };
  });
};

const mapService = (row) => ({
  id: Number(row.id),
  name: row.name,
  duration_minutes: Number(row.duration_minutes),
  settlement_amount: Number(row.cost_amount || 0),
  currency: "ARS",
});

const mapProfessional = (row) => ({
  id: Number(row.id),
  name: row.name,
  specialty: row.specialty || "",
});

const mapPartnerHold = (row) => ({
  id: row.public_id,
  status: row.consumed_at
    ? "consumed"
    : new Date(row.expires_at).getTime() > Date.now()
      ? "active"
      : "expired",
  expires_at: row.expires_at,
  service: {
    id: Number(row.service_id),
    name: row.service_name || "",
    duration_minutes: Number(row.duration_minutes || 0),
  },
  professional: {
    id: Number(row.professional_id),
    name: row.professional_name || "",
  },
  schedule: {
    date: row.hold_date,
    start_time: String(row.start_time || "").slice(0, 5),
    end_time: String(row.end_time || "").slice(0, 5),
    timezone: config.googleCalendarTimeZone,
  },
});

const mapPartnerAppointment = (row) => ({
  id: row.agreement_api_public_id,
  external_id: row.agreement_api_external_id,
  status: row.status,
  payment: {
    status: row.payment_status === "agreement_api_paid" ? "paid" : row.payment_status,
    provider: "agreement",
    reference: row.payment_reference || "",
  },
  patient: {
    first_name: row.patient_first_name || String(row.patient_name || "").split(" ")[0] || "",
    last_name:
      row.patient_last_name || String(row.patient_name || "").split(" ").slice(1).join(" "),
    email: row.patient_email || "",
    phone: row.patient_phone || "",
  },
  service: {
    id: Number(row.service_id),
    name: row.service_name || "",
    duration_minutes: Number(row.duration_minutes || 0),
  },
  professional: {
    id: Number(row.professional_id),
    name: row.professional_name || "",
  },
  schedule: {
    date: row.appointment_date,
    start_time: String(row.start_time || "").slice(0, 5),
    end_time: String(row.end_time || "").slice(0, 5),
    timezone: config.googleCalendarTimeZone,
  },
  settlement: {
    amount: Number(row.amount || 0),
    currency: "ARS",
    billable: row.status === "confirmed",
  },
  cancellation: row.status === "cancelled"
    ? {
        reason: row.cancellation_reason || "",
        cancelled_at: row.cancelled_at || null,
      }
    : null,
  created_at: row.agreement_api_created_at || row.created_at,
  updated_at: row.updated_at,
});

const appointmentSelect = `
  appointment.*,
  to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date,
  to_char(appointment.start_time, 'HH24:MI') AS start_time,
  to_char(appointment.end_time, 'HH24:MI') AS end_time,
  service.name AS service_name,
  service.duration_minutes,
  professional.name AS professional_name,
  patient.first_name AS patient_first_name,
  patient.last_name AS patient_last_name
`;

const loadPartnerAppointment = async (agreementId, publicId, client = null, lock = false) => {
  const executor = client || { query };
  const result = await executor.query(
    `
      SELECT ${appointmentSelect}
      FROM appointments appointment
      INNER JOIN services service ON service.id = appointment.service_id
      INNER JOIN professionals professional ON professional.id = appointment.professional_id
      LEFT JOIN patients patient ON patient.id = appointment.patient_id
      WHERE appointment.agreement_id = $1
        AND appointment.agreement_api_public_id = $2
        AND appointment.booking_channel = 'agreement_api'
      ${lock ? "FOR UPDATE OF appointment" : ""}
    `,
    [agreementId, publicId],
  );
  return result.rows[0] || null;
};

const listAgreementServices = async (credential, response, requestId) => {
  const result = await query(
    `
      SELECT DISTINCT service.*
      FROM services service
      INNER JOIN professional_services professional_service
        ON professional_service.service_id = service.id
      INNER JOIN professional_agreements professional_agreement
        ON professional_agreement.professional_id = professional_service.professional_id
       AND professional_agreement.agreement_id = $1
      INNER JOIN professionals professional
        ON professional.id = professional_service.professional_id
       AND professional.active = TRUE
       AND professional.deleted_at IS NULL
      WHERE service.active = TRUE AND service.deleted_at IS NULL
      ORDER BY service.name, service.id
    `,
    [credential.agreement_id],
  );
  sendPartnerJson(response, 200, { data: result.rows.map(mapService) }, requestId);
};

const listAgreementProfessionals = async (credential, url, response, requestId) => {
  const serviceId = parsePositiveInteger(url.searchParams.get("service_id"), "service_id");
  const professionals = await loadEligibleProfessionals(serviceId, credential.agreement_id);
  sendPartnerJson(
    response,
    200,
    { data: professionals.map(mapProfessional) },
    requestId,
  );
};

const datesBetween = (from, to) => {
  const result = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (current <= end && result.length <= 31) {
    result.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  if (current <= end) {
    throw apiError("validation_error", "El rango de disponibilidad no puede superar 31 días.");
  }
  return result;
};

const listAvailability = async (credential, url, response, requestId) => {
  const serviceId = parsePositiveInteger(url.searchParams.get("service_id"), "service_id");
  const singleDate = url.searchParams.get("date");
  const from = validateDate(singleDate || url.searchParams.get("from"), "date/from");
  const to = validateDate(singleDate || url.searchParams.get("to") || from, "date/to");
  if (to < from) throw apiError("validation_error", "to no puede ser anterior a from.");
  const requestedProfessional = url.searchParams.get("professional_id");
  const professionalId = requestedProfessional
    ? parsePositiveInteger(requestedProfessional, "professional_id")
    : null;
  const [service, professionals] = await Promise.all([
    loadService(serviceId),
    professionalId
      ? loadProfessional(professionalId).then((professional) => (professional ? [professional] : []))
      : loadEligibleProfessionals(serviceId, credential.agreement_id),
  ]);
  if (!service) throw apiError("service_not_found", "Práctica no disponible.", 404);
  if (
    professionalId &&
    !(await professionalSupportsService(professionalId, serviceId, credential.agreement_id))
  ) {
    throw apiError("professional_not_available", "Profesional no disponible para esta práctica.", 404);
  }
  const days = [];
  for (const date of datesBetween(from, to)) {
    const byProfessional = await Promise.all(
      professionals.map(async (professional) => ({
        professional,
        slots: (
          await computeSlots({
            serviceId,
            professionalId: Number(professional.id),
            date,
            agreementId: credential.agreement_id,
            preloadedService: service,
            selectionValidated: true,
          })
        ).slots,
      })),
    );
    const slots = [];
    for (const item of byProfessional) {
      for (const startTime of item.slots) {
        slots.push({
          start_time: startTime,
          end_time: addMinutes(startTime, Number(service.duration_minutes)),
          professional: mapProfessional(item.professional),
        });
      }
    }
    slots.sort((a, b) =>
      a.start_time.localeCompare(b.start_time) || a.professional.name.localeCompare(b.professional.name),
    );
    days.push({ date, slots });
  }
  sendPartnerJson(
    response,
    200,
    {
      data: {
        service: mapService(service),
        timezone: config.googleCalendarTimeZone,
        days,
      },
    },
    requestId,
  );
};

const bookingCandidates = async ({ credential, serviceId, professionalId, date, startTime }) => {
  const service = await loadService(serviceId);
  if (!service) throw apiError("service_not_found", "Práctica no disponible.", 404);
  const professionals = professionalId
    ? [await loadProfessional(professionalId)].filter(Boolean)
    : await loadEligibleProfessionals(serviceId, credential.agreement_id);
  const candidates = [];
  for (const professional of professionals) {
    if (
      professionalId &&
      !(await professionalSupportsService(professionalId, serviceId, credential.agreement_id))
    ) {
      continue;
    }
    const availability = await computeSlots({
      serviceId,
      professionalId: Number(professional.id),
      date,
      agreementId: credential.agreement_id,
      preloadedService: service,
      selectionValidated: !professionalId,
    });
    if (availability.slots.includes(startTime)) candidates.push(professional);
  }
  if (!candidates.length) {
    throw apiError("slot_unavailable", "Ese horario ya no está disponible.", 409);
  }
  return { service, candidates };
};

const selectAvailableCandidate = async ({
  client,
  candidates,
  date,
  startTime,
  endTime,
  ignoreHoldId = null,
}) => {
  for (const candidate of candidates) {
    const candidateId = Number(candidate.id);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [candidateId, date],
    );
    const conflict = await client.query(
      `
        SELECT 1
        FROM appointments
        WHERE professional_id = $1
          AND appointment_date = $2::date
          AND (
            status = 'confirmed'
            OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '40 minutes')
          )
          AND start_time < $4::time
          AND end_time > $3::time
        LIMIT 1
      `,
      [candidateId, date, startTime, endTime],
    );
    const block = await client.query(
      `
        SELECT 1
        FROM schedule_blocks
        WHERE professional_id = $1
          AND block_date = $2::date
          AND start_time < $4::time
          AND end_time > $3::time
        LIMIT 1
      `,
      [candidateId, date, startTime, endTime],
    );
    const hold = await client.query(
      `
        SELECT 1
        FROM agreement_api_holds
        WHERE professional_id = $1
          AND hold_date = $2::date
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND ($5::bigint IS NULL OR id <> $5)
          AND start_time < $4::time
          AND end_time > $3::time
        LIMIT 1
      `,
      [candidateId, date, startTime, endTime, ignoreHoldId],
    );
    if (!conflict.rows[0] && !block.rows[0] && !hold.rows[0]) return candidate;
  }
  return null;
};

const createHold = async (request, credential, payload, response, requestId) => {
  const replay = await lookupIdempotentResult({ request, credential, payload });
  if (replay) {
    sendPartnerJson(response, replay.statusCode, replay.body, requestId, {
      "Idempotent-Replayed": "true",
    });
    return;
  }
  const serviceId = parsePositiveInteger(payload.service_id, "service_id");
  const professionalId = payload.professional_id
    ? parsePositiveInteger(payload.professional_id, "professional_id")
    : null;
  const date = validateDate(payload.date);
  const startTime = validateTime(payload.start_time);
  const { service, candidates } = await bookingCandidates({
    credential,
    serviceId,
    professionalId,
    date,
    startTime,
  });
  const endTime = addMinutes(startTime, Number(service.duration_minutes));

  const result = await runIdempotent({
    request,
    credential,
    payload,
    execute: async (client) => {
      const selectedProfessional = await selectAvailableCandidate({
        client,
        candidates,
        date,
        startTime,
        endTime,
      });
      if (!selectedProfessional) {
        throw apiError("slot_unavailable", "Ese horario ya no está disponible.", 409);
      }
      const publicId = `hold_${randomUUID().replaceAll("-", "")}`;
      const inserted = await client.query(
        `
          INSERT INTO agreement_api_holds (
            public_id, agreement_id, credential_id, service_id, professional_id,
            hold_date, start_time, end_time, expires_at
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6::date, $7::time, $8::time,
            NOW() + ($9::text || ' minutes')::interval
          )
          RETURNING *,
            to_char(hold_date, 'YYYY-MM-DD') AS hold_date,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time
        `,
        [
          publicId,
          credential.agreement_id,
          credential.id,
          serviceId,
          Number(selectedProfessional.id),
          date,
          startTime,
          endTime,
          agreementApiHoldMinutes,
        ],
      );
      return {
        statusCode: 201,
        body: {
          data: mapPartnerHold({
            ...inserted.rows[0],
            service_name: service.name,
            duration_minutes: service.duration_minutes,
            professional_name: selectedProfessional.name,
          }),
        },
      };
    },
  });

  if (!result.replay) {
    await safelyAfterCommit("hold.created", async () => {
      await recordAudit("agreement_api.hold.created", {
        detail: {
          hold_id: result.body.data.id,
          agreement_id: credential.agreement_id,
          credential_id: credential.id,
          professional_id: result.body.data.professional.id,
          date: result.body.data.schedule.date,
          start_time: result.body.data.schedule.start_time,
          expires_at: result.body.data.expires_at,
        },
      });
    });
  }
  sendPartnerJson(
    response,
    result.statusCode,
    result.body,
    requestId,
    result.replay ? { "Idempotent-Replayed": "true" } : {},
  );
};

const createAppointment = async (request, credential, payload, response, requestId) => {
  const replay = await lookupIdempotentResult({ request, credential, payload });
  if (replay) {
    sendPartnerJson(response, replay.statusCode, replay.body, requestId, {
      "Idempotent-Replayed": "true",
    });
    return;
  }
  const externalId = normalizeExternalId(payload.external_id);
  const holdId = String(payload.hold_id || "").trim();
  if (!holdPublicIdPattern.test(holdId)) {
    throw apiError(
      "validation_error",
      "hold_id es obligatorio y debe ser una pre-reserva válida.",
    );
  }
  const patient = normalizePatient(payload.patient);
  const paymentReference = normalizePaymentReference(payload.payment_reference, externalId);

  const result = await runIdempotent({
    request,
    credential,
    payload,
    execute: async (client) => {
      const duplicate = await client.query(
        `
          SELECT agreement_api_public_id
          FROM appointments
          WHERE agreement_id = $1 AND agreement_api_external_id = $2
        `,
        [credential.agreement_id, externalId],
      );
      if (duplicate.rows[0]) {
        throw apiError(
          "external_id_conflict",
          "Ya existe un turno con ese external_id.",
          409,
          { appointment_id: duplicate.rows[0].agreement_api_public_id },
        );
      }

      const holdResult = await client.query(
        `
          SELECT hold.*,
                 to_char(hold.hold_date, 'YYYY-MM-DD') AS hold_date,
                 to_char(hold.start_time, 'HH24:MI') AS start_time,
                 to_char(hold.end_time, 'HH24:MI') AS end_time,
                 hold.expires_at > NOW() AS active,
                 service.name AS service_name,
                 service.duration_minutes,
                 service.cost_amount,
                 professional.name AS professional_name,
                 professional.specialty AS professional_specialty
          FROM agreement_api_holds hold
          INNER JOIN services service ON service.id = hold.service_id
          INNER JOIN professionals professional ON professional.id = hold.professional_id
          WHERE hold.public_id = $1
            AND hold.agreement_id = $2
            AND hold.credential_id = $3
          FOR UPDATE OF hold
        `,
        [holdId, credential.agreement_id, credential.id],
      );
      const hold = holdResult.rows[0];
      if (!hold) {
        throw apiError("hold_not_found", "Pre-reserva no encontrada.", 404);
      }
      if (hold.consumed_at) {
        throw apiError(
          "hold_already_consumed",
          "La pre-reserva ya fue utilizada.",
          409,
          hold.appointment_id ? { appointment_id: Number(hold.appointment_id) } : undefined,
        );
      }

      const serviceId = Number(hold.service_id);
      const date = hold.hold_date;
      const startTime = hold.start_time;
      const endTime = hold.end_time;
      const service = {
        id: serviceId,
        name: hold.service_name,
        duration_minutes: Number(hold.duration_minutes),
        cost_amount: Number(hold.cost_amount || 0),
      };
      const selectedProfessional = await selectAvailableCandidate({
        client,
        candidates: [
          {
            id: Number(hold.professional_id),
            name: hold.professional_name,
            specialty: hold.professional_specialty || "",
          },
        ],
        date,
        startTime,
        endTime,
        ignoreHoldId: Number(hold.id),
      });
      if (!selectedProfessional) {
        throw apiError(
          "slot_unavailable",
          "Ese horario ya no está disponible.",
          409,
          { hold_id: holdId, hold_expired: !Boolean(hold.active) },
        );
      }

      const canonicalPatient = await client.query(
        `
          INSERT INTO patients
            (first_name, last_name, full_name, email, email_normalized, phone)
          VALUES ($1, $2, $3, $4, lower(trim($4)), $5)
          ON CONFLICT (email_normalized) DO UPDATE SET
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            active = TRUE,
            updated_at = NOW()
          RETURNING id
        `,
        [patient.first_name, patient.last_name, patient.name, patient.email, patient.phone],
      );
      const publicId = `apt_${randomUUID().replaceAll("-", "")}`;
      const inserted = await client.query(
        `
          INSERT INTO appointments (
            patient_id, service_id, professional_id, appointment_date, start_time, end_time,
            patient_name, patient_email, patient_phone,
            agreement_id, agreement_name_snapshot, agreement_slug_snapshot,
            agreement_type_snapshot, agreement_cobranded_snapshot,
            amount, payment_status, payment_reference, payment_provider, payment_detail,
            status, booking_channel, agreement_api_credential_id,
            agreement_api_external_id, agreement_api_public_id, agreement_api_created_at
          )
          VALUES (
            $1, $2, $3, $4::date, $5::time, $6::time,
            $7, $8, $9,
            $10, $11, $12, 'Pago', $13,
            $14, 'agreement_api_paid', $15, 'agreement_api', $16::jsonb,
            'confirmed', 'agreement_api', $17, $18, $19, NOW()
          )
          RETURNING *
        `,
        [
          canonicalPatient.rows[0].id,
          serviceId,
          Number(selectedProfessional.id),
          date,
          startTime,
          endTime,
          patient.name,
          patient.email,
          patient.phone,
          credential.agreement_id,
          credential.agreement_name,
          credential.agreement_slug,
          Boolean(credential.agreement_cobranded),
          Number(service.cost_amount || 0),
          paymentReference,
          JSON.stringify({
            confirmed_by: "agreement_api",
            external_id: externalId,
            hold_id: holdId,
            hold_expired_at_confirmation: !Boolean(hold.active),
          }),
          credential.id,
          externalId,
          publicId,
        ],
      );
      const appointment = {
        ...inserted.rows[0],
        appointment_date: date,
        start_time: startTime,
        end_time: endTime,
        service_name: service.name,
        duration_minutes: service.duration_minutes,
        professional_name: selectedProfessional.name,
        patient_first_name: patient.first_name,
        patient_last_name: patient.last_name,
      };
      await client.query(
        `
          UPDATE agreement_api_holds
          SET consumed_at = NOW(), appointment_id = $2
          WHERE id = $1
        `,
        [hold.id, appointment.id],
      );
      return {
        statusCode: 201,
        body: { data: mapPartnerAppointment(appointment) },
        appointmentId: Number(appointment.id),
      };
    },
  });

  if (!result.replay) {
    await safelyAfterCommit("appointment.created", async () => {
      const notification = await notifyConfirmedAppointment(result.appointmentId);
      await recordAudit("agreement_api.appointment.created", {
        detail: {
          appointment_id: result.appointmentId,
          agreement_id: credential.agreement_id,
          credential_id: credential.id,
          external_id: externalId,
          hold_id: holdId,
          patient_notified: notification.patient?.ok === true,
          professional_notified: notification.professional?.ok === true,
        },
      });
    });
  }
  sendPartnerJson(
    response,
    result.statusCode,
    result.body,
    requestId,
    result.replay ? { "Idempotent-Replayed": "true" } : {},
  );
};

const listAppointments = async (credential, url, response, requestId) => {
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const from = url.searchParams.get("from") ? validateDate(url.searchParams.get("from"), "from") : null;
  const to = url.searchParams.get("to") ? validateDate(url.searchParams.get("to"), "to") : null;
  const status = String(url.searchParams.get("status") || "").trim();
  if (status && !["confirmed", "cancelled"].includes(status)) {
    throw apiError("validation_error", "status debe ser confirmed o cancelled.");
  }
  const externalId = String(url.searchParams.get("external_id") || "").trim();
  const result = await query(
    `
      SELECT ${appointmentSelect}, COUNT(*) OVER()::int AS total_count
      FROM appointments appointment
      INNER JOIN services service ON service.id = appointment.service_id
      INNER JOIN professionals professional ON professional.id = appointment.professional_id
      LEFT JOIN patients patient ON patient.id = appointment.patient_id
      WHERE appointment.agreement_id = $1
        AND appointment.booking_channel = 'agreement_api'
        AND ($2::date IS NULL OR appointment.appointment_date >= $2::date)
        AND ($3::date IS NULL OR appointment.appointment_date <= $3::date)
        AND ($4 = '' OR appointment.status = $4)
        AND ($5 = '' OR appointment.agreement_api_external_id = $5)
      ORDER BY appointment.appointment_date DESC, appointment.start_time DESC, appointment.id DESC
      LIMIT $6 OFFSET $7
    `,
    [credential.agreement_id, from, to, status, externalId, limit, (page - 1) * limit],
  );
  sendPartnerJson(
    response,
    200,
    {
      data: result.rows.map(mapPartnerAppointment),
      pagination: {
        page,
        limit,
        total: Number(result.rows[0]?.total_count || 0),
      },
    },
    requestId,
  );
};

const getAppointment = async (credential, publicId, response, requestId) => {
  const appointment = await loadPartnerAppointment(credential.agreement_id, publicId);
  if (!appointment) throw apiError("appointment_not_found", "Turno no encontrado.", 404);
  sendPartnerJson(response, 200, { data: mapPartnerAppointment(appointment) }, requestId);
};

const updateAppointment = async (
  request,
  credential,
  publicId,
  payload,
  response,
  requestId,
) => {
  const replay = await lookupIdempotentResult({ request, credential, payload });
  if (replay) {
    sendPartnerJson(response, replay.statusCode, replay.body, requestId, {
      "Idempotent-Replayed": "true",
    });
    return;
  }
  const initial = await loadPartnerAppointment(credential.agreement_id, publicId);
  if (!initial) throw apiError("appointment_not_found", "Turno no encontrado.", 404);
  if (initial.status !== "confirmed" || !initial.agreement_api_public_id) {
    throw apiError("appointment_not_editable", "El turno ya no puede modificarse.", 409);
  }
  const future = await one(
    `SELECT (($1::date + $2::time) AT TIME ZONE $3) > NOW() AS future`,
    [initial.appointment_date, initial.start_time, config.googleCalendarTimeZone],
  );
  if (!future?.future) {
    throw apiError("appointment_not_editable", "El turno ya comenzó y no puede modificarse.", 409);
  }

  const serviceId = payload.service_id
    ? parsePositiveInteger(payload.service_id, "service_id")
    : Number(initial.service_id);
  const professionalId = payload.professional_id
    ? parsePositiveInteger(payload.professional_id, "professional_id")
    : Number(initial.professional_id);
  const date = payload.date ? validateDate(payload.date) : initial.appointment_date;
  const startTime = payload.start_time ? validateTime(payload.start_time) : initial.start_time;
  const patient = payload.patient
    ? normalizePatient(payload.patient)
    : normalizePatient({
        first_name: initial.patient_first_name || String(initial.patient_name || "").split(" ")[0],
        last_name:
          initial.patient_last_name || String(initial.patient_name || "").split(" ").slice(1).join(" "),
        email: initial.patient_email,
        phone: initial.patient_phone,
      });
  const service = await loadService(serviceId);
  if (!service || !(await professionalSupportsService(professionalId, serviceId, credential.agreement_id))) {
    throw apiError(
      "selection_not_available",
      "La combinación de práctica y profesional no está disponible para este acuerdo.",
      422,
    );
  }
  const scheduleChanged =
    serviceId !== Number(initial.service_id) ||
    professionalId !== Number(initial.professional_id) ||
    date !== initial.appointment_date ||
    startTime !== initial.start_time;
  const endTime = addMinutes(startTime, Number(service.duration_minutes));
  if (scheduleChanged) {
    const available = await computeSlots({
      serviceId,
      professionalId,
      date,
      agreementId: credential.agreement_id,
      excludeAppointmentId: Number(initial.id),
    });
    if (!available.slots.includes(startTime)) {
      throw apiError("slot_unavailable", "Ese horario ya no está disponible.", 409);
    }
  }

  const result = await runIdempotent({
    request,
    credential,
    payload,
    execute: async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
        [professionalId, date],
      );
      const current = await loadPartnerAppointment(
        credential.agreement_id,
        publicId,
        client,
        true,
      );
      if (!current) throw apiError("appointment_not_found", "Turno no encontrado.", 404);
      if (current.status !== "confirmed") {
        throw apiError("appointment_not_editable", "El turno ya no puede modificarse.", 409);
      }
      const conflict = await client.query(
        `
          SELECT 1
          FROM appointments
          WHERE professional_id = $1
            AND appointment_date = $2::date
            AND id <> $3
            AND (
              status = 'confirmed'
              OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '40 minutes')
            )
            AND start_time < $5::time
            AND end_time > $4::time
          LIMIT 1
        `,
        [professionalId, date, current.id, startTime, endTime],
      );
      const block = await client.query(
        `
          SELECT 1
          FROM schedule_blocks
          WHERE professional_id = $1
            AND block_date = $2::date
            AND start_time < $4::time
            AND end_time > $3::time
          LIMIT 1
        `,
        [professionalId, date, startTime, endTime],
      );
      const activeHold = await client.query(
        `
          SELECT 1
          FROM agreement_api_holds
          WHERE professional_id = $1
            AND hold_date = $2::date
            AND consumed_at IS NULL
            AND expires_at > NOW()
            AND start_time < $4::time
            AND end_time > $3::time
          LIMIT 1
        `,
        [professionalId, date, startTime, endTime],
      );
      if (conflict.rows[0] || block.rows[0] || activeHold.rows[0]) {
        throw apiError("slot_unavailable", "Ese horario ya no está disponible.", 409);
      }
      const canonicalPatient = await client.query(
        `
          INSERT INTO patients
            (first_name, last_name, full_name, email, email_normalized, phone)
          VALUES ($1, $2, $3, $4, lower(trim($4)), $5)
          ON CONFLICT (email_normalized) DO UPDATE SET
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            full_name = EXCLUDED.full_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            active = TRUE,
            updated_at = NOW()
          RETURNING id
        `,
        [patient.first_name, patient.last_name, patient.name, patient.email, patient.phone],
      );
      const professionalChanged = professionalId !== Number(current.professional_id);
      const updated = await client.query(
        `
          UPDATE appointments
          SET patient_id = $2,
              patient_name = $3,
              patient_email = $4,
              patient_phone = $5,
              service_id = $6,
              professional_id = $7,
              appointment_date = $8::date,
              start_time = $9::time,
              end_time = $10::time,
              amount = $11,
              payment_reference = $12,
              rescheduled_at = CASE WHEN $13 THEN NOW() ELSE rescheduled_at END,
              reschedule_count = reschedule_count + CASE WHEN $13 THEN 1 ELSE 0 END,
              patient_notified_at = NULL,
              patient_notification_message_id = NULL,
              patient_notification_error = NULL,
              professional_notified_at = NULL,
              professional_notification_message_id = NULL,
              professional_notification_error = NULL,
              patient_followup_notified_at = NULL,
              professional_followup_notified_at = NULL,
              google_calendar_event_id = CASE WHEN $14 THEN NULL ELSE google_calendar_event_id END,
              google_calendar_event_url = CASE WHEN $14 THEN NULL ELSE google_calendar_event_url END,
              google_meet_url = CASE WHEN $14 THEN NULL ELSE google_meet_url END,
              google_sync_status = CASE WHEN $14 THEN 'not_connected' ELSE google_sync_status END,
              google_sync_error = CASE WHEN $14 THEN '' ELSE google_sync_error END,
              google_synced_at = CASE WHEN $14 THEN NULL ELSE google_synced_at END,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          current.id,
          canonicalPatient.rows[0].id,
          patient.name,
          patient.email,
          patient.phone,
          serviceId,
          professionalId,
          date,
          startTime,
          endTime,
          Number(service.cost_amount || 0),
          normalizePaymentReference(payload.payment_reference, current.payment_reference),
          scheduleChanged,
          professionalChanged,
        ],
      );
      const professional = await client.query(
        `SELECT name FROM professionals WHERE id = $1`,
        [professionalId],
      );
      const appointment = {
        ...updated.rows[0],
        appointment_date: date,
        start_time: startTime,
        end_time: endTime,
        service_name: service.name,
        duration_minutes: service.duration_minutes,
        professional_name: professional.rows[0]?.name || "",
        patient_first_name: patient.first_name,
        patient_last_name: patient.last_name,
        previous_professional_id: Number(current.professional_id),
        previous_google_event_id: current.google_calendar_event_id || "",
      };
      return {
        statusCode: 200,
        body: { data: mapPartnerAppointment(appointment) },
        appointmentId: Number(appointment.id),
        afterCommit: {
          professionalChanged,
          previousProfessionalId: Number(current.professional_id),
          previousGoogleEventId: current.google_calendar_event_id || "",
        },
      };
    },
  });

  if (!result.replay) {
    await safelyAfterCommit("appointment.updated", async () => {
      if (result.afterCommit?.professionalChanged && result.afterCommit.previousGoogleEventId) {
        await cancelGoogleCalendarEventForProfessional({
          professionalId: result.afterCommit.previousProfessionalId,
          eventId: result.afterCommit.previousGoogleEventId,
        });
      }
      await notifyConfirmedAppointment(result.appointmentId, { forceGoogleSync: true });
      await recordAudit("agreement_api.appointment.updated", {
        detail: {
          appointment_id: result.appointmentId,
          agreement_id: credential.agreement_id,
          credential_id: credential.id,
          public_id: publicId,
        },
      });
    });
  }
  sendPartnerJson(
    response,
    result.statusCode,
    result.body,
    requestId,
    result.replay ? { "Idempotent-Replayed": "true" } : {},
  );
};

const cancelAppointment = async (
  request,
  credential,
  publicId,
  payload,
  response,
  requestId,
) => {
  const replay = await lookupIdempotentResult({ request, credential, payload });
  if (replay) {
    sendPartnerJson(response, replay.statusCode, replay.body, requestId, {
      "Idempotent-Replayed": "true",
    });
    return;
  }
  const reason = String(payload.reason || "").trim().slice(0, 500);
  if (!reason) throw apiError("validation_error", "reason es obligatorio.");
  const result = await runIdempotent({
    request,
    credential,
    payload,
    execute: async (client) => {
      const appointment = await loadPartnerAppointment(
        credential.agreement_id,
        publicId,
        client,
        true,
      );
      if (!appointment) throw apiError("appointment_not_found", "Turno no encontrado.", 404);
      if (appointment.status === "cancelled") {
        return {
          statusCode: 200,
          body: { data: mapPartnerAppointment(appointment) },
          appointmentId: Number(appointment.id),
          afterCommit: { shouldNotify: false },
        };
      }
      const future = await client.query(
        `SELECT (($1::date + $2::time) AT TIME ZONE $3) > NOW() AS future`,
        [appointment.appointment_date, appointment.start_time, config.googleCalendarTimeZone],
      );
      if (appointment.status !== "confirmed" || !future.rows[0]?.future) {
        throw apiError("appointment_not_cancellable", "El turno ya no puede cancelarse.", 409);
      }
      const updated = await client.query(
        `
          UPDATE appointments
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancellation_reason = $2,
              refund_status = 'external_management',
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [appointment.id, reason],
      );
      return {
        statusCode: 200,
        body: {
          data: mapPartnerAppointment({
            ...appointment,
            ...updated.rows[0],
            appointment_date: appointment.appointment_date,
            start_time: appointment.start_time,
            end_time: appointment.end_time,
          }),
        },
        appointmentId: Number(appointment.id),
        afterCommit: { shouldNotify: true },
      };
    },
  });

  if (!result.replay && result.afterCommit?.shouldNotify) {
    await safelyAfterCommit("appointment.cancelled", async () => {
      await Promise.all([
        cancelGoogleCalendarAppointment(result.appointmentId),
        notifyPatientForCancellation(result.appointmentId),
      ]);
      await recordAudit("agreement_api.appointment.cancelled", {
        detail: {
          appointment_id: result.appointmentId,
          agreement_id: credential.agreement_id,
          credential_id: credential.id,
          public_id: publicId,
          reason,
        },
      });
    });
  }
  sendPartnerJson(
    response,
    result.statusCode,
    result.body,
    requestId,
    result.replay ? { "Idempotent-Replayed": "true" } : {},
  );
};

export const listAgreementApiCredentials = async (agreementId) => {
  const result = await query(
    `
      SELECT id, agreement_id, name, token_prefix, active, created_at, last_used_at, revoked_at
      FROM agreement_api_credentials
      WHERE agreement_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [agreementId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    agreement_id: Number(row.agreement_id),
    name: row.name,
    token_prefix: row.token_prefix,
    active: Boolean(row.active),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  }));
};

export const createAgreementApiCredential = async ({ agreementId, name, userId }) => {
  const agreement = await one(
    `SELECT id, name, type FROM agreements WHERE id = $1 AND deleted_at IS NULL`,
    [agreementId],
  );
  if (!agreement) throw apiError("agreement_not_found", "Acuerdo no encontrado.", 404);
  if (agreement.type !== "Pago") {
    throw apiError(
      "agreement_api_not_available",
      "La API sólo está habilitada para acuerdos que no son de nómina.",
      422,
    );
  }
  const credentialName = String(name || "Integración principal").trim().slice(0, 80);
  if (!credentialName) throw apiError("validation_error", "El nombre es obligatorio.");
  const token = createAgreementApiToken();
  const result = await query(
    `
      INSERT INTO agreement_api_credentials
        (agreement_id, name, token_hash, token_prefix, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, agreement_id, name, token_prefix, active, created_at, last_used_at, revoked_at
    `,
    [agreementId, credentialName, hashToken(token), agreementApiTokenPrefix(token), userId],
  );
  await recordAudit("agreement_api.credential.created", {
    actorUserId: userId,
    detail: {
      agreement_id: Number(agreementId),
      credential_id: Number(result.rows[0].id),
      token_prefix: result.rows[0].token_prefix,
    },
  });
  return {
    credential: {
      ...result.rows[0],
      id: Number(result.rows[0].id),
      agreement_id: Number(result.rows[0].agreement_id),
      active: Boolean(result.rows[0].active),
    },
    token,
  };
};

export const revokeAgreementApiCredential = async ({
  agreementId,
  credentialId,
  userId,
}) => {
  const result = await query(
    `
      UPDATE agreement_api_credentials
      SET active = FALSE,
          revoked_at = COALESCE(revoked_at, NOW()),
          revoked_by_user_id = $3
      WHERE id = $1 AND agreement_id = $2
      RETURNING id
    `,
    [credentialId, agreementId, userId],
  );
  if (!result.rows[0]) throw apiError("credential_not_found", "Credencial no encontrada.", 404);
  await recordAudit("agreement_api.credential.revoked", {
    actorUserId: userId,
    detail: { agreement_id: Number(agreementId), credential_id: Number(credentialId) },
  });
};

export const cleanupAgreementApiIdempotency = async () => {
  const result = await query(
    `DELETE FROM agreement_api_idempotency WHERE expires_at <= NOW()`,
  );
  return { deleted: result.rowCount };
};

export const handleAgreementApi = async (request, response, url) => {
  const requestId = randomUUID();
  try {
    const credential = await requireCredential(request);
    const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(request.method);
    await enforceAgreementApiRateLimit({
      credentialId: credential.id,
      clientIp: getClientIp(request),
      mutation,
    });

    if (url.pathname === "/api/partners/v1/agreement" && request.method === "GET") {
      sendPartnerJson(
        response,
        200,
        {
          data: {
            id: credential.agreement_id,
            name: credential.agreement_name,
            timezone: config.googleCalendarTimeZone,
            capabilities: ["availability", "hold", "create", "list", "reschedule", "cancel"],
          },
        },
        requestId,
      );
      return true;
    }
    if (url.pathname === "/api/partners/v1/services" && request.method === "GET") {
      await listAgreementServices(credential, response, requestId);
      return true;
    }
    if (url.pathname === "/api/partners/v1/professionals" && request.method === "GET") {
      await listAgreementProfessionals(credential, url, response, requestId);
      return true;
    }
    if (url.pathname === "/api/partners/v1/availability" && request.method === "GET") {
      await listAvailability(credential, url, response, requestId);
      return true;
    }
    if (url.pathname === "/api/partners/v1/holds" && request.method === "POST") {
      const payload = await readPartnerJson(request);
      await createHold(request, credential, payload, response, requestId);
      return true;
    }
    if (url.pathname === "/api/partners/v1/appointments" && request.method === "GET") {
      await listAppointments(credential, url, response, requestId);
      return true;
    }
    if (url.pathname === "/api/partners/v1/appointments" && request.method === "POST") {
      const payload = await readPartnerJson(request);
      await createAppointment(request, credential, payload, response, requestId);
      return true;
    }
    const appointmentMatch = url.pathname.match(
      /^\/api\/partners\/v1\/appointments\/(apt_[a-f0-9]{32})$/,
    );
    if (appointmentMatch && publicIdPattern.test(appointmentMatch[1])) {
      if (request.method === "GET") {
        await getAppointment(credential, appointmentMatch[1], response, requestId);
        return true;
      }
      if (request.method === "PATCH") {
        const payload = await readPartnerJson(request);
        await updateAppointment(
          request,
          credential,
          appointmentMatch[1],
          payload,
          response,
          requestId,
        );
        return true;
      }
    }
    const cancelMatch = url.pathname.match(
      /^\/api\/partners\/v1\/appointments\/(apt_[a-f0-9]{32})\/cancel$/,
    );
    if (cancelMatch && request.method === "POST") {
      const payload = await readPartnerJson(request);
      await cancelAppointment(
        request,
        credential,
        cancelMatch[1],
        payload,
        response,
        requestId,
      );
      return true;
    }
    throw apiError("endpoint_not_found", "Endpoint no encontrado.", 404);
  } catch (error) {
    const known = error.publicMessage || error.statusCode;
    const statusCode = error.statusCode || 500;
    const code = error.publicMessage ? error.message : statusCode === 500 ? "internal_error" : "request_failed";
    const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
    sendPartnerJson(
      response,
      statusCode,
      {
        error: {
          code,
          message: known ? error.publicMessage || "La solicitud no pudo completarse." : "Error interno.",
          ...(error.detail ? { detail: error.detail } : {}),
          request_id: requestId,
        },
      },
      requestId,
      headers,
    );
    return true;
  }
};
