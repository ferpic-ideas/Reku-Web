import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizePushSubscription } from "../src/web-push.mjs";

test("push subscriptions require HTTPS endpoints and valid browser keys", () => {
  const valid = normalizePushSubscription({
    endpoint: "https://push.example.com/send/subscription-id",
    keys: {
      p256dh: "A".repeat(88),
      auth: "b".repeat(22),
    },
  });
  assert.equal(valid.endpoint, "https://push.example.com/send/subscription-id");
  assert.throws(
    () =>
      normalizePushSubscription({
        endpoint: "http://push.example.com/insecure",
        keys: { p256dh: "A".repeat(88), auth: "b".repeat(22) },
      }),
    /PUSH_SUBSCRIPTION_INVALID/,
  );
  assert.throws(
    () =>
      normalizePushSubscription({
        endpoint: "https://push.example.com/send/id",
        keys: { p256dh: "bad key", auth: "short" },
      }),
    /PUSH_SUBSCRIPTION_INVALID/,
  );
});

test("professional Web Push is installable, user-visible and manageable", async () => {
  const [manifestSource, worker, portal, api, migration] = await Promise.all([
    readFile(new URL("../profesional/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../profesional/service-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../profesional/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/professional-api.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../migrations/015_professional_push_notifications.sql", import.meta.url),
      "utf8",
    ),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/profesional/");
  assert.match(worker, /showNotification/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /clients\.openWindow/);
  assert.match(portal, /Activar en este teléfono/);
  assert.match(portal, /Agregar a inicio/);
  assert.match(portal, /Enviarme el link al celular/);
  assert.match(portal, /Enviar prueba/);
  assert.match(api, /notifications\/push\/subscriptions/);
  assert.match(api, /requireMutation\(request, account\)/);
  assert.match(migration, /endpoint TEXT NOT NULL UNIQUE/);
  assert.match(migration, /device_kind IN \('mobile', 'desktop'\)/);
});

test("patient waiting pushes open a protected appointment view with a live delay", async () => {
  const [waiting, portal, adminApi, adminApp] = await Promise.all([
    readFile(new URL("../src/patient-meet-waiting.mjs", import.meta.url), "utf8"),
    readFile(new URL("../profesional/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/admin-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../admin/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(waiting, /Tu paciente ya está esperando/);
  assert.match(waiting, /module=appointments&appointment=/);
  assert.match(portal, /Demora del profesional:/);
  assert.match(portal, /Entrar a Google Meet/);
  assert.match(portal, /Ver Formulario Triage/);
  assert.match(portal, /agreement_name/);
  assert.match(adminApi, /push_mobile_devices/);
  assert.match(adminApp, /All connected/);
  assert.match(adminApp, /Calendar connected/);
  assert.match(adminApp, /Notif connected/);
  assert.match(adminApp, /Nothing connected/);
});
