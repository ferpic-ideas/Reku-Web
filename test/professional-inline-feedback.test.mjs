import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../profesional/app.js", import.meta.url),
  "utf8",
);

test("professional actions render their feedback next to the triggering controls", () => {
  assert.match(source, /statusContext: 'global'/);
  assert.match(source, /function renderStatus\(context = 'global'\)/);
  assert.match(source, /Guardar horarios[\s\S]*?renderStatus\('availability'\)/);
  assert.match(source, /Guardar perfil[\s\S]*?renderStatus\('profile'\)/);
  assert.match(source, /Actualizar contraseña[\s\S]*?renderStatus\('password'\)/);
  assert.match(source, /\$\{googleAction\}[\s\S]*?renderStatus\('google'\)/);
});

test("modal feedback appears after its action buttons", () => {
  const details = source.match(
    /function renderPatientDetails[\s\S]*?function renderActionModal/,
  )?.[0] || "";
  assert.ok(
    details.indexOf("patient-detail-actions") < details.indexOf("state.patientDetailMessage"),
  );

  const actionModal = source.match(
    /function renderActionModal[\s\S]*?function renderPatients/,
  )?.[0] || "";
  assert.ok(actionModal.indexOf('class="form-actions"') < actionModal.indexOf("modal.error"));
});
