import test from "node:test";
import assert from "node:assert/strict";
import { bookingAccessCookie } from "../src/booking-links.mjs";
import { professionalSessionCookie } from "../src/professional-links.mjs";

test("booking access is stored in a scoped HttpOnly cookie", () => {
  const cookie = bookingAccessCookie(
    "booking-token",
    new Date(Date.now() + 60 * 60 * 1000),
  );
  assert.match(cookie, /^reku_booking_access=booking-token;/);
  assert.match(cookie, /Path=\/api\/booking/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("professional access uses a separate scoped HttpOnly cookie", () => {
  const cookie = professionalSessionCookie("professional-token");
  assert.match(cookie, /^reku_professional_session=professional-token;/);
  assert.match(cookie, /Path=\/api\/professional/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});
