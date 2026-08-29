import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appointmentHtml,
  appointmentText,
  patientConfirmationHtml,
  patientConfirmationSubject,
  patientConfirmationText,
  patientFollowupHtml,
  patientFollowupText,
  patientPendingPaymentHtml,
  patientPendingPaymentText,
  patientTriageReminderHtml,
  patientTriageReminderText,
  professionalFollowupHtml,
  professionalFollowupText,
} from "../src/appointment-notifications.mjs";

const appointment = {
  appointment_date: "2026-08-19",
  start_time: "10:00",
  end_time: "11:00",
  service_name: "Evaluación",
  professional_name: "Fisio Reku",
  patient_name: "Paciente Reku",
  google_meet_url: "",
};

const manageUrl = "https://www.reku.io/turnos/#manage=private-token";

test("confirmation email is the patient's no-account management access", () => {
  const withTriage = {
    ...appointment,
    payment_status: "approved",
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/example",
  };

  for (const content of [
    patientConfirmationText({ appointment: withTriage, manageUrl }),
    patientConfirmationHtml({ appointment: withTriage, manageUrl }),
  ]) {
    assert.match(content, /Guardá este mail/i);
    assert.match(content, /no necesitás.*usuario/i);
    assert.match(content, /manage=private-token/);
    assert.match(content, /gestionar o mover/i);
    assert.match(content, /Agregar a mi calendario/i);
    assert.match(content, /calendar=1/);
    assert.match(content, /aproximadamente 24 horas/i);
    assert.match(content, /opentriage\/example/);
  }
});

test("calendar buttons in patient emails request a new tab", () => {
  const html = patientConfirmationHtml({
    appointment: { ...appointment, patient_email: "paciente@gmail.com" },
    manageUrl,
  });
  assert.match(
    html,
    /Agregar a Google Calendar<\/a>[\s\S]*target="_blank"|target="_blank"[\s\S]*Agregar a Google Calendar<\/a>/,
  );
  assert.match(html, /rel="noopener noreferrer"/);
});

test("Gmail confirmations open Google Calendar and retain the universal fallback", () => {
  const gmailAppointment = {
    ...appointment,
    patient_email: "paciente@gmail.com",
  };
  for (const content of [
    patientConfirmationText({ appointment: gmailAppointment, manageUrl }),
    patientConfirmationHtml({ appointment: gmailAppointment, manageUrl }),
  ]) {
    assert.match(content, /Agregar a Google Calendar/i);
    assert.match(content, /calendar\.google\.com/);
    assert.match(content, /Usar otro calendario/i);
    assert.match(content, /calendar=1/);
    assert.doesNotMatch(content, /meet\.google\.com/);
  }
});

test("cobranded patient confirmations use the agreement plus Reku subject", () => {
  assert.equal(
    patientConfirmationSubject({
      ...appointment,
      appointment_date: "2026-08-27",
      start_time: "10:00",
      agreement_name: "YPF",
      agreement_cobranded: true,
    }),
    "Turno confirmado YPF+Reku - 27/08/2026 10:00",
  );
  assert.equal(
    patientConfirmationSubject({
      ...appointment,
      appointment_date: "2026-08-27",
      start_time: "10:00",
      agreement_name: "YPF",
      agreement_cobranded: false,
    }),
    "Turno confirmado Reku - 27/08/2026 10:00",
  );
});

