import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adminAppointmentCapabilities } from "../src/admin-api.mjs";

test("admin can edit or cancel only active future appointments", () => {
  for (const status of ["confirmed", "pending_payment"]) {
    assert.deepEqual(
      adminAppointmentCapabilities({ status, is_future: true }),
      { can_edit: true, can_cancel: true },
    );
  }
  for (const appointment of [
    { status: "cancelled", is_future: true },
    { status: "payment_failed", is_future: true },
    { status: "confirmed", is_future: false },
    { status: "pending_payment", is_future: true, reservation_active: false },
  ]) {
    assert.deepEqual(adminAppointmentCapabilities(appointment), {
      can_edit: false,
      can_cancel: false,
    });
  }
});

test("admin turnos UI exposes reassignment, slot selection and cancellation", async () => {
  const source = await readFile(new URL("../admin/app.js", import.meta.url), "utf8");
  assert.match(source, /data-action="edit-appointment"/);
  assert.match(source, /data-action="cancel-appointment"/);
  assert.match(source, /id="appointment-edit-professional"/);
  assert.match(source, /id="appointment-edit-date"/);
  assert.match(source, /id="appointment-edit-slot"/);
  assert.match(source, /id="appointment-cancel-form"/);
  assert.match(source, /reembolso total/);
});

test("pending Calendar holds are patched when an appointment time changes", async () => {
  const source = await readFile(
    new URL("../src/google-calendar.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /const holdEvent =/);
  assert.match(source, /method: "PATCH", body: JSON\.stringify\(holdEvent\)/);
  assert.match(source, /cancelGoogleCalendarEventForProfessional/);
});
