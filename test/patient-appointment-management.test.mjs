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

test("agenda exposes save-mail, gated Meet, reschedule, cancel and triage actions", async () => {
  const source = await readFile(new URL("../agenda/app.js", import.meta.url), "utf8");
  assert.match(source, /Guardá el mail que recibiste/);
  assert.match(source, /data-action="open-management-reschedule"/);
  assert.match(source, /management-reschedule-panel/);
  assert.match(source, /scrollIntoView\(\{[\s\S]*behavior:\s*'smooth'/);
  assert.match(source, /data-action="cancel-management-appointment"/);
  assert.match(source, /Completar cuestionario previo/);
  assert.match(source, /Agregar a mi calendario/);
  assert.match(source, /\/api\/booking\/manage\/calendar\.ics/);
  assert.match(source, /\/api\/booking\/manage\/meet/);
  assert.match(source, /La videollamada todavía no está disponible/);
  assert.match(source, /Tu turno es el/);
});
