import assert from "node:assert/strict";
import test from "node:test";
import { analyzeConsultation, nextConsultationStep, transcribeConsultation } from "../src/consultation-bot-ai.mjs";
import { requireBotOrigin, resolveBotBrand } from "../src/consultation-bot.mjs";
import { serveStatic } from "../src/http.mjs";
import { renderConsultationReport, formatConsultationReportValue } from "../src/consultation-bot-report.mjs";
import { readFile } from "node:fs/promises";

test("PDF omits status, triage and automatic clinical guidance", async () => {
  const source = await readFile(new URL('../src/consultation-bot-report.mjs', import.meta.url), 'utf8');
  assert.ok(!/row\("Estado"/.test(source));
  assert.doesNotMatch(source, /Atención presencial urgente sugerida|Orientación mostrada|urgentReason|data\?\.urgent/);
});

test("PDF values capitalize only their initial character without changing numbers or remaining text", () => {
  for (const [value, expected] of [
    ["torcedura jugando al fútbol", "Torcedura jugando al fútbol"],
    ["tobillo", "Tobillo"], ["izquierdo", "Izquierdo"],
    ["hace dos meses", "Hace dos meses"], ["dolor al caminar", "Dolor al caminar"],
    ["  área lumbar  ", "Área lumbar"], ["consulta con ART", "Consulta con ART"],
    ["YPF", "YPF"], ["5/10", "5/10"], ["2 meses", "2 meses"],
    [0, "0"], [null, "No informado"], [" ", "No informado"],
  ]) assert.equal(formatConsultationReportValue(value), expected);
});

const complete = () => ({
  complaints: [{ reason: "dolor de rodilla", location: "rodilla", locationClear: true, sideRequired: true, side: "derecha", onset: "hace dos semanas", mechanism: "torsión jugando fútbol", pain: 4, painNote: null, limitations: null }],
  priorCare: null, goal: null, contextAnswered: false, urgent: false, urgentReason: null,
});
test("a complete account ends immediately without asking optional questions", () => {
  assert.equal(nextConsultationStep(complete()).complete, true);
});
test("essential questions omit repeated parenthesized areas without changing captured data", () => {
  for (const [field, missing] of [["detail", { locationClear: false }], ["side", { side: null }], ["onset", { onset: null }], ["mechanism", { mechanism: null }], ["pain", { pain: null }]]) {
    const data = complete();
    Object.assign(data.complaints[0], { location: "aductor", ...missing });
    const before = structuredClone(data);
    const step = nextConsultationStep(data);
    assert.equal(step.field, field);
    assert.doesNotMatch(step.text, /[()]|aductor/);
    assert.deepEqual(data, before);
  }
});
test("multiple complaints retain clear attribution without parenthetical labels", () => {
  const data = complete();
  data.complaints.push({ ...data.complaints[0], id: "second", location: "aductor", onset: null });
  const step = nextConsultationStep(data);
  assert.equal(step.complaintId, "second");
  assert.match(step.text, /^Sobre la molestia en aductor: ¿Desde hace cuánto/);
  assert.doesNotMatch(step.text, /[()]/);
});
test("an injury label alone requires its circumstances, but a known or declined cause does not", () => {
  const data = complete();
  Object.assign(data.complaints[0], { mechanism: "torcedura", mechanismClear: false });
  assert.equal(nextConsultationStep(data).key, "0.mechanism");
  assert.match(nextConsultationStep(data).text, /Qué estabas haciendo/);
  Object.assign(data.complaints[0], { mechanism: "Torcedura jugando al fútbol", mechanismClear: true });
  assert.equal(nextConsultationStep(data).complete, true);
  Object.assign(data.complaints[0], { mechanism: "No informado: no recuerda", mechanismClear: false });
  assert.equal(nextConsultationStep(data).complete, true);
});
test("only missing essentials are asked, and central areas do not require a side", () => {
  const data = complete(); data.complaints[0].side = null;
  assert.equal(nextConsultationStep(data).key, "0.side");
  data.complaints[0].sideRequired = false;
  assert.equal(nextConsultationStep(data).complete, true);
  data.complaints[0].pain = null;
  assert.equal(nextConsultationStep(data).key, "0.pain");
  data.complaints[0].painNote = "No informado: no sabe cuantificar";
  assert.equal(nextConsultationStep(data).complete, true);
});
test("unclear areas and separate complaints preserve their missing detail", () => {
  const data = complete(); data.complaints.push({ ...data.complaints[0], location: "brazo", locationClear: false });
  assert.equal(nextConsultationStep(data).key, "1.detail");
});
test("legacy triage flags and high pain never produce clinical advice or skip missing facts", () => {
  const data = complete(); data.urgent = true; data.complaints[0].onset = null; data.complaints[0].pain = 10;
  const next = nextConsultationStep(data);
  assert.equal(next.urgent, undefined);
  assert.equal(next.field, "onset");
  assert.doesNotMatch(next.text, /urgente|guardia|emergencia|esperar/i);
  data.complaints[0].onset = "ayer";
  assert.equal(nextConsultationStep(data).complete, true);
  assert.equal(data.complaints[0].pain, 10);
});
test("extraction rejects fields without literal patient evidence and disables provider storage", async () => {
  const data = complete();
  data.complaints[0].evidence = { reason: "rodilla", location: "rodilla", side: "derecha", onset: "dos semanas", mechanism: "me torcí", pain: "4", limitations: null };
  let request;
  const result = await analyzeConsultation([{ role: "user", text: "Me duele la rodilla hace dos semanas" }, { role: "assistant", text: "¿Es la derecha?" }], {
    settings: { apiKey: "test", model: "test" },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(data) }] }] }) };
    },
  });
  assert.equal(request.store, false);
  assert.equal(result.complaints[0].side, null);
  assert.equal(result.complaints[0].pain, null);
  assert.equal(result.complaints[0].mechanism, null);
  assert.equal(result.complaints[0].onset, "hace dos semanas");
});
test("audio rejects unsupported types before contacting the provider", async () => {
  await assert.rejects(transcribeConsultation({ mimeType: "text/plain", buffer: Buffer.from("hello") }), /BOT_AUDIO_TYPE/);
});
test("long audio transcripts are preserved up to 12000 characters and message transport accepts them", async () => {
  const text = 'Relato de prueba. '.repeat(300).trim();
  const result = await transcribeConsultation({ mimeType: 'audio/webm', buffer: Buffer.from('fake-audio') }, {
    validateAudioImpl: async file => file,
    settings: { apiKey: 'test', transcriptionModel: 'test' }, fetchImpl: async () => ({ ok: true, json: async () => ({ text }) }),
  });
  assert.equal(result, text);
  const source = await readFile(new URL('../src/consultation-bot.mjs', import.meta.url), 'utf8');
  assert.match(source, /readBody\(request, 80_000\)/);
  assert.match(source, /text\.length > 12000/);
});
test("evidence repair identifies the exact invalid field instead of making the patient repeat it", async () => {
  const requests = [];
  const data = complete();
  data.complaints[0] = { ...data.complaints[0], reason: "dolor", location: "rodilla derecha", onset: "ayer", mechanism: "golpe", pain: 4,
    evidence: { reason: "dolor", location: "rodilla derecha", side: "derecha", onset: "ayer", mechanism: "golpe", pain: "4", limitations: null } };
  const result = await analyzeConsultation([{ role: "user", text: "Me duele la rodilla derecha desde ayer por un golpe, 4 de 10." }], {
    settings: { apiKey: "test", model: "test" }, fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const output = structuredClone(data);
      if (requests.length === 2) {
        assert.match(request.input[0].content, /\"field\":\"reason\",\"invalidQuote\":\"dolor\"/);
        assert.match(request.instructions, /evidence.reason/);
        output.complaints[0].evidence.reason = "Me duele";
      }
      return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }] }) };
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(result.complaints[0].reason, "dolor");
  assert.equal(result.complaints[0].evidence.reason, "Me duele");
  assert.equal(nextConsultationStep(result).complete, true);
});

