import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const publicUploadRoot = resolve(
  process.env.PUBLIC_UPLOAD_ROOT ||
    process.env.UPLOAD_ROOT ||
    join(root, "uploads"),
);
export const privateUploadRoot = resolve(
  process.env.PRIVATE_UPLOAD_ROOT || join(root, "private-uploads"),
);
// Compatibility alias for modules that only write explicitly public media.
export const uploadRoot = publicUploadRoot;

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
  databaseSslMode: (process.env.DATABASE_SSL_MODE || "disable").trim().toLowerCase(),
  databaseSslCa: (process.env.DATABASE_SSL_CA || "").replaceAll("\\n", "\n"),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "reku_admin_session",
  sessionSecret: process.env.SESSION_SECRET || "development-session-secret",
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 259_200),
  sessionSecure:
    process.env.SESSION_SECURE === "true" ||
    process.env.APP_ENV === "production",
  bootstrapAdminEmail: (process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase(),
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || "",
  bookingAccessCookieName:
    process.env.BOOKING_ACCESS_COOKIE_NAME || "reku_booking_access",
  bookingEmailVerificationEnabled:
    process.env.BOOKING_EMAIL_VERIFICATION_ENABLED !== "false",
  patientAppointmentSessionCookieName:
    process.env.PATIENT_APPOINTMENT_SESSION_COOKIE_NAME ||
    "reku_patient_appointment_session",
  patientAppointmentLinkGraceDays: Number(
    process.env.PATIENT_APPOINTMENT_LINK_GRACE_DAYS ||
      process.env.PATIENT_APPOINTMENT_LINK_TTL_DAYS ||
      7,
  ),
  patientAppointmentSessionTtlSeconds: Number(
    process.env.PATIENT_APPOINTMENT_SESSION_TTL_SECONDS || 43_200,
  ),
  patientMeetEarlyMinutes: Number(
    process.env.PATIENT_MEET_EARLY_MINUTES || 10,
  ),
  patientMeetLateMinutes: Number(
    process.env.PATIENT_MEET_LATE_MINUTES || 15,
  ),
  professionalLinkTtlHours: Number(process.env.PROFESSIONAL_LINK_TTL_HOURS || 24),
  professionalSessionTtlSeconds: Number(
    process.env.PROFESSIONAL_SESSION_TTL_SECONDS || 43_200,
  ),
  professionalSessionCookieName:
    process.env.PROFESSIONAL_SESSION_COOKIE_NAME || "reku_professional_session",
  professionalInvitationTtlHours: Number(
    process.env.PROFESSIONAL_INVITATION_TTL_HOURS || 72,
  ),
  passwordResetTtlMinutes: Number(
    process.env.PASSWORD_RESET_TTL_MINUTES || 30,
  ),
  webPushVapidPublicKey: (process.env.WEB_PUSH_VAPID_PUBLIC_KEY || "").trim(),
  webPushVapidPrivateKey: (process.env.WEB_PUSH_VAPID_PRIVATE_KEY || "").trim(),
  webPushVapidSubject: (
    process.env.WEB_PUSH_VAPID_SUBJECT || "mailto:hola@reku.io"
  ).trim(),
  mercadoPagoWebhookMaxAgeSeconds: Number(
    process.env.MP_WEBHOOK_MAX_AGE_SECONDS || 300,
  ),
  googleOAuthClientId: (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim(),
  googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  googleOAuthRedirectUri: (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim(),
  googleIntegrationEncryptionKey:
    process.env.GOOGLE_INTEGRATION_ENCRYPTION_KEY || "",
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || "",
  googleCalendarTimeZone:
    process.env.GOOGLE_CALENDAR_TIME_ZONE || "America/Argentina/Buenos_Aires",
  googleCalendarRequired: process.env.GOOGLE_CALENDAR_REQUIRED === "true",
  rehubBaseUrl: (
    process.env.REHUB_BASE_URL ||
    "https://uxc2aw5mv8.execute-api.eu-west-1.amazonaws.com/dev2"
  ).replace(/\/+$/, ""),
  rehubClientId: (process.env.REHUB_CLIENT_ID || "").trim(),
  rehubPublicKeyBase64: (process.env.REHUB_PUBLIC_KEY_BASE64 || "").trim(),
  rehubPublicKeyPath: (process.env.REHUB_PUBLIC_KEY_PATH || "").trim(),
  rehubTriageLang: (process.env.REHUB_TRIAGE_LANG || "es").trim(),
  rehubTimeoutMs: Number(process.env.REHUB_TIMEOUT_MS || 10_000),
  contactToEmail: process.env.CONTACT_TO_EMAIL || "hola@reku.io",
  patientIntakeToEmail:
    process.env.PATIENT_INTAKE_TO_EMAIL || "altas-pacientes@reku.io",
  emailProvider: (process.env.EMAIL_PROVIDER || "ses").trim().toLowerCase(),
  emailFromEmail:
    process.env.EMAIL_FROM ||
    process.env.SES_FROM_EMAIL ||
    "Reku <hola@reku.io>",
  sesFromEmail: process.env.SES_FROM_EMAIL || "Reku <hola@reku.io>",
  resendApiKey: process.env.RESEND_API_KEY || "",
  resendFromEmail:
    process.env.RESEND_FROM_EMAIL ||
    process.env.EMAIL_FROM ||
    process.env.SES_FROM_EMAIL ||
    "Reku <hola@reku.io>",
  resendReplyToEmail:
    process.env.RESEND_REPLY_TO_EMAIL ||
    process.env.EMAIL_REPLY_TO ||
    "hola@reku.io",
  awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
  emailDryRun: process.env.EMAIL_DRY_RUN === "true",
};

export const isProduction = config.appEnv === "production";

export const assertSafeStartup = () => {
  if (isProduction && !config.databaseUrl) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (!["disable", "require", "verify-full"].includes(config.databaseSslMode)) {
    throw new Error("DATABASE_SSL_MODE must be disable, require or verify-full");
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
  if (isProduction && !config.bookingEmailVerificationEnabled) {
    throw new Error("BOOKING_EMAIL_VERIFICATION_ENABLED must be true in production");
  }
  if (config.uploadMaxBytes < 1 || config.csvUploadMaxBytes < 1) {
    throw new Error("Upload limits must be positive");
  }
  if (
    config.professionalLinkTtlHours < 1 ||
    config.patientAppointmentLinkGraceDays < 1 ||
    config.patientAppointmentLinkGraceDays > 30 ||
    config.patientAppointmentSessionTtlSeconds < 300 ||
    !Number.isFinite(config.patientMeetEarlyMinutes) ||
    config.patientMeetEarlyMinutes < 0 ||
    config.patientMeetEarlyMinutes > 120 ||
    !Number.isFinite(config.patientMeetLateMinutes) ||
    config.patientMeetLateMinutes < 0 ||
    config.patientMeetLateMinutes > 120 ||
    config.professionalInvitationTtlHours < 1 ||
    !Number.isFinite(config.passwordResetTtlMinutes) ||
    config.passwordResetTtlMinutes < 10 ||
    config.passwordResetTtlMinutes > 60 ||
    config.professionalSessionTtlSeconds < 300 ||
    config.mercadoPagoWebhookMaxAgeSeconds < 30
  ) {
    throw new Error("Security TTL values must be positive and within safe bounds");
  }
  if (!["ses", "resend"].includes(config.emailProvider)) {
    throw new Error("EMAIL_PROVIDER must be ses or resend");
  }
  const googleConfigured = Boolean(
    config.googleOAuthClientId || config.googleOAuthClientSecret,
  );
  if (
    googleConfigured &&
    (!config.googleOAuthClientId || !config.googleOAuthClientSecret)
  ) {
    throw new Error("Google OAuth client id and secret must be configured together");
  }
  if (isProduction && config.settingsEncryptionKey.length < 32) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY must have at least 32 characters in production",
    );
  }
  if (
    googleConfigured &&
    isProduction &&
    config.googleIntegrationEncryptionKey.length < 32
  ) {
    throw new Error(
      "GOOGLE_INTEGRATION_ENCRYPTION_KEY must have at least 32 characters in production",
    );
  }
  if (config.googleCalendarRequired && !googleConfigured) {
    throw new Error(
      "GOOGLE_CALENDAR_REQUIRED needs Google OAuth client credentials",
    );
  }
  const webPushConfigured = Boolean(
    config.webPushVapidPublicKey || config.webPushVapidPrivateKey,
  );
  if (
    webPushConfigured &&
    (!config.webPushVapidPublicKey || !config.webPushVapidPrivateKey)
  ) {
    throw new Error(
      "WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY must be configured together",
    );
  }
  if (
    webPushConfigured &&
    !/^(mailto:|https:\/\/)/i.test(config.webPushVapidSubject)
  ) {
    throw new Error("WEB_PUSH_VAPID_SUBJECT must be a mailto: or https:// URL");
  }
  const rehubKeyConfigured = Boolean(
    config.rehubPublicKeyBase64 || config.rehubPublicKeyPath,
  );
  if (Boolean(config.rehubClientId) !== rehubKeyConfigured) {
    throw new Error(
      "REHUB_CLIENT_ID and a ReHub public key must be configured together",
    );
  }
  if (config.rehubPublicKeyBase64 && config.rehubPublicKeyPath) {
    throw new Error(
      "Configure only one of REHUB_PUBLIC_KEY_BASE64 or REHUB_PUBLIC_KEY_PATH",
    );
  }
  if (config.rehubTimeoutMs < 1_000 || config.rehubTimeoutMs > 30_000) {
    throw new Error("REHUB_TIMEOUT_MS must be between 1000 and 30000");
  }
};

export const ensureRuntimeDirectories = async () => {
  await mkdir(join(publicUploadRoot, "agreements"), { recursive: true });
  await mkdir(join(publicUploadRoot, "professionals"), { recursive: true });
  await mkdir(join(publicUploadRoot, "services"), { recursive: true });
  await mkdir(privateUploadRoot, { recursive: true });
};
