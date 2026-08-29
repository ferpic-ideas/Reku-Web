import { randomBytes } from "node:crypto";
import { config } from "./config.mjs";
import { one, query, tx } from "./db.mjs";
import { parseCookies } from "./http.mjs";
import { hashToken } from "./security.mjs";

export const createProfessionalAccessLink = async ({
  professionalId,
  appointmentId = null,
  ttlHours = config.professionalLinkTtlHours,
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

  const accessUrl = new URL("/profesional-turnos/", config.appPublicUrl);
  if (Number(appointmentId) > 0) {
    accessUrl.searchParams.set("appointment", String(Number(appointmentId)));
  }
  accessUrl.hash = `token=${encodeURIComponent(token)}`;

  return {
    id: Number(result.rows[0].id),
    token,
    expires_at: result.rows[0].expires_at,
    url: accessUrl.toString(),
  };
};

export const exchangeProfessionalAccessLink = async (token) => {
  const tokenHash = hashToken(token);
  return tx(async (client) => {
    const result = await client.query(
      `
        SELECT
          l.id,
          l.professional_id,
          p.name,
          p.email
        FROM professional_access_links l
        INNER JOIN professionals p ON p.id = l.professional_id
        WHERE l.token_hash = $1
          AND l.expires_at > NOW()
          AND l.revoked_at IS NULL
          AND p.active = TRUE
          AND p.deleted_at IS NULL
        FOR UPDATE OF l
      `,
      [tokenHash],
    );
    const link = result.rows[0];
    if (!link) {
      const error = new Error("PROFESSIONAL_LINK_INVALID");
      error.statusCode = 401;
      throw error;
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const session = await client.query(
      `
        INSERT INTO professional_sessions
          (token_hash, professional_id, access_link_id, expires_at)
        VALUES ($1, $2, $3, NOW() + ($4::text || ' seconds')::interval)
        RETURNING id, expires_at
      `,
      [
        hashToken(sessionToken),
        link.professional_id,
        link.id,
        config.professionalSessionTtlSeconds,
      ],
    );
    await client.query(
      `
        UPDATE professional_access_links
        SET exchanged_at = COALESCE(exchanged_at, NOW()),
            last_accessed_at = NOW()
        WHERE id = $1
      `,
      [link.id],
    );

    return {
      token: sessionToken,
      expires_at: session.rows[0].expires_at,
      professional: {
        id: Number(link.professional_id),
        name: link.name,
        email: link.email,
      },
    };
  });
};

export const professionalSessionCookie = (token) => {
  const parts = [
    `${config.professionalSessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/api/professional",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${config.professionalSessionTtlSeconds}`,
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};

export const clearProfessionalSessionCookie = () => {
  const parts = [
    `${config.professionalSessionCookieName}=`,
    "Path=/api/professional",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};

export const requireProfessionalSession = async (request) => {
  const cookies = parseCookies(request);
  const token = cookies[config.professionalSessionCookieName] || "";
  const session = await one(
    `
      SELECT
        s.id,
        s.professional_id,
        s.expires_at,
        p.name,
        p.email
      FROM professional_sessions s
      INNER JOIN professionals p ON p.id = s.professional_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND s.revoked_at IS NULL
        AND p.active = TRUE
        AND p.deleted_at IS NULL
    `,
    [hashToken(token)],
  );
  if (!session) {
    const error = new Error("PROFESSIONAL_SESSION_INVALID");
    error.statusCode = 401;
    throw error;
  }
  await query(
    "UPDATE professional_sessions SET last_accessed_at = NOW() WHERE id = $1",
    [session.id],
  );
  return {
    id: Number(session.id),
    professional_id: Number(session.professional_id),
    expires_at: session.expires_at,
    professional: {
      id: Number(session.professional_id),
      name: session.name,
      email: session.email,
    },
  };
};

export const revokeProfessionalAccess = async (professionalId) =>
  tx(async (client) => {
    const links = await client.query(
      `
        UPDATE professional_access_links
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE professional_id = $1
          AND revoked_at IS NULL
        RETURNING id
      `,
      [professionalId],
    );
    const sessions = await client.query(
      `
        UPDATE professional_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE professional_id = $1
          AND revoked_at IS NULL
        RETURNING id
      `,
      [professionalId],
    );
    return {
      revoked_links: links.rowCount,
      revoked_sessions: sessions.rowCount,
    };
  });
