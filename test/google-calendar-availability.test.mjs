import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAvailableSlots,
  filterSlotsByMinimumNotice,
  getBookingGoogleBusyRanges,
  holdGoogleCalendarForBooking,
  mapFirstAvailableSlotProfessionals,
} from "../src/booking-api.mjs";

test("first-available slots expose the professional before confirmation", () => {
  const slotProfessionals = mapFirstAvailableSlotProfessionals({
    slots: ["10:00", "10:30", "11:00"],
    availability: [
      {
        professional: { id: 7, name: "Kine A", specialty: "Rodilla" },
        slots: ["10:00", "10:30"],
      },
      {
        professional: { id: 9, name: "Kine B", specialty: "Hombro" },
        slots: ["10:30", "11:00"],
      },
    ],
  });

  assert.deepEqual(slotProfessionals, {
    "10:00": { id: 7, name: "Kine A", photo_url: "", specialty: "Rodilla" },
    "10:30": { id: 7, name: "Kine A", photo_url: "", specialty: "Rodilla" },
    "11:00": { id: 9, name: "Kine B", photo_url: "", specialty: "Hombro" },
  });
});

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
      minimumNoticeMinutes: 30,
      now: new Date("2026-08-24T17:00:00.000Z"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    ["14:30", "15:00"],
  );

  assert.deepEqual(
    filterSlotsByMinimumNotice({
      slots,
      date: "2026-08-24",
      minimumNoticeMinutes: 30,
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
      minimumNoticeMinutes: 30,
      now: new Date("2026-08-24T23:59:59.000Z"),
      timeZone: "America/Argentina/Buenos_Aires",
    }),
    slots,
  );
});

test('the default four-hour notice includes the exact boundary and excludes elapsed seconds', () => {
  const options = {
    slots: ['11:00', '12:00', '13:00', '15:59', '16:00', '16:30'],
    date: '2026-10-28', timeZone: 'America/Argentina/Buenos_Aires',
  };
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, now: new Date('2026-10-28T15:00:00Z') }), ['16:00', '16:30']);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, now: new Date('2026-10-28T15:00:00.001Z') }), ['16:30']);
});

test('zero notice allows upcoming slots but never past times or dates', () => {
  const options = {
    slots: ['11:59', '12:00', '12:01'], date: '2026-10-28', minimumNoticeMinutes: 0,
    now: new Date('2026-10-28T15:00:00Z'), timeZone: 'America/Argentina/Buenos_Aires',
  };
  assert.deepEqual(filterSlotsByMinimumNotice(options), ['12:00', '12:01']);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, now: new Date('2026-10-28T15:00:01Z') }), ['12:01']);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, date: '2026-10-27' }), []);
});

test('notice crosses midnight, month and year boundaries and can span several days', () => {
  const options = {
    slots: ['00:00', '01:00', '01:59', '02:00', '08:00'],
    now: new Date('2026-12-31T22:00:00-03:00'), timeZone: 'America/Argentina/Buenos_Aires',
  };
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, date: '2026-12-31' }), []);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, date: '2027-01-01' }), ['02:00', '08:00']);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, date: '2027-01-02' }), options.slots);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, date: '2027-01-01', minimumNoticeMinutes: 28 * 60 }), []);
  assert.deepEqual(filterSlotsByMinimumNotice({ ...options, date: '2027-01-02', minimumNoticeMinutes: 28 * 60 }), ['02:00', '08:00']);
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
