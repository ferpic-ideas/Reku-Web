import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("professional agreements are persisted and existing data is backfilled", async () => {
  const migration = await readFile(
    new URL("../migrations/013_professional_agreements.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS professional_agreements/);
  assert.match(migration, /PRIMARY KEY \(professional_id, agreement_id\)/);
  assert.match(migration, /CROSS JOIN agreements/);
  assert.match(migration, /ON CONFLICT DO NOTHING/);
});

test("admin assigns agreements and warns when an agreement has no professionals", async () => {
  const [apiSource, appSource] = await Promise.all([
    readFile(new URL("../src/admin-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../admin/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(apiSource, /AS professional_count/);
  assert.match(apiSource, /AS agreements/);
  assert.match(apiSource, /fields\.agreement_ids/);
  assert.match(apiSource, /INSERT INTO professional_agreements/);
  assert.match(appSource, /name="agreement_ids"/);
  assert.match(appSource, /Acuerdos que atiende/);
  assert.match(appSource, /agreement-professional-warning/);
  assert.match(appSource, /Sin profesionales/);
  assert.match(
    appSource,
    /professional\.agreements[\s\S]*appointment\.agreement_id/,
  );
  assert.match(apiSource, /professional_agreement\.agreement_id = \$5/);
});

test("public booking filters professionals by the current agreement", async () => {
  const source = await readFile(
    new URL("../src/booking-api.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /const listProfessionals = async \(url, response, agreementId = null\)/);
  assert.match(source, /FROM professional_agreements pa/);
  assert.match(source, /pa\.agreement_id = \$2/);
  assert.match(source, /loadEligibleProfessionals\(serviceId, agreementId\)/);
  assert.match(source, /professionalSupportsService\(professionalId, serviceId, agreementId\)/);
  assert.match(source, /link\.agreement\?\.id \|\| null/);
});
