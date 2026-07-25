import test from "node:test";
import assert from "node:assert/strict";
import {
  saveAgreementLogo,
  saveAgreementPdf,
} from "../src/uploads.mjs";

test("agreement logos reject SVG even when the client declares an SVG MIME", async () => {
  await assert.rejects(
    saveAgreementLogo({
      filename: "payload.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg><script>alert(1)</script></svg>"),
    }),
    { message: "INVALID_IMAGE" },
  );
});

test("agreement PDFs require MIME, extension and PDF magic bytes", async () => {
  await assert.rejects(
    saveAgreementPdf({
      filename: "payload.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html>not a pdf</html>"),
    }),
    { message: "INVALID_PDF" },
  );
  await assert.rejects(
    saveAgreementPdf({
      filename: "payload.txt",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7"),
    }),
    { message: "INVALID_PDF" },
  );
});