test("a paraphrased side citation is repaired without asking the patient again", async () => {
  const data = complete();
  data.complaints[0] = { ...data.complaints[0], reason: "dolor", location: "hombro izquierdo", side: "izquierda", onset: "un mes", mechanism: "caja pesada", pain: 6, evidence: { reason: "Me duele", location: "hombro izquierdo", side: "izquierda", onset: "un mes", mechanism: "caja pesada", pain: "6 de 10", limitations: null } };
  let calls = 0;
  const result = await analyzeConsultation([{ role: "user", text: "Me duele el hombro izquierdo hace un mes por una caja pesada. 6 de 10." }], {
    settings: { apiKey: "test", model: "test" },
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(data) }] }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.complaints[0].side, "izquierdo");
  assert.equal(nextConsultationStep(result).complete, true);
});
test("bot mutations reject missing and foreign origins", () => {
  assert.throws(() => requireBotOrigin({ headers: { host: "www.reku.io" } }), /Recargá/);
  assert.throws(() => requireBotOrigin({ headers: { host: "www.reku.io", origin: "https://evil.test" } }), /Origen/);
  assert.doesNotThrow(() => requireBotOrigin({ headers: { host: "www.reku.io", origin: "https://www.reku.io" } }));
});
test("bot branding comes only from the agreement subdomain, never query or forwarded host", async () => {
  const prefixes = [];
  const findAgreement = async prefix => {
    prefixes.push(prefix);
    return prefix === "ypf" ? { name: "YPF", slug: "ypf-agreement", cobranded: true, logo_url: "/uploads/agreements/ypf.png" } : null;
  };
  const brand = await resolveBotBrand({ url: "/api/bot/context?form=artro", headers: { host: "ypf.reku.io" } }, { findAgreement });
  assert.equal(brand.slug, "ypf-agreement");
  assert.equal(brand.logo_url, "/uploads/agreements/ypf.png");
  for (const host of ["www.reku.io", "reku.io"]) {
    const general = await resolveBotBrand({ url: "/api/bot/context?form=ypf", headers: { host, "x-forwarded-host": "ypf.reku.io" } }, { findAgreement });
    assert.equal(general.slug, "");
    assert.equal(general.cobranded, false);
  }
  assert.deepEqual(prefixes, ["ypf"]);
  await assert.rejects(resolveBotBrand({ headers: { host: "unknown.reku.io" } }, { findAgreement }), error => error.statusCode === 404);
});
test("microphone permission is enabled only for bot pages", async () => {
  for (const path of ["/bot/index.html", "/turnos/index.html"]) {
    let headers;
    await serveStatic({ method: "HEAD" }, { writeHead: (_code, value) => { headers = value; }, end() {} }, path);
    assert.ok(headers["Permissions-Policy"].includes(path.startsWith("/bot/") ? "microphone=(self)" : "microphone=()"));
    if (path.startsWith("/bot/")) { assert.equal(headers["Cache-Control"], "no-store"); assert.match(headers["X-Robots-Tag"], /noindex/); }
  }
});
test("the report includes a real PDF with no required patient identity", async () => {
  const pdf = await renderConsultationReport({ data: complete(), brand: { name: "Reku" }, updatedAt: Date.now(), status: "complete" });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 3000);
  const pages = Number(pdf.toString("latin1").match(/\/Type \/Pages\s+\/Count (\d+)\b/)?.[1]);
  assert.equal(pages, 1, "Short reports must not create footer-only pages");
});
test("additional answers stay in the narrative without generating a duplicate PDF appendix", async () => {
  const data = complete();
  data.complaints[0].id = "c1";
  data.complaints[0].limitations = "me cuesta caminar";
  data.followups = [{ complaintId: "c1", topic: "actividades", question: "¿Cambió tu rutina?", answer: "me cuesta caminar" }];
  const pdf = await renderConsultationReport({ data, brand: { name: "Reku" }, updatedAt: Date.now(), status: "complete" });
  assert.equal(Number(pdf.toString("latin1").match(/\/Type \/Pages\s+\/Count (\d+)\b/)?.[1]), 1);
});
