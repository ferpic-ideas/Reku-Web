import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("patient identity is unique by normalized email across intake and booking", async () => {
  const [intakes, booking, migration] = await Promise.all([
    readSource("../src/patient-intakes.mjs"),
    readSource("../src/booking-api.mjs"),
    readSource("../migrations/012_patient_email_identity.sql"),
  ]);

  assert.match(intakes, /ON CONFLICT \(email_normalized\)\s+DO UPDATE/s);
  assert.match(intakes, /INSERT INTO patient_intakes\s+\(\s*patient_id,/s);
  assert.match(booking, /ON CONFLICT \(email_normalized\) DO UPDATE SET/s);
  assert.match(booking, /patient_id,\s+service_id,/s);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS patients_email_normalized_key/);
  assert.match(migration, /UPDATE patient_intakes intake\s+SET patient_id = patient\.id/s);
  assert.match(migration, /UPDATE appointments appointment\s+SET patient_id = patient\.id/s);
});

test("admin patients uses canonical records instead of rendering each intake", async () => {
  const [api, admin] = await Promise.all([
    readSource("../src/admin-api.mjs"),
    readSource("../admin/app.js"),
  ]);

  assert.match(api, /FROM patients patient/);
  assert.match(api, /sendJson\(response, 200, \{ patients:/);
  assert.match(api, /COUNT\(\*\)::int AS appointment_count/);
  assert.match(admin, /api\(`\/api\/admin\/patients/);
  assert.match(admin, /data\.patients \?\? data\.patient_intakes/);
  assert.doesNotMatch(admin, /Posible duplicado/);
});
