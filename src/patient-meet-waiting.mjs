import { config } from "./config.mjs";
import { one, query, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { getGoogleMeetConferenceStatus } from "./google-calendar.mjs";
import { escapeHtml } from "./http.mjs";
import { createProfessionalAccessLink } from "./professional-links.mjs";
import { sendPushToProfessional } from "./web-push.mjs";

const formatDate = (value) => {
  const [year, month, day] = String(value || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value || "");
};

const timestamp = (value) => {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
};

export const patientMeetTimeAccess = (
  appointment,
  {
    now = Date.now(),
    earlyMinutes = config.patientMeetEarlyMinutes,
    lateMinutes = config.patientMeetLateMinutes,
  } = {},
) => {
  const startsAt = timestamp(appointment.starts_at);
  const endsAt = timestamp(appointment.ends_at);
  const hasValidSchedule = Number.isFinite(startsAt) && Number.isFinite(endsAt);
  const availableFrom = hasValidSchedule
    ? startsAt - earlyMinutes * 60_000
    : Number.NaN;
  const availableUntil = hasValidSchedule
    ? endsAt + lateMinutes * 60_000
    : Number.NaN;
  let state = "not_configured";

  if (appointment.status !== "confirmed") state = "unavailable";
  else if (!appointment.google_meet_url) state = "not_configured";
  else if (!hasValidSchedule) state = "unavailable";
  else if (now < availableFrom) state = "upcoming";
  else if (now <= availableUntil) state = "available";
  else state = "finished";

  return {
    available: state === "available",
    state,
    starts_at: Number.isFinite(startsAt) ? new Date(startsAt).toISOString() : null,
    ends_at: Number.isFinite(endsAt) ? new Date(endsAt).toISOString() : null,
    available_from: Number.isFinite(availableFrom)
      ? new Date(availableFrom).toISOString()
      : null,
    available_until: Number.isFinite(availableUntil)
      ? new Date(availableUntil).toISOString()
      : null,
    early_minutes: earlyMinutes,
    late_minutes: lateMinutes,
    time_zone: config.googleCalendarTimeZone,
  };
};

export const patientMeetWaitingState = (
  appointment,
  presence,
  options = {},
) => {
  const now = options.now ?? Date.now();
  const access = patientMeetTimeAccess(appointment, { ...options, now });
  if (!access.available) {
    return {
      ...access,
      can_enter: false,
      refresh_after_seconds: access.state === "upcoming" ? 10 : null,
    };
  }
  if (!presence?.checked) {
    return {
      ...access,
      state: "checking",
      can_enter: false,
      presence_reason: presence?.reason || "unavailable",
      refresh_after_seconds: 10,
    };
  }
  if (presence.active) {
    return {
      ...access,
      state: "ready",
      can_enter: true,
      refresh_after_seconds: null,
    };
  }
  return {
    ...access,
    state:
      now < timestamp(appointment.starts_at)
        ? "waiting_early"
        : "waiting_professional",
    can_enter: false,
    refresh_after_seconds: 10,
  };
};

const waitingAppointmentSelect = `
  a.id,
  a.professional_id,
  to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
  to_char(a.start_time, 'HH24:MI') AS start_time,
  to_char(a.end_time, 'HH24:MI') AS end_time,
  a.patient_name,
  a.patient_email,
  a.patient_phone,
  COALESCE(NULLIF(agreement.name, ''), NULLIF(a.agreement_name_snapshot, ''), '') AS agreement_name,
  professional.name AS professional_name,
  professional.email AS professional_email,
  COALESCE(professional.phone, '') AS professional_phone,
  service.name AS service_name
`;

const claimProfessionalWaitingNotification = async (appointmentId) => {
  const result = await query(
    `
      WITH claimed AS (
        UPDATE appointments
        SET patient_waiting_professional_attempted_at = NOW(),
            patient_waiting_professional_notified_at = NOW(),
            patient_waiting_professional_error = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND status = 'confirmed'
          AND patient_waiting_professional_notified_at IS NULL
          AND (
            patient_waiting_professional_attempted_at IS NULL
            OR patient_waiting_professional_attempted_at <= NOW() - INTERVAL '1 minute'
          )
          AND ((appointment_date + start_time) AT TIME ZONE $2) <= NOW()
          AND EXISTS (
            SELECT 1
            FROM professionals eligible_professional
            WHERE eligible_professional.id = appointments.professional_id
              AND eligible_professional.active = TRUE
              AND eligible_professional.deleted_at IS NULL
              AND NULLIF(eligible_professional.email, '') IS NOT NULL
          )
        RETURNING *
      )
      SELECT ${waitingAppointmentSelect}
      FROM claimed a
      INNER JOIN professionals professional ON professional.id = a.professional_id
      INNER JOIN services service ON service.id = a.service_id
      LEFT JOIN agreements agreement ON agreement.id = a.agreement_id
      WHERE professional.active = TRUE
        AND professional.deleted_at IS NULL
        AND NULLIF(professional.email, '') IS NOT NULL
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );
  return result.rows[0] || null;
};

const clearProfessionalWaitingNotification = (appointmentId, errorMessage) =>
  query(
    `
      UPDATE appointments
      SET patient_waiting_professional_notified_at = NULL,
          patient_waiting_professional_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo avisar al profesional.").slice(0, 500)],
  );

const professionalWaitingText = ({ appointment, link }) =>
  [
    "Tu paciente ya está esperando para la videollamada",
    "",
    `Paciente: ${appointment.patient_name}`,
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    appointment.agreement_name ? `Acuerdo: ${appointment.agreement_name}` : "",
    "",
    "Google Meet todavía no registra una videollamada activa. Abrí la sala profesional para revisar la ficha y comenzar la consulta.",
    `Abrir sala profesional: ${link.url}`,
  ]
    .filter(Boolean)
    .join("\n");

const professionalWaitingHtml = ({ appointment, link }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Tu paciente ya está esperando</h1>
    <p>Google Meet todavía no registra una videollamada activa. Abrí la sala profesional para revisar la ficha y comenzar la consulta.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Paciente</strong></td><td>${escapeHtml(appointment.patient_name)}</td></tr>
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      ${appointment.agreement_name ? `<tr><td><strong>Acuerdo</strong></td><td>${escapeHtml(appointment.agreement_name)}</td></tr>` : ""}
    </table>
    <p style="margin-top:20px"><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">Abrir sala profesional</a></p>
  </div>
`;

export const notifyProfessionalPatientWaiting = async (appointmentId) => {
  const appointment = await claimProfessionalWaitingNotification(appointmentId);
  if (!appointment) return { ok: true, skipped: true };
  try {
    const link = await createProfessionalAccessLink({
      professionalId: appointment.professional_id,
      appointmentId: appointment.id,
    });
    const result = await sendEmail({
      formName: "paciente-esperando-profesional",
      to: appointment.professional_email,
      replyTo: appointment.patient_email || undefined,
      subject: `Paciente esperando - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: professionalWaitingText({ appointment, link }),
      html: professionalWaitingHtml({ appointment, link }),
    });
    await query(
      `
        UPDATE appointments
        SET patient_waiting_professional_message_id = $2,
            patient_waiting_professional_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    try {
      await recordAudit("appointment.patient_waiting_professional_notified", {
        detail: {
          appointment_id: Number(appointment.id),
          professional_id: Number(appointment.professional_id),
          message_id: result?.id || "",
        },
      });
    } catch {
      // El mail ya fue enviado y persistido; una falla de auditoría no debe duplicarlo.
    }
    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearProfessionalWaitingNotification(appointment.id, error.message);
    try {
      await recordAudit("appointment.patient_waiting_professional_notification_failed", {
        detail: {
          appointment_id: Number(appointment.id),
          professional_id: Number(appointment.professional_id),
          error: error.message,
        },
      });
    } catch {
      // La falla original se conserva aunque la auditoría no esté disponible.
    }
    return { ok: false, error: error.message };
  }
};

const claimProfessionalWaitingPush = async (appointmentId) => {
  const result = await query(
    `
      WITH claimed AS (
        UPDATE appointments
        SET patient_waiting_professional_push_attempted_at = NOW(),
            patient_waiting_professional_push_notified_at = NOW(),
            patient_waiting_professional_push_error = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND status = 'confirmed'
          AND patient_waiting_professional_push_notified_at IS NULL
          AND (
            patient_waiting_professional_push_attempted_at IS NULL
            OR patient_waiting_professional_push_attempted_at <= NOW() - INTERVAL '1 minute'
          )
          AND ((appointment_date + start_time) AT TIME ZONE $2) <= NOW()
        RETURNING *
      )
      SELECT ${waitingAppointmentSelect}
      FROM claimed a
      INNER JOIN professionals professional ON professional.id = a.professional_id
      INNER JOIN services service ON service.id = a.service_id
      LEFT JOIN agreements agreement ON agreement.id = a.agreement_id
      WHERE professional.active = TRUE
        AND professional.deleted_at IS NULL
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );
  return result.rows[0] || null;
};

