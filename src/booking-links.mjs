import { randomBytes } from "node:crypto";
import { config } from "./config.mjs";
import { query as databaseQuery } from "./db.mjs";
import { hashToken } from "./security.mjs";

export const createBookingAccessLink = async ({
  patientIntakeId = null,
  label = "",
  patientName = "",
  patientEmail = "",
  patientPhone = "",
  agreementId = null,
  agreementName = "",
  agreementSlug = "",
  agreementType = "",
  ttlHours = 48,
  client = null,
} = {}) => {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const execute = client ? client.query.bind(client) : databaseQuery;
  const result = await execute(
    `
      INSERT INTO booking_access_links
        (
          token_hash,
          patient_intake_id,
          label,
          patient_name,
          patient_email,
          patient_phone,
          agreement_id,
          agreement_name_snapshot,
          agreement_slug_snapshot,
          agreement_type_snapshot,
          expires_at
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11::text || ' hours')::interval)
      RETURNING id, expires_at
    `,
    [
      tokenHash,
      patientIntakeId || null,
      String(label || ""),
      String(patientName || ""),
      String(patientEmail || "").trim().toLowerCase(),
      String(patientPhone || ""),
      agreementId || null,
      String(agreementName || ""),
      String(agreementSlug || ""),
      String(agreementType || ""),
      Number(ttlHours),
    ],
  );

  return {
    id: Number(result.rows[0].id),
    token,
    expires_at: result.rows[0].expires_at,
    url: `${config.appPublicUrl}/agenda/#token=${encodeURIComponent(token)}`,
  };
};

export const bookingAccessCookie = (token, expiresAt) => {
  const secondsUntilExpiry = Math.floor(
    (new Date(expiresAt).getTime() - Date.now()) / 1000,
  );
  const maxAge = Math.max(60, Math.min(48 * 60 * 60, secondsUntilExpiry));
  const parts = [
    `${config.bookingAccessCookieName}=${encodeURIComponent(token)}`,
    "Path=/api/booking",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};
