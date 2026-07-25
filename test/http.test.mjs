import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublicUploadPath,
  resolveStaticPath,
} from "../src/http.mjs";

test("static resolver serves only declared public files and mounts", async () => {
  assert.match(await resolveStaticPath("/index.html"), /index\.html$/);
  assert.match(await resolveStaticPath("/admin/app.js"), /admin\/app\.js$/);
  assert.match(
    await resolveStaticPath("/images/logo-reku.svg"),
    /images\/logo-reku\.svg$/,
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
