import assert from "node:assert/strict";
import test from "node:test";
import { buildAvailableSlots } from "../src/booking-api.mjs";

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
