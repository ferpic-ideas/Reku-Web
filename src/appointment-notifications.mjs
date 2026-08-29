import { createProfessionalAccessLink } from "./professional-links.mjs";
import { query, recordAudit } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { escapeHtml } from "./http.mjs";
import { syncAppointmentToGoogleCalendar } from "./google-calendar.mjs";
import { config } from "./config.mjs";
import { ensureAppointmentTriage } from "./appointment-triage.mjs";
import { isReHubConfigured } from "./rehub.mjs";
import {
  createPatientAppointmentAccessLink,
  revokeOtherPatientAppointmentAccessLinks,
} from "./patient-appointment-links.mjs";
import {
  googleCalendarTemplateUrl,
  isGoogleCalendarEmail,
  patientCalendarActionUrl,
} from "./appointment-calendar.mjs";

const formatDate = (value) => {
  const [year, month, day] = String(value || "").split("-");
  if (!year || !month || !day) return String(value || "");
  return `${day}/${month}/${year}`;
};

const isRescheduled = (appointment) => Number(appointment.reschedule_count || 0) > 0;

const appointmentAgreementName = (appointment) =>
  String(appointment.agreement_name || "").trim();

const safeSubjectPart = (value) =>
  String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 100);

const patientConfirmationBrand = (appointment) => {
  const agreementName = appointmentAgreementName(appointment);
  return appointment.agreement_cobranded && agreementName
    ? `${safeSubjectPart(agreementName)}+Reku`
    : "Reku";
};

export const patientConfirmationSubject = (appointment) =>
  `${isRescheduled(appointment) ? "Turno reprogramado" : "Turno confirmado"} ${patientConfirmationBrand(appointment)} - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`;

const professionalNotificationLead = (appointment) => {
  const lead = isRescheduled(appointment)
    ? "El paciente reprogramó su turno en Reku"
    : "Se confirmó un nuevo turno en Reku";
  const agreementName = appointmentAgreementName(appointment);
  return agreementName
    ? `${lead} vía el acuerdo de ${agreementName}.`
    : `${lead}.`;
};

const patientMeetWindowText = () =>
  `Por seguridad, el acceso a la videollamada se habilita ${config.patientMeetEarlyMinutes} minutos antes del turno y permanece disponible hasta ${config.patientMeetLateMinutes} minutos después de su finalización.`;

const rotateDeliveredPatientAccessLink = async (appointmentId, linkId) => {
  try {
    await revokeOtherPatientAppointmentAccessLinks({
      appointmentId,
      keepLinkId: linkId,
    });
  } catch (error) {
    await recordAudit("appointment.patient_access_link_rotation_failed", {
      detail: {
        appointment_id: Number(appointmentId),
        access_link_id: Number(linkId),
        error: String(error?.message || "LINK_ROTATION_FAILED").slice(0, 160),
      },
    }).catch(() => {});
  }
};

const patientMeetTextLines = (appointment, manageUrl) =>
  appointment.google_meet_url && manageUrl
    ? [
        "",
        "Ingresar a la videollamada",
        `Ingresar: ${manageUrl}`,
        patientMeetWindowText(),
      ]
    : [];

const patientMeetHtml = (appointment, manageUrl) =>
  appointment.google_meet_url && manageUrl
    ? `<div style="margin-top:24px;padding:18px;border-radius:12px;background:#eef9fb"><h2 style="font-size:18px;margin:0 0 14px">Ingresar a la videollamada</h2><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">Ingresar</a><p style="margin:12px 0 0;color:#64738a;font-size:13px">${escapeHtml(patientMeetWindowText())}</p></div>`
    : "";

const patientCalendarTextLines = (appointment, manageUrl) => {
  if (!manageUrl) return [];
  if (!isGoogleCalendarEmail(appointment.patient_email)) {
    return [`Agregar a mi calendario: ${patientCalendarActionUrl(manageUrl)}`];
  }
  return [
    `Agregar a Google Calendar: ${googleCalendarTemplateUrl({
      appointment,
      manageUrl,
      timeZone: config.googleCalendarTimeZone,
    })}`,
    `Usar otro calendario: ${patientCalendarActionUrl(manageUrl)}`,
  ];
};

