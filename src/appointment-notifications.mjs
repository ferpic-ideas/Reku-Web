import { createProfessionalAccessLink } from "./professional-links.mjs";
import { query, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { escapeHtml } from "./http.mjs";
import { syncAppointmentToGoogleCalendar } from "./google-calendar.mjs";

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

const patientConfirmationText = ({ appointment }) =>
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
    "",
    "Te esperamos.",
  ].join("\n");

const patientConfirmationHtml = ({ appointment }) => `
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
    <p style="color:#64738a;font-size:13px">Este mail confirma que el turno fue reservado correctamente.</p>
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

export const notifyConfirmedAppointment = async (appointmentId) => {
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
    };
  }
  const [patient, professional] = await Promise.all([
    notifyPatientForAppointment(appointmentId),
    notifyProfessionalForAppointment(appointmentId),
  ]);
  return { patient, professional, google_calendar: googleCalendar };
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
