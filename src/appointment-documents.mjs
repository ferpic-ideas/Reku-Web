import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { one, query, tx, recordAudit } from "./db.mjs";
import { privateUploadRoot } from "./config.mjs";
import { withSecurityHeaders } from "./http.mjs";

const supportedMimeTypes = new Map([
  ["application/pdf", ".pdf"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const cleanOriginalName = (value) =>
  basename(String(value || "documento"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 240) || "documento";

const hasExpectedSignature = (mimeType, buffer) => {
  if (mimeType === "application/pdf") {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (mimeType === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
};

export const validateClinicalDocument = (file) => {
  const mimeType = String(file?.mimeType || "").toLowerCase();
  const extension = supportedMimeTypes.get(mimeType);
  if (!file?.buffer?.length || !extension || !hasExpectedSignature(mimeType, file.buffer)) {
    const error = new Error("INVALID_APPOINTMENT_DOCUMENT");
    error.statusCode = 415;
    throw error;
  }
  return {
    extension,
    mimeType,
    originalName: cleanOriginalName(file.filename),
    sizeBytes: file.buffer.length,
  };
};

export const normalizeDocumentLinks = (value) => {
  let candidates = value;
  if (typeof candidates === "string") {
    try {
      candidates = JSON.parse(candidates || "[]");
    } catch {
      candidates = [];
    }
  }
  if (!Array.isArray(candidates)) return [];
  const links = [];
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw) continue;
    if (raw.length > 2_000) {
      const error = new Error("INVALID_APPOINTMENT_DOCUMENT_LINK");
      error.statusCode = 422;
      throw error;
    }
    let candidateUrl = raw;
    if (/^http:\/\//i.test(candidateUrl)) {
      candidateUrl = `https://${candidateUrl.slice("http://".length)}`;
    } else if (/^\/\//.test(candidateUrl)) {
      candidateUrl = `https:${candidateUrl}`;
    } else if (!/^https:\/\//i.test(candidateUrl)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(candidateUrl)) {
        const error = new Error("INVALID_APPOINTMENT_DOCUMENT_LINK");
        error.statusCode = 422;
        throw error;
      }
      candidateUrl = `https://${candidateUrl}`;
    }
    let url;
    try {
      url = new URL(candidateUrl);
    } catch {
      const error = new Error("INVALID_APPOINTMENT_DOCUMENT_LINK");
      error.statusCode = 422;
      throw error;
    }
    if (url.protocol !== "https:" || !url.hostname) {
      const error = new Error("INVALID_APPOINTMENT_DOCUMENT_LINK");
      error.statusCode = 422;
      throw error;
    }
    const normalized = url.toString();
    if (normalized.length > 2_000) {
      const error = new Error("INVALID_APPOINTMENT_DOCUMENT_LINK");
      error.statusCode = 422;
      throw error;
    }
    if (!links.includes(normalized)) links.push(normalized);
  }
  return links;
};

const savePrivateClinicalDocument = async (file, folder, ownerId) => {
  const validated = validateClinicalDocument(file);
  const directory = join(privateUploadRoot, folder, String(ownerId));
  await mkdir(directory, { recursive: true });
  const storagePath = `${folder}/${ownerId}/${randomUUID()}${validated.extension}`;
  await writeFile(join(privateUploadRoot, storagePath), file.buffer, { mode: 0o640 });
  return { ...validated, storagePath };
};

export const saveClinicalDocument = (file, appointmentId) =>
  savePrivateClinicalDocument(file, 'appointments', appointmentId);

export const saveIntakeMedicalOrder = (file, intakeId) =>
  savePrivateClinicalDocument(file, 'intakes', intakeId);

export const removeClinicalDocuments = async (storagePaths) => {
  await Promise.all(
    storagePaths.map((storagePath) =>
      unlink(join(privateUploadRoot, storagePath)).catch(() => {}),
    ),
  );
};

const mapAppointmentDocumentFor = (row, fileBasePath) => ({
  id: Number(row.id),
  kind: row.kind,
  purpose: row.purpose || 'study',
  can_delete: row.can_delete !== false,
  name: row.purpose === 'medical_order'
    ? `Orden médica · ${row.original_name || 'Documento'}`
    : row.original_name || (row.kind === "link" ? "Estudio por enlace" : "Documento"),
  mime_type: row.mime_type || "",
  size_bytes: Number(row.size_bytes || 0),
  url:
    row.kind === "link"
      ? row.external_url
      : `${fileBasePath}/${Number(row.id)}`,
  created_at: row.created_at,
});

export const mapAppointmentDocument = (row) =>
  mapAppointmentDocumentFor(row, "/api/professional/appointment-documents");

export const mapAdminAppointmentDocument = (row) =>
  mapAppointmentDocumentFor(row, "/api/admin/appointment-documents");

export const mapPatientAppointmentDocument = (row) =>
  mapAppointmentDocumentFor(row, "/api/booking/manage/documents");

export const listPatientAppointmentDocuments = async (appointmentId) => {
  const result = await query(`SELECT document.*,
      NOT (document.purpose = 'medical_order' AND appointment.medical_order_required) AS can_delete
    FROM appointment_documents document JOIN appointments appointment ON appointment.id = document.appointment_id
    WHERE document.appointment_id = $1 AND document.uploaded_by = 'patient'
    ORDER BY document.created_at, document.id`, [appointmentId]);
  return result.rows.map(mapPatientAppointmentDocument);
};

export const deletePatientAppointmentDocument = async (documentId, appointmentId) => {
  const removed = await tx(async client => {
    const result = await client.query(`DELETE FROM appointment_documents document
      USING appointments appointment
      WHERE document.id = $1 AND document.appointment_id = $2
        AND document.uploaded_by = 'patient' AND appointment.id = document.appointment_id
        AND appointment.status = 'confirmed'
        AND NOT (document.purpose = 'medical_order' AND appointment.medical_order_required)
      RETURNING document.id, document.storage_path`, [documentId, appointmentId]);
    const row = result.rows[0];
    if (!row) return null;
    await client.query(`INSERT INTO audit_events (event_type, detail) VALUES ($1, $2::jsonb)`, [
      'patient.appointment.document.deleted',
      JSON.stringify({ appointment_document_id: Number(row.id), appointment_id: Number(appointmentId) }),
    ]);
    return row;
  });
  if (removed?.storage_path) {
    // Intake orders can back more than one appointment. Do not remove a shared file.
    const referenced = await one(`SELECT 1 FROM patient_intake_medical_orders WHERE storage_path = $1
      UNION ALL SELECT 1 FROM appointment_documents WHERE storage_path = $1 LIMIT 1`, [removed.storage_path]);
    if (!referenced) await removeClinicalDocuments([removed.storage_path]);
  }
  return Boolean(removed);
};

const streamAppointmentDocument = async (
  request,
  response,
  documentId,
  { actorUserId = null, professionalId = null, appointmentId = null, inline = false, auditEvent },
) => {
  const document = await one(
    `
      SELECT document.*, appointment.professional_id
      FROM appointment_documents document
      INNER JOIN appointments appointment ON appointment.id = document.appointment_id
      WHERE document.id = $1
        AND document.kind = 'file'
    `,
    [documentId],
  );
  if (
    !document ||
    (professionalId !== null && Number(document.professional_id) !== Number(professionalId)) ||
    (appointmentId !== null && (Number(document.appointment_id) !== Number(appointmentId) || document.uploaded_by !== 'patient'))
  ) {
    response.writeHead(404, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }, { privateRoute: true }));
    response.end("Documento no encontrado.");
    return;
  }

  const filePath = resolve(privateUploadRoot, document.storage_path);
  const relativePath = relative(privateUploadRoot, filePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    const error = new Error("PRIVATE_DOCUMENT_PATH_INVALID");
    error.statusCode = 500;
    throw error;
  }
  let fileStat;
  try { fileStat = await stat(filePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    response.writeHead(404, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }, { privateRoute: true }));
    response.end("Documento no encontrado.");
    return;
  }
  const safeAsciiName = cleanOriginalName(document.original_name).replace(/[^a-zA-Z0-9._-]/g, "_");
  await recordAudit(auditEvent, {
    actorUserId,
    detail: {
      appointment_document_id: Number(document.id),
      appointment_id: Number(document.appointment_id),
      professional_id: Number(document.professional_id),
    },
  });
  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": document.mime_type || "application/octet-stream",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `${inline ? 'inline' : 'attachment'}; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(cleanOriginalName(document.original_name))}`,
        "Cache-Control": "private, no-store",
      },
      { privateRoute: true },
    ),
  );
  if (request.method === "HEAD") response.end();
  // Deletion can race an already-authorized download. Fail only this response,
  // never let an unhandled read error terminate the application process.
  else createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
};

export const streamProfessionalAppointmentDocument = async (
  request,
  response,
  documentId,
  account,
) =>
  streamAppointmentDocument(request, response, documentId, {
    actorUserId: account.user.id,
    professionalId: account.user.professional_id,
    auditEvent: "appointment.document.downloaded",
  });

export const streamAdminAppointmentDocument = async (
  request,
  response,
  documentId,
  user,
) =>
  streamAppointmentDocument(request, response, documentId, {
    actorUserId: user.id,
    auditEvent: "admin.appointment.document.downloaded",
  });

export const streamPatientAppointmentDocument = async (request, response, documentId, appointmentId) =>
  streamAppointmentDocument(request, response, documentId, {
    appointmentId, inline: true, auditEvent: 'patient.appointment.document.viewed',
  });
