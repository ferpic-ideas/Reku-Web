import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  patientMeetWaitingState,
} from "../src/patient-meet-waiting.mjs";
import {
  googleMeetCodeFromUrl,
  googleMeetPresenceScope,
} from "../src/google-calendar.mjs";

const appointment = {
  id: 91,
  status: "confirmed",
  google_meet_url: "https://meet.google.com/abc-defg-hij",
  starts_at: "2026-08-28T13:00:00.000Z",
  ends_at: "2026-08-28T13:30:00.000Z",
};

const waitingAt = (now, presence) =>
  patientMeetWaitingState(appointment, presence, {
    now: new Date(now).getTime(),
    earlyMinutes: 10,
    lateMinutes: 15,
  });

test("waiting room changes feedback as the appointment advances", () => {
  assert.equal(
    waitingAt("2026-08-28T12:49:59.999Z", { checked: true, active: false }).state,
    "upcoming",
  );
  assert.equal(
    waitingAt("2026-08-28T12:50:00.000Z", { checked: true, active: false }).state,
    "waiting_early",
  );
  assert.equal(
    waitingAt("2026-08-28T13:00:00.000Z", { checked: true, active: false }).state,
    "waiting_professional",
  );
  assert.equal(
    waitingAt("2026-08-28T13:00:00.000Z", { checked: true, active: true }).state,
    "ready",
  );
  assert.equal(
    waitingAt("2026-08-28T13:00:00.000Z", { checked: true, active: true }).can_enter,
    true,
  );
  assert.equal(
    waitingAt("2026-08-28T13:45:00.001Z", { checked: true, active: true }).state,
    "finished",
  );
});

test("waiting room fails closed when Google presence cannot be checked", () => {
  const status = waitingAt("2026-08-28T13:01:00.000Z", {
    checked: false,
    active: false,
    reason: "reauthorization_required",
  });
  assert.equal(status.state, "checking");
  assert.equal(status.can_enter, false);
  assert.equal(status.presence_reason, "reauthorization_required");
});

test("Meet presence accepts only canonical Google Meet URLs", () => {
  assert.equal(
    googleMeetCodeFromUrl("https://meet.google.com/AbC-DeFg-HiJ?authuser=0"),
    "abc-defg-hij",
  );
  assert.equal(googleMeetCodeFromUrl("https://example.com/abc-defg-hij"), "");
  assert.equal(googleMeetCodeFromUrl("javascript:alert(1)"), "");
  assert.equal(
    googleMeetPresenceScope,
    "https://www.googleapis.com/auth/meetings.space.readonly",
  );
});

test("waiting notifications are deduplicated and Reku escalates after five minutes", async () => {
  const source = await readFile(
    new URL("../src/patient-meet-waiting.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /patient_waiting_professional_notified_at IS NULL/);
  assert.match(source, /patient_waiting_professional_push_notified_at IS NULL/);
  assert.match(source, /notifyProfessionalPatientWaitingPush/);
  assert.match(source, /sendPushToProfessional/);
  assert.match(source, /module=appointments&appointment=\$\{appointment\.id\}&waiting=1/);
  assert.match(source, /patient_waiting_escalated_at IS NULL/);
  assert.match(source, /INTERVAL '5 minutes'/);
  assert.match(source, /patient_waiting_last_seen_at >= NOW\(\) - INTERVAL '1 minute'/);
  assert.match(source, /to: config\.patientIntakeToEmail/);
});

test("the patient UI uses a private branded lobby and automatic polling", async () => {
  const source = await readFile(new URL("../agenda/app.js", import.meta.url), "utf8");
  assert.match(source, /view=videollamada/);
  assert.match(source, /\/api\/booking\/manage\/meet-status/);
  assert.match(source, /Tu profesional todavía no ingresó/);
  assert.match(source, /Estamos contactándolo/);
  assert.match(source, /También avisamos al equipo de Reku/);
  assert.match(source, /refresh_after_seconds/);
});

test("patient emails generate a dedicated private lobby link", async () => {
  const [links, notifications] = await Promise.all([
    readFile(new URL("../src/patient-appointment-links.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/appointment-notifications.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(links, /meet_url: `\$\{config\.appPublicUrl\}\/turnos\/\?view=videollamada#manage=/);
  assert.match(notifications, /meetUrl: manageLink\.meet_url/);
});
