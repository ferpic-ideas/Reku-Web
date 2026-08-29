import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requiredPermissionForRequest } from "../src/authorization.mjs";

test("admin can send an audited push notification to a professional", async () => {
  const [api, app] = await Promise.all([
    readFile(new URL("../src/admin-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../admin/app.js", import.meta.url), "utf8"),
  ]);

  assert.equal(
    requiredPermissionForRequest(
      "POST",
      "/api/admin/professionals/12/notifications",
    ),
    "professionals.write",
  );
  assert.match(api, /sendPushToProfessional/);
  assert.match(api, /admin\.professional_push\.sent/);
  assert.match(api, /url: "\/profesional\/"/);
  assert.match(api, /PROFESSIONAL_PUSH_NOT_AVAILABLE/);
  assert.match(app, /data-action="notify-professional"/);
  assert.match(app, /id="professional-notification-form"/);
  assert.match(app, /Enviar notificación/);
  assert.match(app, /push_devices/);
});
