import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublicUploadPath,
  resolveStaticRequestPath,
  resolveStaticPath,
} from "../src/http.mjs";

test("static request routing exposes only declared application entrypoints", () => {
  assert.equal(resolveStaticRequestPath("/"), "/index.html");
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
    resolveStaticRequestPath("/profesional-turnos/private"),
    "/profesional-turnos/private",
  );
});

test("static resolver serves only declared public files and mounts", async () => {
  assert.match(await resolveStaticPath("/index.html"), /index\.html$/);
  assert.match(await resolveStaticPath("/admin/app.js"), /admin\/app\.js$/);
  assert.match(
    await resolveStaticPath("/images/logo-reku.svg"),
    /images\/logo-reku\.svg$/,
  );
  assert.match(
    await resolveStaticPath("/congreso-cokiba/index.html"),
    /congreso-cokiba\/index\.html$/,
  );
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
