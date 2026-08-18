import test from "node:test";
import assert from "node:assert/strict";
import {
  hasPermission,
  permissionsForRole,
  permissionsForUser,
  requiredPermissionForRequest,
  requireAdminApiPermission,
} from "../src/authorization.mjs";

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
        "/api/admin/patient-intakes/42",
      ),
    { message: "PERMISSION_DENIED" },
  );
});

test("professional role has self-service permissions but no admin API access", () => {
  const professional = { role: "professional" };
  assert.equal(hasPermission(professional, "professional.profile.read_self"), true);
  assert.equal(hasPermission(professional, "professional.patients.read_all"), true);
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

test("admin route policy fails closed for missing and unknown routes", () => {
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
