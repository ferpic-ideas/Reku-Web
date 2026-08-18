import test from "node:test";
import assert from "node:assert/strict";
import { serializeCsv } from "../src/csv.mjs";

test("CSV export preserves accents, quotes, newlines and arrays", () => {
  const csv = serializeCsv(
    ["Nombre", "Comentario", "Ámbitos"],
    [
      ["María Gómez", 'Hola, "Reku"', ["Consultorio", "Domicilio"]],
      ["Juan Pérez", "Línea 1\nLínea 2", []],
    ],
  );

  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"María Gómez","Hola, ""Reku""","Consultorio \| Domicilio"/);
  assert.match(csv, /"Juan Pérez","Línea 1\nLínea 2",""/);
  assert.ok(csv.endsWith("\r\n"));
});

test("CSV export neutralizes spreadsheet formulas from user data", () => {
  const csv = serializeCsv(
    ["Comentario"],
    [["=2+2"], [" +SUM(A1:A2)"], ["@usuario"], ["-10"]],
  );

  assert.match(csv, /"'=2\+2"/);
  assert.match(csv, /"' \+SUM\(A1:A2\)"/);
  assert.match(csv, /"'@usuario"/);
  assert.match(csv, /"'-10"/);
});
