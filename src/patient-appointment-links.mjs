import { randomBytes } from "node:crypto";
import { config } from "./config.mjs";
import { one, query, tx } from "./db.mjs";
import { parseCookies } from "./http.mjs";
import { hashToken } from "./security.mjs";

export const createPatientAppointmentAccessLink = async ({
  appointmentId,
  graceDays = config.patientAppointmentLinkGraceDays,
  maxExchanges = config.patientAppointmentLinkMaxExchanges,
} = {}) => {
  const token = randomBytes(32).toString("base64url");
  const result = await query(
    `
      INSERT INTO patient_appointment_access_links
        (token_hash, appointment_id, expires_at, max_exchanges)
      SELECT
        $1,
        appointment.id,
        GREATEST(
          NOW() + INTERVAL '1 day',
          ((appointment.appointment_date + appointment.end_time) AT TIME ZONE $4)
            + ($3::text || ' days')::interval
        ),
        $5
      FROM appointments appointment
      WHERE appointment.id = $2
      RETURNING id, expires_at
    `,
    [
      hashToken(token),
      Number(appointmentId),
      Number(graceDays),
      config.googleCalendarTimeZone,
      Number(maxExchanges),
    ],
  );
  if (!result.rows[0]) {
    const error = new Error("PATIENT_APPOINTMENT_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  await query(
    `
      DELETE FROM patient_appointment_sessions
      WHERE expires_at < NOW() - INTERVAL '30 days'
    `,
  );
  await query(
    `
      DELETE FROM patient_appointment_access_links
      WHERE expires_at < NOW() - INTERVAL '30 days'
    `,
  );
  return {
    id: Number(result.rows[0].id),
    token,
    expires_at: result.rows[0].expires_at,
    url: `${config.appPublicUrl}/turnos/#manage=${encodeURIComponent(token)}`,
    meet_url: `${config.appPublicUrl}/turnos/?view=videollamada#manage=${encodeURIComponent(token)}`,
  };
};

export const exchangePatientAppointmentAccessLink = async (token) =>
  tx(async (client) => {
    const linkResult = await client.query(
      `
        SELECT link.id, link.appointment_id
        FROM patient_appointment_access_links link
        INNER JOIN appointments appointment ON appointment.id = link.appointment_id
        WHERE link.token_hash = $1
          AND link.expires_at > NOW()
          AND link.revoked_at IS NULL
          AND link.exchange_count < link.max_exchanges
          AND NULLIF(appointment.patient_email, '') IS NOT NULL
        FOR UPDATE OF link
      `,
      [hashToken(token)],
    );
    const link = linkResult.rows[0];
    if (!link) {
      const error = new Error("PATIENT_APPOINTMENT_LINK_INVALID");
      error.statusCode = 401;
      throw error;
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionResult = await client.query(
      `
        INSERT INTO patient_appointment_sessions
          (token_hash, access_link_id, appointment_id, expires_at)
        VALUES ($1, $2, $3, NOW() + ($4::text || ' seconds')::interval)
        RETURNING id, expires_at
      `,
      [
        hashToken(sessionToken),
        link.id,
        link.appointment_id,
        config.patientAppointmentSessionTtlSeconds,
      ],
    );
    await client.query(
      `
        UPDATE patient_appointment_access_links
        SET last_accessed_at = NOW(),
            exchange_count = exchange_count + 1
        WHERE id = $1
      `,
      [link.id],
    );
    return {
      token: sessionToken,
      appointment_id: Number(link.appointment_id),
      expires_at: sessionResult.rows[0].expires_at,
    };
  });

export const revokeOtherPatientAppointmentAccessLinks = async ({
  appointmentId,
  keepLinkId,
}) => {
  await query(
    `
      UPDATE patient_appointment_access_links
      SET revoked_at = NOW()
      WHERE appointment_id = $1
        AND id <> $2
        AND revoked_at IS NULL
    `,
    [Number(appointmentId), Number(keepLinkId)],
  );
};

export const patientAppointmentSessionCookie = (token) => {
  const parts = [
    `${config.patientAppointmentSessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/api/booking/manage",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${config.patientAppointmentSessionTtlSeconds}`,
  ];
  if (config.sessionSecure) parts.push("Secure");
  return parts.join("; ");
};

export const requirePatientAppointmentSession = async (request) => {
  const token = parseCookies(request)[config.patientAppointmentSessionCookieName] || "";
  const session = await one(
    `
      SELECT id, appointment_id, expires_at
      FROM patient_appointment_sessions
      WHERE token_hash = $1
        AND expires_at > NOW()
        AND revoked_at IS NULL
    `,
    [hashToken(token)],
  );
  if (!session) {
    const error = new Error("PATIENT_APPOINTMENT_SESSION_INVALID");
    error.statusCode = 401;
    throw error;
  }
  await query(
    "UPDATE patient_appointment_sessions SET last_accessed_at = NOW() WHERE id = $1",
    [session.id],
  );
  return {
    id: Number(session.id),
    appointment_id: Number(session.appointment_id),
    expires_at: session.expires_at,
  };
};

export const enforcePatientAppointmentOrigin = (request) => {
  const origin = String(request.headers.origin || "").trim();
  let valid = false;
  try {
    valid = Boolean(origin) && new URL(origin).origin === new URL(config.appPublicUrl).origin;
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error("PATIENT_APPOINTMENT_ORIGIN_INVALID");
    error.statusCode = 403;
    throw error;
  }
};
