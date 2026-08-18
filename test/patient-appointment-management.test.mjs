import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { patientAppointmentCapabilities } from "../src/booking-api.mjs";
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

test("agenda exposes save-mail, reschedule, cancel and triage management actions", async () => {
  const source = await readFile(new URL("../agenda/app.js", import.meta.url), "utf8");
  assert.match(source, /Guardá el mail que recibiste/);
  assert.match(source, /data-action="open-management-reschedule"/);
  assert.match(source, /data-action="cancel-management-appointment"/);
  assert.match(source, /Completar cuestionario previo/);
});
