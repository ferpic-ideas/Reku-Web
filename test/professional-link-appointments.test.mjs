import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { professionalMeetUrl } from "../src/professional-api.mjs";

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("professional Meet links select the connected organizer account", () => {
  assert.equal(
    professionalMeetUrl(
      "https://meet.google.com/abc-defg-hij",
      "Fisio@Example.com",
    ),
    "https://meet.google.com/abc-defg-hij?authuser=fisio%40example.com",
  );
  assert.equal(
    professionalMeetUrl("https://example.com/not-a-meet", "fisio@example.com"),
    "https://example.com/not-a-meet",
  );
});

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
            consultation_report_url: "/api/professional/appointments/1/consultation-report",
            consultation_status: 'completed',
            booking_url: "https://ypf.reku.io/turnos/",
            documents: [
              {
                id: 41,
                kind: "file",
                name: "Resonancia.pdf",
                url: "/api/professional/appointment-documents/41",
              },
            ],
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
          {
            id: 3, date: '2026-08-26', start_time: '16:00', end_time: '16:30',
            patient_name: 'Paciente con cuestionario en curso', consultation_status: 'started',
            triage_url: 'https://patient.rehub.cloud/opentriage/legacy-must-not-render',
          },
          {
            id: 4, date: '2026-08-27', start_time: '09:00', end_time: '09:30',
            patient_name: 'Paciente del día siguiente',
          },
        ].reverse(),
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
      search: "?appointment=1",
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

  assert.match(html, /Acuerdo \/ origen<\/dt><dd>YPF/);
  assert.match(html, /https:\/\/meet\.google\.com\/available-room/);
  assert.doesNotMatch(html, /https:\/\/meet\.google\.com\/too-early-room/);
  assert.match(html, /Entrar a Google Meet/);
  assert.match(html, /Ver informe PDF/);
  const appointmentCards = html.match(/<article class="appointment-row[\s\S]*?<\/article>/g);
  assert.doesNotMatch(appointmentCards[0], /triage-note|El paciente completó el cuestionario/);
  assert.match(appointmentCards[0], /Ver informe PDF/);
  assert.match(appointmentCards[1], /triage-note[\s\S]*El paciente todavía no completó/);
  assert.match(appointmentCards[2], /triage-note[\s\S]*El paciente inició el cuestionario/);
  assert.doesNotMatch(html, /Formulario Triage|ReHub|rehub\.cloud/);
  assert.match(html, /Cuestionario pendiente/);
  assert.match(html, /Cuestionario en curso/);
  assert.match(html, /El paciente inició el cuestionario y todavía no lo completó/);
  assert.match(html, /Resonancia\.pdf/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /Si el paciente quiere comenzar el tratamiento/);
  assert.match(html, /data-action="copy-booking-url"/);
  assert.match(html, /appointment-featured/);
  assert.ok(html.indexOf('Paciente YPF') < html.indexOf('Paciente futuro'));
  assert.ok(html.indexOf('Paciente futuro') < html.indexOf('Paciente con cuestionario en curso'));
  assert.ok(html.indexOf('Paciente con cuestionario en curso') < html.indexOf('Paciente del día siguiente'));
  assert.ok(timers.some(({ delay }) => delay === 40 * 60 * 1000));
});

test('upcoming professional appointments are selected chronologically before the 500 row limit', async () => {
  const source = await readFile(new URL('../src/professional-api.mjs', import.meta.url), 'utf8');
  assert.match(source, /ORDER BY a\.appointment_date \$\{upcomingOnly \? 'ASC' : 'DESC'\},\s*a\.start_time \$\{upcomingOnly \? 'ASC' : 'DESC'\}, a\.id \$\{upcomingOnly \? 'ASC' : 'DESC'\}\s*LIMIT 500/);
});

test("professional preparation rooms expose only scoped appointment resources in new tabs", async () => {
  const [portal, quickAccess, api, links, styles] = await Promise.all([
    readFile(new URL("../profesional/app.js", import.meta.url), "utf8"),
    readFile(new URL("../profesional-turnos/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/professional-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/professional-links.mjs", import.meta.url), "utf8"),
    readFile(new URL("../profesional/styles.css", import.meta.url), "utf8"),
  ]);

  for (const source of [portal, quickAccess]) {
    assert.match(source, /Ver informe PDF/);
    assert.doesNotMatch(source, /Formulario Triage|integración con ReHub/);
    assert.match(source, /Entrar a Google Meet/);
    assert.match(source, /target="_blank" rel="noopener noreferrer"/);
    assert.match(source, /data-action="copy-booking-url"/);
    assert.match(source, /consulta\|evaluacion\|valoracion/);
  }
  assert.match(portal, /Ficha del paciente \+ Meet/);
  assert.match(api, /triage_url:\s*row\.bot_report_available \? professionalReportUrl\(row\.id\)/);
  assert.match(api, /google_connection\.google_email AS professional_google_email/);
  assert.match(api, /url\.searchParams\.set\("authuser", account\)/);
  assert.match(api, /booking_url:\s*agreementBookingUrl/);
  assert.match(api, /WHERE a\.professional_id = \$1/);
  assert.match(links, /accessUrl\.searchParams\.set\("appointment"/);
  assert.match(styles, /\.consultation-room-panel\s*\{[^}]*width:\s*min\(100%, 980px\)/s);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.consultation-room-hero\s*\{[^}]*grid-template-columns:\s*1fr/s);
});
