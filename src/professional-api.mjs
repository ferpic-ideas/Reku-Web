import { one, query, recordAudit, tx } from "./db.mjs";
import { getClientIp, readBody, sendJson, sendRedirect } from "./http.mjs";
import {
  clearSessionCookie,
  createSessionToken,
  enforceCsrf,
  enforceLoginRateLimit,
  hashPassword,
  readSessionFromRequest,
  sessionCookie,
  verifyPassword,
} from "./security.mjs";
import {
  exchangeProfessionalAccessLink,
  professionalSessionCookie,
  requireProfessionalSession,
} from "./professional-links.mjs";
import { parseMultipartForm, saveProfessionalPhoto } from "./uploads.mjs";
import { createMercadoPagoFullRefund } from "./mercado-pago.mjs";
import {
  notifyPatientForCancellation,
  notifyPatientTriageReminder,
} from "./appointment-notifications.mjs";
import {
  cancelGoogleCalendarAppointment,
  createGoogleOAuthAuthorization,
  disconnectGoogleCalendar,
  finishGoogleOAuth,
  getGoogleConnectionStatus,
} from "./google-calendar.mjs";
import { acceptProfessionalInvitation } from "./professional-invitations.mjs";
import { PROFESSIONAL_PASSWORD_MIN_LENGTH } from "./professional-users.mjs";
import {
  mapAppointmentDocument,
  streamProfessionalAppointmentDocument,
} from "./appointment-documents.mjs";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

const parseJsonBody = async (request) => {
  const body = await readBody(request);
  return body ? JSON.parse(body) : {};
};

const timeToMinutes = (value) => {
  const [hours, minutes] = String(value || "00:00").slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
};

