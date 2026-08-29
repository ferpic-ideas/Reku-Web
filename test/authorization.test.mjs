import test from "node:test";
import assert from "node:assert/strict";
import {
  hasPermission,
  permissionsForRole,
  permissionsForUser,
  requiredPermissionForRequest,
  requiredProfessionalPermissionForRequest,
  requireAdminApiPermission,
  requireProfessionalApiPermission,
} from "../src/authorization.mjs";
import { readFile } from "node:fs/promises";

test("admin retains all declared permissions", () => {
  const admin = { role: "admin" };
  assert.deepEqual(permissionsForRole("admin"), ["*"]);
  assert.equal(hasPermission(admin, "records.delete"), true);
  assert.equal(hasPermission(admin, "settings.write"), true);
});

test("operational user is explicitly denied system and sensitive deletion permissions", () => {
  const user = { role: "user" };
  assert.equal(hasPermission(user, "agreements.read"), true);
  assert.equal(hasPermission(user, "appointments.read"), true);
  assert.equal(hasPermission(user, "appointments.write"), false);
  assert.equal(hasPermission(user, "agreements.write"), false);
  assert.equal(hasPermission(user, "users.read"), false);
  assert.equal(hasPermission(user, "records.delete"), false);
  assert.equal(hasPermission(user, "professionals.revoke_access"), false);
  assert.deepEqual(
    permissionsForUser({ role: "user", permissions: ["records.delete"] }),
    [
      "account.self",
      "dashboard.read",
      "agreements.read",
      "services.read",
      "professionals.read",
      "schedule_blocks.read",
      "appointments.read",
      "records.delete",
    ],
  );
  assert.equal(
    hasPermission({ role: "user", permissions: ["records.delete"] }, "records.delete"),
    true,
  );
  assert.equal(
    hasPermission({ role: "user", permissions: ["*"] }, "settings.write"),
    false,
  );
  assert.throws(
    () =>
      requireAdminApiPermission(
        user,
        "DELETE",
        "/api/admin/patients/42",
      ),
    { message: "PERMISSION_DENIED" },
  );
});

test("professional role has self-service permissions but no admin API access", () => {
  const professional = { role: "professional" };
  assert.equal(hasPermission(professional, "professional.profile.read_self"), true);
  assert.equal(hasPermission(professional, "professional.patients.read_self"), true);
  assert.equal(
    hasPermission(professional, "professional.integrations.google.manage_self"),
    true,
  );
  assert.equal(hasPermission(professional, "appointments.read"), false);
  assert.equal(hasPermission(professional, "users.read"), false);
  assert.throws(
    () =>
      requireAdminApiPermission(
        professional,
        "GET",
        "/api/admin/appointments",
      ),
    { message: "PERMISSION_DENIED" },
  );
});

test("professional route policy is explicit and fails closed", () => {
  const professional = { role: "professional" };
  assert.equal(
    requiredProfessionalPermissionForRequest(
      "GET",
      "/api/professional/patients",
    ),
    "professional.patients.read_self",
  );
  assert.equal(
    requiredProfessionalPermissionForRequest(
      "POST",
      "/api/professional/appointments/42/cancel",
    ),
    "professional.appointments.cancel_self",
  );
  assert.equal(
    requireProfessionalApiPermission(
      professional,
      "GET",
      "/api/professional/appointment-documents/42",
    ),
    "professional.appointments.read_self",
  );
  assert.throws(
    () =>
      requireProfessionalApiPermission(
        professional,
        "GET",
        "/api/professional/unknown",
      ),
    { message: "PERMISSION_DENIED" },
  );
});

