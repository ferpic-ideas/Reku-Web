import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPatientEmail } from "../src/templates.mjs";

test("patient intake notification stays active with one fixed Reku template", () => {
  const email = buildPatientEmail({
    submission: {
      values: {
        nombre: "María",
        apellido: "Gómez",
        telefono: "+54 11 4444 5555",
        email: "maria@example.com",
        identificador: "YPF-123",
      },
    },
    agreement: {
      name: "YPF",
      type: "Nomina",
      email_subject_template: "CUSTOM SUBJECT",
      email_body_template: "CUSTOM BODY",
    },
  });

  assert.equal(email.subject, "Alta de paciente - YPF");
  assert.match(email.text, /Recibimos una nueva solicitud de alta/);
  assert.match(email.text, /Paciente: María Gómez/);
  assert.match(email.text, /Acuerdo: YPF/);
  assert.doesNotMatch(email.text, /CUSTOM/);
});

test("agreement configuration no longer exposes or accepts email templates", async () => {
  const [adminApp, adminApi, authorization, intake] = await Promise.all([
    readFile(new URL("../admin/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/admin-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/authorization.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/patient-intakes.mjs", import.meta.url), "utf8"),
  ]);

  for (const source of [adminApp, adminApi]) {
    assert.doesNotMatch(source, /email_subject_template|email_body_template/);
    assert.doesNotMatch(source, /send-template-test|validate-template/);
  }
  assert.doesNotMatch(authorization, /\/api\/admin\/templates\//);
  assert.match(intake, /const intakeEmail = buildPatientEmail/);
  assert.match(intake, /to: submission\.to/);
});
