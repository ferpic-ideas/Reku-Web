import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createPatientEmailVerificationToken,
  readPatientEmailVerificationFromRequest,
  readPatientEmailVerificationToken,
  shouldReusePatientEmailVerification,
} from "../src/patient-email-verification.mjs";
import { hasPriorAppointmentForEmail } from "../src/patient-intakes.mjs";

const now = Date.UTC(2026, 8, 2, 12, 0, 0);

test("patient email verification token round-trips a normalized email", () => {
  const token = createPatientEmailVerificationToken(" Patient@Example.com ", {
    now,
    ttlSeconds: 3600,
  });
  assert.equal(
    readPatientEmailVerificationToken(token, { now: now + 1000 }),
    "patient@example.com",
  );
});

test("patient email verification rejects expired and tampered tokens", () => {
  const token = createPatientEmailVerificationToken("patient@example.com", {
    now,
    ttlSeconds: 60,
  });
  assert.equal(
    readPatientEmailVerificationToken(token, { now: now + 60_000 }),
    "",
  );
  assert.equal(
    readPatientEmailVerificationToken(`${token.slice(0, -1)}x`, { now }),
    "",
  );
});

test("patient email verification is read from its dedicated request cookie", () => {
  const token = createPatientEmailVerificationToken("patient@example.com", {
    now,
    ttlSeconds: 3600,
  });
  const request = {
    headers: {
      cookie: `another=value; reku_booking_verified_email=${encodeURIComponent(token)}`,
    },
  };
  assert.equal(
    readPatientEmailVerificationFromRequest(request, { now }),
    "patient@example.com",
  );
});

test("verification is reused only for the same email with a prior appointment", () => {
  assert.equal(
    shouldReusePatientEmailVerification({
      submittedEmail: "Patient@Example.com",
      rememberedEmail: "patient@example.com",
      hasPriorAppointment: true,
    }),
    true,
  );
  assert.equal(
    shouldReusePatientEmailVerification({
      submittedEmail: "other@example.com",
      rememberedEmail: "patient@example.com",
      hasPriorAppointment: true,
    }),
    false,
  );
  assert.equal(
    shouldReusePatientEmailVerification({
      submittedEmail: "patient@example.com",
      rememberedEmail: "patient@example.com",
      hasPriorAppointment: false,
    }),
    false,
  );
});

test("prior appointment lookup normalizes the email and returns the database result", async () => {
  let parameters;
  const found = await hasPriorAppointmentForEmail(" Patient@Example.com ", {
    queryImpl: async (_sql, values) => {
      parameters = values;
      return { rows: [{ has_prior_appointment: true }] };
    },
  });
  assert.equal(found, true);
  assert.deepEqual(parameters, ["patient@example.com"]);
});

test("booking intake wires remembered verification into direct booking access", async () => {
  const source = await readFile(
    new URL("../src/booking-api.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /readPatientEmailVerificationFromRequest\(request\)[\s\S]+hasPriorAppointmentForEmail\(submission\.values\.email\)/s,
  );
  assert.match(
    source,
    /config\.bookingEmailVerificationEnabled && !reuseEmailVerification/,
  );
  assert.match(
    source,
    /createVerifiedPatientBookingAccess\([\s\S]+patientEmailVerificationCookie\(submission\.values\.email\)/s,
  );
  assert.match(source, /verification_required: false/);
});
