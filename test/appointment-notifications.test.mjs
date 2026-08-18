import assert from "node:assert/strict";
import test from "node:test";
import {
  patientConfirmationHtml,
  patientConfirmationText,
  patientFollowupHtml,
  patientFollowupText,
  patientPendingPaymentHtml,
  patientPendingPaymentText,
  patientTriageReminderHtml,
  patientTriageReminderText,
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

const manageUrl = "https://www.reku.io/agenda/#manage=private-token";

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
    assert.match(content, /aproximadamente 24 horas/i);
    assert.match(content, /opentriage\/example/);
  }
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
