import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeSubmission,
  validateBaseSubmission,
} from "../src/forms.mjs";

const validParams = () =>
  new URLSearchParams({
    "reku-form": "congreso-cokiba",
    nombre: "María",
    apellido: "Gómez",
    profesion: "Lic. en Kinesiología",
    telefono: "+54 9 11 4444 5555",
    email: "maria@gmail.com",
  });

test("congreso COKIBA normalizes its five fields and accepts personal email", () => {
  const submission = normalizeSubmission(validParams());

  assert.equal(submission.formName, "congreso-cokiba");
  assert.equal(submission.subject, "Contacto Reku");
  assert.deepEqual(validateBaseSubmission(submission), {});
  assert.deepEqual(submission.values, {
    nombre: "María",
    apellido: "Gómez",
    profesion: "Lic. en Kinesiología",
    telefono: "+54 9 11 4444 5555",
    email: "maria@gmail.com",
  });
});

test("congreso COKIBA requires profession", () => {
  const params = validParams();
  params.set("profesion", "");
  const errors = validateBaseSubmission(normalizeSubmission(params));

  assert.equal(errors.profesion, "Ingresá tu profesión.");
});

test("congreso COKIBA page posts the expected form fields", async () => {
  const html = await readFile(
    new URL("../congreso-cokiba/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /name="reku-form" value="congreso-cokiba"/);
  for (const field of ["nombre", "apellido", "profesion", "telefono", "email"]) {
    assert.match(html, new RegExp(`name="${field}"`));
  }
});
