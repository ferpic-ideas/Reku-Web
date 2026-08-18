import test from "node:test";
import assert from "node:assert/strict";
import {
  createPendingProfessionalUser,
  syncProfessionalUser,
  validateProfessionalPassword,
} from "../src/professional-users.mjs";

const fakeClient = (...responses) => {
  const calls = [];
  return {
    calls,
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return responses.shift() || { rows: [] };
    },
  };
};

test("professional account password is mandatory for a new or missing account", () => {
  assert.throws(
    () => validateProfessionalPassword("", { required: true }),
    { message: "PROFESSIONAL_PASSWORD_REQUIRED" },
  );
  assert.throws(
    () => validateProfessionalPassword("1234567", { required: true }),
    { message: "PROFESSIONAL_PASSWORD_INVALID" },
  );
  assert.equal(validateProfessionalPassword("12345678"), "12345678");
  assert.equal(validateProfessionalPassword(""), "");
});

test("an email invitation reserves an inactive professional account", async () => {
  const client = fakeClient(
    { rows: [] },
    {
      rows: [
        {
          id: "55",
          email: "invite@example.com",
          name: "Profesional invitado",
          role: "professional",
          professional_id: "18",
          is_active: false,
        },
      ],
    },
  );

  const user = await createPendingProfessionalUser(client, {
    professionalId: 18,
    name: "Profesional invitado",
    email: "INVITE@example.com",
    passwordHash: "unusable-placeholder",
  });

  assert.equal(user.is_active, false);
  assert.match(client.calls[1].sql, /is_active\)/);
  assert.deepEqual(client.calls[1].parameters, [
    "invite@example.com",
    "Profesional invitado",
    "unusable-placeholder",
    18,
  ]);
});

test("an invitation cannot replace an active account", async () => {
  const client = fakeClient({
    rows: [
      {
        id: "55",
        email: "invite@example.com",
        role: "professional",
        professional_id: "18",
        is_active: true,
      },
    ],
  });

  await assert.rejects(
    () =>
      createPendingProfessionalUser(client, {
        professionalId: 18,
        name: "Profesional invitado",
        email: "invite@example.com",
        passwordHash: "unusable-placeholder",
      }),
    { message: "PROFESSIONAL_EMAIL_IN_USE" },
  );
});

test("creating a professional also inserts its professional user", async () => {
  const client = fakeClient(
    { rows: [] },
    {
      rows: [
        {
          id: "41",
          email: "pro@example.com",
          name: "Profesional",
          role: "professional",
          professional_id: "12",
          is_active: true,
        },
      ],
    },
  );

  const result = await syncProfessionalUser(client, {
    professionalId: 12,
    name: "Profesional",
    email: "pro@example.com",
    passwordHash: "stored-hash",
  });

  assert.equal(result.action, "created");
  assert.equal(result.user.id, "41");
  assert.match(client.calls[1].sql, /INSERT INTO users/);
  assert.deepEqual(client.calls[1].parameters, [
    "pro@example.com",
    "Profesional",
    "stored-hash",
    12,
  ]);
});

test("editing keeps and synchronizes an active linked professional user", async () => {
  const linked = {
    id: "41",
    email: "old@example.com",
    role: "professional",
    professional_id: "12",
    is_active: true,
  };
  const client = fakeClient(
    { rows: [linked] },
    { rows: [{ ...linked, email: "new@example.com", name: "Nombre nuevo" }] },
  );

  const result = await syncProfessionalUser(client, {
    professionalId: 12,
    name: "Nombre nuevo",
    email: "new@example.com",
  });

  assert.equal(result.action, "updated");
  assert.match(client.calls[1].sql, /UPDATE users/);
  assert.deepEqual(client.calls[1].parameters, [
    "new@example.com",
    "Nombre nuevo",
    null,
    12,
    "41",
  ]);
});

test("editing a professional without an account cannot finish without a password", async () => {
  const client = fakeClient({ rows: [] });

  await assert.rejects(
    () =>
      syncProfessionalUser(client, {
        professionalId: 12,
        name: "Profesional",
        email: "pro@example.com",
      }),
    { message: "PROFESSIONAL_PASSWORD_REQUIRED" },
  );
  assert.equal(client.calls.length, 1);
});

test("a professional cannot take the email of another user", async () => {
  const client = fakeClient({
    rows: [
      {
        id: "99",
        email: "used@example.com",
        role: "user",
        professional_id: null,
        is_active: true,
      },
    ],
  });

  await assert.rejects(
    () =>
      syncProfessionalUser(client, {
        professionalId: 12,
        name: "Profesional",
        email: "used@example.com",
        passwordHash: "stored-hash",
      }),
    { message: "PROFESSIONAL_EMAIL_IN_USE" },
  );
  assert.equal(client.calls.length, 1);
});

test("an inactive unlinked user can be safely reused as the professional account", async () => {
  const inactive = {
    id: "99",
    email: "pro@example.com",
    role: "user",
    professional_id: null,
    is_active: false,
  };
  const client = fakeClient(
    { rows: [inactive] },
    {
      rows: [
        {
          ...inactive,
          name: "Profesional",
          role: "professional",
          professional_id: "12",
          is_active: true,
        },
      ],
    },
  );

  const result = await syncProfessionalUser(client, {
    professionalId: 12,
    name: "Profesional",
    email: "pro@example.com",
    passwordHash: "stored-hash",
  });

  assert.equal(result.action, "reactivated");
  assert.match(client.calls[1].sql, /permissions = ARRAY\[\]::TEXT\[\]/);
});