const patientCalendarHtml = (appointment, manageUrl) => {
  if (!manageUrl) return "";
  if (!isGoogleCalendarEmail(appointment.patient_email)) {
    return `<p style="margin-top:18px"><a href="${escapeHtml(patientCalendarActionUrl(manageUrl))}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#fff;color:#18213f;border:1px solid #ccd5e2;padding:11px 15px;border-radius:8px;text-decoration:none;font-weight:700"><span aria-hidden="true" style="margin-right:8px">&#128197;</span>Agregar a mi calendario</a></p>`;
  }
  const googleUrl = googleCalendarTemplateUrl({
    appointment,
    manageUrl,
    timeZone: config.googleCalendarTimeZone,
  });
  return `<p style="margin-top:18px"><a href="${escapeHtml(googleUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#fff;color:#18213f;border:1px solid #ccd5e2;padding:11px 15px;border-radius:8px;text-decoration:none;font-weight:700"><span aria-hidden="true" style="margin-right:8px">&#128197;</span>Agregar a Google Calendar</a><br><a href="${escapeHtml(patientCalendarActionUrl(manageUrl))}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:9px;color:#64738a;text-decoration:underline;text-underline-offset:3px;font-size:13px">Usar otro calendario</a></p>`;
};

export const appointmentText = ({ appointment, link }) =>
  [
    isRescheduled(appointment)
      ? "Turno reprogramado en Reku"
      : "Nuevo turno confirmado en Reku",
    "",
    professionalNotificationLead(appointment),
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Paciente: ${appointment.patient_name}`,
    `Teléfono: ${appointment.patient_phone || "-"}`,
    `Mail: ${appointment.patient_email || "-"}`,
    appointmentAgreementName(appointment)
      ? `Acuerdo: ${appointmentAgreementName(appointment)}`
      : null,
    "",
    `Ver ficha del turno: ${link.url}`,
  ].filter((line) => line !== null).join("\n");

export const appointmentHtml = ({ appointment, link }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">${isRescheduled(appointment) ? "Turno reprogramado" : "Nuevo turno confirmado"}</h1>
    <p>${escapeHtml(professionalNotificationLead(appointment))}</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Paciente</strong></td><td>${escapeHtml(appointment.patient_name)}</td></tr>
      <tr><td><strong>Teléfono</strong></td><td>${escapeHtml(appointment.patient_phone || "-")}</td></tr>
      <tr><td><strong>Mail</strong></td><td>${escapeHtml(appointment.patient_email || "-")}</td></tr>
      ${appointmentAgreementName(appointment) ? `<tr><td><strong>Acuerdo</strong></td><td>${escapeHtml(appointmentAgreementName(appointment))}</td></tr>` : ""}
    </table>
    <p style="margin-top:20px">
      <a href="${escapeHtml(link.url)}" style="display:inline-block;background:#18213f;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none">
        Ver ficha del turno
      </a>
    </p>
    <p style="color:#64738a;font-size:13px">Este acceso privado abre la ficha del turno y también permite consultar los próximos turnos confirmados.</p>
  </div>
`;

export const professionalFollowupText = ({ appointment, link }) =>
  [
    "Recordatorio: tenés un turno en aproximadamente 24 horas",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Paciente: ${appointment.patient_name}`,
    appointmentAgreementName(appointment)
      ? `Acuerdo: ${appointmentAgreementName(appointment)}`
      : "",
    appointment.google_meet_url
      ? `Abrir sala de preparación e ingresar a Meet: ${link.url}`
      : `Ver ficha del turno: ${link.url}`,
  ].filter(Boolean).join("\n");

export const professionalFollowupHtml = ({ appointment, link }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Recordatorio de turno</h1>
    <p>Tenés un turno en aproximadamente 24 horas.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Paciente</strong></td><td>${escapeHtml(appointment.patient_name)}</td></tr>
      ${appointmentAgreementName(appointment) ? `<tr><td><strong>Acuerdo</strong></td><td>${escapeHtml(appointmentAgreementName(appointment))}</td></tr>` : ""}
    </table>
    <p style="margin-top:20px">
      <a href="${escapeHtml(link.url)}" style="display:inline-block;background:#18213f;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">${appointment.google_meet_url ? "Abrir sala de preparación" : "Ver ficha del turno"}</a>
    </p>
    <p style="color:#64738a;font-size:13px">Desde la sala vas a poder revisar la información del paciente, sus estudios y el formulario de triaje antes de abrir Meet.</p>
  </div>
`;

export const patientConfirmationText = ({
  appointment,
  manageUrl = "",
  meetUrl = manageUrl,
}) =>
  [
    isRescheduled(appointment)
      ? "Tu turno en Reku fue reprogramado"
      : "Tu turno en Reku quedó confirmado",
    "",
    "IMPORTANTE: no necesitás un usuario en la plataforma. Guardá este mail: es tu acceso privado para gestionar el turno.",
    "No reenvíes el enlace de gestión a otras personas.",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Profesional: ${appointment.professional_name}`,
    ...(manageUrl
      ? [
          "",
          "Gestionar o mover mi turno:",
          manageUrl,
        ]
      : []),
    ...patientCalendarTextLines(appointment, manageUrl),
    ...(appointment.triage_url
      ? [
          "",
          "Antes de la consulta, completá este breve cuestionario para que el equipo pueda preparar mejor tu atención:",
          appointment.triage_url,
        ]
      : []),
    ...patientMeetTextLines(appointment, meetUrl),
    "",
    "Te enviaremos otro recordatorio aproximadamente 24 horas antes.",
    "",
    "Te esperamos.",
  ].join("\n");

export const patientConfirmationHtml = ({
  appointment,
  manageUrl = "",
  meetUrl = manageUrl,
}) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">${isRescheduled(appointment) ? "Tu turno fue reprogramado" : "Tu turno quedó confirmado"}</h1>
    <p>${isRescheduled(appointment) ? "Actualizamos tu reserva." : "Confirmamos tu reserva."}</p>
    <div style="margin:20px 0;padding:18px;border:1px solid #f2d48a;border-radius:12px;background:#fff8e6">
      <strong style="display:block;margin-bottom:6px">Guardá este mail</strong>
      <p style="margin:0">No necesitás crear un usuario en la plataforma. Este mail y su enlace privado son tu acceso para gestionar el turno. No lo reenvíes a otras personas.</p>
    </div>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
    </table>
    ${manageUrl ? `<p style="margin-top:20px"><a href="${escapeHtml(manageUrl)}" style="color:#18213f;text-decoration:underline;text-underline-offset:3px;font-weight:700">Gestionar o mover mi turno</a></p>` : ""}
    ${patientCalendarHtml(appointment, manageUrl)}
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
    ${patientMeetHtml(appointment, meetUrl)}
    <p style="color:#64738a;font-size:13px">Te enviaremos un recordatorio aproximadamente 24 horas antes del turno.</p>
  </div>
`;

export const patientPendingPaymentText = ({ appointment, manageUrl = "" }) =>
  [
    "Tu reserva en Reku está pendiente de pago",
    "",
    "Guardá este mail. No necesitás un usuario: desde sus enlaces podés completar el pago o cancelar la reserva mientras siga pendiente.",
    "No reenvíes el enlace de gestión a otras personas.",
    "",
    `Fecha: ${formatDate(appointment.appointment_date)}`,
    `Horario: ${appointment.start_time} a ${appointment.end_time}`,
    `Servicio: ${appointment.service_name}`,
    `Profesional: ${appointment.professional_name}`,
    "",
    appointment.payment_init_point
      ? `Completar pago: ${appointment.payment_init_point}`
      : "",
    manageUrl ? `Gestionar o cancelar reserva: ${manageUrl}` : "",
    "",
    "La reserva del horario vence si el pago no se completa a tiempo.",
  ].filter(Boolean).join("\n");

export const patientPendingPaymentHtml = ({ appointment, manageUrl = "" }) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Tu reserva está pendiente de pago</h1>
    <div style="margin:20px 0;padding:18px;border:1px solid #f2d48a;border-radius:12px;background:#fff8e6">
      <strong style="display:block;margin-bottom:6px">Guardá este mail</strong>
      <p style="margin:0">No necesitás un usuario en Reku. Desde acá podés completar el pago o cancelar la reserva mientras siga pendiente. No reenvíes el enlace privado.</p>
    </div>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(formatDate(appointment.appointment_date))}</td></tr>
      <tr><td><strong>Horario</strong></td><td>${escapeHtml(appointment.start_time)} a ${escapeHtml(appointment.end_time)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(appointment.service_name)}</td></tr>
      <tr><td><strong>Profesional</strong></td><td>${escapeHtml(appointment.professional_name)}</td></tr>
    </table>
    ${appointment.payment_init_point ? `<p style="margin-top:20px"><a href="${escapeHtml(appointment.payment_init_point)}" style="display:inline-block;background:#6c4bf4;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">Completar pago</a></p>` : ""}
    ${manageUrl ? `<p><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#fff;color:#18213f;border:1px solid #ccd5e2;padding:11px 15px;border-radius:8px;text-decoration:none;font-weight:700">Gestionar o cancelar reserva</a></p>` : ""}
    <p style="color:#64738a;font-size:13px">La reserva del horario vence si el pago no se completa a tiempo.</p>
  </div>
`;

export const patientFollowupText = ({
  appointment,
  manageUrl = "",
  meetUrl = manageUrl,
}) =>
  [
    "Recordatorio: tu turno en Reku es en aproximadamente 24 horas",
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
    ...patientMeetTextLines(appointment, meetUrl),
    ...(manageUrl
      ? [
          "",
          "Gestionar mi turno:",
          manageUrl,
        ]
      : []),
    ...patientCalendarTextLines(appointment, manageUrl),
  ].join("\n");

export const patientFollowupHtml = ({
  appointment,
  manageUrl = "",
  meetUrl = manageUrl,
}) => `
  <div style="font-family:Arial,sans-serif;color:#18213f;line-height:1.5">
    <h1 style="font-size:24px;margin:0 0 16px">Recordatorio de tu turno</h1>
    <p>Tu consulta con Reku es en aproximadamente 24 horas.</p>
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
    ${patientMeetHtml(appointment, meetUrl)}
    ${manageUrl ? `<p style="margin-top:24px"><a href="${escapeHtml(manageUrl)}" style="display:inline-block;background:#18213f;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">Gestionar mi turno</a></p>` : ""}
    ${patientCalendarHtml(appointment, manageUrl)}
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
        a.agreement_name_snapshot AS agreement_name,
        a.agreement_cobranded_snapshot AS agreement_cobranded,
        a.reschedule_count,
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
        a.agreement_name_snapshot AS agreement_name,
        a.agreement_cobranded_snapshot AS agreement_cobranded,
        a.payment_status,
        a.reschedule_count,
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

const claimPendingPaymentNotification = async (appointmentId) => {
  const result = await query(
    `
      UPDATE appointments appointment
      SET pending_payment_notified_at = NOW(),
          pending_payment_notification_error = NULL,
          updated_at = NOW()
      FROM professionals professional,
           services service
      WHERE appointment.id = $1
        AND appointment.professional_id = professional.id
        AND appointment.service_id = service.id
        AND appointment.status = 'pending_payment'
        AND appointment.pending_payment_notified_at IS NULL
        AND NULLIF(appointment.patient_email, '') IS NOT NULL
      RETURNING
        appointment.id,
        to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(appointment.start_time, 'HH24:MI') AS start_time,
        to_char(appointment.end_time, 'HH24:MI') AS end_time,
        appointment.patient_email,
        appointment.payment_init_point,
        professional.name AS professional_name,
        service.name AS service_name
    `,
    [appointmentId],
  );
  return result.rows[0] || null;
};

const clearPendingPaymentNotificationClaim = async (appointmentId, errorMessage) => {
  await query(
    `
      UPDATE appointments
      SET pending_payment_notified_at = NULL,
          pending_payment_notification_error = $2,
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
      appointmentId: appointment.id,
    });
    const subject = `${isRescheduled(appointment) ? "Turno reprogramado" : "Nuevo turno"} Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`;
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

export const notifyPatientForAppointment = async (
  appointmentId,
  { accessLink = null } = {},
) => {
  const appointment = await claimPatientConfirmation(appointmentId);
  if (!appointment) return { ok: true, skipped: true };

  try {
    const manageLink =
      accessLink || (await createPatientAppointmentAccessLink({ appointmentId }));
    const subject = patientConfirmationSubject(appointment);
    const result = await sendEmail({
      formName: "turno-paciente",
      to: appointment.patient_email,
      subject,
      text: patientConfirmationText({
        appointment,
        manageUrl: manageLink.url,
        meetUrl: manageLink.meet_url,
      }),
      html: patientConfirmationHtml({
        appointment,
        manageUrl: manageLink.url,
        meetUrl: manageLink.meet_url,
      }),
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
    await rotateDeliveredPatientAccessLink(appointment.id, manageLink.id);
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

export const notifyPatientForPendingPayment = async (appointmentId) => {
  const appointment = await claimPendingPaymentNotification(appointmentId);
  if (!appointment) return { ok: true, skipped: true };
  try {
    const manageLink = await createPatientAppointmentAccessLink({ appointmentId });
    const result = await sendEmail({
      formName: "turno-pago-pendiente",
      to: appointment.patient_email,
      subject: `Completá el pago de tu turno Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: patientPendingPaymentText({ appointment, manageUrl: manageLink.url }),
      html: patientPendingPaymentHtml({ appointment, manageUrl: manageLink.url }),
    });
    await query(
      `
        UPDATE appointments
        SET pending_payment_notification_message_id = $2,
            pending_payment_notification_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    await rotateDeliveredPatientAccessLink(appointment.id, manageLink.id);
    await recordAudit("appointment.pending_payment_patient_notified", {
      detail: { appointment_id: Number(appointment.id), message_id: result?.id || "" },
    });
    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearPendingPaymentNotificationClaim(appointment.id, error.message);
    await recordAudit("appointment.pending_payment_patient_notification_failed", {
      detail: { appointment_id: Number(appointment.id), error: error.message },
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
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $2) > NOW()
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $2) <= NOW() + INTERVAL '24 hours'
      RETURNING
        a.id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_email,
        a.triage_url,
        a.google_meet_url,
        a.reschedule_count,
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
    const manageLink = await createPatientAppointmentAccessLink({
      appointmentId: appointment.id,
    });
    const result = await sendEmail({
      formName: "recordatorio-turno-paciente",
      to: appointment.patient_email,
      subject: `Recordatorio turno Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: patientFollowupText({
        appointment,
        manageUrl: manageLink.url,
        meetUrl: manageLink.meet_url,
      }),
      html: patientFollowupHtml({
        appointment,
        manageUrl: manageLink.url,
        meetUrl: manageLink.meet_url,
      }),
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
    await rotateDeliveredPatientAccessLink(appointment.id, manageLink.id);
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

const claimProfessionalFollowup = async (appointmentId) => {
  const result = await query(
    `
      UPDATE appointments a
      SET professional_followup_notified_at = NOW(),
          professional_followup_notification_error = NULL,
          updated_at = NOW()
      FROM professionals p,
           services s
      WHERE a.id = $1
        AND a.professional_id = p.id
        AND a.service_id = s.id
        AND a.status = 'confirmed'
        AND a.professional_followup_notified_at IS NULL
        AND p.deleted_at IS NULL
        AND p.active = TRUE
        AND NULLIF(p.email, '') IS NOT NULL
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $2) > NOW()
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $2) <= NOW() + INTERVAL '24 hours'
      RETURNING
        a.id,
        a.professional_id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_name,
        a.patient_email,
        a.google_meet_url,
        a.agreement_name_snapshot AS agreement_name,
        p.name AS professional_name,
        p.email AS professional_email,
        s.name AS service_name
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );
  return result.rows[0] || null;
};

const clearProfessionalFollowupClaim = async (appointmentId, errorMessage) => {
  await query(
    `
      UPDATE appointments
      SET professional_followup_notified_at = NULL,
          professional_followup_notification_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(errorMessage || "No se pudo enviar el recordatorio.").slice(0, 500)],
  );
};

export const notifyProfessionalAppointmentFollowup = async (appointmentId) => {
  const appointment = await claimProfessionalFollowup(appointmentId);
  if (!appointment) return { ok: true, skipped: true };

  try {
    const link = await createProfessionalAccessLink({
      professionalId: appointment.professional_id,
      appointmentId: appointment.id,
    });
    const result = await sendEmail({
      formName: "recordatorio-turno-profesional",
      to: appointment.professional_email,
      replyTo: appointment.patient_email || undefined,
      subject: `Recordatorio turno Reku - ${formatDate(appointment.appointment_date)} ${appointment.start_time}`,
      text: professionalFollowupText({ appointment, link }),
      html: professionalFollowupHtml({ appointment, link }),
    });
    await query(
      `
        UPDATE appointments
        SET professional_followup_notification_message_id = $2,
            professional_followup_notification_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, result?.id || ""],
    );
    await recordAudit("appointment.professional_followup_notified", {
      detail: {
        appointment_id: Number(appointment.id),
        professional_id: Number(appointment.professional_id),
        message_id: result?.id || "",
      },
    });
    return { ok: true, skipped: false, message_id: result?.id || "" };
  } catch (error) {
    await clearProfessionalFollowupClaim(appointment.id, error.message);
    await recordAudit("appointment.professional_followup_notification_failed", {
      detail: {
        appointment_id: Number(appointment.id),
        professional_id: Number(appointment.professional_id),
        error: error.message,
      },
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

export const notifyConfirmedAppointment = async (
  appointmentId,
  { forceGoogleSync = false } = {},
) => {
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
  let patientAccessLink = null;
  try {
    patientAccessLink = await createPatientAppointmentAccessLink({ appointmentId });
  } catch {
    // Confirmation remains available by email even if the early shared link cannot be created.
  }
  try {
    googleCalendar = await syncAppointmentToGoogleCalendar(appointmentId, {
      force: forceGoogleSync,
      patientLobbyUrl: patientAccessLink?.meet_url || "",
    });
  } catch (error) {
    googleCalendar = { ok: false, error: error.message };
    await recordAudit("appointment.google_calendar.sync_failed", {
      detail: {
        appointment_id: Number(appointmentId),
        error: String(error.message || "GOOGLE_SYNC_FAILED").slice(0, 120),
      },
    });
  }
  const [patient, professional] = await Promise.all([
    notifyPatientForAppointment(appointmentId, { accessLink: patientAccessLink }),
    notifyProfessionalForAppointment(appointmentId),
  ]);
  return { patient, professional, google_calendar: googleCalendar, triage };
};

export const sendUpcomingAppointmentFollowups = async () => {
  const result = await query(
    `
      SELECT a.id
      FROM appointments a
      INNER JOIN professionals p ON p.id = a.professional_id
      WHERE a.status = 'confirmed'
        AND (
          (
            a.patient_followup_notified_at IS NULL
            AND NULLIF(a.patient_email, '') IS NOT NULL
          )
          OR (
            a.professional_followup_notified_at IS NULL
            AND p.active = TRUE
            AND p.deleted_at IS NULL
            AND NULLIF(p.email, '') IS NOT NULL
          )
        )
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $1) > NOW()
        AND ((a.appointment_date + a.start_time) AT TIME ZONE $1) <= NOW() + INTERVAL '24 hours'
      ORDER BY a.appointment_date, a.start_time
      LIMIT 50
    `,
    [config.googleCalendarTimeZone],
  );
  let completed = 0;
  let patientCompleted = 0;
  let professionalCompleted = 0;
  for (const row of result.rows) {
    try {
      await syncAppointmentToGoogleCalendar(Number(row.id));
    } catch {
      // Reminders still go out when Google synchronization is unavailable.
    }
    if (isReHubConfigured()) {
      try {
        await ensureAppointmentTriage(Number(row.id));
      } catch {
        // The appointment reminder still goes out without a triage link.
      }
    }
    const [patient, professional] = await Promise.all([
      notifyPatientAppointmentFollowup(Number(row.id)),
      notifyProfessionalAppointmentFollowup(Number(row.id)),
    ]);
    const patientSent = patient.ok && !patient.skipped;
    const professionalSent = professional.ok && !professional.skipped;
    if (patientSent) patientCompleted += 1;
    if (professionalSent) professionalCompleted += 1;
    if (patientSent || professionalSent) completed += 1;
  }
  return {
    attempted: result.rowCount,
    completed,
    patient_completed: patientCompleted,
    professional_completed: professionalCompleted,
  };
};

export const retryPendingPaymentNotifications = async () => {
  const result = await query(
    `
      SELECT id
      FROM appointments
      WHERE status = 'pending_payment'
        AND pending_payment_notified_at IS NULL
        AND NULLIF(patient_email, '') IS NOT NULL
        AND NULLIF(payment_init_point, '') IS NOT NULL
        AND created_at > NOW() - INTERVAL '40 minutes'
      ORDER BY created_at
      LIMIT 50
    `,
  );
  let completed = 0;
  for (const row of result.rows) {
    const notification = await notifyPatientForPendingPayment(Number(row.id));
    if (notification.ok && !notification.skipped) completed += 1;
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
