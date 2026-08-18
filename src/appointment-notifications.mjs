import { createProfessionalAccessLink } from "./professional-links.mjs";
import { query, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { escapeHtml } from "./http.mjs";
import { syncAppointmentToGoogleCalendar } from "./google-calendar.mjs";
import { config } from "./config.mjs";
import { ensureAppointmentTriage } from "./appointment-triage.mjs";
import { isReHubConfigured } from "./rehub.mjs";

const formatDate = (value) => {
  const [year, month, day] = String(value || "").split("-");
  if (!year || !month || !day) return String(value || "");
  return `${day}/${month}/${year}`;
};

const appointmentText = ({ appointment, link }) =>
  [
    "Nuevo turno confirmado en Reku",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Paciente: ${appointment.patient_name}`,
    `Teléfono: ${appointment.patient_phone || "-"}`,
    `Mail: ${appointment.patient_email || "-"}`,
    appointment.google_meet_url
      ? `Videollamada: ${appointment.google_meet_url}`
      : "",
    "",
    `Ver próximos turnos: ${link.url}`,
  ].join("\n");

const appointmentHtml = ({ appointment, link }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Nuevo turno confirmado</h1>
    <p>Se confirmó un nuevo turno en Reku.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Paciente</strong></td><td>${escapeHtml(appointment.patient_name)}</td></tr>
      <tr><td><strong>Teléfono</strong></td><td>${escapeHtml(appointment.patient_phone || "-")}</td></tr>
      <tr><td><strong>Mail</strong></td><td>${escapeHtml(appointment.patient_email || "-")}</td></tr>
    </table>
    ${
      appointment.google_meet_url
        ? `<p style="margin-top:20px"><a href="${escapeHtml(appointment.google_meet_url)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">Entrar a Google Meet</a></p>`
        : ""
    }
    <p style="margin-top:20px">
      <a href="${escapeHtml(link.url)}" style="display:inline-block;background:#18213f;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">
        Ver próximos turnos
      </a>
    </p>
    <p style="color:#64738a;font-size:13px">Este link permite ver tus turnos confirmados hacia adelante.</p>
  </div>
`;

export const patientConfirmationText = ({ appointment }) =>
  [
    "Tu turno en Reku quedó confirmado",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Profesional: ${appointment.professional_name}`,
    appointment.google_meet_url
      ? `Videollamada: ${appointment.google_meet_url}`
      : "",
    ...(appointment.triage_url
      ? [
          "",
          "Antes de la consulta, completá este breve cuestionario para que el equipo pueda preparar mejor tu atención:",
          appointment.triage_url,
        ]
      : []),
    "",
    "Te esperamos.",
  ].join("\n");

export const patientConfirmationHtml = ({ appointment }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Tu turno quedó confirmado</h1>
    <p>Confirmamos tu reserva en Reku.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
    </table>
    ${
      appointment.google_meet_url
        ? `<p style="margin-top:20px"><a href="${escapeHtml(appointment.google_meet_url)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">Entrar a Google Meet</a></p>`
        : ""
    }
    ${
      appointment.triage_url
        ? `
          <div style="margin-top:24px;padding:18px;border-radius:12px;background:#f4f1ff">
            <h2 style="font-size:18px;margin:0 0 8px">Cuestionario previo</h2>
            <p style="margin:0 0 14px">Completalo antes de la consulta para que el equipo pueda preparar mejor tu atención.</p>
            <a href="${escapeHtml(appointment.triage_url)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">Completar cuestionario</a>
          </div>
        `
        : ""
    }
    <p style="color:#64738a;font-size:13px">Este mail confirma que el turno fue reservado correctamente.</p>
  </div>
`;

export const patientFollowupText = ({ appointment }) =>
  [
    "Recordatorio de tu turno en Reku",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Profesional: ${appointment.professional_name}`,
    ...(appointment.triage_url
      ? [
          "",
          "Si todavía no completaste el cuestionario previo, es importante que lo hagas antes de la consulta con tu fisio:",
          appointment.triage_url,
        ]
      : []),
  ].join("\n");

export const patientFollowupHtml = ({ appointment }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Recordatorio de tu turno</h1>
    <p>Tu consulta con Reku es mañana.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
    </table>
    ${
      appointment.triage_url
        ? `
          <div style="margin-top:24px;padding:18px;border-radius:12px;background:#f4f1ff">
            <h2 style="font-size:18px;margin:0 0 8px">Cuestionario previo</h2>
            <p style="margin:0 0 14px">Si todavía no lo completaste, es importante que lo hagas antes de la consulta con tu fisio.</p>
            <a href="${escapeHtml(appointment.triage_url)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">Completar cuestionario</a>
          </div>
        `
        : ""
    }
  </div>
`;

export const patientTriageReminderText = ({ appointment }) =>
  [
    "Recordatorio: completá tu cuestionario previo",
    "",
    `Hola ${appointment.patient_name || ""},`,
    "",
    "Si todavía no completaste el cuestionario previo, hacelo antes de tu consulta para que tu fisio pueda preparar mejor la atención.",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Profesional: ${appointment.professional_name}`,
    "",
    appointment.triage_url,
  ].join("\n");

export const patientTriageReminderHtml = ({ appointment }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Completá tu cuestionario previo</h1>
    <p>Hola ${escapeHtml(appointment.patient_name || "")},</p>
    <p>Si todavía no lo completaste, hacelo antes de tu consulta para que tu fisio pueda preparar mejor la atención.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
    </table>
    <p style="margin-top:24px">
      <a href="${escapeHtml(appointment.triage_url)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">Completar cuestionario</a>
    </p>
    <p style="color:#64738a;font-size:13px">Si ya lo completaste, podés ignorar este mensaje.</p>
  </div>
`;

const patientCancellationText = ({ appointment }) =>
  [
    "Tu turno en Reku fue cancelado",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Profesional: ${appointment.professional_name}`,
    appointment.cancellation_reason
      ? `Motivo: ${appointment.cancellation_reason}`
      : "",
    "",
    appointment.refund_status === "approved"
      ? "El reembolso total fue solicitado correctamente a Mercado Pago."
      : appointment.refund_status === "failed"
        ? "La devolución está siendo revisada por Reku."
        : "No había un pago que reembolsar.",
  ]
    .filter(Boolean)
    .join("\n");

const patientCancellationHtml = ({ appointment }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Tu turno fue cancelado</h1>
    <p>Te informamos que el siguiente turno en Reku fue cancelado.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
      ${appointment.cancellation_reason ? `<tr><td><strong>Motivo</strong></td><td>${escapeHtml(appointment.cancellation_reason)}</td></tr>` : ""}
    </table>
    <p>${
      appointment.refund_status === "approved"
        ? "El reembolso total fue solicitado correctamente a Mercado Pago."
        : appointment.refund_status === "failed"
          ? "La devolución está siendo revisada por Reku."
          : "No había un pago que reembolsar."
    }</p>
  </div>
`;

const claimAppointmentNotification = async (appointmentId) => {
  const result = await query(
    `
      UPDATE appointments a
      SET professional_notified_at = NOW(),
          professional_notification_error = NULL,
          updated_at = NOW()
      FROM professionals p,
           services s
      WHERE a.id = $1
        AND a.professional_id = p.id
        AND a.service_id = s.id
        AND a.status = 'confirmed'
        AND a.professional_notified_at IS NULL
        AND p.deleted_at IS NULL
        AND p.active = TRUE
        AND NULLIF(p.email, '') IS NOT NULL
      RETURNING
        a.id,
        a.professional_id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_name,
        a.patient_email,
        a.patient_phone,
        a.google_meet_url,
        p.name AS professional_name,
        p.email AS professional_email,
        s.name AS service_name
    `,
    [appointmentId],
  );

  return result.rows[0] || null;
};

const claimPatientConfirmation = async (appointmentId) => {
  const result = await query(
    `
      UPDATE appointments a
      SET patient_notified_at = NOW(),
          patient_notification_error = NULL,
          updated_at = NOW()
      FROM professionals p,
           services s
      WHERE a.id = $1
        AND a.professional_id = p.id
        AND a.service_id = s.id
        AND a.status = 'confirmed'
        AND a.patient_notified_at IS NULL
        AND NULLIF(a.patient_email, '') IS NOT NULL
      RETURNING
        a.id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_name,
        a.patient_email,
        a.google_meet_url,
        a.triage_url,
        p.name AS professional_name,
        s.name AS service_name
    `,
    [appointmentId],
  );

  return result.rows[0] || null;
};

const clearAppointmentNotificationClaim = async (appointmentId, errorMessage) => {
  await query(
    `
      UPDATE appointments
      SET professional_notified_at = NULL,
          professional_notification_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo enviar el mail.").slice(0, 500)],
  );
};

const clearPatientConfirmationClaim = async (appointmentId, errorMessage) => {
  await query(
    `
      UPDATE appointments
      SET patient_notified_at = NULL,
          patient_notification_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo enviar el mail.").slice(0, 500)],
  );
};

export const notifyProfessionalForAppointment = async (appointmentId) => {
  const appointment = await claimAppointmentNotification(appointmentId);
  if (!appointment) return { ok: true, skipped: true };

  try {
    const link = await createProfessionalAccessLink({
      professionalId: appointment.professional_id,
    });
    const subject = `Nuevo turno Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`;
    const result = await sendEmail({
      formName: "turno-profesional",
      to: appointment.professional_email,
      replyTo: appointment.patient_email || undefined,
      subject,
      text: appointmentText({ appointment, link }),
      html: appointmentHtml({ appointment, link }),
    });

    await query(
      `
        UPDATE appointments
        SET professional_notification_message_id = $2,
            professional_notification_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    await recordAudit("appointment.professional_notified", {
      detail: {
        appointment_id: Number(appointment.id),
        professional_id: Number(appointment.professional_id),
        message_id: result?.id || "",
      },
    });

    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearAppointmentNotificationClaim(appointment.id, error.message);
    await recordAudit("appointment.professional_notification_failed", {
      detail: {
        appointment_id: Number(appointment.id),
        professional_id: Number(appointment.professional_id),
        error: error.message,
      },
    });
    return { ok: false, error: error.message };
  }
};

export const notifyPatientForAppointment = async (appointmentId) => {
  const appointment = await claimPatientConfirmation(appointmentId);
  if (!appointment) return { ok: true, skipped: true };

  try {
    const subject = `Turno confirmado Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`;
    const result = await sendEmail({
      formName: "turno-paciente",
      to: appointment.patient_email,
      subject,
      text: patientConfirmationText({ appointment }),
      html: patientConfirmationHtml({ appointment }),
    });

    await query(
      `
        UPDATE appointments
        SET patient_notification_message_id = $2,
            patient_notification_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    await recordAudit("appointment.patient_notified", {
      detail: {
        appointment_id: Number(appointment.id),
        message_id: result?.id || "",
      },
    });

    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearPatientConfirmationClaim(appointment.id, error.message);
    await recordAudit("appointment.patient_notification_failed", {
      detail: {
        appointment_id: Number(appointment.id),
        error: error.message,
      },
    });
    return { ok: false, error: error.message };
  }
};

const claimPatientFollowup = async (appointmentId) => {
  const result = await query(
    `
      UPDATE appointments a
      SET patient_followup_notified_at = NOW(),
          patient_followup_notification_error = NULL,
          updated_at = NOW()
      FROM professionals p,
           services s
      WHERE a.id = $1
        AND a.professional_id = p.id
        AND a.service_id = s.id
        AND a.status = 'confirmed'
        AND a.patient_followup_notified_at IS NULL
        AND NULLIF(a.patient_email, '') IS NOT NULL
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $2) > NOW() + INTERVAL '23 hours'
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $2) <= NOW() + INTERVAL '24 hours'
      RETURNING
        a.id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_email,
        a.triage_url,
        p.name AS professional_name,
        s.name AS service_name
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );
  return result.rows[0] || null;
};

const clearPatientFollowupClaim = async (appointmentId, errorMessage) => {
  await query(
    `
      UPDATE appointments
      SET patient_followup_notified_at = NULL,
          patient_followup_notification_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo enviar el recordatorio.").slice(0, 500)],
  );
};

export const notifyPatientAppointmentFollowup = async (appointmentId) => {
  const appointment = await claimPatientFollowup(appointmentId);
  if (!appointment) return { ok: true, skipped: true };

  try {
    const result = await sendEmail({
      formName: "recordatorio-turno-paciente",
      to: appointment.patient_email,
      subject: `Recordatorio turno Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: patientFollowupText({ appointment }),
      html: patientFollowupHtml({ appointment }),
    });
    await query(
      `
        UPDATE appointments
        SET patient_followup_notification_message_id = $2,
            patient_followup_notification_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    await recordAudit("appointment.patient_followup_notified", {
      detail: {
        appointment_id: Number(appointment.id),
        message_id: result?.id || "",
      },
    });
    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearPatientFollowupClaim(appointment.id, error.message);
    await recordAudit("appointment.patient_followup_notification_failed", {
      detail: { appointment_id: Number(appointment.id), error: error.message },
    });
    return { ok: false, error: error.message };
  }
};

const triageReminderError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const claimManualTriageReminder = async (appointmentId, professionalId) => {
  const result = await query(
    `
      UPDATE appointments appointment
      SET triage_reminder_last_attempted_at = NOW(),
          triage_reminder_error = NULL,
          updated_at = NOW()
      FROM professionals professional,
           services service
      WHERE appointment.id = $1
        AND appointment.professional_id = $2
        AND appointment.professional_id = professional.id
        AND appointment.service_id = service.id
        AND appointment.status = 'confirmed'
        AND NULLIF(appointment.patient_email, '') IS NOT NULL
        AND NULLIF(appointment.triage_url, '') IS NOT NULL
        AND ((appointment.appointment_date + appointment.start_time) AT TIME ZONE $3) > NOW()
        AND (
          appointment.triage_reminder_last_attempted_at IS NULL
          OR appointment.triage_reminder_last_attempted_at < NOW() - INTERVAL '5 minutes'
        )
      RETURNING
        appointment.id,
        to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(appointment.start_time, 'HH24:MI') AS start_time,
        to_char(appointment.end_time, 'HH24:MI') AS end_time,
        appointment.patient_name,
        appointment.patient_email,
        appointment.triage_url,
        professional.name AS professional_name,
        service.name AS service_name
    `,
    [appointmentId, professionalId, config.googleCalendarTimeZone],
  );
  if (result.rows[0]) return result.rows[0];

  const existing = await query(
    `
      SELECT
        id,
        status,
        patient_email,
        triage_url,
        triage_reminder_last_attempted_at,
        ((appointment_date + start_time) AT TIME ZONE $3) > NOW() AS is_future
      FROM appointments
      WHERE id = $1 AND professional_id = $2
    `,
    [appointmentId, professionalId, config.googleCalendarTimeZone],
  );
  const row = existing.rows[0];
  if (!row) throw triageReminderError("TRIAGE_REMINDER_NOT_FOUND", 404);
  if (
    row.status !== "confirmed" ||
    !row.patient_email ||
    !row.triage_url ||
    !row.is_future
  ) {
    throw triageReminderError("TRIAGE_REMINDER_NOT_AVAILABLE", 409);
  }
  throw triageReminderError("TRIAGE_REMINDER_RATE_LIMITED", 429);
};

export const notifyPatientTriageReminder = async (
  appointmentId,
  professionalId,
  { actorUserId = null } = {},
) => {
  const appointment = await claimManualTriageReminder(appointmentId, professionalId);
  try {
    const result = await sendEmail({
      formName: "recordatorio-triaje-paciente",
      to: appointment.patient_email,
      subject: `Completá tu cuestionario antes del turno del ${formatDate(appointment.appointment_date)}`,
      text: patientTriageReminderText({ appointment }),
      html: patientTriageReminderHtml({ appointment }),
    });
    const updated = await query(
      `
        UPDATE appointments
        SET triage_reminder_sent_at = NOW(),
            triage_reminder_message_id = $2,
            triage_reminder_error = NULL,
            triage_reminder_count = triage_reminder_count + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING triage_reminder_sent_at, triage_reminder_count
      `,
      [appointment.id, result?.id || ""],
    );
    await recordAudit("appointment.triage_reminder_sent", {
      actorUserId,
      detail: {
        appointment_id: Number(appointment.id),
        professional_id: Number(professionalId),
        message_id: result?.id || "",
      },
    });
    return {
      ok: true,
      email: appointment.patient_email,
      sent_at: updated.rows[0]?.triage_reminder_sent_at || new Date().toISOString(),
      count: Number(updated.rows[0]?.triage_reminder_count || 1),
    };
  } catch (error) {
    await query(
      `
        UPDATE appointments
        SET triage_reminder_error = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, String(error.message || "EMAIL_SEND_FAILED").slice(0, 500)],
    );
    await recordAudit("appointment.triage_reminder_failed", {
      actorUserId,
      detail: {
        appointment_id: Number(appointment.id),
        professional_id: Number(professionalId),
        error: String(error.message || "EMAIL_SEND_FAILED").slice(0, 120),
      },
    });
    throw error;
  }
};

export const notifyConfirmedAppointment = async (appointmentId) => {
  let triage = { ok: false, skipped: true, reason: "not_configured" };
  if (isReHubConfigured()) {
    try {
      const assigned = await ensureAppointmentTriage(appointmentId);
      triage = { ok: true, url: assigned.url };
    } catch (error) {
      triage = { ok: false, error: error.message };
    }
  }
  let googleCalendar;
  try {
    googleCalendar = await syncAppointmentToGoogleCalendar(appointmentId);
  } catch (error) {
    googleCalendar = { ok: false, error: error.message };
    await recordAudit("appointment.google_calendar.sync_failed", {
      detail: {
        appointment_id: Number(appointmentId),
        error: String(error.message || "GOOGLE_SYNC_FAILED").slice(0, 120),
      },
    });
  }
  if (googleCalendar?.ok === false || googleCalendar?.status === "pending") {
    return {
      patient: { ok: false, skipped: true, reason: "google_calendar_pending" },
      professional: { ok: false, skipped: true, reason: "google_calendar_pending" },
      google_calendar: googleCalendar,
      triage,
    };
  }
  const [patient, professional] = await Promise.all([
    notifyPatientForAppointment(appointmentId),
    notifyProfessionalForAppointment(appointmentId),
  ]);
  return { patient, professional, google_calendar: googleCalendar, triage };
};

export const sendUpcomingAppointmentFollowups = async () => {
  const result = await query(
    `
      SELECT a.id
      FROM appointments a
      WHERE a.status = 'confirmed'
        AND a.patient_followup_notified_at IS NULL
        AND NULLIF(a.patient_email, '') IS NOT NULL
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $1) > NOW() + INTERVAL '23 hours'
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $1) <= NOW() + INTERVAL '24 hours'
      ORDER BY a.appointment_date, a.start_time
      LIMIT 50
    `,
    [config.googleCalendarTimeZone],
  );
  let completed = 0;
  for (const row of result.rows) {
    if (isReHubConfigured()) {
      try {
        await ensureAppointmentTriage(Number(row.id));
      } catch {
        // The appointment reminder still goes out without a triage link.
      }
    }
    const followup = await notifyPatientAppointmentFollowup(Number(row.id));
    if (followup.ok && !followup.skipped) completed += 1;
  }
  return { attempted: result.rowCount, completed };
};

export const retryPendingGoogleAppointmentNotifications = async () => {
  const result = await query(
    `
      SELECT a.id
      FROM appointments a
      INNER JOIN professional_google_connections pgc
        ON pgc.professional_id = a.professional_id
       AND pgc.status = 'active'
      WHERE a.status = 'confirmed'
        AND a.google_sync_status IN ('pending', 'failed')
        AND (
          a.patient_notified_at IS NULL
          OR a.professional_notified_at IS NULL
        )
      ORDER BY a.updated_at
      LIMIT 50
    `,
  );
  let completed = 0;
  for (const row of result.rows) {
    const notification = await notifyConfirmedAppointment(Number(row.id));
    if (notification.google_calendar?.status === "synced") completed += 1;
  }
  return { attempted: result.rowCount, completed };
};

export const notifyPatientForCancellation = async (appointmentId) => {
  const result = await query(
    `
      UPDATE appointments a
      SET patient_cancellation_notified_at = NOW(),
          patient_cancellation_error = NULL,
          updated_at = NOW()
      FROM professionals p,
           services s
      WHERE a.id = $1
        AND a.professional_id = p.id
        AND a.service_id = s.id
        AND a.status = 'cancelled'
        AND a.patient_cancellation_notified_at IS NULL
        AND NULLIF(a.patient_email, '') IS NOT NULL
      RETURNING
        a.id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_email,
        a.cancellation_reason,
        a.refund_status,
        p.name AS professional_name,
        s.name AS service_name
    `,
    [appointmentId],
  );
  const appointment = result.rows[0];
  if (!appointment) return { ok: true, skipped: true };

  try {
    const email = await sendEmail({
      formName: "cancelacion-turno-paciente",
      to: appointment.patient_email,
      subject: `Turno cancelado Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: patientCancellationText({ appointment }),
      html: patientCancellationHtml({ appointment }),
    });
    await query(
      `
        UPDATE appointments
        SET patient_cancellation_message_id = $2,
            patient_cancellation_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, email?.id || ""],
    );
    await recordAudit("appointment.patient_cancellation_notified", {
      detail: { appointment_id: Number(appointment.id), message_id: email?.id || "" },
    });
    return { ok: true, skipped: false, message_id: email?.id || "" };
  } catch (error) {
    await query(
      `
        UPDATE appointments
        SET patient_cancellation_notified_at = NULL,
            patient_cancellation_error = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, String(error.message || "No se pudo enviar el mail.").slice(0, 500)],
    );
    await recordAudit("appointment.patient_cancellation_notification_failed", {
      detail: { appointment_id: Number(appointment.id), error: error.message },
    });
    return { ok: false, error: error.message };
  }
};
