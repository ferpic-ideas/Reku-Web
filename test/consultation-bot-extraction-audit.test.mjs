import assert from "node:assert/strict";
import test from "node:test";
import { analyzeConsultation, intakeSchema, nextConsultationStep, transcribeConsultation } from "../src/consultation-bot-ai.mjs";
import { buildConsultationNarrative, fallbackConsultationNarrative } from "../src/consultation-bot-narrative.mjs";

const settings = { apiKey: "synthetic-test-only", model: "test", transcriptionModel: "test" };
const empty = () => ({ complaints: [], priorCare: null, goal: null, globalEvidence: { priorCare: null, goal: null },
  corrections: [], urgent: false, urgentReason: null, contextAnswered: false,
  lastAnswer: { status: "unrelated", value: null, evidence: null } });
const response = data => ({ ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(data) }] }] }) });

test("extraction is intake-only and discards legacy triage fields", async () => {
  for (const field of ["urgent", "urgentReason"]) {
    assert.equal(intakeSchema.properties[field], undefined);
    assert.ok(!intakeSchema.required.includes(field));
  }
  const result = await analyzeConsultation([{ role: "user", text: "hola" }], {
    settings, fetchImpl: async (_url, options) => {
      assert.match(JSON.parse(options.body).instructions, /No clasifiques urgencia o gravedad/);
      return response({ ...empty(), urgent: true, urgentReason: "legacy clinical assessment" });
    },
  });
  assert.equal(result.urgent, undefined);
  assert.equal(result.urgentReason, undefined);
});

test("global facts require literal patient evidence, never assistant suggestions", async () => {
  const result = await analyzeConsultation([{ role: "user", text: "Me molesta un tobillo" }, { role: "assistant", text: "¿Te operaron? ¿Querés correr?" }], {
    settings, fetchImpl: async () => response({ ...empty(), priorCare: "Cirugía", goal: "Correr", globalEvidence: { priorCare: "operaron", goal: "correr" } }),
  });
  assert.equal(result.priorCare, null);
  assert.equal(result.goal, null);
  assert.deepEqual(result.globalEvidence, { priorCare: null, goal: null });
});

test("global evidence repairs once inside the same deadline and preserves the fact", async t => {
  const controller = new AbortController();
  const timeouts = [];
  const signals = [];
  t.mock.method(AbortSignal, "timeout", ms => { timeouts.push(ms); return controller.signal; });
  const result = await analyzeConsultation([{ role: "user", text: "Hice fisioterapia y quiero volver a bailar" }], {
    settings, fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      const payload = JSON.parse(options.body);
      if (signals.length === 2) assert.match(payload.input[0].content, /"field":"priorCare"/);
      return response({ ...empty(), priorCare: "Fisioterapia", goal: "Volver a bailar",
        globalEvidence: { priorCare: signals.length === 1 ? "realizó fisioterapia" : "Hice fisioterapia", goal: "quiero volver a bailar" } });
    },
  });
  assert.deepEqual(timeouts, [20_000]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(result.priorCare, "Fisioterapia");
  assert.equal(result.goal, "Volver a bailar");
});

test("an aborted extraction never starts evidence repair or accepts late JSON", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(analyzeConsultation([{ role: "user", text: "hola" }], { settings, signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => { controller.abort(); return { status: "completed", output: [] }; } };
    },
  }), error => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("schema supports explicit global retractions and general anatomical specificity", () => {
  const properties = intakeSchema.properties;
  assert.ok(properties.corrections.items.properties.field.enum.includes("priorCare"));
  assert.ok(properties.corrections.items.properties.field.enum.includes("goal"));
  assert.ok(properties.corrections.items.properties.complaintId.type.includes("null"));
  assert.deepEqual(properties.globalEvidence.required, ["priorCare", "goal"]);
  const description = properties.complaints.items.properties.locationClear.description;
  assert.match(description, /grupo muscular/);
  assert.match(description, /lateralidad se evalúa aparte/);
});

