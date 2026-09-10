import assert from "node:assert/strict";
import test from "node:test";
import { mergeConsultationData, advanceConsultation } from "../src/consultation-bot-conversation.mjs";
import { fallbackConsultationNarrative } from "../src/consultation-bot-narrative.mjs";

const complaint = (id = "c1", overrides = {}) => ({ id, reason: "tirón", location: "muslo derecho", locationClear: true,
  sideRequired: true, side: "derecha", onset: "ayer", mechanism: "jugando al fútbol", pain: 4, painNote: null,
  limitations: null, evidence: { reason: "tirón", location: "muslo derecho", side: "derecho", onset: "ayer", mechanism: "jugando al fútbol", pain: "4", limitations: null }, ...overrides });
const state = (items = [complaint()]) => ({ complaints: items, priorCare: null, goal: null, urgent: false, urgentReason: null, followups: [] });
const msgs = text => [{ role: "user", text }];
const contextText = "Ayer sentí un tirón en el muslo derecho jugando al fútbol, me duele 4.";

test("verified facts survive omitted fields, omitted complaints and reordered extraction", () => {
  const previous = state([complaint(), complaint("c2", { location: "espalda baja", sideRequired: false })]);
  const extracted = state([complaint("c2", { onset: null }), complaint("c1", { onset: null, mechanism: null })]);
  let data = mergeConsultationData(previous, extracted, "3", { field: "pain", complaintId: "c2" });
  assert.deepEqual(data.complaints.map(item => item.id), ["c1", "c2"]);
  assert.equal(data.complaints[0].onset, "ayer");
  assert.equal(data.complaints[0].mechanism, "jugando al fútbol");
  data = mergeConsultationData(data, state([]), "gracias", null);
  assert.equal(data.complaints.length, 2);
});
test("short pain answers bind to the last question, not another complaint", () => {
  const previous = state([complaint(), complaint("c2", { location: "espalda baja", pain: null })]);
  const extracted = state([complaint("c1", { pain: 3, evidence: { pain: "3" } })]);
  extracted.lastAnswer = { status: "answered", value: "3", evidence: "3" };
  const data = mergeConsultationData(previous, extracted, "3", { field: "pain", complaintId: "c2" });
  assert.equal(data.complaints[0].pain, 4);
  assert.equal(data.complaints[1].pain, 3);
});
test("current corrections replace facts while stale evidence cannot overwrite them", () => {
  const previous = state();
  let data = mergeConsultationData(previous, state([complaint("c1", { onset: "hace tres semanas", evidence: { onset: "tres semanas" } })]), "Me equivoqué: hace tres semanas", null);
  assert.equal(data.complaints[0].onset, "hace tres semanas");
  data = mergeConsultationData(data, state(), "4", { field: "pain", complaintId: "c1" });
  assert.equal(data.complaints[0].onset, "hace tres semanas");
});
test("unverified lastAnswer cannot inject an answer", () => {
  const extracted = state([]);
  extracted.lastAnswer = { status: "answered", value: "9", evidence: "9" };
  const data = mergeConsultationData(state(), extracted, "3", { field: "pain", complaintId: "c1" });
  assert.equal(data.complaints[0].pain, 4);
});
test("a detailed mechanism survives subsequent pain answers and shorter re-extraction", () => {
  const previous = state([complaint("c1", { mechanism: "Torcedura jugando al fútbol", mechanismClear: true })]);
  const extracted = state([complaint("c1", { mechanism: "Torcedura", mechanismClear: false, evidence: { mechanism: "torcí" } })]);
  const data = mergeConsultationData(previous, extracted, "5", { field: "pain", complaintId: "c1" });
  assert.equal(data.complaints[0].mechanism, "Torcedura jugando al fútbol");
  assert.equal(data.complaints[0].mechanismClear, true);
});
test("mechanism clarification preserves full extracted context instead of a short lastAnswer", () => {
  const previous = state([complaint("c1", { mechanism: "torcedura", mechanismClear: false })]);
  const extracted = state([complaint("c1", { mechanism: "Torcedura jugando al fútbol", mechanismClear: true, evidence: { mechanism: "jugando al fútbol" } })]);
  extracted.lastAnswer = { status: "answered", value: "fútbol", evidence: "fútbol" };
  const data = mergeConsultationData(previous, extracted, "Fue jugando al fútbol", { field: "mechanism", complaintId: "c1" });
  assert.equal(data.complaints[0].mechanism, "Torcedura jugando al fútbol");
  assert.equal(data.complaints[0].evidence.mechanism, "jugando al fútbol");
  assert.equal(data.complaints[0].mechanismClear, true);
});
test("a patient who cannot clarify the mechanism is not asked indefinitely", async () => {
  const previous = state([complaint("c1", { mechanism: "torcedura", mechanismClear: false })]);
  const extracted = { ...state([]), lastAnswer: { status: "answered", value: "No informado: no recuerda", evidence: "no recuerdo" } };
  const turn = await advanceConsultation({ data: previous, version: 2, lastQuestion: { field: "mechanism", complaintId: "c1" } }, msgs("no recuerdo"), {
    analyze: async () => extracted, chooseFollowup: async () => null,
  });
  assert.equal(turn.next.complete, true);
  assert.equal(turn.data.complaints[0].mechanismClear, true);
});
test("Caminando cannot become no recuerda even if the model labels its literal citation as unknown", () => {
  const previous = state([complaint("c1", { mechanism: "torcedura", mechanismClear: false })]);
  const extracted = state([complaint("c1", { mechanism: "No informado: no recuerda", evidence: { mechanism: "Caminando" } })]);
  extracted.lastAnswer = { status: "answered", value: "No informado: no recuerda", evidence: "Caminando" };
  const data = mergeConsultationData(previous, extracted, "Caminando", { field: "mechanism", complaintId: "c1" });
  assert.equal(data.complaints[0].mechanism, "Caminando");
  assert.equal(data.complaints[0].mechanismClear, true);
  assert.equal(data.complaints[0].evidence.mechanism, "Caminando");
  const next = state([complaint("c1", { mechanism: "No informado: no recuerda", evidence: { mechanism: "Me cuesta subir escaleras" } })]);
  const later = mergeConsultationData(data, next, "Me cuesta subir escaleras", { field: "followup", complaintId: "c1" });
  assert.equal(later.complaints[0].mechanism, "Caminando");
});
test("a correct direct mechanism answer takes precedence over a contradictory unknown extraction", () => {
  const extracted = state([complaint("c1", { mechanism: "No informado: no recuerda", evidence: { mechanism: "Caminando" } })]);
  extracted.lastAnswer = { status: "answered", value: "Caminando", evidence: "Caminando" };
  const data = mergeConsultationData(state(), extracted, "Caminando", { field: "mechanism", complaintId: "c1" });
  assert.equal(data.complaints[0].mechanism, "Caminando");
});
test("an explicit unknown cause or refusal stays unknown without changing other complaints", () => {
  for (const text of ["No recuerdo", "Prefiero no responder", "Me resulta imposible precisar ese momento"]) {
    const extracted = state([]);
    extracted.lastAnswer = { status: "answered", value: "No informado: no recuerda", evidence: text };
    const data = mergeConsultationData(state([complaint(), complaint("c2")]), extracted, text, { field: "mechanism", complaintId: "c1" });
    assert.ok(/No informado:|Me resulta imposible/.test(data.complaints[0].mechanism));
    assert.equal(data.complaints[0].mechanismClear, true);
    assert.equal(data.complaints[1].mechanism, "jugando al fútbol");
  }
});
test("ambiguity pauses until the patient clarifies or explicitly cannot answer", async () => {
  const session = { data: state([complaint("c1", { mechanism: null }), complaint("c2", { location: "espalda baja", pain: null })]), version: 2,
    lastQuestion: { complaintId: "c1", field: "mechanism", key: "c1.mechanism", text: "¿Hubo golpe, esfuerzo, apareció de a poco o no recordás?" } };
  const unclear = async () => ({ ...state([]), lastAnswer: { status: "unclear", value: null, evidence: "no" } });
  let turn = await advanceConsultation(session, msgs("no"), { analyze: unclear });
  assert.equal(turn.next.clarification, true);
  assert.match(turn.next.text, /No me quedó claro/);
  assert.notEqual(turn.next.text, session.lastQuestion.text);
  turn = await advanceConsultation({ ...session, data: turn.data, lastQuestion: turn.next }, msgs("no"), { analyze: unclear });
  assert.equal(turn.next.field, "mechanism");
  assert.equal(turn.data.complaints[0].mechanism, null);
  turn = await advanceConsultation({ ...session, data: turn.data, lastQuestion: turn.next }, msgs("No recuerdo"), {
    analyze: async () => ({ ...state([]), lastAnswer: { status: "answered", value: "No informado: no recuerda", evidence: "No recuerdo" } }),
  });
  assert.equal(turn.next.key, "c2.pain");
  turn = await advanceConsultation({ ...session, data: turn.data, lastQuestion: turn.next }, msgs("3"), {
    analyze: async () => ({ ...state([]), lastAnswer: { status: "answered", value: "3", evidence: "3" } }), chooseFollowup: async () => null,
  });
  assert.equal(turn.next.complete, true);
  assert.equal(turn.data.complaints[1].pain, 3);
});
test("zero followups is valid; only missing essentials prevent selection, not legacy triage", async () => {
  let calls = 0;
  const chooseFollowup = async () => { calls++; return null; };
  const turn = await advanceConsultation({ data: state(), version: 1 }, msgs("ok"), { analyze: async () => state([]), chooseFollowup });
  assert.equal(turn.next.complete, true);
  assert.equal(calls, 1);
  await advanceConsultation({ data: state([complaint("c1", { onset: null })]), version: 1 }, msgs("hola"), { analyze: async () => state([]), chooseFollowup });
  assert.equal(calls, 1);
  const legacy = await advanceConsultation({ data: state(), version: 1 }, msgs("ok"), { analyze: async () => ({ ...state([]), urgent: true, urgentReason: "legacy" }), chooseFollowup });
  assert.equal(legacy.next.complete, true);
  assert.equal(legacy.next.urgent, undefined);
  assert.equal(legacy.data.urgent, undefined);
  assert.equal(legacy.data.urgentReason, undefined);
  assert.equal(calls, 2);
});
test("followup ledger allows at most three total and preserves literal answers for the report", async () => {
  let session = { data: state(), version: 1 };
  let count = 0;
  const chooseFollowup = async () => ({ complaintId: "c1", topic: `topic-${++count}`, question: "¿Notaste algún moretón en ese muslo?", answer: null });
  const analyze = async () => state([]);
  for (const answer of ["ok", "No vi moretones", "Caminar me cuesta un poco", "A la noche no molesta"]) {
    const turn = await advanceConsultation(session, msgs(answer), { analyze, chooseFollowup });
    session = { data: turn.data, lastQuestion: turn.next, version: session.version + 1 };
  }
  assert.equal(count, 3);
  assert.equal(session.lastQuestion.complete, true);
  assert.deepEqual(session.data.followups.map(item => item.answer), ["No vi moretones", "Caminar me cuesta un poco", "A la noche no molesta"]);
});
test("provider extraction failures do not mutate the session", async () => {
  const session = { data: state(), version: 1 };
  const before = structuredClone(session);
  await assert.rejects(advanceConsultation(session, msgs("hola"), { analyze: async () => { throw new Error("failure"); } }));
  assert.deepEqual(session, before);
});

