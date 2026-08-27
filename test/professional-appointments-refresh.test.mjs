import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("professional appointments refresh on entry and poll every five minutes", async () => {
  const source = await readFile(
    new URL("../profesional/app.js", import.meta.url),
    "utf8",
  );
  const moduleHandlers = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let appointmentsRequests = 0;
  let appointmentSearchHandler = null;
  let appointmentDetailsHandler = null;
  let html = "";

  const moduleButtons = ["overview", "appointments", "patients", "availability", "profile"].map(
    (module) => ({
      dataset: { module },
      addEventListener(event, handler) {
        if (event === "click") moduleHandlers.set(module, handler);
      },
    }),
  );
  const app = {
    className: "",
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
    },
    querySelectorAll(selector) {
      if (selector === "[data-module]") return moduleButtons;
      if (
        selector === '[data-action="appointment-patient-details"]' &&
        html.includes('data-action="appointment-patient-details"')
      ) {
        return [
          {
            dataset: { id: "10" },
            addEventListener(event, handler) {
              if (event === "click") appointmentDetailsHandler = handler;
            },
          },
        ];
      }
      return [];
    },
  };
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  });
  const fetch = async (path) => {
    if (path === "/api/professional/auth/me") {
      return jsonResponse({
        user: { name: "Profesional", email: "pro@example.com" },
        professional: { name: "Profesional" },
        csrf_token: "csrf",
      });
    }
    if (path === "/api/professional/profile") {
      return jsonResponse({ profile: { name: "Profesional" }, services: [] });
    }
    if (path === "/api/professional/availability") {
      return jsonResponse({ availability: [] });
    }
    if (path === "/api/professional/blocks") {
      return jsonResponse({ schedule_blocks: [] });
    }
    if (path === "/api/professional/patients") {
      return jsonResponse({ patients: [] });
    }
    if (path === "/api/professional/integrations/google") {
      return jsonResponse({ google: { available: false, connected: false } });
    }
    if (path === "/api/professional/appointments") {
      appointmentsRequests += 1;
      return jsonResponse({
        appointments: appointmentsRequests === 1
          ? []
          : [
              {
                id: 10,
                patient_id: 100,
                date: "2026-08-24",
                start_time: "14:20",
                end_time: "14:50",
                patient_name: "Paciente actualizado",
                service_name: "Evaluación",
                agreement_name: "YPF",
                agreement_type: "Nomina",
                status: "confirmed",
                google_meet_url: "https://meet.google.com/available",
                documents: [
                  {
                    id: 50,
                    kind: "link",
                    name: "Estudio por enlace",
                    url: "https://imagenes.example.com/estudio/50",
                  },
                ],
              },
              {
                id: 11,
                patient_id: 101,
                date: "2026-08-24",
                start_time: "14:21",
                end_time: "14:51",
                patient_name: "Paciente futuro",
                service_name: "Evaluación",
                status: "confirmed",
                google_meet_url: "https://meet.google.com/too-early",
              },
              {
                id: 12,
                patient_id: 102,
                date: "2026-08-24",
                start_time: "15:00",
                end_time: "15:30",
                patient_name: "Paciente cancelado",
                service_name: "Evaluación",
                status: "cancelled",
                google_meet_url: "https://meet.google.com/cancelled",
              },
            ],
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const document = {
    visibilityState: "visible",
    getElementById(id) {
      if (id === "professional-portal") return app;
      if (id === "appointment-search-form" && html.includes('id="appointment-search-form"')) {
        return {
          addEventListener(event, handler) {
            if (event === "submit") appointmentSearchHandler = handler;
          },
        };
      }
      return null;
    },
    addEventListener() {},
  };
  const window = {
    location: { hash: "", search: "", pathname: "/profesional/" },
    history: { replaceState() {} },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const fixedNow = new Date("2026-08-24T17:00:00.000Z").getTime();
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNow;
    }
  }

  vm.runInNewContext(source, {
    console,
    Date: FixedDate,
    FormData,
    Intl,
    Number,
    Object,
    String,
    URLSearchParams,
    document,
    fetch,
    window,
  });

  await flushAsyncWork();
  assert.equal(appointmentsRequests, 1);
  assert.equal(timers.size, 0);

  await moduleHandlers.get("appointments")();
  await flushAsyncWork();

  assert.equal(appointmentsRequests, 2);
  assert.match(html, /Paciente actualizado/);
  assert.match(html, /Acuerdo: YPF/);
  assert.match(html, /https:\/\/meet\.google\.com\/available/);
  assert.doesNotMatch(html, /https:\/\/meet\.google\.com\/too-early/);
  assert.doesNotMatch(html, /https:\/\/meet\.google\.com\/cancelled/);
  assert.match(html, /Disponible desde las 14:01/);
  assert.match(html, /data-action="appointment-patient-details"/);
  assert.match(html, /data-action="cancel-appointment"/);
  assert.match(html, /Actualización automática cada 5 min/);
  assert.equal(timers.size, 2);
  assert.ok([...timers.values()].some((timer) => timer.delay === 5 * 60 * 1000));
  assert.ok([...timers.values()].some((timer) => timer.delay === 60 * 1000));

  appointmentDetailsHandler();
  assert.match(html, /Documentación del turno/);
  assert.match(html, /https:\/\/imagenes\.example\.com\/estudio\/50/);

  appointmentSearchHandler({
    preventDefault() {},
    currentTarget: { q: { value: "futuro" } },
  });
  const filteredTable = html.match(/<table>[\s\S]*?<\/table>/)?.[0] || "";
  assert.match(filteredTable, /Paciente futuro/);
  assert.doesNotMatch(filteredTable, /Paciente actualizado/);
  assert.doesNotMatch(filteredTable, /Paciente cancelado/);

  moduleHandlers.get("overview")();
  assert.equal(
    [...timers.values()].filter((timer) => timer.delay === 5 * 60 * 1000).length,
    0,
  );
});

test("all booking confirmations use custom application modals", async () => {
  const [professionalSource, agendaSource, professionalApiSource] = await Promise.all([
    readFile(new URL("../profesional/app.js", import.meta.url), "utf8"),
    readFile(new URL("../agenda/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/professional-api.mjs", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(professionalSource, /window\.(?:confirm|prompt|alert)\s*\(/);
  assert.doesNotMatch(agendaSource, /window\.(?:confirm|prompt|alert)\s*\(/);
  assert.match(professionalSource, /function renderActionModal\(/);
  assert.match(professionalSource, /documents:\s*appointment\.documents\s*\|\|\s*\[\]/);
  assert.match(professionalSource, /Documentación \$\{patient\.detail_appointment/);
  assert.match(agendaSource, /function renderManagementCancelModal\(/);
  assert.match(professionalApiSource, /patient_id:\s*row\.patient_id/);
});

test("upcoming appointments separate each day with a full-width color band", async () => {
  const styles = await readFile(
    new URL("../profesional-turnos/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.day-title\s*\{[^}]*width:\s*100%/s);
  assert.match(styles, /\.day-title\s*\{[^}]*background:\s*#e4f4f7/s);
  assert.match(styles, /\.day-title\s*\{[^}]*padding:\s*10px 14px/s);
});
