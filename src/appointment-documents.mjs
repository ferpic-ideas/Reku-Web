import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { one, recordAudit } from "./db.mjs";
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
    let url;
    try {
      url = new URL(raw);
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
    if (!links.includes(normalized)) links.push(normalized);
  }
  return links;
};

export const saveClinicalDocument = async (file, appointmentId) => {
  const validated = validateClinicalDocument(file);
  const directory = join(privateUploadRoot, "appointments", String(appointmentId));
  await mkdir(directory, { recursive: true });
  const storagePath = `appointments/${appointmentId}/${randomUUID()}${validated.extension}`;
  await writeFile(join(privateUploadRoot, storagePath), file.buffer, { mode: 0o640 });
  return { ...validated, storagePath };
};

export const removeClinicalDocuments = async (storagePaths) => {
  await Promise.all(
    storagePaths.map((storagePath) =>
      unlink(join(privateUploadRoot, storagePath)).catch(() => {}),
    ),
  );
};

export const mapAppointmentDocument = (row) => ({
  id: Number(row.id),
  kind: row.kind,
  name: row.original_name || (row.kind === "link" ? "Estudio por enlace" : "Documento"),
  mime_type: row.mime_type || "",
  size_bytes: Number(row.size_bytes || 0),
  url:
    row.kind === "link"
      ? row.external_url
      : `/api/professional/appointment-documents/${Number(row.id)}`,
  created_at: row.created_at,
});

export const streamProfessionalAppointmentDocument = async (
  request,
  response,
  documentId,
  account,
) => {
  const document = await one(
    `
      SELECT document.*, appointment.professional_id
      FROM appointment_documents document
      INNER JOIN appointments appointment ON appointment.id = document.appointment_id
      WHERE document.id = $1
        AND document.kind = 'file'
        AND appointment.professional_id = $2
    `,
    [documentId, account.user.professional_id],
  );
  if (!document) {
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
  const fileStat = await stat(filePath);
  const safeAsciiName = cleanOriginalName(document.original_name).replace(/[^a-zA-Z0-9._-]/g, "_");
  await recordAudit("appointment.document.downloaded", {
    actorUserId: account.user.id,
    detail: {
      appointment_document_id: Number(document.id),
      appointment_id: Number(document.appointment_id),
      professional_id: account.user.professional_id,
    },
  });
  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": document.mime_type || "application/octet-stream",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(cleanOriginalName(document.original_name))}`,
        "Cache-Control": "private, no-store",
      },
      { privateRoute: true },
    ),
  );
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
};
