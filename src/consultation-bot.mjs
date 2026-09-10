import { randomBytes } from "node:crypto";
import { isProduction } from "./config.mjs";
import { getClientIp, parseCookies, readBody, sendJson, withSecurityHeaders } from "./http.mjs";
import { agreementPrefixForRequest } from "./agreement-resolution.mjs";
import { getAgreementBySubdomainPrefix } from "./db.mjs";
import { consumeRateLimit } from "./rate-limit.mjs";
import { parseMultipartForm } from "./uploads.mjs";
import { transcribeConsultation, botSettings } from "./consultation-bot-ai.mjs";
import { advanceConsultation } from "./consultation-bot-conversation.mjs";
import { loadBotBrandLogo, renderConsultationReport } from "./consultation-bot-report.mjs";
import { buildConsultationNarrative, cachedConsultationNarrative } from "./consultation-bot-narrative.mjs";
import { consultationBotMode, requireBotAppointment, botAppointmentCookie, botAccessMessages,
  beginBotAppointmentAction, finishBotAppointmentAction, readBotAppointmentReport } from "./consultation-bot-access.mjs";
import { requireBotReportKey } from "./consultation-bot-report-storage.mjs";

export const welcomeMessages = [
  "Hola, bienvenido a Reku. Necesitamos que nos cuentes el motivo de tu consulta: si es una lesión o una dolencia que venís arrastrando, cómo empezó, en qué zona, cuánto te duele del 1 al 10 y desde hace cuánto tiempo.",
  "Podés escribirlo o, si te resulta más cómodo, mandar un audio. Nosotros lo transcribimos a texto con ayuda de IA.",
];
const cookieName = "reku_consultation_bot";
const ttl = 2 * 60 * 60 * 1000;
const sessions = new Map();
export const forgetConsultationSession = (store, token, host, instanceId) => {
  const session = store.get(token);
  if (!session || session.host !== host || (instanceId !== undefined && session.instanceId !== instanceId)) return false;
  session.controller?.abort();
  return store.delete(token);
};
let activeRequests = 0;
const cleanSessions = () => {
  for (const [id, session] of sessions) if (session.expiresAt < Date.now()) { session.controller?.abort(); sessions.delete(id); }
};
const cleanup = setInterval(cleanSessions, 60_000);
cleanup.unref();
const fail = (message, statusCode = 422) => Object.assign(new Error(message), { statusCode, publicMessage: message });
const present = (session) => ({
  messages: session.messages, data: session.data, brand: session.brand, status: session.status,
  expiresAt: session.expiresAt, version: session.version, instanceId: session.instanceId,
  diagnosticId: session.diagnosticId, followupDiagnostics: session.followupDiagnostics || [],
});
export const requireBotOrigin = (request) => {
  let origin;
  try { origin = new URL(request.headers.origin); } catch { throw fail("Recargá la página para continuar.", 403); }
  if (origin.host !== request.headers.host || (isProduction && origin.protocol !== "https:") || !["http:", "https:"].includes(origin.protocol)) throw fail("Origen no permitido.", 403);
};
export const resolveBotBrand = async (request, { findAgreement = getAgreementBySubdomainPrefix } = {}) => {
  const prefix = agreementPrefixForRequest(request);
  const agreement = prefix ? await findAgreement(prefix) : null;
  if (prefix && !agreement) throw fail("No encontramos ese acuerdo.", 404);
  return agreement ? { name: agreement.name, slug: agreement.slug, cobranded: Boolean(agreement.cobranded), logo_url: agreement.cobranded ? agreement.logo_url : "" } : { name: "Reku", slug: "", cobranded: false, logo_url: "" };
};
const context = request => resolveBotBrand(request);
const sendReport = (response, pdf) => {
  response.writeHead(200, withSecurityHeaders({ "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="reku-motivo-de-consulta.pdf"', "Cache-Control": "private, no-store" }, { privateRoute: true }));
  response.end(pdf);
};

export const handleConsultationBot = async (request, response, url) => {
  try {
    const action = url.pathname.slice("/api/bot/".length);
    const productionAccess = consultationBotMode() === "production";
    if (request.method === "GET" && action === "logo") {
      const logo = await loadBotBrandLogo(await context(request, url));
      if (!logo) throw fail("Logo no encontrado.", 404);
      response.writeHead(200, withSecurityHeaders({ "Content-Type": "image/png", "Cache-Control": "public, max-age=300" }));
      response.end(logo);
      return;
    }
    if (request.method === "GET" && action === "context") {
      let access = { allowed: true };
      if (productionAccess) {
        try {
          const appointment = await requireBotAppointment(request, { allowCompleted: true });
          if (appointment.completed_at) access = { allowed: false, completed: true, reportAvailable: appointment.report_available, message: botAccessMessages.completed };
        }
        catch (error) {
          if (!error.publicMessage) throw error;
          access = { allowed: false, message: error.publicMessage };
        }
      }
      sendJson(response, 200, { brand: await context(request, url), available: Boolean(botSettings.apiKey), access });
      return;
    }
    if (request.method === "POST") requireBotOrigin(request);
    if (request.method === "POST" && action === "access") {
      if (!productionAccess) { sendJson(response, 200, { ok: true }); return; }
      await consumeRateLimit({ scope: "bot.access", key: getClientIp(request), limit: 30, windowSeconds: 3600 });
      const body = JSON.parse(await readBody(request, 1000));
      await requireBotAppointment(request, { token: body.token, allowCompleted: true });
      sendJson(response, 200, { ok: true }, { "Set-Cookie": botAppointmentCookie(body.token) });
      return;
    }
    const token = parseCookies(request)[cookieName];
    let session = sessions.get(token);
    if (session && (session.expiresAt < Date.now() || session.host !== request.headers.host)) session = null;
    if (request.method === "GET" && action === "session") {
      // Visits never restore prior conversations, even with a legacy cookie.
      sendJson(response, 200, { session: null });
      return;
    }
    if (request.method === "POST" && action === "reset") {
      forgetConsultationSession(sessions, token, request.headers.host);
      sendJson(response, 200, { session: null }, { "Set-Cookie": `${cookieName}=; Path=/api/bot/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? "; Secure" : ""}` });
      return;
    }
    if (request.method === "POST" && action === "close") {
      const body = JSON.parse(await readBody(request, 1000));
      if (typeof body.instanceId !== "string" || !body.instanceId || body.instanceId.length > 100) throw fail("Conversación inválida.");
      // A delayed pagehide from another tab must not delete a newer conversation.
      forgetConsultationSession(sessions, token, request.headers.host, body.instanceId);
      sendJson(response, 200, { session: null });
      return;
    }
    if (request.method === "POST" && action === "session") {
      const body = JSON.parse(await readBody(request, 1000));
      if (body.consent !== true) throw fail("Necesitamos tu aceptación para procesar el relato.");
      const appointmentAccess = productionAccess ? await requireBotAppointment(request) : null;
      if (productionAccess) requireBotReportKey();
      if (!botSettings.apiKey) throw fail("El asistente todavía no está disponible.", 503);
      await consumeRateLimit({ scope: "bot.sessions", key: getClientIp(request), limit: 12, windowSeconds: 3600 });
      cleanSessions();
      if (sessions.size >= 500) throw fail("El asistente está ocupado. Probá en unos minutos.", 503);
      const brand = await context(request, url);
      if (token) forgetConsultationSession(sessions, token, request.headers.host);
      const id = randomBytes(32).toString("hex");
      session = {
        host: request.headers.host, brand, data: null, status: "collecting", busy: false,
        appointmentId: appointmentAccess?.appointment_id || null,
        createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + ttl,
        version: 0, lastRequestId: null, audioCount: 0,
        instanceId: randomBytes(12).toString("hex"),
        diagnosticId: randomBytes(6).toString("hex"), followupDiagnostics: [],
        messages: welcomeMessages.map((text) => ({ role: "assistant", text })),
      };
      sessions.set(id, session);
      sendJson(response, 201, { session: present(session) }, { "Set-Cookie": `${cookieName}=${id}; Path=/api/bot/; HttpOnly; SameSite=Strict${isProduction ? "; Secure" : ""}` });
      return;
    }
    // A completed appointment can retrieve its encrypted PDF without restoring
    // a conversation or granting a second interview, even after server restart.
    if (productionAccess && request.method === "GET" && action === "report") {
      await consumeRateLimit({ scope: "bot.report", key: getClientIp(request), limit: 40, windowSeconds: 3600 });
      sendReport(response, await readBotAppointmentReport(request));
      return;
    }
    if (!session) throw fail("La sesión terminó. Iniciá una nueva conversación.", 401);
    if (productionAccess) {
      const access = await requireBotAppointment(request, { allowCompleted: session.status !== "collecting" });
      if (String(access.appointment_id) !== String(session.appointmentId)) throw fail(botAccessMessages.required, 403);
    }
    if ((await context(request, url)).slug !== session.brand.slug) throw fail("Esta conversación corresponde a otro acuerdo. Iniciá una nueva conversación.", 409);
    if (request.method === "GET" && action === "report") {
      if (!session.data || session.status === "collecting") throw fail("Primero completá la conversación.", 409);
      await consumeRateLimit({ scope: "bot.report", key: getClientIp(request), limit: 40, windowSeconds: 3600 });
      const narrative = await cachedConsultationNarrative(session, { generate: async current => {
        await enforceAIQuota(request);
        if (activeRequests >= 6) throw new Error("BOT_BUSY");
        activeRequests++;
        try { return await buildConsultationNarrative(current); } finally { activeRequests--; }
      } });
      const pdf = await renderConsultationReport(session, { narrative });
      sendReport(response, pdf);
      return;
    }
    if (request.method !== "POST" || !["message", "transcribe"].includes(action)) throw fail("Endpoint no encontrado.", 404);
    if (session.busy) throw fail("Estamos procesando tu mensaje anterior.", 409);
    if (activeRequests >= 6) throw fail("El asistente está ocupado. Intentá de nuevo en unos segundos.", 503);
    activeRequests++;
    session.busy = true;
    const controller = new AbortController();
    session.controller = controller;
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once?.('close', disconnect);
    let reservation;
    try {
      if (action === "message") {
        const body = JSON.parse(await readBody(request, 80_000));
        if (body.instanceId !== session.instanceId) throw fail("Se inició otra conversación. Recargá la página para continuar.", 409);
        if (typeof body.requestId !== "string" || !/^[\w-]{10,80}$/.test(body.requestId)) throw fail("Mensaje inválido.");
        if (body.requestId === session.lastRequestId) { sendJson(response, 200, { session: present(session) }); return; }
        if (body.version !== session.version) throw fail("La conversación cambió en otra ventana. Recargá para continuar.", 409);
        if (session.status !== "collecting") throw fail(productionAccess ? botAccessMessages.completed : "La entrevista ya finalizó. Podés comenzar una nueva para corregir el relato.", 409);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 12000) throw fail("El mensaje puede tener hasta 12000 caracteres.");
        await enforceAIQuota(request);
        if (productionAccess) reservation = await beginBotAppointmentAction(request, session.appointmentId, "message");
        const messages = [...session.messages, { role: "user", text }];
        const diagnostics = [];
        const { data, next } = await advanceConsultation(session, messages, { signal: controller.signal, onFollowupDecision: event => diagnostics.push({ ...event, turn: session.version + 1 }) });
        controller.signal.throwIfAborted();
        const exhausted = session.version >= 24;
        const reply = exhausted && !next.complete
          ? "Gracias por tu tiempo. Dejamos un informe parcial con lo que nos contaste y los datos pendientes para revisar con el profesional. Podés descargarlo acá abajo."
          : next.text;
        // Commit the one-use marker before exposing a completed interview.
        // A lost HTTP response cannot grant a new interview on another device.
        if (productionAccess) {
          const completed = Boolean(next.complete || exhausted);
          // Use the grounded fallback here so report durability adds no extra
          // provider calls to the final message's deadline.
          const reportPdf = completed ? await renderConsultationReport({ ...session, data, updatedAt: Date.now() }) : undefined;
          controller.signal.throwIfAborted();
          await finishBotAppointmentAction(reservation, { completed, reportPdf });
          reservation = null;
        }
        session.messages = [...messages, { role: "assistant", text: reply }];
        session.data = data;
        session.lastQuestion = next;
        session.followupDiagnostics = [...(session.followupDiagnostics || []), ...diagnostics].slice(-5);
        for (const event of diagnostics) console.info("Consultation bot followup decision", { diagnosticId: session.diagnosticId, ...event });
        session.status = next.complete ? "complete" : exhausted ? "partial" : "collecting";
        session.version++;
        session.lastRequestId = body.requestId;
        session.updatedAt = Date.now();
        sendJson(response, 200, { session: present(session) });
      } else {
        if (session.status !== "collecting") throw fail(productionAccess ? botAccessMessages.completed : "La entrevista ya finalizó.", 409);
        if (session.audioCount >= 15) throw fail("Llegaste al límite de audios. Podés seguir escribiendo.", 429);
        await enforceAIQuota(request);
        session.audioCount++;
        const { files } = await parseMultipartForm(request, { maxBytes: 8 * 1024 * 1024, maxFiles: 1, signal: controller.signal });
        if (productionAccess) reservation = await beginBotAppointmentAction(request, session.appointmentId, "transcribe");
        const text = await transcribeConsultation(files.audio, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (productionAccess) {
          await finishBotAppointmentAction(reservation);
          reservation = null;
        }
        sendJson(response, 200, { text });
      }
    } finally {
      try { if (reservation) await finishBotAppointmentAction(reservation); }
      finally { response.off?.('close', disconnect); session.controller = null; session.busy = false; activeRequests--; }
    }
  } catch (error) {
    const status = error.message === "RATE_LIMITED" ? 429 : error.message === "PAYLOAD_TOO_LARGE" ? 413 : error instanceof SyntaxError ? 422 : error.statusCode || 502;
    const message = error.publicMessage || (status === 429 ? "Llegaste al límite de solicitudes. Probá más tarde." : status === 413 ? "El audio es demasiado grande. Usá uno de hasta 8 MB." : error.message === "BOT_AUDIO_TYPE" ? "Usá un audio MP3, M4A, WAV, OGG o WebM." : "No pudimos procesarlo. Tu conversación sigue disponible; intentá de nuevo o escribí el mensaje.");
    // Never log patient messages, audio, API responses or credentials.
    if (status >= 500) console.error("Consultation bot request failed", { code: String(error.message).startsWith("BOT_") ? error.message : "BOT_FAILED" });
    if (!response.destroyed && !response.writableEnded) sendJson(response, status, { error: message }, status === 429 ? { "Retry-After": String(error.retryAfter || 60) } : {});
  }
};

const enforceAIQuota = async (request) => {
  await consumeRateLimit({ scope: "bot.ai.ip", key: getClientIp(request), limit: 100, windowSeconds: 3600 });
  await consumeRateLimit({ scope: "bot.ai.global", key: "global", limit: Number(process.env.OPENAI_BOT_DAILY_LIMIT || 1000), windowSeconds: 86_400 });
};
