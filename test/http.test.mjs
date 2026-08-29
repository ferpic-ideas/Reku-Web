import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  resolvePublicUploadPath,
  resolveStaticRequestPath,
  resolveStaticPath,
  serveStatic,
  withSecurityHeaders,
} from "../src/http.mjs";

test("security headers only omit frame protection when explicitly requested", () => {
  const regularHeaders = withSecurityHeaders();
  const crossOriginPreviewHeaders = withSecurityHeaders(
    {
      "Content-Security-Policy":
        "default-src 'self'; frame-ancestors https://www.reku.io",
    },
    { omitFrameOptions: true },
  );

  assert.equal(regularHeaders["X-Frame-Options"], "DENY");
  assert.match(
    regularHeaders["Content-Security-Policy"],
    /frame-ancestors 'none'/,
  );
  assert.equal(crossOriginPreviewHeaders["X-Frame-Options"], undefined);
  assert.match(
    crossOriginPreviewHeaders["Content-Security-Policy"],
    /frame-ancestors https:\/\/www\.reku\.io/,
  );
});

test("CSP blocks arbitrary inline scripts and authorizes every shipped inline block by hash", async () => {
  const policy = withSecurityHeaders()["Content-Security-Policy"];
  const scriptDirective = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src "));
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/);
  assert.match(scriptDirective, /https:\/\/www\.googletagmanager\.com/);

  for (const path of [
    "../404.html",
    "../alta-pacientes/index.html",
    "../evidencia.html",
    "../index.html",
    "../producto.html",
  ]) {
    const html = await readFile(new URL(path, import.meta.url), "utf8");
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      const openingTag = match[0].slice(0, match[0].indexOf(">"));
      if (/\bsrc=/.test(openingTag)) continue;
      const hash = createHash("sha256").update(match[1]).digest("base64");
      assert.match(scriptDirective, new RegExp(`sha256-${hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  }
});

test("CSP blocks arbitrary inline styles and authorizes shipped styles by hash", async () => {
  const policy = withSecurityHeaders()["Content-Security-Policy"];
  const styleDirective = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("style-src "));
  assert.doesNotMatch(styleDirective, /'unsafe-inline'/);
  assert.match(styleDirective, /'unsafe-hashes'/);

  for (const path of [
    "../404.html",
    "../admin/index.html",
    "../agenda/index.html",
    "../alta-pacientes/index.html",
    "../congreso-cokiba/index.html",
    "../evidencia.html",
    "../google85f04377b6d8f892.html",
    "../index.html",
    "../integraciones/api/index.html",
    "../privacidad/index.html",
    "../producto.html",
    "../profesional-turnos/index.html",
    "../profesional/index.html",
    "../terminos/index.html",
  ]) {
    const html = await readFile(new URL(path, import.meta.url), "utf8");
    const inlineStyles = [
      ...[...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map(
        (match) => match[1],
      ),
      ...[...html.matchAll(/\sstyle=(['"])(.*?)\1/gi)].map((match) => match[2]),
    ];
    for (const inlineStyle of inlineStyles) {
      const hash = createHash("sha256").update(inlineStyle).digest("base64");
      assert.match(styleDirective, new RegExp(`sha256-${hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  }
});

const captureStaticHeaders = async (pathname, options) => {
  let capturedHeaders;
  await serveStatic(
    { method: "HEAD" },
    {
      writeHead: (_statusCode, headers) => {
        capturedHeaders = headers;
      },
      end: () => {},
    },
    pathname,
    options,
  );
  return capturedHeaders;
};

test("admin can embed only agreement subdomain agenda documents", async () => {
  const adminHeaders = await captureStaticHeaders("/admin/index.html");
  const agreementHeaders = await captureStaticHeaders("/turnos/index.html", {
    agreementSubdomain: true,
  });
  const canonicalAgendaHeaders = await captureStaticHeaders(
    "/turnos/index.html",
  );

  assert.match(
    adminHeaders["Content-Security-Policy"],
    /frame-src 'self' https:\/\/\*\.reku\.io/,
  );
  assert.equal(agreementHeaders["X-Frame-Options"], undefined);
  assert.match(
    agreementHeaders["Content-Security-Policy"],
    /frame-ancestors https:\/\/www\.reku\.io/,
  );
  assert.doesNotMatch(
    agreementHeaders["Content-Security-Policy"],
    /frame-ancestors 'self'/,
  );
  assert.equal(canonicalAgendaHeaders["X-Frame-Options"], "SAMEORIGIN");
  assert.match(
    canonicalAgendaHeaders["Content-Security-Policy"],
    /frame-ancestors 'self'/,
  );
});

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
  assert.equal(
    resolveStaticRequestPath("/integraciones/api/"),
    "/integraciones/api/index.html",
  );
  assert.equal(resolveStaticRequestPath("/api/docs"), "/api/docs/index.html");
  assert.equal(resolveStaticRequestPath("/api/docs/"), "/api/docs/index.html");
  assert.equal(resolveStaticRequestPath("/turnos/"), "/turnos/index.html");
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
  assert.match(
    await resolveStaticPath("/integraciones/api/openapi.json"),
    /integraciones\/api\/openapi\.json$/,
  );
  assert.match(
    await resolveStaticPath("/api/docs/openapi.json"),
    /integraciones\/api\/openapi\.json$/,
  );
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
