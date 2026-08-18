import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("study links require HTTPS and are deduplicated", () => {
  assert.deepEqual(
    normalizeDocumentLinks([
      "https://imagenes.example.com/study/123",
      "https://imagenes.example.com/study/123",
    ]),
    ["https://imagenes.example.com/study/123"],
  );
  assert.throws(
    () => normalizeDocumentLinks(["javascript:alert(1)"]),
    { message: "INVALID_APPOINTMENT_DOCUMENT_LINK" },
  );
  assert.throws(
    () => normalizeDocumentLinks(["http://imagenes.example.com/study/123"]),
    { message: "INVALID_APPOINTMENT_DOCUMENT_LINK" },
  );
});