test("global corrections remove withdrawn care and goals and cannot revive stale history", () => {
  const previous = { ...state(), priorCare: "Cirugía hace dos meses", goal: "Volver a correr",
    globalEvidence: { priorCare: "me operaron", goal: "quiero correr" } };
  const text = "Nunca me operaron y no quiero correr, lo entendiste mal";
  const extracted = { ...state([]), corrections: [
    { complaintId: null, field: "priorCare", evidence: "Nunca me operaron" },
    { complaintId: null, field: "goal", evidence: "no quiero correr" },
  ], lastAnswer: { status: "correction", value: null, evidence: text } };
  const data = mergeConsultationData(previous, extracted, text, { field: "pain", complaintId: "c1" });
  assert.equal(data.priorCare, null);
  assert.equal(data.goal, null);
  assert.deepEqual(data.invalidatedGlobalFields, ["priorCare", "goal"]);
  assert.doesNotMatch(fallbackConsultationNarrative(data), /Cirugía|correr/);
  const stale = mergeConsultationData(data, previous, "4", { field: "pain", complaintId: "c1" });
  assert.equal(stale.priorCare, null);
  assert.equal(stale.goal, null);
  assert.equal(stale.complaints[0].pain, 4);
});

test("a grounded replacement of a global fact wins but absent and forged corrections do not", () => {
  const previous = { ...state(), priorCare: "Cirugía", goal: "Correr", globalEvidence: { priorCare: "me operaron", goal: "correr" } };
  const text = "No era cirugía, solamente hice fisioterapia";
  const replaced = mergeConsultationData(previous, { ...state([]), priorCare: "Fisioterapia",
    globalEvidence: { priorCare: "hice fisioterapia", goal: null },
    corrections: [{ complaintId: null, field: "priorCare", evidence: text }] }, text, null);
  assert.equal(replaced.priorCare, "Fisioterapia");
  assert.equal(replaced.goal, "Correr");
  const unchanged = mergeConsultationData(replaced, { ...state([]), corrections: [
    { complaintId: null, field: "priorCare", evidence: "Nunca hice nada" },
    { complaintId: "c1", field: "goal", evidence: "hola" },
  ] }, "hola", null);
  assert.equal(unchanged.priorCare, "Fisioterapia");
  assert.equal(unchanged.goal, "Correr");
  assert.equal(unchanged.corrections.length, 0);
});