test("patient confirmation places protected video access after the questionnaire", () => {
  const withMeet = {
    ...appointment,
    google_meet_url: "https://meet.google.com/private-raw-url",
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/confirmation-order",
  };
  const text = patientConfirmationText({ appointment: withMeet, manageUrl });
  const html = patientConfirmationHtml({ appointment: withMeet, manageUrl });

  assert.ok(text.indexOf("opentriage/confirmation-order") < text.indexOf("Ingresar a la videollamada"));
  assert.ok(html.indexOf("Cuestionario previo") < html.indexOf("Ingresar a la videollamada"));
  assert.ok(html.indexOf("Ingresar a la videollamada") < html.indexOf("Por seguridad"));
  assert.match(html, /<h2[^>]*>Ingresar a la videollamada<\/h2>/);
  assert.match(html, /<a[^>]*>Ingresar<\/a>/);
  assert.match(html, />Gestionar o mover mi turno<\/a>/);
  assert.match(html, /Confirmamos tu reserva\./);
  assert.doesNotMatch(html, /Confirmamos tu reserva en Reku/);
  assert.doesNotMatch(html, /background:#18213f[^>]*>Gestionar o mover mi turno/);
});

test("professional confirmation names the agreement and the reminder opens the preparation room", () => {
  const professionalAppointment = {
    ...appointment,
    agreement_name: "YPF",
    google_meet_url: "https://meet.google.com/professional-room",
  };
  const link = { url: "https://www.reku.io/profesional-turnos/#token=private" };
  const confirmationText = appointmentText({ appointment: professionalAppointment, link });
  const confirmationHtml = appointmentHtml({ appointment: professionalAppointment, link });
  const reminderText = professionalFollowupText({ appointment: professionalAppointment, link });
  const reminderHtml = professionalFollowupHtml({ appointment: professionalAppointment, link });

  for (const content of [confirmationText, confirmationHtml]) {
    assert.match(content, /vía el acuerdo de YPF/i);
    assert.doesNotMatch(content, /meet\.google\.com\/professional-room/);
  }
  for (const content of [reminderText, reminderHtml]) {
    assert.match(content, /Acuerdo(?:: YPF|<\/strong><\/td><td>YPF)/i);
    assert.doesNotMatch(content, /meet\.google\.com\/professional-room/);
    assert.match(content, /sala de preparación/i);
    assert.match(content, /profesional-turnos\/\#token=private/);
  }

  const withoutAgreement = appointmentHtml({ appointment, link });
  assert.doesNotMatch(withoutAgreement, /<strong>Acuerdo<\/strong>/);
  assert.doesNotMatch(withoutAgreement, /vía el acuerdo/i);
});

test("pending payment email allows payment or cancellation without an account", () => {
  const pending = {
    ...appointment,
    payment_init_point: "https://mercadopago.com.ar/checkout/example",
  };

  for (const content of [
    patientPendingPaymentText({ appointment: pending, manageUrl }),
    patientPendingPaymentHtml({ appointment: pending, manageUrl }),
  ]) {
    assert.match(content, /Guardá este mail/i);
    assert.match(content, /no necesitás.*usuario/i);
    assert.match(content, /completar.*pago/i);
    assert.match(content, /cancelar.*reserva/i);
    assert.match(content, /manage=private-token/);
  }
});

test("24-hour reminder keeps management and triage access", () => {
  const withTriage = {
    ...appointment,
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/reminder",
  };

  for (const content of [
    patientFollowupText({ appointment: withTriage, manageUrl }),
    patientFollowupHtml({ appointment: withTriage, manageUrl }),
  ]) {
    assert.match(content, /aproximadamente 24 horas/i);
    assert.match(content, /manage=private-token/);
    assert.match(content, /opentriage\/reminder/);
    assert.match(content, /Agregar a mi calendario/i);
    assert.match(content, /calendar=1/);
  }
});

test("patient reminder leaves management and calendar actions at the end", () => {
  const reminder = {
    ...appointment,
    patient_email: "paciente@gmail.com",
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/reminder-order",
    google_meet_url: "https://meet.google.com/private-reminder-url",
  };
  const html = patientFollowupHtml({ appointment: reminder, manageUrl });
  const text = patientFollowupText({ appointment: reminder, manageUrl });

  assert.ok(html.indexOf("Cuestionario previo") < html.indexOf("Ingresar a la videollamada"));
  assert.ok(html.indexOf("Ingresar a la videollamada") < html.indexOf("Gestionar mi turno"));
  assert.ok(html.indexOf("Gestionar mi turno") < html.indexOf("Agregar a Google Calendar"));
  assert.ok(text.indexOf("opentriage/reminder-order") < text.indexOf("Ingresar a la videollamada"));
  assert.ok(text.indexOf("Ingresar a la videollamada") < text.indexOf("Gestionar mi turno"));
  assert.ok(text.indexOf("Gestionar mi turno") < text.indexOf("Agregar a Google Calendar"));
});

test("patient emails gate Meet behind Reku and never expose Google's URL", () => {
  const withMeet = {
    ...appointment,
    google_meet_url: "https://meet.google.com/private-raw-url",
  };

  for (const content of [
    patientConfirmationText({ appointment: withMeet, manageUrl }),
    patientConfirmationHtml({ appointment: withMeet, manageUrl }),
    patientFollowupText({ appointment: withMeet, manageUrl }),
    patientFollowupHtml({ appointment: withMeet, manageUrl }),
  ]) {
    assert.match(content, /acceso.*videollamada/i);
    assert.match(content, /10 minutos antes/i);
    assert.match(content, /15 minutos después/i);
    assert.match(content, /manage=private-token/);
    assert.doesNotMatch(content, /meet\.google\.com\/private-raw-url/);
  }
});

test("patient emails include the triage URL when it was assigned", () => {
  const withTriage = {
    ...appointment,
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/example",
  };

  for (const content of [
    patientConfirmationText({ appointment: withTriage }),
    patientConfirmationHtml({ appointment: withTriage }),
    patientFollowupText({ appointment: withTriage }),
    patientFollowupHtml({ appointment: withTriage }),
  ]) {
    assert.match(content, /patient-dev2\.rehub\.cloud\/opentriage\/example/);
    assert.match(content, /cuestionario/i);
  }
});

test("patient emails continue normally without mentioning triage after an assignment failure", () => {
  for (const content of [
    patientConfirmationText({ appointment }),
    patientConfirmationHtml({ appointment }),
    patientFollowupText({ appointment }),
    patientFollowupHtml({ appointment }),
  ]) {
    assert.doesNotMatch(content, /cuestionario/i);
    assert.doesNotMatch(content, /rehub\.cloud/i);
  }
});

test("Google synchronization failures do not suppress booking confirmation emails", async () => {
  const source = await readFile(
    new URL("../src/appointment-notifications.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /reason: "google_calendar_pending"/);
  assert.match(
    source,
    /googleCalendar = \{ ok: false, error: error\.message \};[\s\S]*notifyPatientForAppointment\(appointmentId\)[\s\S]*notifyProfessionalForAppointment\(appointmentId\)/,
  );
});

test("24-hour maintenance schedules independent patient and professional reminders", async () => {
  const [notifications, database, bookingApi, adminApi] = await Promise.all([
    readFile(new URL("../src/appointment-notifications.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/db.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/booking-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/admin-api.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(notifications, /notifyProfessionalAppointmentFollowup/);
  assert.match(
    notifications,
    /Promise\.all\(\[\s*notifyPatientAppointmentFollowup[\s\S]*notifyProfessionalAppointmentFollowup/,
  );
  assert.match(database, /professional_followup_notified_at TIMESTAMPTZ/);
  assert.match(database, /appointments_professional_followup_pending_idx/);
  assert.match(bookingApi, /professional_followup_notified_at = NULL/);
  assert.match(adminApi, /professional_followup_notified_at = NULL/);
});

test("manual triage reminders include the assigned questionnaire and safe fallback copy", () => {
  const withTriage = {
    ...appointment,
    patient_name: "Paciente <Reku>",
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/reminder-example",
  };

  const text = patientTriageReminderText({ appointment: withTriage });
  const html = patientTriageReminderHtml({ appointment: withTriage });

  assert.match(text, /reminder-example/);
  assert.match(text, /Si todavía no completaste/i);
  assert.match(html, /reminder-example/);
  assert.match(html, /Si ya lo completaste, podés ignorar/i);
  assert.doesNotMatch(html, /Paciente <Reku>/);
  assert.match(html, /Paciente &lt;Reku&gt;/);
});
