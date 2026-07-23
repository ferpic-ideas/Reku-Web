import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const uploadRoot = resolve(
  process.env.UPLOAD_ROOT || join(root, "uploads"),
);

export const config = {
  appEnv: process.env.APP_ENV || "development",
  appPublicUrl: (process.env.APP_PUBLIC_URL || "https://www.reku.io").replace(
    /\/$/,
    "",
  ),
  port: Number(process.env.PORT || 3000),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 50_000),
  uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024),
  csvUploadMaxBytes: Number(process.env.CSV_UPLOAD_MAX_BYTES || 2 * 1024 * 1024),
  databaseUrl: process.env.DATABASE_URL || "",
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "reku_admin_session",
  sessionSecret: process.env.SESSION_SECRET || "development-session-secret",
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 259_200),
  sessionSecure:
    process.env.SESSION_SECURE === "true" ||
    process.env.APP_ENV === "production",
  bootstrapAdminEmail: (
    process.env.BOOTSTRAP_ADMIN_EMAIL || "ferpic@gmail.com"
  ).toLowerCase(),
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || "",
  contactToEmail: process.env.CONTACT_TO_EMAIL || "hola@reku.io",
  patientIntakeToEmail:
    process.env.PATIENT_INTAKE_TO_EMAIL || "altas-pacientes@reku.io",
  sesFromEmail: process.env.SES_FROM_EMAIL || "Reku <hola@reku.io>",
  awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
  emailDryRun: process.env.EMAIL_DRY_RUN === "true",
};

export const isProduction = config.appEnv === "production";

export const assertSafeStartup = () => {
  if (isProduction && !config.databaseUrl) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (
    isProduction &&
    (config.sessionSecret === "development-session-secret" ||
      config.sessionSecret.length < 32)
  ) {
    throw new Error("SESSION_SECRET must be changed in production");
  }
  if (isProduction && !config.sessionSecure) {
    throw new Error("SESSION_SECURE must be true in production");
  }
  if (config.uploadMaxBytes < 1 || config.csvUploadMaxBytes < 1) {
    throw new Error("Upload limits must be positive");
  }
};

export const ensureRuntimeDirectories = async () => {
  await mkdir(join(uploadRoot, "agreements"), { recursive: true });
  await mkdir(join(uploadRoot, "professionals"), { recursive: true });
  await mkdir(join(uploadRoot, "services"), { recursive: true });
};
