import { createProfessionalAccessLink } from "./professional-links.mjs";
import { query, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { escapeHtml } from "./http.mjs";

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
    <p style="color:#64738a;font-size:13px">Este mail confirma que el turno fue reservado correctamente.</p>
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
  const [patient, professional] = await Promise.all([
    notifyPatientForAppointment(appointmentId),
    notifyProfessionalForAppointment(appointmentId),
  ]);
  return { patient, professional };
};
