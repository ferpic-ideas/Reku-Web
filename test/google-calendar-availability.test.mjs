import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAvailableSlots,
  filterSlotsByMinimumNotice,
  getBookingGoogleBusyRanges,
  holdGoogleCalendarForBooking,
} from "../src/booking-api.mjs";

test("external Google Calendar events are removed from professional availability", () => {
  const slots = buildAvailableSlots({
    availabilityRanges: [{ start_time: "10:00", end_time: "18:00" }],
    busyRanges: [{ start_time: "14:00", end_time: "16:00" }],
    durationMinutes: 60,
  });

  assert.deepEqual(slots, ["10:00", "11:00", "12:00", "13:00", "16:00", "17:00"]);
});

test("a slot is removed when it only partially overlaps an external event", () => {
  const slots = buildAvailableSlots({
    availabilityRanges: [{ start_time: "13:00", end_time: "16:00" }],
    busyRanges: [{ start_time: "14:00", end_time: "15:00" }],
    durationMinutes: 90,
  });

  assert.deepEqual(slots, []);
});

test("same-day slots require at least 30 minutes notice", () => {
  const slots = ["13:30", "14:00", "14:29", "14:30", "15:00"];

  assert.deepEqual(
    filterSlotsByMinimumNotice({
      slots,
      date: "2026-08-24",
      now: new Date("2026-08-24T17:00:00.000Z"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    ["14:30", "15:00"],
  );

  assert.deepEqual(
    filterSlotsByMinimumNotice({
      slots,
      date: "2026-08-24",
      now: new Date("2026-08-24T17:00:01.000Z"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    ["15:00"],
  );
});

test("the 30-minute cutoff does not remove future-day slots", () => {
  const slots = ["08:00", "09:00"];
  assert.equal(
    filterSlotsByMinimumNotice({
      slots,
      date: "2026-08-25",
      now: new Date("2026-08-24T23:59:59.000Z"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    slots,
  );
});

test("Google availability failures fall back to Reku availability", async () => {
  const audits = [];
  const result = await getBookingGoogleBusyRanges(
    {
      professionalId: 17,
      startDate: "2026-08-24",
      endDateExclusive: "2026-08-25",
    },
    {
      loadBusyRanges: async () => {
        throw new Error("GOOGLE_API_ERROR");
      },
      audit: async (eventType, payload) => audits.push({ eventType, payload }),
      warn: () => {},
    },
  );

  assert.deepEqual(result, {});
  assert.deepEqual(
    buildAvailableSlots({
      availabilityRanges: [{ start_time: "10:00", end_time: "18:00" }],
      busyRanges: [
        { start_time: "11:00", end_time: "12:00" },
        { start_time: "14:00", end_time: "15:00" },
        ...(result["2026-08-24"] || []),
      ],
      durationMinutes: 60,
    }),
    ["10:00", "12:00", "13:00", "15:00", "16:00", "17:00"],
  );
  assert.deepEqual(audits, [
    {
      eventType: "booking.google_calendar.availability_fallback",
      payload: {
        detail: {
          professional_id: 17,
          start_date: "2026-08-24",
          end_date_exclusive: "2026-08-25",
          error: "GOOGLE_API_ERROR",
        },
      },
    },
  ]);
});

test("Google busy ranges are still applied when validation succeeds", async () => {
  const expected = {
    "2026-08-24": [{ start_time: "14:00", end_time: "16:00" }],
  };
  let audited = false;
  const result = await getBookingGoogleBusyRanges(
    {
      professionalId: 17,
      startDate: "2026-08-24",
      endDateExclusive: "2026-08-25",
    },
    {
      loadBusyRanges: async () => expected,
      audit: async () => {
        audited = true;
      },
      warn: () => {},
    },
  );

  assert.equal(result, expected);
  assert.equal(audited, false);
});

test("a Google hold failure does not abort a paid Reku booking", async () => {
  const marked = [];
  const audits = [];
  const result = await holdGoogleCalendarForBooking(88, {
    hold: async () => {
      throw new Error("GOOGLE_API_ERROR");
    },
    markFailed: async (appointmentId, error) => marked.push({ appointmentId, error }),
    audit: async (eventType, payload) => audits.push({ eventType, payload }),
    warn: () => {},
  });

  assert.deepEqual(result, { ok: false, error: "GOOGLE_API_ERROR" });
  assert.deepEqual(marked, [{ appointmentId: 88, error: "GOOGLE_API_ERROR" }]);
  assert.deepEqual(audits, [
    {
      eventType: "appointment.google_calendar.hold_failed",
      payload: {
        detail: {
          appointment_id: 88,
          error: "GOOGLE_API_ERROR",
        },
      },
    },
  ]);
});
