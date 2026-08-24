import assert from "node:assert/strict";
import test from "node:test";
import {
  mapAdminAppointmentDocument,
  mapAppointmentDocument,
  normalizeDocumentLinks,
  validateClinicalDocument,
} from "../src/appointment-documents.mjs";

test("clinical documents accept validated PDFs and supported image signatures", () => {
  const pdf = validateClinicalDocument({
    filename: "orden traumatólogo.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nexample"),
  });
  assert.equal(pdf.extension, ".pdf");
  assert.equal(pdf.originalName, "orden traumatólogo.pdf");

  const jpeg = validateClinicalDocument({
    filename: "estudio.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
  });
  assert.equal(jpeg.extension, ".jpg");
});

test("clinical documents reject content that does not match its declared type", () => {
  assert.throws(
    () =>
      validateClinicalDocument({
        filename: "estudio.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("<script>alert(1)</script>"),
      }),
    { message: "INVALID_APPOINTMENT_DOCUMENT" },
  );
});

test("study links receive HTTPS automatically and are deduplicated", () => {
  assert.deepEqual(
    normalizeDocumentLinks([
      "imagenes.example.com/study/123",
      "https://imagenes.example.com/study/123",
      "http://imagenes.example.com/study/456",
      "//imagenes.example.com/study/789",
    ]),
    [
      "https://imagenes.example.com/study/123",
      "https://imagenes.example.com/study/456",
      "https://imagenes.example.com/study/789",
    ],
  );
  assert.throws(
    () => normalizeDocumentLinks(["javascript:alert(1)"]),
    { message: "INVALID_APPOINTMENT_DOCUMENT_LINK" },
  );
  assert.throws(
    () => normalizeDocumentLinks(["ftp://imagenes.example.com/study/123"]),
    { message: "INVALID_APPOINTMENT_DOCUMENT_LINK" },
  );
});

test("private appointment files use role-scoped authenticated URLs", () => {
  const file = {
    id: 42,
    kind: "file",
    original_name: "resonancia.pdf",
    mime_type: "application/pdf",
    size_bytes: 1234,
  };
  assert.equal(
    mapAppointmentDocument(file).url,
    "/api/professional/appointment-documents/42",
  );
  assert.equal(
    mapAdminAppointmentDocument(file).url,
    "/api/admin/appointment-documents/42",
  );
  assert.equal(
    mapAdminAppointmentDocument({
      ...file,
      kind: "link",
      external_url: "https://imagenes.example.com/estudio/42",
    }).url,
    "https://imagenes.example.com/estudio/42",
  );
});
