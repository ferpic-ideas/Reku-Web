import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agenda offers automatic assignment, specialties, documents and triage", async () => {
  const source = await readFile(new URL("../agenda/app.js", import.meta.url), "utf8");
  assert.match(source, /Primera disponibilidad/);
  assert.match(source, /professional\.specialty/);
  assert.match(source, /appointment-documents-form/);
  assert.match(source, /primary-button documents-submit-button/);
  assert.match(source, /documentFiles: \[\]/);
  assert.match(source, /state\.documentFiles = files/);
  assert.match(source, /new DataTransfer\(\)/);
  assert.match(source, /image\/jpeg,image\/png,image\/webp,application\/pdf/);
  assert.match(source, /Último paso: cuestionario previo/);
  assert.match(source, /También vas a recibir este enlace por mail/);
});

test("the selected calendar day uses the same highlighted state as a selected time", async () => {
  const styles = await readFile(new URL("../agenda/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.date-button\.available\.active\s*\{[^}]*border-color:\s*var\(--accent\)/s);
  assert.match(styles, /\.date-button\.available\.active\s*\{[^}]*background:\s*var\(--accent-soft\)/s);
  assert.match(styles, /\.date-button\.available\.active\s*\{[^}]*color:\s*var\(--accent\)/s);
});
