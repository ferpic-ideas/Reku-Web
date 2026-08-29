import assert from "node:assert/strict";
import test from "node:test";
import {
  createMercadoPagoReturnCredential,
  mercadoPagoReturnUrl,
  validateMercadoPagoPaymentForAppointment,
  verifyMercadoPagoReturnToken,
} from "../src/mercado-pago.mjs";
import { isLegacyMercadoPagoReturnEligible } from "../src/booking-api.mjs";
import { patientIntakeVerificationUrl } from "../src/patient-intakes.mjs";

const appointment = {
  id: 35,
  amount: 25000,
  payment_preference_id: "pref-35",
  payment_external_reference: "reku-appointment-35",
};

const payment = {
  id: "payment-35",
  status: "approved",
  external_reference: "reku-appointment-35",
  preference_id: "pref-35",
  transaction_amount: 25000,
  currency_id: "ARS",
  metadata: { appointment_id: 35 },
};

test("verification links open directly on the agreement subdomain", () => {
  assert.equal(
    patientIntakeVerificationUrl({
      token: "verification token",
      agreement: { slug: "artro", subdomain_prefix: "artro" },
      appPublicUrl: "https://www.reku.io",
    }),
    "https://artro.reku.io/turnos/#verify=verification%20token",
  );
});

test("payment back URLs preserve the agreement host and carry dedicated access", () => {
  const url = new URL(
    mercadoPagoReturnUrl({
      returnAgendaUrl: "https://artro.reku.io/turnos/",
      appointmentId: 35,
      result: "success",
      returnToken: "return-token",
    }),
  );
  assert.equal(url.origin, "https://artro.reku.io");
  assert.equal(url.pathname, "/turnos/");
  assert.equal(url.searchParams.get("appointment_id"), "35");
  assert.equal(url.searchParams.get("mp_return"), "success");
  assert.equal(url.searchParams.get("payment_return_token"), "return-token");
});

test("payment return credentials reject wrong and expired tokens", () => {
  const now = new Date("2026-08-29T01:00:00.000Z");
  const credential = createMercadoPagoReturnCredential({
    token: "correct-token",
    now,
    ttlHours: 2,
  });
  assert.equal(
    verifyMercadoPagoReturnToken({
      token: "correct-token",
      tokenHash: credential.token_hash,
      expiresAt: credential.expires_at,
      now: new Date("2026-08-29T02:59:59.000Z"),
    }),
    true,
  );
  assert.equal(
    verifyMercadoPagoReturnToken({
      token: "wrong-token",
      tokenHash: credential.token_hash,
      expiresAt: credential.expires_at,
      now,
    }),
    false,
  );
  assert.equal(
    verifyMercadoPagoReturnToken({
      token: "correct-token",
      tokenHash: credential.token_hash,
      expiresAt: credential.expires_at,
      now: new Date("2026-08-29T03:00:01.000Z"),
    }),
    false,
  );
});

test("payment reconciliation accepts only the exact appointment, preference and amount", () => {
  assert.equal(validateMercadoPagoPaymentForAppointment(payment, appointment), true);
  assert.equal(
    validateMercadoPagoPaymentForAppointment(
      { ...payment, preference_id: undefined },
      appointment,
    ),
    true,
  );

  for (const invalidPayment of [
    { ...payment, external_reference: "reku-appointment-36" },
    { ...payment, metadata: { appointment_id: 36 } },
    { ...payment, preference_id: "pref-other" },
    { ...payment, transaction_amount: 24999 },
    { ...payment, currency_id: "USD" },
  ]) {
    assert.throws(
      () => validateMercadoPagoPaymentForAppointment(invalidPayment, appointment),
      /MERCADO_PAGO_PAYMENT_/,
    );
  }
});

test("legacy recovery is narrow, recent and disabled once dedicated access exists", () => {
  const now = new Date("2026-08-29T02:00:00.000Z");
  assert.equal(
    isLegacyMercadoPagoReturnEligible(
      { created_at: "2026-08-29T01:44:25.000Z", payment_return_token_hash: null },
      { now },
    ),
    true,
  );
  assert.equal(
    isLegacyMercadoPagoReturnEligible(
      { created_at: "2026-08-28T18:00:00.000Z", payment_return_token_hash: null },
      { now },
    ),
    false,
  );
  assert.equal(
    isLegacyMercadoPagoReturnEligible(
      { created_at: "2026-08-29T01:44:25.000Z", payment_return_token_hash: "set" },
      { now },
    ),
    false,
  );
  assert.equal(
    isLegacyMercadoPagoReturnEligible(
      { created_at: "2026-08-29T02:00:01.000Z", payment_return_token_hash: null },
      { now },
    ),
    false,
  );
});

test("the agenda redirects cross-host verification and removes payment credentials", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../agenda/app.js", import.meta.url), "utf8"),
  );
  assert.match(source, /bookingUrl\.origin !== window\.location\.origin/);
  assert.match(source, /window\.location\.replace\(bookingUrl\.toString\(\)\)/);
  assert.match(source, /payment_return_token/);
  assert.match(source, /removePaymentReturnParams\(\)/);
});