test("every authenticated professional route has an explicit permission", () => {
  const routes = [
    ["GET", "/api/professional/auth/me"],
    ["POST", "/api/professional/auth/logout"],
    ["POST", "/api/professional/auth/change-password"],
    ["GET", "/api/professional/profile"],
    ["PUT", "/api/professional/profile"],
    ["GET", "/api/professional/notifications/push"],
    ["POST", "/api/professional/notifications/push/subscriptions"],
    ["POST", "/api/professional/notifications/push/subscriptions/check"],
    ["DELETE", "/api/professional/notifications/push/subscriptions"],
    ["DELETE", "/api/professional/notifications/push/subscriptions/12"],
    ["POST", "/api/professional/notifications/push/test"],
    ["POST", "/api/professional/notifications/push/activation-email"],
    ["GET", "/api/professional/integrations/google"],
    ["POST", "/api/professional/integrations/google/connect"],
    ["POST", "/api/professional/integrations/google/disconnect"],
    ["GET", "/api/professional/availability"],
    ["PUT", "/api/professional/availability"],
    ["GET", "/api/professional/blocks"],
    ["POST", "/api/professional/blocks"],
    ["DELETE", "/api/professional/blocks/12"],
    ["GET", "/api/professional/patients"],
    ["GET", "/api/professional/appointments"],
    ["GET", "/api/professional/appointment-documents/12"],
    ["HEAD", "/api/professional/appointment-documents/12"],
    ["POST", "/api/professional/appointments/12/cancel"],
    ["POST", "/api/professional/appointments/12/triage-reminder"],
  ];
  for (const [method, pathname] of routes) {
    assert.ok(
      requiredProfessionalPermissionForRequest(method, pathname),
      `${method} ${pathname} quedó sin permiso`,
    );
  }
});

test("professional patient visibility includes confirmed past and future appointments only", async () => {
  const source = await readFile(
    new URL("../src/professional-api.mjs", import.meta.url),
    "utf8",
  );
  const relationshipScope = source.match(
    /AND EXISTS \(\s*SELECT 1\s*FROM appointments related_appointment[\s\S]*?\n\s*\)/,
  )?.[0] || "";
  assert.match(relationshipScope, /related_appointment\.status = 'confirmed'/);
  assert.doesNotMatch(relationshipScope, /appointment_date/);
  assert.doesNotMatch(relationshipScope, /cancelled|pending_payment/);
});

test("admin route policy fails closed for missing and unknown routes", () => {
  assert.equal(
    requiredPermissionForRequest("PUT", "/api/admin/appointments/12"),
    "appointments.write",
  );
  assert.equal(
    requiredPermissionForRequest("POST", "/api/admin/appointments/12/cancel"),
    "appointments.write",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/appointments/12/slots"),
    "appointments.write",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/appointment-documents/12"),
    "appointments.read",
  );
  assert.equal(
    requiredPermissionForRequest("HEAD", "/api/admin/appointment-documents/12"),
    "appointments.read",
  );
  assert.equal(
    requiredPermissionForRequest(
      "POST",
      "/api/admin/professionals/12/revoke-access",
    ),
    "professionals.revoke_access",
  );
  assert.equal(
    requiredPermissionForRequest("DELETE", "/api/admin/agreements/12"),
    "agreements.delete",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/patients"),
    "patient_intakes.read",
  );
  assert.equal(
    requiredPermissionForRequest("DELETE", "/api/admin/patients/12"),
    "records.delete",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/congress-registrations"),
    "contacts.read",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/congress-registrations.csv"),
    "contacts.read",
  );
  assert.equal(
    requiredPermissionForRequest(
      "DELETE",
      "/api/admin/congress-registrations/12",
    ),
    "records.delete",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/future-unmapped-route"),
    null,
  );
  assert.throws(
    () =>
      requireAdminApiPermission(
        { role: "admin" },
        "GET",
        "/api/admin/future-unmapped-route",
      ),
    { message: "PERMISSION_DENIED" },
  );
});

test("settlements and agreement credentials are protected by dedicated permissions", () => {
  assert.equal(
    requiredPermissionForRequest("POST", "/api/admin/agreements/4/api-credentials"),
    "agreements.write",
  );
  assert.equal(
    requiredPermissionForRequest("POST", "/api/admin/agreements/4/api-credentials/9/revoke"),
    "agreements.write",
  );
  assert.equal(
    requiredPermissionForRequest("GET", "/api/admin/settlements/preview"),
    "settlements.read",
  );
  assert.equal(
    requiredPermissionForRequest("POST", "/api/admin/settlements"),
    "settlements.write",
  );
});
