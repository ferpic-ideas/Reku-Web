import assert from "node:assert/strict";
import test from "node:test";
import {
  appointmentCalendarContent,
  appointmentCalendarFilename,
  googleCalendarTemplateUrl,
  isGoogleCalendarEmail,
  patientCalendarActionUrl,
} from "../src/appointment-calendar.mjs";

const appointment = {
  id: 42,
  appointment_date: "2026-08-27",
  starts_at: "2026-08-27T13:00:00.000Z",
  ends_at: "2026-08-27T13:30:00.000Z",
  service_name: "Evaluación Kinésica",
  professional_name: "Fisio Reku",
  reschedule_count: 2,
  google_meet_url: "https://meet.google.com/raw-secret",
};

test("calendar action preserves the private management token in the fragment", () => {
  assert.equal(
    patientCalendarActionUrl("https://www.reku.io/turnos/#manage=private"),
    "https://www.reku.io/turnos/#manage=private&calendar=1",
  );
});

test("Gmail patients receive a direct prefilled Google Calendar action", () => {
  assert.equal(isGoogleCalendarEmail("patient@gmail.com"), true);
  assert.equal(isGoogleCalendarEmail("patient@googlemail.com"), true);
  assert.equal(isGoogleCalendarEmail("patient@example.com"), false);

  const url = new URL(
    googleCalendarTemplateUrl({
      appointment: {
        ...appointment,
        start_time: "10:00",
        end_time: "10:30",
      },
      manageUrl: "https://www.reku.io/turnos/#manage=protected",
    }),
  );
  assert.equal(url.origin, "https://calendar.google.com");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("dates"), "20260827T100000/20260827T103000");
  assert.equal(url.searchParams.get("ctz"), "America/Argentina/Buenos_Aires");
  assert.match(url.searchParams.get("details"), /manage=protected/);
  assert.doesNotMatch(url.toString(), /meet\.google\.com/);
});

test("patient calendar contains the appointment and only the protected Reku URL", () => {
  const content = appointmentCalendarContent({
    appointment,
    manageUrl: "https://www.reku.io/turnos/#manage=protected",
    generatedAt: "2026-08-26T12:00:00.000Z",
  });

  assert.match(content, /UID:appointment-42@reku\.io/);
  assert.match(content, /DTSTART:20260827T130000Z/);
  assert.match(content, /DTEND:20260827T133000Z/);
  assert.match(content, /SEQUENCE:2/);
  assert.match(content, /Evaluación Kinésica con Fisio Reku/);
  assert.match(content, /manage=protected/);
  assert.match(content, /TRIGGER:-PT24H/);
  assert.doesNotMatch(content, /meet\.google\.com/);
  assert.equal(appointmentCalendarFilename(appointment), "turno-reku-2026-08-27.ics");
});