test("declining anatomical detail preserves the known region and records its uncertainty", async () => {
  const previous = state([complaint("c1", { location: "pierna", locationClear: false })]);
  const extracted = { ...state([complaint("c1", { location: "No informado: no puede precisar", locationClear: true,
    evidence: { location: "No puedo precisar mejor" } })]),
    lastAnswer: { status: "answered", value: "No informado: no puede precisar", evidence: "No puedo precisar mejor" } };
  const turn = await advanceConsultation({ data: previous, version: 1, lastQuestion: { field: "detail", complaintId: "c1" } }, msgs("No puedo precisar mejor"), {
    analyze: async () => extracted, chooseFollowup: async () => null,
  });
  assert.equal(turn.data.complaints[0].location, "pierna");
  assert.equal(turn.data.complaints[0].locationNote, "No informado: no puede precisar");
  assert.equal(turn.data.complaints[0].locationClear, true);
  assert.equal(turn.next.complete, true);
  assert.match(fallbackConsultationNarrative(turn.data), /pierna/);
  assert.match(fallbackConsultationNarrative(turn.data), /no puede precisar/);
});

test("richer anatomical extraction survives a short lastAnswer and retains its evidence", () => {
  const previous = state([complaint("c1", { location: "muslo", locationClear: false })]);
  const extracted = { ...state([complaint("c1", { location: "parte interna del muslo derecho", locationClear: true,
    evidence: { location: "en la parte interna" } })]), lastAnswer: { status: "answered", value: "interna", evidence: "interna" } };
  const data = mergeConsultationData(previous, extracted, "en la parte interna", { field: "detail", complaintId: "c1" });
  assert.equal(data.complaints[0].location, "parte interna del muslo derecho");
  assert.equal(data.complaints[0].evidence.location, "en la parte interna");
  const omitted = mergeConsultationData(previous, { ...state([]), lastAnswer: extracted.lastAnswer }, "interna", { field: "detail", complaintId: "c1" });
  assert.equal(omitted.complaints[0].location, "muslo; interna");
});