const normalizeTime = (value) => {
  const time = String(value || "").trim();
  const [hours, minutes] = time.split(":").map(Number);
  if (
    !timePattern.test(time) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    const error = new Error("TIME_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return time;
};

const normalizeDate = (value) => {
  const date = String(value || "").trim();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !datePattern.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    const error = new Error("DATE_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return date;
};

const normalizeAvailability = (value) => {
  if (!Array.isArray(value)) {
    const error = new Error("AVAILABILITY_INVALID");
    error.statusCode = 422;
    throw error;
  }
  const availability = value.map((range) => {
    const dayOfWeek = Number(range.day_of_week);
    const startTime = normalizeTime(range.start_time);
    const endTime = normalizeTime(range.end_time);
    if (
      !Number.isInteger(dayOfWeek) ||
      dayOfWeek < 1 ||
      dayOfWeek > 7 ||
      timeToMinutes(startTime) >= timeToMinutes(endTime)
    ) {
      const error = new Error("AVAILABILITY_INVALID");
      error.statusCode = 422;
      throw error;
    }
    return {
      day_of_week: dayOfWeek,
      start_time: startTime,
      end_time: endTime,
    };
  });
  if (!availability.length) {
    const error = new Error("AVAILABILITY_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  const ordered = [...availability].sort(
    (a, b) =>
      a.day_of_week - b.day_of_week ||
      timeToMinutes(a.start_time) - timeToMinutes(b.start_time),
  );
  if (
    ordered.some(
      (range, index) =>
        index > 0 &&
        ordered[index - 1].day_of_week === range.day_of_week &&
        timeToMinutes(ordered[index - 1].end_time) >
          timeToMinutes(range.start_time),
    )
  ) {
    const error = new Error("AVAILABILITY_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return availability;
};

const mapProfile = (row) => ({
  id: Number(row.professional_id || row.id),
  name: row.professional_name || row.name || "",
  email: row.professional_email || row.email || "",
  photo_url: row.photo_path ? `/uploads/${row.photo_path}` : "",
  license_number: row.license_number || "",
  specialty: row.specialty || "",
  bio: row.bio || "",
  phone: row.phone || "",
});

const mapAccount = (row) => ({
  id: Number(row.user_id || row.id),
  email: row.user_email || row.email,
  name: row.user_name || row.name || "",
  role: row.role,
  professional_id: Number(row.professional_id),
});

const loadProfessionalAccount = async (request) => {
  const session = readSessionFromRequest(request);
  if (!session) return null;
  const row = await one(
    `
      SELECT
        u.id AS user_id,
        u.email AS user_email,
        u.name AS user_name,
        u.role,
        u.session_version,
        u.professional_id,
        p.name AS professional_name,
        p.email AS professional_email,
        p.photo_path,
        p.license_number,
        p.specialty,
        p.bio,
        p.phone
      FROM users u
      INNER JOIN professionals p ON p.id = u.professional_id
      WHERE u.id = $1
        AND u.role = 'professional'
        AND u.is_active = TRUE
        AND p.active = TRUE
        AND p.deleted_at IS NULL
    `,
    [session.sub],
  );
  if (!row || Number(row.session_version) !== Number(session.sv)) return null;
  return {
    user: mapAccount(row),
    professional: mapProfile(row),
    session,
  };
};

const requireProfessionalAccount = async (request) => {
  const account = await loadProfessionalAccount(request);
  if (!account) {
    const error = new Error("PROFESSIONAL_ACCOUNT_REQUIRED");
    error.statusCode = 401;
    throw error;
  }
  return account;
};

const requireMutation = (request, account) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    enforceCsrf(request, account.session);
  }
};

const handleAccountLogin = async (request, response) => {
  const payload = await parseJsonBody(request);
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");
  if (!emailPattern.test(email)) {
    sendJson(response, 401, { error: "Credenciales inválidas." });
    return;
  }
  enforceLoginRateLimit(getClientIp(request), email);
  const user = await one(
    `
      SELECT
        u.id,
        u.email,
        u.name,
        u.role,
        u.password_hash,
        u.session_version,
        u.professional_id,
        u.is_active,
        p.active AS professional_active,
        p.deleted_at AS professional_deleted_at
      FROM users u
      LEFT JOIN professionals p ON p.id = u.professional_id
      WHERE lower(u.email) = lower($1)
    `,
    [email],
  );
  const valid =
    user?.role === "professional" &&
    user.is_active &&
    user.professional_id &&
    user.professional_active &&
    !user.professional_deleted_at &&
    (await verifyPassword(password, user.password_hash));
  if (!valid) {
    await recordAudit("professional.auth.login_failed", {
      detail: { email, client_ip: getClientIp(request) },
    });
    sendJson(response, 401, { error: "Credenciales inválidas." });
    return;
  }

  await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
  const { token, csrf } = createSessionToken(user);
  await recordAudit("professional.auth.login_succeeded", {
    actorUserId: user.id,
    detail: {
      professional_id: Number(user.professional_id),
      client_ip: getClientIp(request),
    },
  });
  sendJson(
    response,
    200,
    { user: mapAccount(user), csrf_token: csrf },
    { "Set-Cookie": sessionCookie(token) },
  );
};

const handleInvitationAcceptance = async (request, response) => {
  const payload = await parseJsonBody(request);
  const token = String(payload.token || "").trim();
  enforceLoginRateLimit(getClientIp(request), `invite:${token.slice(0, 16)}`);
  const accepted = await acceptProfessionalInvitation({
    token,
    password: String(payload.password || ""),
  });
  const { token: sessionToken, csrf } = createSessionToken(accepted.user);
  await recordAudit("professional.invitation.accepted", {
    actorUserId: accepted.user.id,
    detail: {
      professional_id: Number(accepted.user.professional_id),
      invitation_id: accepted.invitationId,
      client_ip: getClientIp(request),
    },
  });
  sendJson(
    response,
    200,
    {
      user: mapAccount(accepted.user),
      professional: accepted.professional,
      csrf_token: csrf,
    },
    { "Set-Cookie": sessionCookie(sessionToken) },
  );
};

const handleAccountMe = async (request, response, account) => {
  sendJson(response, 200, {
    user: account.user,
    professional: account.professional,
    csrf_token: account.session.csrf,
  });
};

const handleAccountLogout = async (response, account) => {
  await recordAudit("professional.auth.logout", {
    actorUserId: account.user.id,
    detail: { professional_id: account.user.professional_id },
  });
  sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

const handlePasswordChange = async (request, response, account) => {
  const payload = await parseJsonBody(request);
  const currentPassword = String(payload.current_password || "");
  const newPassword = String(payload.new_password || "");
  if (newPassword.length < PROFESSIONAL_PASSWORD_MIN_LENGTH) {
    sendJson(response, 422, { error: "La nueva clave debe tener al menos 8 caracteres." });
    return;
  }
  const row = await one("SELECT password_hash FROM users WHERE id = $1", [account.user.id]);
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    sendJson(response, 400, { error: "La clave actual no es correcta." });
    return;
  }
  await query(
    `
      UPDATE users
      SET password_hash = $1,
          session_version = session_version + 1,
          updated_at = NOW()
      WHERE id = $2
    `,
    [await hashPassword(newPassword), account.user.id],
  );
  await recordAudit("professional.auth.password_changed", {
    actorUserId: account.user.id,
    detail: { professional_id: account.user.professional_id },
  });
  sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

const listProfileServices = async (professionalId) => {
  const result = await query(
    `
      SELECT
        service.id,
        service.name,
        (professional_service.professional_id IS NOT NULL) AS selected
      FROM services service
      LEFT JOIN professional_services professional_service
        ON professional_service.service_id = service.id
       AND professional_service.professional_id = $1
      WHERE service.active = TRUE
        AND service.deleted_at IS NULL
      ORDER BY service.name
    `,
    [professionalId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name || "",
    selected: Boolean(row.selected),
  }));
};

const getProfile = async (response, account) => {
  sendJson(response, 200, {
    profile: account.professional,
    services: await listProfileServices(account.user.professional_id),
  });
};

const updateProfile = async (request, response, account) => {
  const { fields, files } = await parseMultipartForm(request);
  const name = String(fields.name || "").trim().slice(0, 180);
  const licenseNumber = String(fields.license_number || "").trim().slice(0, 120);
  const specialty = String(fields.specialty || "").trim().slice(0, 160);
  const bio = String(fields.bio || "").trim().slice(0, 2_000);
  const phone = String(fields.phone || "").trim().slice(0, 80);
  let serviceIds = [];
  try {
    serviceIds = [
      ...new Set(
        JSON.parse(String(fields.service_ids || "[]"))
          .map(Number)
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ];
  } catch {
    serviceIds = [];
  }
  if (!name) {
    sendJson(response, 422, { error: "El nombre visible es obligatorio." });
    return;
  }
  if (!serviceIds.length) {
    sendJson(response, 422, { error: "Seleccioná al menos una práctica." });
    return;
  }
  const validServices = await query(
    `
      SELECT id
      FROM services
      WHERE id = ANY($1::bigint[])
        AND active = TRUE
        AND deleted_at IS NULL
    `,
    [serviceIds],
  );
  if (validServices.rowCount !== serviceIds.length) {
    sendJson(response, 422, { error: "Revisá las prácticas seleccionadas." });
    return;
  }
  const photoPath = await saveProfessionalPhoto(files.photo);
  const current = await one("SELECT photo_path FROM professionals WHERE id = $1", [
    account.user.professional_id,
  ]);
  const nextPhotoPath =
    fields.remove_photo === "true" ? null : photoPath || current?.photo_path || null;
  await tx(async (client) => {
    await client.query(
      `
        UPDATE professionals
        SET name = $1,
            license_number = $2,
            specialty = $3,
            bio = $4,
            phone = $5,
            photo_path = $6,
            updated_at = NOW()
        WHERE id = $7
      `,
      [name, licenseNumber, specialty, bio, phone, nextPhotoPath, account.user.professional_id],
    );
    await client.query("UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2", [
      name,
      account.user.id,
    ]);
    await client.query(
      "DELETE FROM professional_services WHERE professional_id = $1",
      [account.user.professional_id],
    );
    for (const serviceId of serviceIds) {
      await client.query(
        `
          INSERT INTO professional_services (professional_id, service_id)
          VALUES ($1, $2)
        `,
        [account.user.professional_id, serviceId],
      );
    }
  });
  await recordAudit("professional.profile.updated", {
    actorUserId: account.user.id,
    detail: { professional_id: account.user.professional_id },
  });
  const refreshed = await loadProfessionalAccount(request);
  sendJson(response, 200, {
    profile: refreshed.professional,
    services: await listProfileServices(account.user.professional_id),
  });
};

const mapAvailability = (row) => ({
  id: Number(row.id),
  day_of_week: Number(row.day_of_week),
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
});

const listAvailability = async (response, account) => {
  const result = await query(
    `
      SELECT
        id,
        day_of_week,
        to_char(start_time, 'HH24:MI') AS start_time,
        to_char(end_time, 'HH24:MI') AS end_time
      FROM professional_availability
      WHERE professional_id = $1
      ORDER BY day_of_week, start_time
    `,
    [account.user.professional_id],
  );
  sendJson(response, 200, { availability: result.rows.map(mapAvailability) });
};

const replaceAvailability = async (request, response, account) => {
  const payload = await parseJsonBody(request);
  const availability = normalizeAvailability(payload.availability);
  await tx(async (client) => {
    await client.query("DELETE FROM professional_availability WHERE professional_id = $1", [
      account.user.professional_id,
    ]);
    for (const range of availability) {
      await client.query(
        `
          INSERT INTO professional_availability
            (professional_id, day_of_week, start_time, end_time)
          VALUES ($1, $2, $3::time, $4::time)
        `,
        [
          account.user.professional_id,
          range.day_of_week,
          range.start_time,
          range.end_time,
        ],
      );
    }
  });
  await recordAudit("professional.availability.updated", {
    actorUserId: account.user.id,
    detail: {
      professional_id: account.user.professional_id,
      ranges: availability.length,
    },
  });
  await listAvailability(response, account);
};

const mapBlock = (row) => ({
  id: Number(row.id),
  block_date: row.block_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  reason: row.reason || "",
});

const listBlocks = async (response, account) => {
  const result = await query(
    `
      SELECT
        id,
        to_char(block_date, 'YYYY-MM-DD') AS block_date,
        to_char(start_time, 'HH24:MI') AS start_time,
        to_char(end_time, 'HH24:MI') AS end_time,
        reason
      FROM schedule_blocks
      WHERE professional_id = $1
        AND block_date >= CURRENT_DATE
      ORDER BY block_date, start_time
      LIMIT 500
    `,
    [account.user.professional_id],
  );
  sendJson(response, 200, { schedule_blocks: result.rows.map(mapBlock) });
};

const createBlock = async (request, response, account) => {
  const payload = await parseJsonBody(request);
  const blockDate = normalizeDate(payload.block_date);
  const startTime = normalizeTime(payload.start_time);
  const endTime = normalizeTime(payload.end_time);
  const reason = String(payload.reason || "").trim().slice(0, 300);
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    sendJson(response, 422, { error: "La hora de fin debe ser posterior al inicio." });
    return;
  }
  const result = await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [account.user.professional_id, blockDate],
    );
    const appointment = await client.query(
      `
        SELECT id
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
      [account.user.professional_id, blockDate, startTime, endTime],
    );
    if (appointment.rows[0]) return null;
    const existingBlock = await client.query(
      `
        SELECT id
        FROM schedule_blocks
        WHERE professional_id = $1
          AND block_date = $2::date
          AND start_time < $4::time
          AND end_time > $3::time
        LIMIT 1
      `,
      [account.user.professional_id, blockDate, startTime, endTime],
    );
    if (existingBlock.rows[0]) return null;
    const inserted = await client.query(
      `
        INSERT INTO schedule_blocks
          (professional_id, block_date, start_time, end_time, reason)
        VALUES ($1, $2::date, $3::time, $4::time, $5)
        RETURNING id
      `,
      [account.user.professional_id, blockDate, startTime, endTime, reason || null],
    );
    return inserted.rows[0];
  });
  if (!result) {
    sendJson(response, 409, {
      error: "Ese bloqueo se superpone con un turno u otro bloqueo existente.",
    });
    return;
  }
  await recordAudit("professional.schedule_block.created", {
    actorUserId: account.user.id,
    detail: {
      professional_id: account.user.professional_id,
      schedule_block_id: Number(result.id),
    },
  });
  sendJson(response, 201, { ok: true, id: Number(result.id) });
};

const deleteBlock = async (response, account, id) => {
  const result = await query(
    "DELETE FROM schedule_blocks WHERE id = $1 AND professional_id = $2 RETURNING id",
    [id, account.user.professional_id],
  );
  if (!result.rows[0]) {
    sendJson(response, 404, { error: "Bloqueo no encontrado." });
    return;
  }
  await recordAudit("professional.schedule_block.deleted", {
    actorUserId: account.user.id,
    detail: {
      professional_id: account.user.professional_id,
      schedule_block_id: Number(id),
    },
  });
  sendJson(response, 200, { ok: true });
};

const listPatients = async (url, response, account) => {
  const search = String(url.searchParams.get("q") || "").trim().slice(0, 120);
  const pattern = `%${search}%`;
  const result = await query(
    `
      SELECT
        patient.id,
        patient.full_name,
        patient.email,
        patient.phone,
        next_appointment.id AS next_appointment_id,
        next_appointment.appointment_date AS next_appointment_date,
        next_appointment.start_time AS next_start_time,
        next_appointment.end_time AS next_end_time,
        next_appointment.service_name AS next_service_name,
        next_appointment.triage_url AS next_triage_url,
        next_appointment.triage_assignment_error AS next_triage_error,
        next_appointment.triage_reminder_sent_at AS next_triage_reminder_sent_at,
        next_appointment.triage_reminder_count AS next_triage_reminder_count,
        next_appointment.documents AS next_documents,
        COALESCE(next_appointment.agreement_name, latest_appointment.agreement_name, '') AS source_name,
        COALESCE(next_appointment.agreement_type, latest_appointment.agreement_type, '') AS source_type,
        COALESCE(next_appointment.payment_status, latest_appointment.payment_status, '') AS payment_status,
        COALESCE(next_appointment.amount, latest_appointment.amount, 0) AS amount,
        latest_appointment.appointment_date AS latest_appointment_date,
        latest_appointment.service_name AS latest_service_name
      FROM patients patient
      LEFT JOIN LATERAL (
        SELECT
          appointment.id,
          appointment.appointment_date,
          appointment.start_time,
          appointment.end_time,
          appointment.triage_url,
          appointment.triage_assignment_error,
          appointment.triage_reminder_sent_at,
          appointment.triage_reminder_count,
          (
            SELECT COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', document.id,
                  'kind', document.kind,
                  'original_name', document.original_name,
                  'mime_type', document.mime_type,
                  'size_bytes', document.size_bytes,
                  'external_url', document.external_url,
                  'created_at', document.created_at
                )
                ORDER BY document.created_at, document.id
              ),
              '[]'::jsonb
            )
            FROM appointment_documents document
            WHERE document.appointment_id = appointment.id
          ) AS documents,
          appointment.agreement_name_snapshot AS agreement_name,
          appointment.agreement_type_snapshot AS agreement_type,
          appointment.payment_status,
          appointment.amount,
          service.name AS service_name
        FROM appointments appointment
        INNER JOIN services service ON service.id = appointment.service_id
        WHERE appointment.professional_id = $3
          AND appointment.status = 'confirmed'
          AND appointment.appointment_date >= CURRENT_DATE
          AND (
            appointment.patient_id = patient.id
            OR (
              appointment.patient_id IS NULL
              AND lower(trim(appointment.patient_email)) = patient.email_normalized
            )
          )
        ORDER BY appointment.appointment_date, appointment.start_time
        LIMIT 1
      ) next_appointment ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          appointment.appointment_date,
          appointment.agreement_name_snapshot AS agreement_name,
          appointment.agreement_type_snapshot AS agreement_type,
          appointment.payment_status,
          appointment.amount,
          service.name AS service_name
        FROM appointments appointment
        INNER JOIN services service ON service.id = appointment.service_id
        WHERE appointment.professional_id = $3
          AND (
            appointment.patient_id = patient.id
            OR (
              appointment.patient_id IS NULL
              AND lower(trim(appointment.patient_email)) = patient.email_normalized
            )
          )
        ORDER BY appointment.appointment_date DESC, appointment.start_time DESC
        LIMIT 1
      ) latest_appointment ON TRUE
      WHERE patient.active = TRUE
        AND (
          $1 = ''
          OR patient.full_name ILIKE $2
          OR patient.email ILIKE $2
          OR patient.phone ILIKE $2
        )
      ORDER BY (next_appointment.appointment_date IS NULL), next_appointment.appointment_date, patient.full_name, patient.email
      LIMIT 250
    `,
    [search, pattern, account.user.professional_id],
  );
  await recordAudit("professional.patients.viewed", {
    actorUserId: account.user.id,
    detail: {
      professional_id: account.user.professional_id,
      result_count: result.rowCount,
      filtered: Boolean(search),
    },
  });
  sendJson(response, 200, {
    patients: result.rows.map((row) => ({
      id: Number(row.id),
      name: row.full_name || "",
      email: row.email || "",
      phone: row.phone || "",
      next_appointment: row.next_appointment_date
        ? {
            id: Number(row.next_appointment_id),
            date: row.next_appointment_date,
            start_time: String(row.next_start_time || "").slice(0, 5),
            end_time: String(row.next_end_time || "").slice(0, 5),
            service_name: row.next_service_name || "",
            triage_reminder_sent_at: row.next_triage_reminder_sent_at || null,
            triage_reminder_count: Number(row.next_triage_reminder_count || 0),
            documents: (row.next_documents || []).map(mapAppointmentDocument),
          }
        : null,
      practice: row.next_service_name || row.latest_service_name || "",
      triage_status: row.next_triage_url
        ? "assigned"
        : row.next_triage_error
          ? "failed"
          : row.next_appointment_date
            ? "pending"
            : "not_applicable",
      source: {
        type: row.source_type || "",
        name: row.source_name || "",
      },
      payment: {
        status: row.payment_status || "",
        amount: Number(row.amount || 0),
      },
      latest_appointment_date: row.latest_appointment_date || null,
    })),
  });
};

const mapAppointment = (row) => ({
  id: Number(row.id),
  date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  service_name: row.service_name || "",
  patient_name: row.patient_name || "",
  patient_email: row.patient_email || "",
  patient_phone: row.patient_phone || "",
  payment_status: row.payment_status || "",
  status: row.status || "",
  cancelled_at: row.cancelled_at || null,
  cancellation_reason: row.cancellation_reason || "",
  refund_status: row.refund_status || "not_required",
  google_meet_url: row.google_meet_url || "",
  google_calendar_event_url: row.google_calendar_event_url || "",
  google_sync_status: row.google_sync_status || "not_connected",
  google_sync_error: row.google_sync_error || "",
  triage_status: row.triage_url
    ? "assigned"
    : row.triage_assignment_error
      ? "failed"
      : "pending",
  triage_reminder_sent_at: row.triage_reminder_sent_at || null,
  triage_reminder_count: Number(row.triage_reminder_count || 0),
});

const listProfessionalAppointments = async (
  response,
  professionalId,
  { professional = null, expiresAt = null, upcomingOnly = false } = {},
) => {
  const result = await query(
    `
      SELECT
        a.id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_name,
        a.patient_email,
        a.patient_phone,
        a.payment_status,
        a.status,
        a.cancelled_at,
        a.cancellation_reason,
        a.refund_status,
        a.google_meet_url,
        a.google_calendar_event_url,
        a.google_sync_status,
        a.google_sync_error,
        a.triage_url,
        a.triage_assignment_error,
        a.triage_reminder_sent_at,
        a.triage_reminder_count,
        s.name AS service_name
      FROM appointments a
      INNER JOIN services s ON s.id = a.service_id
      WHERE a.professional_id = $1
        AND ($2::boolean = FALSE OR a.appointment_date >= CURRENT_DATE)
        AND a.status IN ('confirmed', 'pending_payment', 'cancelled')
      ORDER BY a.appointment_date DESC, a.start_time DESC
      LIMIT 500
    `,
    [professionalId, upcomingOnly],
  );

  sendJson(response, 200, {
    ...(professional ? { professional } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    appointments: result.rows.map(mapAppointment),
  });
};

const cancelAppointment = async (request, response, account, appointmentId) => {
  const payload = await parseJsonBody(request);
  const reason = String(payload.reason || "").trim().slice(0, 500);
  if (!reason) {
    sendJson(response, 422, { error: "Indicá el motivo de la cancelación." });
    return;
  }

  const appointment = await tx(async (client) => {
    const result = await client.query(
      `
        SELECT *, appointment_date < CURRENT_DATE AS is_past
        FROM appointments
        WHERE id = $1
          AND professional_id = $2
        FOR UPDATE
      `,
      [appointmentId, account.user.professional_id],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.status === "cancelled") return row;
    if (row.status !== "confirmed") {
      const error = new Error("APPOINTMENT_NOT_CANCELLABLE");
      error.statusCode = 409;
      throw error;
    }
    if (row.is_past) {
      const error = new Error("APPOINTMENT_NOT_CANCELLABLE");
      error.statusCode = 409;
      throw error;
    }
    const paidWithMercadoPago =
      row.payment_status === "approved" && row.payment_provider === "mercadopago";
    const refundStatus = paidWithMercadoPago ? "pending" : "not_required";
    const updated = await client.query(
      `
        UPDATE appointments
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancelled_by_user_id = $2,
            cancellation_reason = $3,
            refund_status = $4,
            refund_error = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [appointmentId, account.user.id, reason, refundStatus],
    );
    return updated.rows[0];
  });

  if (!appointment) {
    sendJson(response, 404, { error: "Turno no encontrado." });
    return;
  }

  let refundStatus = appointment.refund_status || "not_required";
  let refundError = appointment.refund_error || "";
  if (["pending", "failed"].includes(refundStatus)) {
    if (!appointment.payment_id) {
      refundStatus = "failed";
      refundError = "El pago aprobado no tiene un identificador para reembolsar.";
      await query(
        `
          UPDATE appointments
          SET refund_status = 'failed',
              refund_error = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [appointment.id, refundError],
      );
    } else {
      try {
        const refund = await createMercadoPagoFullRefund({
          appointmentId: appointment.id,
          paymentId: appointment.payment_id,
        });
        refundStatus = "approved";
        refundError = "";
        await query(
          `
            UPDATE appointments
            SET refund_status = 'approved',
                refund_id = $2,
                refund_amount = $3,
                refund_error = NULL,
                payment_status = 'refunded',
                updated_at = NOW()
            WHERE id = $1
          `,
          [appointment.id, refund.id || null, refund.amount || Number(appointment.amount || 0)],
        );
      } catch (error) {
        refundStatus = "failed";
        refundError = String(error.message || "No se pudo solicitar el reembolso.").slice(0, 500);
        await query(
          `
            UPDATE appointments
            SET refund_status = 'failed',
                refund_error = $2,
                updated_at = NOW()
            WHERE id = $1
          `,
          [appointment.id, refundError],
        );
      }
    }
  }

  const googleCancellation = await cancelGoogleCalendarAppointment(appointment.id);
  const notification = await notifyPatientForCancellation(appointment.id);
  await recordAudit("professional.appointment.cancelled", {
    actorUserId: account.user.id,
    detail: {
      appointment_id: Number(appointment.id),
      professional_id: account.user.professional_id,
      refund_status: refundStatus,
      patient_notified: Boolean(notification.ok),
      google_calendar_cancelled:
        googleCancellation.reason === "not_synced" || Boolean(googleCancellation.ok),
    },
  });
  sendJson(response, 200, {
    ok: true,
    appointment: {
      id: Number(appointment.id),
      status: "cancelled",
      refund_status: refundStatus,
      refund_error: refundError,
    },
    notification,
    google_calendar: googleCancellation,
  });
};

const sendTriageReminder = async (response, account, appointmentId) => {
  const result = await notifyPatientTriageReminder(
    appointmentId,
    account.user.professional_id,
    { actorUserId: account.user.id },
  );
  sendJson(response, 200, {
    ok: true,
    message: `Recordatorio enviado a ${result.email}.`,
    triage_reminder_sent_at: result.sent_at,
    triage_reminder_count: result.count,
  });
};

export const handleProfessionalApi = async (request, response, url) => {
  const pathname = url.pathname;

  try {
    if (
      pathname === "/api/professional/invitations/accept" &&
      request.method === "POST"
    ) {
      await handleInvitationAcceptance(request, response);
      return true;
    }
    if (pathname === "/api/professional/auth/login" && request.method === "POST") {
      await handleAccountLogin(request, response);
      return true;
    }

    if (pathname === "/api/professional/session" && request.method === "POST") {
      const payload = await parseJsonBody(request);
      const session = await exchangeProfessionalAccessLink(
        String(payload.token || "").trim(),
      );
      sendJson(
        response,
        200,
        {
          ok: true,
          professional: session.professional,
          expires_at: session.expires_at,
        },
        { "Set-Cookie": professionalSessionCookie(session.token) },
      );
      return true;
    }

    if (
      pathname === "/api/professional/integrations/google/callback" &&
      request.method === "GET"
    ) {
      if (url.searchParams.get("error")) {
        sendRedirect(response, "/profesional/?google=cancelled");
        return true;
      }
      try {
        await finishGoogleOAuth({
          state: String(url.searchParams.get("state") || ""),
          code: String(url.searchParams.get("code") || ""),
        });
        sendRedirect(response, "/profesional/?google=connected");
      } catch (error) {
        await recordAudit("professional.google.connection_failed", {
          detail: { error: String(error.message || "GOOGLE_OAUTH_FAILED").slice(0, 120) },
        });
        sendRedirect(
          response,
          error.message === "GOOGLE_ACCOUNT_CHANGE_BLOCKED"
            ? "/profesional/?google=account_change_blocked"
            : "/profesional/?google=error",
        );
      }
      return true;
    }

    let account = await loadProfessionalAccount(request);
    if (
      pathname === "/api/professional/appointments" &&
      request.method === "GET" &&
      !account
    ) {
      const legacy = await requireProfessionalSession(request);
      await listProfessionalAppointments(response, legacy.professional_id, {
        professional: legacy.professional,
        expiresAt: legacy.expires_at,
        upcomingOnly: true,
      });
      return true;
    }

    account ||= await requireProfessionalAccount(request);
    requireMutation(request, account);

    if (pathname === "/api/professional/auth/me" && request.method === "GET") {
      await handleAccountMe(request, response, account);
      return true;
    }
    if (pathname === "/api/professional/auth/logout" && request.method === "POST") {
      await handleAccountLogout(response, account);
      return true;
    }
    if (
      pathname === "/api/professional/auth/change-password" &&
      request.method === "POST"
    ) {
      await handlePasswordChange(request, response, account);
      return true;
    }
    if (pathname === "/api/professional/profile" && request.method === "GET") {
      await getProfile(response, account);
      return true;
    }
    if (
      pathname === "/api/professional/integrations/google" &&
      request.method === "GET"
    ) {
      sendJson(response, 200, {
        google: await getGoogleConnectionStatus(account.user.professional_id),
      });
      return true;
    }
    if (
      pathname === "/api/professional/integrations/google/connect" &&
      request.method === "POST"
    ) {
      const authorizationUrl = await createGoogleOAuthAuthorization(
        account.user.professional_id,
      );
      await recordAudit("professional.google.connection_started", {
        actorUserId: account.user.id,
        detail: { professional_id: account.user.professional_id },
      });
      sendJson(response, 200, { authorization_url: authorizationUrl });
      return true;
    }
    if (
      pathname === "/api/professional/integrations/google/disconnect" &&
      request.method === "POST"
    ) {
      await disconnectGoogleCalendar(account.user.professional_id);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (pathname === "/api/professional/profile" && request.method === "PUT") {
      await updateProfile(request, response, account);
      return true;
    }
    if (pathname === "/api/professional/availability" && request.method === "GET") {
      await listAvailability(response, account);
      return true;
    }
    if (pathname === "/api/professional/availability" && request.method === "PUT") {
      await replaceAvailability(request, response, account);
      return true;
    }
    if (pathname === "/api/professional/blocks" && request.method === "GET") {
      await listBlocks(response, account);
      return true;
    }
    if (pathname === "/api/professional/blocks" && request.method === "POST") {
      await createBlock(request, response, account);
      return true;
    }
    const blockMatch = pathname.match(/^\/api\/professional\/blocks\/(\d+)$/);
    if (blockMatch && request.method === "DELETE") {
      await deleteBlock(response, account, Number(blockMatch[1]));
      return true;
    }
    if (pathname === "/api/professional/patients" && request.method === "GET") {
      await listPatients(url, response, account);
      return true;
    }
    if (pathname === "/api/professional/appointments" && request.method === "GET") {
      await listProfessionalAppointments(response, account.user.professional_id);
      return true;
    }
    const appointmentDocumentMatch = pathname.match(
      /^\/api\/professional\/appointment-documents\/(\d+)$/,
    );
    if (
      appointmentDocumentMatch &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      await streamProfessionalAppointmentDocument(
        request,
        response,
        Number(appointmentDocumentMatch[1]),
        account,
      );
      return true;
    }
    const appointmentCancelMatch = pathname.match(
      /^\/api\/professional\/appointments\/(\d+)\/cancel$/,
    );
    if (appointmentCancelMatch && request.method === "POST") {
      await cancelAppointment(
        request,
        response,
        account,
        Number(appointmentCancelMatch[1]),
      );
      return true;
    }
    const appointmentTriageReminderMatch = pathname.match(
      /^\/api\/professional\/appointments\/(\d+)\/triage-reminder$/,
    );
    if (appointmentTriageReminderMatch && request.method === "POST") {
      await sendTriageReminder(
        response,
        account,
        Number(appointmentTriageReminderMatch[1]),
      );
      return true;
    }

    return false;
  } catch (error) {
    if (error.message === "PROFESSIONAL_LINK_INVALID") {
      sendJson(response, 401, { error: "El link de turnos expiró o no es válido." });
      return true;
    }
    if (error.message === "PROFESSIONAL_SESSION_INVALID") {
      sendJson(response, 401, {
        error: "La sesión expiró. Abrí nuevamente el link recibido por mail.",
      });
      return true;
    }
    if (error.message === "PROFESSIONAL_ACCOUNT_REQUIRED") {
      sendJson(response, 401, { error: "Iniciá sesión como profesional." });
      return true;
    }
    if (error.message === "PROFESSIONAL_INVITATION_INVALID") {
      sendJson(response, 401, {
        error: "La invitación venció, ya fue usada o no es válida. Pedí que te envíen una nueva.",
      });
      return true;
    }
    if (error.message === "PROFESSIONAL_PASSWORD_REQUIRED") {
      sendJson(response, 422, { error: "Creá una clave de al menos 8 caracteres." });
      return true;
    }
    if (error.message === "PROFESSIONAL_PASSWORD_INVALID") {
      sendJson(response, 422, { error: "La clave debe tener al menos 8 caracteres." });
      return true;
    }
    if (error.message === "RATE_LIMITED") {
      sendJson(response, 429, { error: "Demasiados intentos. Esperá unos minutos." });
      return true;
    }
    if (
      [
        "TIME_INVALID",
        "DATE_INVALID",
        "AVAILABILITY_INVALID",
        "AVAILABILITY_REQUIRED",
      ].includes(error.message)
    ) {
      sendJson(response, 422, { error: "Revisá los días y horarios cargados." });
      return true;
    }
    if (error.message === "CSRF_REQUIRED") {
      sendJson(response, 403, { error: "La sesión no pudo validar la operación." });
      return true;
    }
    if (error.message === "APPOINTMENT_NOT_CANCELLABLE") {
      sendJson(response, 409, { error: "Ese turno ya no se puede cancelar." });
      return true;
    }
    if (error.message === "TRIAGE_REMINDER_NOT_FOUND") {
      sendJson(response, 404, { error: "No encontramos ese turno." });
      return true;
    }
    if (error.message === "TRIAGE_REMINDER_NOT_AVAILABLE") {
      sendJson(response, 409, {
        error: "El recordatorio sólo está disponible para turnos futuros con cuestionario asignado.",
      });
      return true;
    }
    if (error.message === "TRIAGE_REMINDER_RATE_LIMITED") {
      sendJson(response, 429, {
        error: "El recordatorio ya fue solicitado. Esperá unos minutos antes de reenviarlo.",
      });
      return true;
    }
    if (
      ["EMAIL_SEND_FAILED", "EMAIL_CONFIGURATION_MISSING"].includes(error.message)
    ) {
      sendJson(response, 502, {
        error: "No se pudo enviar el recordatorio. Probá nuevamente en unos minutos.",
      });
      return true;
    }
    if (error.message === "GOOGLE_NOT_CONFIGURED") {
      sendJson(response, 503, {
        error: "La conexión con Google todavía no está habilitada por Reku.",
      });
      return true;
    }
    if (error.message === "GOOGLE_DISCONNECT_BLOCKED") {
      sendJson(response, 409, {
        error:
          "No podés desconectar Google mientras haya turnos futuros sincronizados.",
      });
      return true;
    }
    if (error.message === "PAYLOAD_TOO_LARGE") {
      sendJson(response, 413, { error: "La imagen supera el tamaño permitido." });
      return true;
    }
    if (error.message === "INVALID_IMAGE") {
      sendJson(response, 415, { error: "La foto debe ser una imagen válida." });
      return true;
    }
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode === 401 ? "No autenticado." : "Error inesperado.",
    });
    return true;
  }
};
