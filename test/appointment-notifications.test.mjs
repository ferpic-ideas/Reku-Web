import assert from "node:assert/strict";
import test from "node:test";
import {
  patientConfirmationHtml,
  patientConfirmationText,
  patientFollowupHtml,
  patientFollowupText,
} from "../src/appointment-notifications.mjs";

const appointment = {
  appointment_date: "2026-08-19",
  start_time: "10:00",
  end_time: "11:00",
  service_name: "Evaluación",
  professional_name: "Fisio Reku",
  google_meet_url: "",
};

test("patient emails include the triage URL when it was assigned", () => {
  const withTriage = {
    ...appointment,
    triage_url: "https://patient-dev2.rehub.cloud/opentriage/example",
  };

  for (const content of [
    patientConfirmationText({ appointment: withTriage }),
    patientConfirmationHtml({ appointment: withTriage }),
    patientFollowupText({ appointment: withTriage }),
    patientFollowupHtml({ appointment: withTriage }),
  ]) {
    assert.match(content, /patient-dev2\.rehub\.cloud\/opentriage\/example/);
    assert.match(content, /cuestionario/i);
  }
});

test("patient emails continue normally without mentioning triage after an assignment failure", () => {
  for (const content of [
    patientConfirmationText({ appointment }),
    patientConfirmationHtml({ appointment }),
    patientFollowupText({ appointment }),
    patientFollowupHtml({ appointment }),
  ]) {
    assert.doesNotMatch(content, /cuestionario/i);
    assert.doesNotMatch(content, /rehub\.cloud/i);
  }
});

