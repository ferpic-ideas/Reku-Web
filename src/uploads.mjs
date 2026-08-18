import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import Busboy from "busboy";
import sharp from "sharp";
import { config, uploadRoot } from "./config.mjs";

const csvMimeTypes = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
]);

const optimizableImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const normalizeMimeType = (mimeType) =>
  String(mimeType || "").split(";", 1)[0].trim().toLowerCase();

const invalidImageError = () => {
  const error = new Error("INVALID_IMAGE");
  error.statusCode = 415;
  return error;
};

export const parseMultipartForm = (
  request,
  {
    maxBytes = config.uploadMaxBytes,
    maxFiles = 4,
    collectFiles = false,
  } = {},
) =>
  new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: request.headers,
      limits: {
        fileSize: maxBytes,
        files: maxFiles,
        fields: 80,
      },
    });
    const fields = {};
    const files = {};
    let totalBytes = 0;
    let failed = false;

    const fail = (error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, file, info) => {
      const chunks = [];
      const filename = info.filename || "";
      const mimeType = normalizeMimeType(info.mimeType);

      if (!filename) {
        file.resume();
        return;
      }

      file.on("data", (chunk) => {
        if (failed) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          const error = new Error("PAYLOAD_TOO_LARGE");
          error.statusCode = 413;
          fail(error);
          return;
        }
        chunks.push(chunk);
      });

      file.on("limit", () => {
        const error = new Error("PAYLOAD_TOO_LARGE");
        error.statusCode = 413;
        fail(error);
      });

      file.on("end", () => {
        if (!failed && chunks.length > 0) {
          const upload = {
            filename,
            mimeType,
            buffer: Buffer.concat(chunks),
          };
          if (collectFiles) {
            files[name] ||= [];
            files[name].push(upload);
          } else {
            files[name] = upload;
          }
        }
      });
    });

    busboy.on("filesLimit", () => {
      if (failed) return;
      const error = new Error("TOO_MANY_FILES");
      error.statusCode = 422;
      fail(error);
    });
    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (!failed) resolve({ fields, files });
    });
    request.pipe(busboy);
  });

export const saveAgreementLogo = async (file) => {
  if (!file) return "";
  const buffer = await optimizeImageUpload(file, {
    width: 1200,
    height: 600,
    fit: "inside",
  });
  return saveAgreementFile(buffer, ".webp");
};

export const saveAgreementPdf = async (file) => {
  if (!file) return "";
  const hasPdfSignature =
    file.buffer.length >= 5 && file.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (
    file.mimeType !== "application/pdf" ||
    extname(file.filename).toLowerCase() !== ".pdf" ||
    !hasPdfSignature
  ) {
    const error = new Error("INVALID_PDF");
    error.statusCode = 415;
    throw error;
  }
  return saveAgreementFile(file.buffer, ".pdf");
};

export const saveProfessionalPhoto = async (file) => {
  if (!file) return "";
  const buffer = await optimizeImageUpload(file, {
    width: 512,
    height: 512,
    fit: "cover",
  });
  return saveUploadFile("professionals", buffer, ".webp");
};

export const saveServiceImage = async (file) => {
  if (!file) return "";
  const buffer = await optimizeImageUpload(file, {
    width: 1200,
    height: 720,
    fit: "cover",
  });
  return saveUploadFile("services", buffer, ".webp");
};

const optimizeImageUpload = async (file, options) => {
  if (!optimizableImageMimeTypes.has(file.mimeType)) {
    throw invalidImageError();
  }

  try {
    return await optimizeImageBuffer(file.buffer, options);
  } catch {
    throw invalidImageError();
  }
};

export const optimizeImageBuffer = async (buffer, options) =>
  sharp(buffer, { failOn: "warning" })
    .rotate()
    .resize({
      width: options.width,
      height: options.height,
      fit: options.fit,
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

const saveAgreementFile = async (buffer, extension) => {
  return saveUploadFile("agreements", buffer, extension);
};

const saveUploadFile = async (folder, buffer, extension) => {
  await mkdir(join(uploadRoot, folder), { recursive: true });
  const relativePath = `${folder}/${randomUUID()}${extension}`;
  await writeFile(join(uploadRoot, relativePath), buffer, { mode: 0o640 });
  return relativePath;
};

export const readCsvUpload = (file) => {
  if (!file) {
    const error = new Error("CSV_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!csvMimeTypes.has(file.mimeType) && extname(file.filename).toLowerCase() !== ".csv") {
    const error = new Error("INVALID_CSV");
    error.statusCode = 415;
    throw error;
  }
  return file.buffer.toString("utf8");
};
