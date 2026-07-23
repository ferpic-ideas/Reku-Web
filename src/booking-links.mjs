import { randomBytes } from "node:crypto";
import { config } from "./config.mjs";
import { query } from "./db.mjs";
import { hashToken } from "./security.mjs";

export const createBookingAccessLink = async ({
  patientIntakeId = null,
  label = "",
  ttlHours = 48,
} = {}) => {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const result = await query(
    `
      INSERT INTO booking_access_links
        (token_hash, patient_intake_id, label, expires_at)
      VALUES ($1, $2, $3, NOW() + ($4::text || ' hours')::interval)
      RETURNING id, expires_at
    `,
    [tokenHash, patientIntakeId || null, String(label || ""), Number(ttlHours)],
  );

  return {
    id: Number(result.rows[0].id),
    token,
    expires_at: result.rows[0].expires_at,
    url: `${config.appPublicUrl}/agenda/?token=${encodeURIComponent(token)}`,
  };
};