const clearProfessionalWaitingPush = (appointmentId, errorMessage) =>
  query(
    `
      UPDATE appointments
      SET patient_waiting_professional_push_notified_at = NULL,
          patient_waiting_professional_push_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo enviar la push.").slice(0, 500)],
  );

export const notifyProfessionalPatientWaitingPush = async (appointmentId) => {
  const appointment = await claimProfessionalWaitingPush(appointmentId);
  if (!appointment) return { ok: true, skipped: true };
  const result = await sendPushToProfessional(
    appointment.professional_id,
    {
      title: "Tu paciente ya está esperando",
      body: `Hay un paciente esperando para el turno de ${appointment.start_time}. Tocá para ver sus datos e ingresar a Meet.`,
      url: `/profesional/?module=appointments&appointment=${appointment.id}&room=1&waiting=1`,
      tag: `reku-patient-waiting-${appointment.id}`,
    },
    { eventType: "appointment.patient_waiting_professional_push_sent" },
  );
  if (!result.delivered) {
    await clearProfessionalWaitingPush(
      appointment.id,
      result.configured
        ? "No hay dispositivos activos o la notificación no pudo entregarse."
        : "Web Push no está configurado.",
    );
    return { ok: false, skipped: result.attempted === 0, ...result };
  }
  return { ok: true, skipped: false, ...result };
};

const claimRekuWaitingEscalation = async (appointmentId) => {
  const result = await query(
    `
      WITH claimed AS (
        UPDATE appointments
        SET patient_waiting_escalation_attempted_at = NOW(),
            patient_waiting_escalated_at = NOW(),
            patient_waiting_escalation_error = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND status = 'confirmed'
          AND patient_waiting_started_at IS NOT NULL
          AND patient_waiting_escalated_at IS NULL
          AND (
            patient_waiting_escalation_attempted_at IS NULL
            OR patient_waiting_escalation_attempted_at <= NOW() - INTERVAL '5 minutes'
          )
          AND patient_waiting_last_seen_at >= NOW() - INTERVAL '1 minute'
          AND GREATEST(
            patient_waiting_started_at,
            ((appointment_date + start_time) AT TIME ZONE $2)
          ) + INTERVAL '5 minutes' <= NOW()
        RETURNING *
      )
      SELECT ${waitingAppointmentSelect}
      FROM claimed a
      INNER JOIN professionals professional ON professional.id = a.professional_id
      INNER JOIN services service ON service.id = a.service_id
      LEFT JOIN agreements agreement ON agreement.id = a.agreement_id
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );
  return result.rows[0] || null;
};

