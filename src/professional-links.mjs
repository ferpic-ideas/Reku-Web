import { randomBytes } from "node:crypto";
import { config } from "./config.mjs";
import { one, query } from "./db.mjs";
import { hashToken } from "./security.mjs";

export const createProfessionalAccessLink = async ({
  professionalId,
  ttlHours = 24 * 90,
} = {}) => {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const result = await query(
    `
      INSERT INTO professional_access_links
        (token_hash, professional_id, expires_at)
      VALUES ($1, $2, NOW() + ($3::text || ' hours')::interval)
      RETURNING id, expires_at
    `,
    [tokenHash, Number(professionalId), Number(ttlHours)],
  );

  return {
    id: Number(result.rows[0].id),
    token,
    expires_at: result.rows[0].expires_at,
    url: `${config.appPublicUrl}/profesional-turnos/?token=${encodeURIComponent(token)}`,
  };
};

export const requireProfessionalAccessLink = async (token) => {
  const tokenHash = hashToken(token);
  const link = await one(
    `
      SELECT
        l.id,
        l.professional_id,
        l.expires_at,
        p.name,
        p.email
      FROM professional_access_links l
      INNER JOIN professionals p ON p.id = l.professional_id
      WHERE l.token_hash = $1
        AND l.expires_at > NOW()
        AND p.active = TRUE
        AND p.deleted_at IS NULL
    `,
    [tokenHash],
  );
  if (!link) {
    const error = new Error("PROFESSIONAL_LINK_INVALID");
    error.statusCode = 401;
    throw error;
  }

  await query(
    "UPDATE professional_access_links SET last_accessed_at = NOW() WHERE id = $1",
    [link.id],
  );

  return {
    id: Number(link.id),
    professional_id: Number(link.professional_id),
    expires_at: link.expires_at,
    professional: {
      id: Number(link.professional_id),
      name: link.name,
      email: link.email,
    },
  };
};
