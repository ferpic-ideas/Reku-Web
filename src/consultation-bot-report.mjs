import PDFDocument from "pdfkit";
import sharp from "sharp";
import { join } from "node:path";
import { root } from "./config.mjs";
import { resolvePublicUploadPath } from "./http.mjs";
import { fallbackConsultationNarrative } from "./consultation-bot-narrative.mjs";

export const loadBotBrandLogo = async (brand) => {
  if (!brand.cobranded || !brand.logo_url) return null;
  const path = await resolvePublicUploadPath(brand.logo_url);
  return path ? sharp(path).trim().resize({ width: 400, height: 160, fit: "inside" }).png().toBuffer().catch(() => null) : null;
};

export const formatConsultationReportValue = (value) => {
  const text = String(value ?? "").trim() || "No informado";
  return text.charAt(0).toLocaleUpperCase("es-AR") + text.slice(1);
};

export const consultationReportRows = (data) => (data?.complaints || []).map((item) => [
  ["Motivo", item.reason],
  ["Zona / detalle", [item.location, item.locationNote].filter(Boolean).join('. ')],
  ["Lado", item.side || (item.sideRequired ? "No informado" : "No aplica")],
  ["Inicio / antigüedad", item.onset],
  ["Cómo comenzó", item.mechanism],
  ["Dolor actual", [Number.isFinite(item.pain) ? `${item.pain}/10` : "No cuantificado", item.painNote].filter(Boolean).join(". ")],
  ["Limitación / actividad que lo agrava", item.limitations],
]);

export const renderConsultationReport = async (session, { narrative = fallbackConsultationNarrative(session.data) } = {}) => {
  const doc = new PDFDocument({ size: "A4", margins: { top: 48, left: 48, right: 48, bottom: 88 }, bufferPages: true, info: { Title: "Reku - Motivo de consulta", Author: "Reku" } });
  const chunks = [];
  const ready = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = 499;
  const navy = "#18213f";
  const muted = "#64738a";
  const teal = "#318b99";
  const rekuLogo = await sharp(join(root, "images/logo-reku.svg")).resize({ width: 340 }).png().toBuffer();
  const agreementLogo = await loadBotBrandLogo(session.brand);
  const heading = (title) => {
    if (doc.y > 680) doc.addPage();
    doc.moveDown(0.7).font("Helvetica-Bold").fontSize(13).fillColor(teal).text(title, 48, doc.y, { width });
    doc.moveDown(0.7);
  };
  const row = (label, value) => {
    const text = formatConsultationReportValue(value);
    doc.font("Helvetica").fontSize(10);
    const valueHeight = doc.heightOfString(text, { width: 315 });
    doc.font("Helvetica-Bold").fontSize(9);
    const height = Math.max(24, valueHeight + 14, doc.heightOfString(label, { width: 163 }) + 14);
    if (doc.y + height > 750) doc.addPage();
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text(label, 48, y, { width: 163 });
    doc.font("Helvetica").fontSize(10).fillColor(navy).text(text, 232, y, { width: 315 });
    doc.y = y + height;
    doc.moveTo(48, doc.y - 6).lineTo(547, doc.y - 6).strokeColor("#e4ebef").stroke();
  };
  if (agreementLogo) {
    doc.image(agreementLogo, 48, 50, { fit: [126, 35] });
    doc.image(rekuLogo, 464, 44, { fit: [83, 42] });
  } else doc.image(rekuLogo, 48, 43, { fit: [120, 52] });
  doc.y = 123;
  doc.font("Helvetica-Bold").fontSize(23).fillColor(navy).text("Motivo de consulta", 48, doc.y);
  doc.moveDown(0.35).font("Helvetica").fontSize(11).fillColor(muted).text("Entrevista previa de telerehabilitación kinésica");
  doc.moveDown(1.1);
  row("Fecha", new Date(session.updatedAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }));
  row(session.appointmentId ? "Turno" : "Paciente", session.appointmentId ? `Referencia ${session.appointmentId}` : "Prueba sin datos de identificación ni turno asociado");
  if (session.brand.slug) row("Acuerdo", `${session.brand.name} (${session.brand.slug})`);
  heading("El relato del paciente");
  doc.font("Helvetica").fontSize(9).fillColor(muted).text("Síntesis organizada a partir de sus mensajes; no es una cita textual.", 48, doc.y, { width });
  doc.moveDown(0.6).fontSize(11).fillColor(navy).text(narrative, 48, doc.y, { width, lineGap: 3 });
  const complaints = consultationReportRows(session.data);
  complaints.forEach((rows, index) => {
    heading(complaints.length > 1 ? `Datos obtenidos - Motivo ${index + 1}` : "Datos obtenidos de la conversación");
    rows.forEach(([label, value]) => row(label, value));
  });
  const notice = "Resumen asistido por IA a partir del relato del paciente. Sólo organiza la información aportada; no realiza diagnósticos, clasificaciones clínicas ni recomendaciones. La evaluación y las decisiones corresponden al profesional. Los datos no informados y las incertidumbres se conservan para su revisión.";
  doc.font("Helvetica").fontSize(9);
  if (doc.y + 12 + doc.heightOfString(notice, { width, lineGap: 3 }) > 750) doc.addPage();
  doc.moveDown(0.8).fillColor(muted).text(notice, 48, doc.y, { width, lineGap: 3 });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    // Footers live outside the content margin; do not let PDFKit paginate them.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(muted).text(`REKU  ·  ${session.appointmentId ? 'INFORME PREVIO A LA CONSULTA' : 'INFORME DE PRUEBA'}  ·  ${i + 1} / ${range.count}`, 48, 776, { width, lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return ready;
};
