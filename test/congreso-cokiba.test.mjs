import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeSubmission,
  validateBaseSubmission,
} from "../src/forms.mjs";
import { buildContactEmail } from "../src/templates.mjs";

const validParams = () =>
  new URLSearchParams([
    ["reku-form", "congreso-cokiba"],
    ["nombre_apellido", "María Gómez"],
    ["email", "maria@gmail.com"],
    ["telefono", "+54 9 11 4444 5555"],
    ["profesion", "Kinesiólogo / Fisioterapeuta"],
    ["ambito", "Consultorio / Centro kinésico propio"],
    ["ambito", "Atención a domicilio"],
    ["interes_telerehabilitacion", "Sí, me interesa activamente."],
    [
      "interes_tecnologia",
      "Sí, busco implementar nuevas herramientas digitales.",
    ],
    ["comentario", "Quisiera conocer los próximos pasos."],
  ]);

test("congreso COKIBA normalizes the questionnaire and accepts personal email", () => {
  const submission = normalizeSubmission(validParams());

  assert.equal(submission.formName, "congreso-cokiba");
  assert.equal(submission.subject, "Nuevo registro Congreso COKIBA - Reku");
  assert.deepEqual(validateBaseSubmission(submission), {});
  assert.deepEqual(submission.values, {
    nombre_apellido: "María Gómez",
    profesion: "Kinesiólogo / Fisioterapeuta",
    telefono: "+54 9 11 4444 5555",
    email: "maria@gmail.com",
    ambitos: [
      "Consultorio / Centro kinésico propio",
      "Atención a domicilio",
    ],
    interes_telerehabilitacion: "Sí, me interesa activamente.",
    interes_tecnologia:
      "Sí, busco implementar nuevas herramientas digitales.",
    comentario: "Quisiera conocer los próximos pasos.",
  });
});

test("sumate profesionales uses the same questionnaire with a separate form identity", () => {
  const params = validParams();
  params.set("reku-form", "sumate-profesional");
  const submission = normalizeSubmission(params);

  assert.equal(submission.formName, "sumate-profesional");
  assert.equal(submission.subject, "Nuevo profesional interesado - Reku");
  assert.deepEqual(validateBaseSubmission(submission), {});
});

test("sumate route customizes the shared COKIBA form for professionals", async () => {
  const app = await readFile(
    new URL("../congreso-cokiba/app.js", import.meta.url),
    "utf8",
  );
  assert.match(app, /isProfessionalSignup/);
  assert.match(app, /sumate-profesional/);
  assert.match(app, /Sumate a Reku/);
  assert.match(app, /Quiero sumarme/);
});

test("congreso COKIBA only requires contact data and profession", () => {
  const params = validParams();
  params.delete("ambito");
  params.delete("interes_telerehabilitacion");
  params.delete("interes_tecnologia");
  params.delete("comentario");

  const submission = normalizeSubmission(params);

  assert.deepEqual(validateBaseSubmission(submission), {});
  assert.deepEqual(submission.values.ambitos, []);
  assert.equal(submission.values.comentario, "");
});

test("congreso COKIBA requires both name and surname", () => {
  const params = validParams();
  params.set("nombre_apellido", "María");

  const errors = validateBaseSubmission(normalizeSubmission(params));

  assert.equal(errors.nombre_apellido, "Ingresá tu nombre y apellido.");
});

test("congreso COKIBA requires an allowed profession", () => {
  const params = validParams();
  params.set("profesion", "");
  let errors = validateBaseSubmission(normalizeSubmission(params));
  assert.equal(errors.profesion, "Seleccioná tu profesión o especialidad.");

  params.set("profesion", "Otra profesión");
  errors = validateBaseSubmission(normalizeSubmission(params));
  assert.equal(errors.profesion, "Seleccioná una profesión válida.");
});

test("congreso COKIBA rejects forged optional selections", () => {
  const params = validParams();
  params.append("ambito", "Opción inventada");
  params.set("interes_telerehabilitacion", "Tal vez");
  params.set("interes_tecnologia", "Otro");

  const errors = validateBaseSubmission(normalizeSubmission(params));

  assert.equal(errors.ambito, "Seleccioná únicamente ámbitos válidos.");
  assert.equal(errors.interes_telerehabilitacion, "Seleccioná una opción válida.");
  assert.equal(errors.interes_tecnologia, "Seleccioná una opción válida.");
});

test("congreso COKIBA email renders multiple work settings legibly", () => {
  const email = buildContactEmail(normalizeSubmission(validParams()));

  assert.match(
    email.text,
    /Ámbitos de trabajo: Consultorio \/ Centro kinésico propio, Atención a domicilio/,
  );
  assert.doesNotMatch(email.text, /\[object Object\]/);
});

test("congreso COKIBA page exposes the requested fields and closing message", async () => {
  const html = await readFile(
    new URL("../congreso-cokiba/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /name="reku-form" value="congreso-cokiba"/);
  for (const field of [
    "nombre_apellido",
    "email",
    "telefono",
    "profesion",
    "ambito",
    "interes_telerehabilitacion",
    "interes_tecnologia",
    "comentario",
  ]) {
    assert.match(html, new RegExp(`name="${field}"`));
  }

  assert.match(html, /Sumate a la evolución digital en salud/);
  assert.match(html, /¡Gracias por registrarte!/);
  assert.match(html, /Nos pondremos en contacto contigo a la brevedad\./);
  assert.match(html, /href="\/favicon-32x32\.png\?v=2"/);
  assert.match(html, /href="\/favicon-16x16\.png\?v=2"/);
  assert.match(html, /href="\/favicon\.ico\?v=2"/);
  assert.doesNotMatch(
    html,
    /name="(?:ambito|interes_telerehabilitacion|interes_tecnologia|comentario)"[^>]*required/,
  );
});

test("admin exposes searchable, downloadable and deletable COKIBA contacts", async () => {
  const adminApp = await readFile(
    new URL("../admin/app.js", import.meta.url),
    "utf8",
  );

  assert.match(adminApp, /Congreso COKIBA/);
  assert.match(adminApp, /filterId: 'congress-text-filter'/);
  assert.match(adminApp, /\/api\/admin\/congress-registrations/);
  assert.match(adminApp, /\/api\/admin\/congress-registrations\.csv/);
  assert.match(adminApp, /deleteAction: 'delete-congress-registration'/);
  assert.match(adminApp, /\/api\/admin\/congress-registrations\/\$\{id\}/);
  assert.match(adminApp, /Descargar CSV/);
});

test("admin keeps professional applications in the second contacts tab", async () => {
  const adminApp = await readFile(
    new URL("../admin/app.js", import.meta.url),
    "utf8",
  );

  assert.match(adminApp, /data-tab="professionals"[\s\S]*Profesionales/);
  assert.match(adminApp, /filterId: 'professional-application-text-filter'/);
  assert.match(adminApp, /\/api\/admin\/professional-applications\.csv/);
  assert.match(adminApp, /deleteAction: 'delete-professional-application'/);
  assert.match(adminApp, /label: 'Eliminar registro'/);
  assert.match(adminApp, /destructiveIconButton/);
});
