import { analyzeConsultation, nextConsultationStep } from "./consultation-bot-ai.mjs";
import { chooseReviewedFollowup, MAX_CONSULTATION_FOLLOWUPS } from "./consultation-bot-followups.mjs";

const fields = ["reason", "location", "side", "onset", "mechanism", "pain", "limitations"];
const globalFields = ["priorCare", "goal"];
const normalize = value => String(value || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const quotedIn = (quote, text) => Boolean(normalize(quote)) && normalize(text).includes(normalize(quote));
const unknownMechanism = value => /^no informado:/i.test(value || "");
// A literal citation proves that words exist, not that they express uncertainty.
// If a model labels a concrete answer as unknown, keep the answer itself.
const expressesUncertainty = value => /\b(?:no (?:lo )?(?:recuerdo|se|sé|me acuerdo|puedo precisar|sabría|sabria)|no estoy segur[oa]|prefiero no|no (?:quiero|deseo) (?:decir|responder|contestar))/i.test(value || "");

// A missing model field is not a withdrawal of a previously verified fact.
// Stable ids prevent extraction order from moving answers between complaints.
export function mergeConsultationData(previous, extracted, latestText, lastQuestion) {
  let complaints = structuredClone(previous?.complaints || []);
  const retired = new Set(previous?.retiredComplaintIds || []);
  const invalidatedFields = structuredClone(previous?.invalidatedFields || {});
  const invalidatedGlobalFields = new Set(previous?.invalidatedGlobalFields || []);
  const globalValues = Object.fromEntries(globalFields.map(field => [field, previous?.[field] || null]));
  const globalEvidence = { ...previous?.globalEvidence };
  const corrections = (extracted.corrections || []).filter(correction => quotedIn(correction?.evidence, latestText)
    && (globalFields.includes(correction.field) ? correction.complaintId === null
      : complaints.some(item => item.id === correction.complaintId) && ["complaint", ...fields].includes(correction.field)));
  for (const correction of corrections) {
    if (globalFields.includes(correction.field)) {
      globalValues[correction.field] = null;
      globalEvidence[correction.field] = null;
      invalidatedGlobalFields.add(correction.field);
      continue;
    }
    const item = complaints.find(item => item.id === correction.complaintId);
    if (!item) continue;
    if (correction.field === "complaint") {
      retired.add(item.id);
      complaints = complaints.filter(other => other.id !== item.id);
      continue;
    }
    // A revised location invalidates anatomical wording/laterality, not the
    // patient's independently established timing or pain for the same complaint.
    const cleared = correction.field === "location" ? ["location", "reason", "side"] : [correction.field];
    invalidatedFields[item.id] = [...new Set([...(invalidatedFields[item.id] || []), ...cleared])];
    for (const field of cleared) { item[field] = null; item.evidence = { ...item.evidence, [field]: null }; }
    if (cleared.includes("location")) { item.locationClear = false; item.locationNote = null; item.sideRequired = false; }
    if (cleared.includes("pain")) item.painNote = null;
    if (cleared.includes("mechanism")) item.mechanismClear = false;
  }
  let nextId = Math.max(0, ...[...(previous?.complaints || []).map(item => item.id), ...retired].map(id => Number(/^c(\d+)$/.exec(id)?.[1]) || 0)) + 1;
  const seen = new Set();
  const currentMechanisms = new Set();
  const currentLocations = new Set();
  for (const raw of extracted.complaints) {
    if (retired.has(raw.id)) continue;
    const incoming = unknownMechanism(raw.mechanism) && !expressesUncertainty(raw.evidence?.mechanism)
      ? { ...raw, mechanism: null, mechanismClear: false } : raw;
    let item = complaints.find(existing => incoming.id && existing.id === incoming.id);
    if (!item && incoming.id) continue; // Never accept an invented existing id.
    if (!item) item = complaints.find(existing => normalize(existing.location) === normalize(incoming.location) && normalize(existing.side) === normalize(incoming.side));
    if (!item) {
      if (complaints.length >= 5) continue;
      // Historical wording alone must not resurrect a retracted complaint
      // under a new id. New symptoms need evidence in this turn.
      if (previous && !["reason", "location"].some(field => quotedIn(incoming.evidence?.[field], latestText))) continue;
      item = { ...incoming, id: `c${nextId++}` };
      complaints.push(item);
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const priorEvidence = item.evidence || {};
    item.evidence = { ...priorEvidence };
    for (const field of fields) {
      const quote = incoming.evidence?.[field];
      if (invalidatedFields[item.id]?.includes(field) && !quotedIn(quote, latestText)) continue;
      if (incoming[field] == null) continue;
      // Inability to add detail is not a new anatomical location. Retain the
      // region already reported and keep the uncertainty in a separate note.
      if (field === "location" && unknownMechanism(incoming[field])) continue;
      // Bare numbers / yes / no belong only to the last question's target.
      if (/^(?:\d+(?:[.,]\d+)?|s[ií]|no)[.!\s]*$/i.test(latestText) && quotedIn(quote, latestText)
        && lastQuestion?.complaintId && (item.id !== lastQuestion.complaintId || (field !== lastQuestion.field && !(lastQuestion.field === "detail" && field === "location")))) continue;
      if (item[field] == null || item[field] === incoming[field] || quotedIn(quote, latestText)) {
        const unchanged = item[field] === incoming[field];
        item[field] = incoming[field];
        item.evidence[field] = quote;
        if (field === "location") {
          item.locationClear = (unchanged && item.locationClear) || incoming.locationClear; item.sideRequired = incoming.sideRequired;
          if (quotedIn(quote, latestText)) { currentLocations.add(item.id); item.locationNote = null; }
        }
        if (field === "pain") item.painNote = incoming.painNote;
        if (field === "mechanism") {
          item.mechanismClear = unchanged && item.mechanismClear === true ? true : incoming.mechanismClear;
          if (quotedIn(quote, latestText)) currentMechanisms.add(item.id);
        }
      }
    }
    if (incoming.pain == null && /^No informado:/i.test(incoming.painNote || "") && quotedIn(incoming.evidence?.pain, latestText)) {
      item.pain = null; item.painNote = incoming.painNote; item.evidence.pain = incoming.evidence.pain;
    }
  }
  const answer = extracted.lastAnswer;
  const target = complaints.find(item => item.id === lastQuestion?.complaintId);
  if (!corrections.length && target && fields.concat("detail").includes(lastQuestion.field) && answer?.status === "answered"
    && typeof answer.value === "string" && quotedIn(answer.evidence, latestText)) {
    const field = lastQuestion.field === "detail" ? "location" : lastQuestion.field;
    if (field === "pain") {
      const pain = /^\d+(?:[.,]\d+)?$/.test(answer.value.trim()) ? Number(answer.value.replace(",", ".")) : NaN;
      if (Number.isFinite(pain) && pain >= 0 && pain <= 10) { target.pain = pain; target.painNote = null; }
      else if (/^No informado:/i.test(answer.value)) { target.pain = null; target.painNote = answer.value.slice(0, 1000); }
    } else if (field === "mechanism") {
      // Prefer the full, grounded extraction over a short lastAnswer ("fútbol").
      // An answered clarification is terminal even if the patient cannot add detail.
      const value = unknownMechanism(answer.value) && !expressesUncertainty(answer.evidence) ? answer.evidence : answer.value;
      if (!currentMechanisms.has(target.id) || (unknownMechanism(target.mechanism) && !unknownMechanism(value))) target.mechanism = value.slice(0, 1000);
      target.mechanismClear = true;
    } else if (lastQuestion.field === "detail") {
      if (unknownMechanism(answer.value) || expressesUncertainty(answer.evidence)) {
        target.locationNote = answer.value.slice(0, 1000);
      } else if (!currentLocations.has(target.id)) {
        // No richer extraction this turn: append a grounded precision to the
        // known region instead of replacing e.g. "muslo" with "interna".
        const value = answer.value.slice(0, 1000);
        target.location = target.location && !normalize(value).includes(normalize(target.location))
          ? `${target.location}; ${value}`.slice(0, 1000) : value;
        target.locationNote = null;
      }
      target.locationClear = true;
    } else {
      target[field] = answer.value.slice(0, 1000);
      if (lastQuestion.field === "detail") target.locationClear = true;
    }
    if (!(field === "mechanism" && currentMechanisms.has(target.id))
      && !(lastQuestion.field === "detail" && (currentLocations.has(target.id) || target.locationNote))) {
      target.evidence = { ...target.evidence, [field]: answer.evidence };
    }
  }
  for (const field of globalFields) {
    const quote = extracted.globalEvidence?.[field];
    const value = extracted[field];
    if (typeof value !== "string" || !value.trim() || !normalize(quote)) continue;
    if (invalidatedGlobalFields.has(field) && !quotedIn(quote, latestText)) continue;
    if (globalValues[field] === null || globalValues[field] === value || quotedIn(quote, latestText)) {
      globalValues[field] = value.slice(0, 1000);
      globalEvidence[field] = quote;
    }
  }
  const { urgent: _legacyUrgent, urgentReason: _legacyUrgentReason, ...intake } = extracted;
  return {
    ...intake, complaints, corrections, retiredComplaintIds: [...retired], invalidatedFields,
    ...globalValues, globalEvidence, invalidatedGlobalFields: [...invalidatedGlobalFields],
    followups: structuredClone(previous?.followups || []).filter(item => !retired.has(item.complaintId)
      && !corrections.some(correction => correction.complaintId === item.complaintId)),
    followupCount: previous?.followupCount ?? previous?.followups?.length ?? 0,
  };
}

export async function advanceConsultation(session, messages, { analyze = analyzeConsultation, chooseFollowup = chooseReviewedFollowup, onFollowupDecision = () => {}, signal: parentSignal, timeoutMs = 20_000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  signal.throwIfAborted();
  const latestText = messages.at(-1).text;
  const lastQuestion = session.lastQuestion;
  const extracted = await analyze(messages, { previousData: session.data, lastQuestion, signal });
  signal.throwIfAborted();
  const data = mergeConsultationData(session.data, extracted, latestText, lastQuestion);
  const correcting = data.corrections.length > 0 || ["correction", "correction_unclear"].includes(extracted.lastAnswer?.status);
  if (extracted.lastAnswer?.status === "correction_unclear") {
    return { data, next: { key: "correction", field: "correction", text: "Perdón, puede que te haya entendido mal. ¿Qué dato querés corregir y cómo es en realidad?" } };
  }
  if (!correcting && lastQuestion?.field === "correction" && ["unclear", "unrelated"].includes(extracted.lastAnswer?.status)) {
    return { data, next: { ...lastQuestion, text: "Todavía no me quedó claro qué entendí mal. ¿Podés decirme qué dato hay que cambiar y cuál sería el correcto?" } };
  }
  if (!correcting && lastQuestion?.field === "followup" && ["unclear", "unrelated"].includes(extracted.lastAnswer?.status)) {
    const baseText = lastQuestion.baseText || lastQuestion.text;
    return { data, next: { ...lastQuestion, baseText, text: `No me quedó clara tu respuesta. ${baseText} Si no lo sabés o preferís no responder, podés decirlo.` } };
  }
  if (!correcting && lastQuestion?.field === "followup") {
    const entry = data.followups[lastQuestion.followupIndex];
    if (entry && entry.answer === null) entry.answer = latestText; // Verbatim, never an inferred diagnosis.
  }
  // Ambiguity is not a refusal: clarify without inventing an answer or marking
  // the field complete. Only an explicit unknown/refusal can close it.
  if (!correcting && lastQuestion?.complaintId && lastQuestion.field !== "followup" && extracted.lastAnswer?.status === "unclear") {
    const item = data.complaints.find(item => item.id === lastQuestion.complaintId);
    if (item) {
      const baseText = lastQuestion.baseText || lastQuestion.text;
      const text = lastQuestion.field === "mechanism"
        ? "No me quedó claro cómo empezó. ¿Podés contármelo de otra forma? Si no lo recordás, podés decirlo."
        : `No me quedó clara tu respuesta. ${baseText} También podés corregirme si entendí mal o decir que no lo sabés.`;
      return { data, next: { ...lastQuestion, baseText, text, clarification: true } };
    }
  }
  const next = nextConsultationStep(data);
  if (correcting) next.text = `Gracias por aclararlo. ${next.text}`;
  if (!next.complete || session.version >= 24 || data.followupCount >= MAX_CONSULTATION_FOLLOWUPS) return { data, next };
  const followup = await chooseFollowup(data, messages, { onDecision: onFollowupDecision, signal });
  parentSignal?.throwIfAborted();
  if (!followup || signal.aborted) return { data, next };
  data.followups.push(followup);
  data.followupCount++;
  return { data, next: { key: `followup.${data.followupCount}`, field: "followup", complaintId: followup.complaintId,
    followupIndex: data.followups.length - 1, text: followup.question } };
}
