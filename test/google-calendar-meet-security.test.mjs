import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("each appointment owns a distinct Meet and patients receive no raw Google invite", async () => {
  const source = await readFile(
    new URL("../src/google-calendar.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /requestId: `reku-appointment-\$\{appointmentId\}`/);
  assert.match(source, /attendees: \[\]/);
  assert.match(source, /conferenceDataVersion=1&sendUpdates=none/);
  assert.match(source, /WHERE google_meet_url = \$1[\s\S]*AND id <> \$2/);
  assert.doesNotMatch(
    source,
    /conferenceDataVersion=1&sendUpdates=all/,
  );
});
