import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolvePublicUploadPath,
  resolveStaticRequestPath,
  resolveStaticPath,
} from "../src/http.mjs";

test("static request routing exposes only declared application entrypoints", () => {
  assert.equal(resolveStaticRequestPath("/"), "/index.html");
  assert.equal(
    resolveStaticRequestPath("/privacidad"),
    "/privacidad/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/privacidad/"),
    "/privacidad/index.html",
  );
  assert.equal(resolveStaticRequestPath("/terminos"), "/terminos/index.html");
  assert.equal(resolveStaticRequestPath("/terminos/"), "/terminos/index.html");
  assert.equal(resolveStaticRequestPath("/agenda/"), "/agenda/index.html");
  assert.equal(
    resolveStaticRequestPath("/congreso-cokiba"),
    "/congreso-cokiba/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/congreso-cokiba/"),
    "/congreso-cokiba/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/admin/turnos"),
    "/admin/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/profesional-turnos/"),
    "/profesional-turnos/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/profesional-turnos"),
    "/profesional-turnos/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/profesional/"),
    "/profesional/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/profesional/turnos"),
    "/profesional/index.html",
  );
  assert.equal(
    resolveStaticRequestPath("/profesional-turnos/private"),
    "/profesional-turnos/private",
  );
});

test("static resolver serves only declared public files and mounts", async () => {
  assert.match(await resolveStaticPath("/index.html"), /index\.html$/);
  assert.match(await resolveStaticPath("/admin/app.js"), /admin\/app\.js$/);
  assert.match(
    await resolveStaticPath("/profesional/app.js"),
    /profesional\/app\.js$/,
  );
  assert.match(
    await resolveStaticPath("/images/logo-reku.svg"),
    /images\/logo-reku\.svg$/,
  );
  assert.match(
    await resolveStaticPath("/congreso-cokiba/index.html"),
    /congreso-cokiba\/index\.html$/,
  );
  assert.match(
    await resolveStaticPath("/privacidad/index.html"),
    /privacidad\/index\.html$/,
  );
  assert.match(
    await resolveStaticPath("/terminos/index.html"),
    /terminos\/index\.html$/,
  );
  assert.match(await resolveStaticPath("/legal/styles.css"), /legal\/styles\.css$/);
});

test("legal pages identify the operator and disclose Google data use", async () => {
  const privacyPath = await resolveStaticPath("/privacidad/index.html");
  const termsPath = await resolveStaticPath("/terminos/index.html");
  const [privacy, terms] = await Promise.all([
    readFile(privacyPath, "utf8"),
    readFile(termsPath, "utf8"),
  ]);

  assert.match(privacy, /FISIOS S\.A\.S\./);
  assert.match(privacy, /30-71796517-1/);
  assert.match(privacy, /Uso limitado de datos de Google/);
  assert.match(privacy, /api-services-user-data-policy/);
  assert.match(terms, /FISIOS S\.A\.S\./);
  assert.match(terms, /Google Calendar y Google Meet/);
});

test("static resolver blocks source, deployment and secret paths", async () => {
  assert.equal(await resolveStaticPath("/src/admin-api.mjs"), null);
  assert.equal(await resolveStaticPath("/docker-compose.yml"), null);
  assert.equal(await resolveStaticPath("/.env"), null);
  assert.equal(await resolveStaticPath("/reku-admin-password.txt"), null);
  assert.equal(await resolveStaticPath("/admin/../../src/admin-api.mjs"), null);
  assert.equal(
    await resolveStaticPath("/admin/%2e%2e/%2e%2e/src/admin-api.mjs"),
    null,
  );
});

test("public upload resolver rejects SVG and undeclared folders", async () => {
  assert.equal(
    await resolvePublicUploadPath("/uploads/agreements/payload.svg"),
    null,
  );
  assert.equal(
    await resolvePublicUploadPath("/uploads/private/patient.pdf"),
    null,
  );
  assert.equal(
    await resolvePublicUploadPath("/uploads/agreements/../patient.pdf"),
    null,
  );
});