for (const field of ["onset", "followup"]) test(`repeated ${field} clarifications never recursively repeat previous wrappers`, async () => {
  const question = "¿Desde hace cuánto lo notás?";
  let session = { data: state(), version: 1, lastQuestion: { field, complaintId: "c1", text: question } };
  let stableText;
  for (let index = 0; index < 4; index++) {
    const turn = await advanceConsultation(session, msgs("mmm"), {
      analyze: async () => ({ ...state([]), lastAnswer: { status: "unclear", value: null, evidence: "mmm" } }),
    });
    assert.equal(turn.next.baseText, question);
    assert.equal(turn.next.text.split("No me quedó clara tu respuesta.").length, 2);
    if (stableText) assert.equal(turn.next.text, stableText);
    stableText = turn.next.text;
    session = { ...session, data: turn.data, lastQuestion: turn.next };
  }
});

test("extraction and followups receive one shared 20 second deadline", async t => {
  const controller = new AbortController();
  const timeouts = [];
  const signals = [];
  t.mock.method(AbortSignal, "timeout", ms => { timeouts.push(ms); return controller.signal; });
  const result = await advanceConsultation({ data: state(), version: 1 }, msgs("ok"), {
    analyze: async (_messages, { signal }) => { signals.push(signal); return state([]); },
    chooseFollowup: async (_data, _messages, { signal }) => { signals.push(signal); return null; },
  });
  assert.deepEqual(timeouts, [20_000]);
  assert.equal(signals[0], signals[1]);
  assert.equal(result.next.complete, true);
});

test("cancellation cannot commit an extraction or followup result after disconnection", async () => {
  for (const stage of ["analysis", "followup"]) {
    const controller = new AbortController();
    const session = { data: state(), version: 1 };
    const before = structuredClone(session);
    await assert.rejects(advanceConsultation(session, msgs("ok"), {
      signal: controller.signal,
      analyze: async () => { if (stage === "analysis") controller.abort(); return state([]); },
      chooseFollowup: async () => { controller.abort(); return null; },
    }), error => error.name === "AbortError");
    assert.deepEqual(session, before);
  }
});
