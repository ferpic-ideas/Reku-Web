import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("professional link shows agreement and Meet only inside the access window", async () => {
  const source = await readFile(
    new URL("../profesional-turnos/app.js", import.meta.url),
    "utf8",
  );
  let html = "";
  const timers = [];
  const app = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
    },
  };
  const response = (payload) => ({
    ok: true,
    async json() {
      return payload;
    },
  });
  const fetch = async (path) => {
    if (path === "/api/professional/session") return response({ ok: true });
    if (path === "/api/professional/appointments") {
      return response({
        professional: { name: "Profesional" },
        appointments: [
          {
            id: 1,
            date: "2026-08-26",
            start_time: "14:15",
            end_time: "14:45",
            patient_name: "Paciente YPF",
            service_name: "Evaluación",
            agreement_name: "YPF",
            google_meet_url: "https://meet.google.com/available-room",
          },
          {
            id: 2,
            date: "2026-08-26",
            start_time: "15:00",
            end_time: "15:30",
            patient_name: "Paciente futuro",
            service_name: "Evaluación",
            agreement_name: "",
            google_meet_url: "https://meet.google.com/too-early-room",
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const fixedNow = new Date("2026-08-26T17:00:00.000Z").getTime();
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNow;
    }
  }
  const window = {
    location: {
      search: "",
      hash: "#token=private-token",
    },
    history: { replaceState() {} },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
  };
  const document = {
    getElementById(id) {
      return id === "professional-app" ? app : null;
    },
  };

  vm.runInNewContext(source, {
    console,
    Date: FixedDate,
    Intl,
    Number,
    URLSearchParams,
    document,
    fetch,
    window,
  });
  await flushAsyncWork();

  assert.match(html, /Acuerdo: YPF/);
  assert.match(html, /https:\/\/meet\.google\.com\/available-room/);
  assert.doesNotMatch(html, /https:\/\/meet\.google\.com\/too-early-room/);
  assert.match(html, /Acceder a Google Meet/);
  assert.ok(timers.some(({ delay }) => delay === 40 * 60 * 1000));
});
