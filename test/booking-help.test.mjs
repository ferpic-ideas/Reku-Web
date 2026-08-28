import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { config } from "../src/config.mjs";
import { normalizeSubmission, validateBaseSubmission } from "../src/forms.mjs";

const helpParams = (overrides = {}) =>
  new URLSearchParams({
    "reku-form": "booking-help",
    nombre: "Ana",
    apellido: "Pérez",
    telefono: "+54 11 5555 1212",
    email: "ana@gmail.com",
    motivo: "No encuentro un horario disponible.",
    acuerdo: "YPF",
    pagina: "https://ypf.reku.io/turnos/",
    ...overrides,
  });

test("booking help is validated and sent to the patient intake inbox", () => {
  const submission = normalizeSubmission(helpParams());
  assert.equal(submission.formName, "booking-help");
  assert.equal(submission.to, config.patientIntakeToEmail);
  assert.equal(submission.replyTo, "ana@gmail.com");
  assert.deepEqual(validateBaseSubmission(submission), {});

  const invalid = normalizeSubmission(helpParams({ motivo: "" }));
  assert.equal(
    validateBaseSubmission(invalid).motivo,
    "Contanos brevemente en qué necesitás ayuda.",
  );
});

test("the booking flow exposes a custom help modal and a public POST route", async () => {
  const [agendaSource, serverSource, styles] = await Promise.all([
    readFile(new URL("../agenda/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../agenda/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(agendaSource, /data-action="open-booking-help"/);
  assert.match(agendaSource, /id="booking-help-form"/);
  assert.match(agendaSource, /'reku-form': 'booking-help'/);
  assert.match(agendaSource, /api\('\/turnos\/'/);
  assert.match(agendaSource, /Motivo de consulta/);
  assert.match(serverSource, /"\/turnos", "\/turnos\/"/);
  assert.match(styles, /\.booking-help-modal/);
});