test("recognized muscles, joints and regions use the same detail criterion and separate laterality", async () => {
  for (const location of ["aductor", "tobillo", "trapecio", "zona lumbar"]) {
    const text = `Me molesta a la altura del ${location}`;
    const data = { ...empty(), complaints: [{ id: null, reason: "Molestia", location, locationClear: true,
      sideRequired: true, side: null, onset: null, mechanism: null, mechanismClear: false, pain: null, painNote: null, limitations: null,
      evidence: { reason: "Me molesta", location, side: null, onset: null, mechanism: null, pain: null, limitations: null } }] };
    const result = await analyzeConsultation([{ role: "user", text }], { settings, fetchImpl: async (_url, options) => {
      const instructions = JSON.parse(options.body).instructions;
      assert.match(instructions, /criterio GENERAL de utilidad para admisión, no una lista/);
      assert.match(instructions, /Un músculo o grupo muscular es tan válido como una articulación/);
      return response(data);
    } });
    assert.equal(nextConsultationStep(result).field, "side");
    assert.equal(result.complaints[0].location, location);
  }
});

test("narrative generation and review share one deadline and keep correction metadata", async t => {
  const controller = new AbortController();
  const timeouts = [];
  const signals = [];
  t.mock.method(AbortSignal, "timeout", ms => { timeouts.push(ms); return controller.signal; });
  const session = { data: { ...empty(), invalidatedGlobalFields: ["priorCare"], retiredComplaintIds: ["c1"], invalidatedFields: { c2: ["side"] } },
    messages: [{ role: "user", text: "Nunca me operaron" }] };
  const paragraph = await buildConsultationNarrative(session, { settings, fetchImpl: async (_url, options) => {
    signals.push(options.signal);
    const payload = JSON.parse(options.body);
    const input = JSON.parse(payload.input[0].content);
    assert.deepEqual(input.data.invalidatedGlobalFields, ["priorCare"]);
    if (signals.length === 1) return response({ sentences: [{ text: "Aclara que no fue operado.", evidence: ["Nunca me operaron"] }] });
    return response({ faithful: true, complete: true, uncertaintyPreserved: true, noDiagnosisAdded: true, noRecommendations: true, noContradictions: true, respectful: true, confidence: "high" });
  } });
  assert.equal(paragraph, "Aclara que no fue operado.");
  assert.deepEqual(timeouts, [20_000]);
  assert.equal(signals[0], signals[1]);
});

test("a timed-out narrative uses the grounded fallback without another provider request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const session = { data: empty(), messages: [{ role: "user", text: "hola" }] };
  const paragraph = await buildConsultationNarrative(session, { settings, signal: controller.signal, fetchImpl: async () => {
    calls++;
    controller.abort();
    return response({ sentences: [{ text: "hola", evidence: ["hola"] }] });
  } });
  assert.equal(calls, 1);
  assert.equal(paragraph, fallbackConsultationNarrative(session.data));
});

test("audio validation failure never contacts OpenAI and canonical audio is what is uploaded", async () => {
  const raw = { mimeType: "audio/webm", buffer: Buffer.from("synthetic raw input") };
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const file = options.body.get("file");
    assert.equal(file.name, "consulta.wav");
    assert.equal(file.type, "audio/wav");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "bounded canonical audio");
    return { ok: true, json: async () => ({ text: "Relato sintético" }) };
  };
  await assert.rejects(transcribeConsultation(raw, { settings, fetchImpl,
    validateAudioImpl: async () => { throw new Error("BOT_AUDIO_DURATION"); },
  }), /BOT_AUDIO_DURATION/);
  assert.equal(calls, 0);
  const text = await transcribeConsultation(raw, { settings, fetchImpl,
    validateAudioImpl: async (_file, { signal }) => { assert.equal(signal.aborted, false); return { mimeType: "audio/wav", buffer: Buffer.from("bounded canonical audio") }; },
  });
  assert.equal(text, "Relato sintético");
  assert.equal(calls, 1);
});

test("passing a disconnection signal cannot remove the 60 second audio deadline", async t => {
  const deadlineController = new AbortController();
  const externalController = new AbortController();
  const timeouts = [];
  let requests = 0;
  t.mock.method(AbortSignal, "timeout", ms => { timeouts.push(ms); return deadlineController.signal; });
  await assert.rejects(transcribeConsultation({ mimeType: "audio/webm", buffer: Buffer.from("synthetic audio") }, {
    settings, signal: externalController.signal,
    validateAudioImpl: async file => { deadlineController.abort(new DOMException("Deadline", "TimeoutError")); return file; },
    fetchImpl: async () => { requests++; return response({}); },
  }), error => error.name === "TimeoutError");
  assert.deepEqual(timeouts, [60_000]);
  assert.equal(externalController.signal.aborted, false);
  assert.equal(requests, 0);
});
