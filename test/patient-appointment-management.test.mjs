import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  patientAppointmentCapabilities,
  patientMeetAccess,
} from "../src/booking-api.mjs";
import { enforcePatientAppointmentOrigin } from "../src/patient-appointment-links.mjs";

const futureAppointment = {
  status: "confirmed",
  payment_status: "approved",
  is_future: true,
  professional_available: true,
};

test("only future settled appointments can be rescheduled", () => {
  for (const paymentStatus of ["approved", "paid_simulated", "nomina", "free"]) {
    const capabilities = patientAppointmentCapabilities({
      ...futureAppointment,
      payment_status: paymentStatus,
    });
    assert.equal(capabilities.can_reschedule, true);
    assert.equal(capabilities.can_cancel, false);
  }

  assert.equal(
    patientAppointmentCapabilities({
      ...futureAppointment,
      payment_status: "pending",
    }).can_reschedule,
    false,
  );
  assert.equal(
    patientAppointmentCapabilities({
      ...futureAppointment,
      is_future: false,
    }).can_reschedule,
    false,
  );
});

test("only future unpaid reservations can be cancelled", () => {
  const capabilities = patientAppointmentCapabilities({
    ...futureAppointment,
    status: "pending_payment",
    payment_status: "pending",
  });
  assert.equal(capabilities.can_reschedule, false);
  assert.equal(capabilities.can_cancel, true);

  assert.equal(
    patientAppointmentCapabilities({
      ...futureAppointment,
      status: "cancelled",
      payment_status: "pending",
    }).can_cancel,
    false,
  );
  assert.equal(
    patientAppointmentCapabilities({
      ...futureAppointment,
      status: "pending_payment",
      payment_status: "approved",
    }).can_cancel,
    false,
  );
});

test("patient management mutations require the Reku origin", () => {
  assert.doesNotThrow(() =>
    enforcePatientAppointmentOrigin({
      headers: { origin: "https://www.reku.io" },
    }),
  );
  assert.throws(
    () =>
      enforcePatientAppointmentOrigin({
        headers: { origin: "https://attacker.example" },
      }),
    /PATIENT_APPOINTMENT_ORIGIN_INVALID/,
  );
});

test("Meet access is limited to the appointment window", () => {
  const appointment = {
    status: "confirmed",
    google_meet_url: "https://meet.google.com/unique-appointment",
    starts_at: "2026-08-19T13:00:00.000Z",
    ends_at: "2026-08-19T14:00:00.000Z",
  };
  const accessAt = (now) =>
    patientMeetAccess(appointment, {
      now: new Date(now).getTime(),
      earlyMinutes: 10,
      lateMinutes: 15,
    });

  assert.equal(accessAt("2026-08-19T12:49:59.999Z").state, "upcoming");
  assert.equal(accessAt("2026-08-19T12:50:00.000Z").available, true);
  assert.equal(accessAt("2026-08-19T14:15:00.000Z").available, true);
  assert.equal(accessAt("2026-08-19T14:15:00.001Z").state, "finished");
  assert.equal(
    patientMeetAccess({ ...appointment, google_meet_url: "" }).state,
    "not_configured",
  );
  assert.equal(
    patientMeetAccess({ ...appointment, status: "cancelled" }).state,
    "unavailable",
  );
});

test("agenda exposes the allowed patient management actions", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../agenda/app.js", import.meta.url), "utf8"),
    readFile(new URL("../agenda/styles.css", import.meta.url), "utf8"),
  ]);
  const managementView = source.match(
    /function renderAppointmentManagement\(\)[\s\S]*?function renderManagementCancelModal\(\)/,
  )?.[0] || "";
  assert.match(source, /Guardá el mail que recibiste/);
  assert.match(source, /data-action="cancel-management-appointment"/);
  assert.match(managementView, /Completar cuestionario previo/);
  assert.match(managementView, /data-action="toggle-management-documents"/);
  assert.match(managementView, /class="secondary-button management-documents-toggle"/);
  assert.match(managementView, /aria-expanded="\$\{management\.documentsOpen \? 'true' : 'false'\}"/);
  assert.match(managementView, /management-documents-toggle-icon/);
  assert.match(styles, /\.management-documents-toggle\s*\{[^}]*background:\s*#e9f8fb/s);
  assert.match(styles, /\.management-documents-toggle:not\(:disabled\):hover,[\s\S]*?background:\s*#d7f0f5/);
  assert.match(styles, /\[aria-expanded='true'\][^{]*management-documents-toggle-icon\s*\{[^}]*rotate\(180deg\)/s);
  assert.match(source, /management-documents-form/);
  assert.match(source, /\/api\/booking\/manage\/documents/);
  assert.match(managementView, /open-management-reschedule/);
  assert.match(managementView, /capabilities\.can_reschedule/);
  assert.match(managementView, />Mover turno<\/button>/);
  assert.doesNotMatch(managementView, /calendarActions\(/);
  assert.match(source, /\/api\/booking\/manage\/calendar\.ics/);
  assert.match(source, /\/api\/booking\/manage\/google-calendar/);
  assert.match(
    source,
    /shouldDownloadCalendar[\s\S]*prefers_google_calendar[\s\S]*manage\/google-calendar/,
  );
  assert.match(source, /\/api\/booking\/manage\/meet/);
  assert.match(source, /La videollamada todavía no está disponible/);
  assert.match(source, /Tu turno es el/);
});

test("managed document uploads use the private session and same-origin protection", async () => {
  const source = await readFile(new URL("../src/booking-api.mjs", import.meta.url), "utf8");
  const handler = source.match(
    /const uploadManagedAppointmentDocuments[\s\S]*?\n};/,
  )?.[0] || "";
  assert.match(handler, /enforcePatientAppointmentOrigin\(request\)/);
  assert.match(handler, /requireManagedAppointment\(request\)/);
  assert.match(handler, /appointment\.status !== "confirmed"/);
  assert.match(source, /pathname === "\/api\/booking\/manage\/documents"/);
});

test("managed document confirmation stays in the open upload panel", async () => {
  const source = await readFile(new URL("../agenda/app.js", import.meta.url), "utf8");
  const submit = source.match(
    /async function submitManagementDocuments[\s\S]*?async function loadManagementDays/,
  )?.[0] || "";
  const panel = source.match(
    /function renderManagementDocumentsPanel[\s\S]*?function renderAppointmentManagement/,
  )?.[0] || "";
  assert.match(submit, /management\.documentsMessage = payload\.message/);
  assert.doesNotMatch(submit, /management\.documentsOpen = false/);
  assert.ok(
    panel.indexOf("Enviar documentación") < panel.indexOf("management.documentsMessage"),
  );
});

test("managed appointments reuse the booking cobranded header", async () => {
  const [agendaSource, bookingSource] = await Promise.all([
    readFile(new URL("../agenda/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/booking-api.mjs", import.meta.url), "utf8"),
  ]);
  const header = agendaSource.match(
    /function renderHeader\(\)[\s\S]*?function fieldError/,
  )?.[0] || "";
  assert.match(header, /state\.management\.appointment\?\.agreement/);
  assert.match(header, /booking-brand-lockup cobranded/);
  assert.match(header, /agreement-brand-logo/);
  assert.match(header, /cobranded-reku-logo/);
  assert.match(bookingSource, /LEFT JOIN agreements agreement ON agreement\.id = appointment\.agreement_id/);
  assert.match(bookingSource, /agreement_logo_path/);
});