const clearRekuWaitingEscalation = (appointmentId, errorMessage) =>
  query(
    `
      UPDATE appointments
      SET patient_waiting_escalated_at = NULL,
          patient_waiting_escalation_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo escalar la espera.").slice(0, 500)],
  );

const rekuWaitingText = (appointment) =>
  [
    "Un paciente sigue esperando y la videollamada no comenzó",
    "",
    `Paciente: ${appointment.patient_name}`,
    `Mail del paciente: ${appointment.patient_email || "-"}`,
    `Teléfono del paciente: ${appointment.patient_phone || "-"}`,
    `Profesional: ${appointment.professional_name}`,
    `Mail del profesional: ${appointment.professional_email || "-"}`,
    `Teléfono del profesional: ${appointment.professional_phone || "-"}`,
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Acuerdo: ${appointment.agreement_name || "Sin acuerdo"}`,
    "",
    "El paciente está activo en la sala de espera de Reku y Google Meet todavía no registra una videollamada activa.",
  ].join("\n");

const rekuWaitingHtml = (appointment) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Paciente esperando: el profesional todavía no ingresó</h1>
    <p>El paciente está activo en la sala de espera de Reku y Google Meet todavía no registra una videollamada activa.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Paciente</strong></td><td>${escapeHtml(appointment.patient_name)}</td></tr>
      <tr><td><strong>Mail del paciente</strong></td><td>${escapeHtml(appointment.patient_email || "-")}</td></tr>
      <tr><td><strong>Teléfono del paciente</strong></td><td>${escapeHtml(appointment.patient_phone || "-")}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
      <tr><td><strong>Mail del profesional</strong></td><td>${escapeHtml(appointment.professional_email || "-")}</td></tr>
      <tr><td><strong>Teléfono del profesional</strong></td><td>${escapeHtml(appointment.professional_phone || "-")}</td></tr>
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Acuerdo</strong></td><td>${escapeHtml(appointment.agreement_name || "Sin acuerdo")}</td></tr>
    </table>
  </div>
