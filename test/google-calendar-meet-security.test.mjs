import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildConfirmedCalendarRequest,
  buildProtectedCalendarRequest,
} from "../src/google-calendar.mjs";

const appointment = {
  service_name: "Kinesiología",
  appointment_date_text: "2026-09-03",
  start_time_text: "10:00",
  end_time_text: "10:45",
  patient_email: "paciente@example.com",
};

test("Meet is created privately before the patient receives the Calendar event", async () => {
  const request = buildConfirmedCalendarRequest({
    appointmentId: 42,
    eventId: "rekuappointment42",
    calendarId: "fisio@example.com",
    appointment,
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.path,
    "/calendars/fisio%40example.com/events?conferenceDataVersion=1&sendUpdates=none",
  );
  assert.deepEqual(body.attendees, []);
  assert.equal(
    body.conferenceData.createRequest.requestId,
    "reku-appointment-42",
  );

  const source = await readFile(
    new URL("../src/google-calendar.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /WHERE google_meet_url = \$1[\s\S]*AND id <> \$2/);
  assert.doesNotMatch(source, /sendUpdates=all/);
});

test("the published Calendar event exposes Reku rooms and not the raw Meet", () => {
  const request = buildProtectedCalendarRequest({
    appointmentId: 42,
    eventId: "rekuappointment42",
    calendarId: "fisio@example.com",
    appointment,
    patientLobbyUrl:
      "https://www.reku.io/turnos/?view=videollamada#manage=private-token",
  });
  const body = JSON.parse(request.options.body);

  assert.equal(request.options.method, "PATCH");
  assert.equal(body.conferenceData, null);
  assert.deepEqual(body.attendees, [{ email: "paciente@example.com" }]);
  assert.match(body.location, /view=videollamada#manage=private-token/);
  assert.match(body.description, /Paciente · Sala de espera/);
  assert.match(body.description, /Profesional · Sala profesional/);
  assert.match(body.description, /appointment=42/);
  assert.doesNotMatch(body.description, /meet\.google\.com/);
});

test("invalid patient emails are not sent to Google Calendar", () => {
  const request = buildProtectedCalendarRequest({
    appointmentId: 43,
    eventId: "rekuappointment43",
    appointment: {
      service_name: "Kinesiología",
      appointment_date_text: "2026-09-03",
      start_time_text: "11:00",
      end_time_text: "11:45",
      patient_email: "correo-invalido",
    },
    patientLobbyUrl: "https://www.reku.io/turnos/?view=videollamada#manage=token",
  });

  assert.deepEqual(JSON.parse(request.options.body).attendees, []);
});