`;

export const notifyRekuPatientStillWaiting = async (appointmentId) => {
  const appointment = await claimRekuWaitingEscalation(appointmentId);
  if (!appointment) return { ok: true, skipped: true };
  try {
    const result = await sendEmail({
      formName: "paciente-esperando-escalacion",
      to: config.patientIntakeToEmail,
      replyTo: appointment.patient_email || undefined,
      subject: `Alerta: paciente esperando - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: rekuWaitingText(appointment),
      html: rekuWaitingHtml(appointment),
    });
    await query(
      `
        UPDATE appointments
        SET patient_waiting_escalation_message_id = $2,
            patient_waiting_escalation_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    try {
      await recordAudit("appointment.patient_waiting_escalated", {
        detail: {
          appointment_id: Number(appointment.id),
          professional_id: Number(appointment.professional_id),
          message_id: result?.id || "",
        },
      });
    } catch {
      // El mail ya fue enviado y persistido; una falla de auditoría no debe duplicarlo.
    }
    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearRekuWaitingEscalation(appointment.id, error.message);
    try {
      await recordAudit("appointment.patient_waiting_escalation_failed", {
        detail: {
          appointment_id: Number(appointment.id),
          professional_id: Number(appointment.professional_id),
          error: error.message,
        },
      });
    } catch {
      // La falla original se conserva aunque la auditoría no esté disponible.
    }
    return { ok: false, error: error.message };
  }
};

const touchPatientWaitingRoom = (appointmentId) =>
  query(
    `
      UPDATE appointments
      SET patient_waiting_started_at = COALESCE(patient_waiting_started_at, NOW()),
          patient_waiting_last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND status = 'confirmed'
    `,
    [appointmentId],
  );

const loadWaitingNotificationStatus = (appointmentId) =>
  one(
    `
      SELECT
        patient_waiting_started_at,
        patient_waiting_last_seen_at,
        patient_waiting_professional_notified_at,
        patient_waiting_professional_push_notified_at,
        patient_waiting_escalated_at
      FROM appointments
      WHERE id = $1
    `,
    [appointmentId],
  );

export const getPatientMeetWaitingRoomStatus = async ({
  appointment,
  now = Date.now(),
  presenceCheck = getGoogleMeetConferenceStatus,
}) => {
  const timeAccess = patientMeetTimeAccess(appointment, { now });
  let presence = { checked: false, active: false, reason: "outside_window" };
  if (timeAccess.available) {
    presence = await presenceCheck({
      professionalId: appointment.professional_id,
      meetUrl: appointment.google_meet_url,
    });
  }
  const waiting = patientMeetWaitingState(appointment, presence, { now });

  if (["waiting_early", "waiting_professional"].includes(waiting.state)) {
    await touchPatientWaitingRoom(appointment.id);
  }
  if (waiting.state === "waiting_professional") {
    await Promise.all([
      notifyProfessionalPatientWaiting(appointment.id),
      notifyProfessionalPatientWaitingPush(appointment.id),
    ]);
    await notifyRekuPatientStillWaiting(appointment.id);
  }

  const notification = await loadWaitingNotificationStatus(appointment.id);
  return {
    ...waiting,
    professional_notified: Boolean(
      notification?.patient_waiting_professional_notified_at,
    ),
    professional_push_notified: Boolean(
      notification?.patient_waiting_professional_push_notified_at,
    ),
    reku_notified: Boolean(notification?.patient_waiting_escalated_at),
  };
};
