import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { config } from "./config.mjs";
import { one, query, recordAudit, tx } from "./db.mjs";
import { hashToken } from "./security.mjs";

const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const revokeEndpoint = "https://oauth2.googleapis.com/revoke";
const calendarApi = "https://www.googleapis.com/calendar/v3";
const scopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
];
const busyCache = new Map();

export const googleOAuthRedirectUri = () =>
  config.googleOAuthRedirectUri ||
  `${config.appPublicUrl}/api/professional/integrations/google/callback`;

export const googleIntegrationConfigured = () =>
  Boolean(config.googleOAuthClientId && config.googleOAuthClientSecret);

const integrationKey = () => {
  const material =
    config.googleIntegrationEncryptionKey ||
    (config.appEnv === "production" ? "" : config.sessionSecret);
  if (!material || material.length < 16) {
    const error = new Error("GOOGLE_ENCRYPTION_KEY_REQUIRED");
    error.statusCode = 503;
    throw error;
  }
  return createHash("sha256").update(material).digest();
};

const encrypt = (plainText) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", integrationKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
};

const decrypt = (payload) => {
  const [version, iv, tag, encrypted] = String(payload || "").split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("GOOGLE_TOKEN_DECRYPT_FAILED");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    integrationKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

const googleError = (status, detail = "") => {
  const error = new Error("GOOGLE_API_ERROR");
  error.statusCode = status === 429 ? 503 : 502;
  error.googleStatus = status;
  error.detail = String(detail || "").slice(0, 500);
  return error;
};

const fetchGoogle = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw googleError(
      response.status,
      payload.error_description || payload.error?.message || payload.error || text,
    );
  }
  return payload;
};

const tokenRequest = (fields) =>
  fetchGoogle(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

const idTokenClaims = (idToken) => {
  try {
    const payload = String(idToken || "").split(".")[1];
    return payload
      ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      : {};
  } catch {
    return {};
  }
};

export const getGoogleConnectionStatus = async (professionalId) => {
  if (!googleIntegrationConfigured()) {
    return { available: false, connected: false, status: "not_configured" };
  }
  const connection = await one(
    `
      SELECT google_email, calendar_id, status, last_error, connected_at
      FROM professional_google_connections
      WHERE professional_id = $1
    `,
    [professionalId],
  );
  return {
    available: true,
    connected: connection?.status === "active",
    status: connection?.status || "not_connected",
    google_email: connection?.google_email || "",
    calendar_id: connection?.calendar_id || "primary",
    last_error: connection?.last_error || "",
    connected_at: connection?.connected_at || null,
  };
};

export const createGoogleOAuthAuthorization = async (professionalId) => {
  if (!googleIntegrationConfigured()) {
    const error = new Error("GOOGLE_NOT_CONFIGURED");
    error.statusCode = 503;
    throw error;
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await query(
    `
      INSERT INTO google_oauth_states
        (state_hash, professional_id, code_verifier_encrypted, expires_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')
    `,
    [hashToken(state), professionalId, encrypt(verifier)],
  );
  await query(
    `
      DELETE FROM google_oauth_states
      WHERE expires_at < NOW() - INTERVAL '1 day'
         OR consumed_at < NOW() - INTERVAL '1 day'
    `,
  );

  const url = new URL(authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: config.googleOAuthClientId,
    redirect_uri: googleOAuthRedirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

const consumeOAuthState = (state) =>
  tx(async (client) => {
    const result = await client.query(
      `
        UPDATE google_oauth_states
        SET consumed_at = NOW()
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING professional_id, code_verifier_encrypted
      `,
      [hashToken(state)],
    );
    return result.rows[0] || null;
  });

const revokeToken = async (token) => {
  if (!token) return;
  try {
    await fetchGoogle(revokeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Revocation is best effort; the local token is always removed.
  }
};

export const finishGoogleOAuth = async ({ state, code }) => {
  if (!googleIntegrationConfigured() || !state || !code) {
    throw new Error("GOOGLE_OAUTH_INVALID");
  }
  const oauthState = await consumeOAuthState(state);
  if (!oauthState) throw new Error("GOOGLE_OAUTH_STATE_INVALID");

  const tokens = await tokenRequest({
    client_id: config.googleOAuthClientId,
    client_secret: config.googleOAuthClientSecret,
    code,
    code_verifier: decrypt(oauthState.code_verifier_encrypted),
    grant_type: "authorization_code",
    redirect_uri: googleOAuthRedirectUri(),
  });
  const claims = idTokenClaims(tokens.id_token);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !claims.sub ||
    !audiences.includes(config.googleOAuthClientId) ||
    !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
    Number(claims.exp || 0) <= Math.floor(Date.now() / 1000)
  ) {
    await revokeToken(tokens.refresh_token || tokens.access_token);
    throw new Error("GOOGLE_ID_TOKEN_INVALID");
  }
  const existing = await one(
    `SELECT * FROM professional_google_connections WHERE professional_id = $1`,
    [oauthState.professional_id],
  );
  if (
    existing?.google_subject &&
    claims.sub &&
    existing.google_subject !== claims.sub
  ) {
    const future = await one(
      `
        SELECT COUNT(*)::int AS count
        FROM appointments
        WHERE professional_id = $1
          AND appointment_date >= CURRENT_DATE
          AND google_calendar_event_id IS NOT NULL
          AND google_sync_status <> 'cancelled'
      `,
      [oauthState.professional_id],
    );
    if (Number(future?.count || 0) > 0) {
      await revokeToken(tokens.refresh_token || tokens.access_token);
      throw new Error("GOOGLE_ACCOUNT_CHANGE_BLOCKED");
    }
  }

  const refreshToken = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : existing?.refresh_token_encrypted || "";
  if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN_MISSING");
  await query(
    `
      INSERT INTO professional_google_connections
        (
          professional_id, google_subject, google_email, calendar_id,
          access_token_encrypted, refresh_token_encrypted, token_expires_at,
          granted_scopes, status, last_error, connected_at, updated_at
        )
      VALUES ($1, $2, $3, 'primary', $4, $5, NOW() + ($6 * INTERVAL '1 second'),
              $7, 'active', '', NOW(), NOW())
      ON CONFLICT (professional_id) DO UPDATE SET
        google_subject = EXCLUDED.google_subject,
        google_email = EXCLUDED.google_email,
        calendar_id = 'primary',
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        token_expires_at = EXCLUDED.token_expires_at,
        granted_scopes = EXCLUDED.granted_scopes,
        status = 'active',
        last_error = '',
        connected_at = NOW(),
        updated_at = NOW()
    `,
    [
      oauthState.professional_id,
      String(claims.sub || existing?.google_subject || ""),
      String(claims.email || existing?.google_email || ""),
      encrypt(tokens.access_token),
      refreshToken,
      Number(tokens.expires_in || 3600),
      String(tokens.scope || scopes.join(" ")),
    ],
  );
  busyCache.clear();
  await recordAudit("professional.google.connected", {
    detail: {
      professional_id: Number(oauthState.professional_id),
      google_email: String(claims.email || ""),
    },
  });
  return { professional_id: Number(oauthState.professional_id) };
};

export const disconnectGoogleCalendar = async (professionalId) => {
  const connection = await one(
    `SELECT * FROM professional_google_connections WHERE professional_id = $1`,
    [professionalId],
  );
  if (!connection) return { disconnected: true };
  const future = await one(
    `
      SELECT COUNT(*)::int AS count
      FROM appointments
      WHERE professional_id = $1
        AND appointment_date >= CURRENT_DATE
        AND google_calendar_event_id IS NOT NULL
        AND google_sync_status <> 'cancelled'
    `,
    [professionalId],
  );
  if (Number(future?.count || 0) > 0) {
    const error = new Error("GOOGLE_DISCONNECT_BLOCKED");
    error.statusCode = 409;
    throw error;
  }
  let token = "";
  try {
    token = decrypt(
      connection.refresh_token_encrypted || connection.access_token_encrypted,
    );
  } catch {
    token = "";
  }
  await revokeToken(token);
  await query(
    `
      UPDATE professional_google_connections
      SET access_token_encrypted = '',
          refresh_token_encrypted = '',
          token_expires_at = NULL,
          status = 'revoked',
          last_error = '',
          updated_at = NOW()
      WHERE professional_id = $1
    `,
    [professionalId],
  );
  busyCache.clear();
  await recordAudit("professional.google.disconnected", {
    detail: { professional_id: Number(professionalId) },
  });
  return { disconnected: true };
};

const loadConnection = (professionalId) =>
  one(
    `SELECT * FROM professional_google_connections WHERE professional_id = $1`,
    [professionalId],
  );

const markConnectionError = (professionalId, message) =>
  query(
    `
      UPDATE professional_google_connections
      SET status = 'error', last_error = $2, updated_at = NOW()
      WHERE professional_id = $1
    `,
    [professionalId, String(message || "Google requiere reconexión.").slice(0, 500)],
  );

const accessTokenFor = async (connection, { forceRefresh = false } = {}) => {
  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : 0;
  if (
    !forceRefresh &&
    connection.access_token_encrypted &&
    expiresAt > Date.now() + 60_000
  ) {
    return decrypt(connection.access_token_encrypted);
  }
  if (!connection.refresh_token_encrypted) {
    await markConnectionError(connection.professional_id, "Falta autorización offline.");
    throw new Error("GOOGLE_REAUTH_REQUIRED");
  }
  try {
    const refreshed = await tokenRequest({
      client_id: config.googleOAuthClientId,
      client_secret: config.googleOAuthClientSecret,
      refresh_token: decrypt(connection.refresh_token_encrypted),
      grant_type: "refresh_token",
    });
    await query(
      `
        UPDATE professional_google_connections
        SET access_token_encrypted = $2,
            token_expires_at = NOW() + ($3 * INTERVAL '1 second'),
            status = 'active',
            last_error = '',
            updated_at = NOW()
        WHERE professional_id = $1
      `,
      [
        connection.professional_id,
        encrypt(refreshed.access_token),
        Number(refreshed.expires_in || 3600),
      ],
    );
    return refreshed.access_token;
  } catch (error) {
    await markConnectionError(
      connection.professional_id,
      "Google rechazó la autorización. Volvé a conectar la cuenta.",
    );
    throw error;
  }
};

const calendarRequest = async (connection, path, options = {}) => {
  const token = await accessTokenFor(connection);
  try {
    return await fetchGoogle(`${calendarApi}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    if (error.googleStatus !== 401) throw error;
    const refreshed = await accessTokenFor(connection, { forceRefresh: true });
    return fetchGoogle(`${calendarApi}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
        Authorization: `Bearer ${refreshed}`,
      },
    });
  }
};

const datePlusDays = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const zonedParts = (instant) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: config.googleCalendarTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

const zonedDateTime = (date, time = "00:00") => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess));
    const rendered = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    guess += target - rendered;
  }
  return new Date(guess);
};

const timeInZone = (instant) => {
  const parts = zonedParts(instant);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
};

export const getGoogleBusyRanges = async ({
  professionalId,
  startDate,
  endDateExclusive,
}) => {
  const result = {};
  for (let date = startDate; date < endDateExclusive; date = datePlusDays(date, 1)) {
    result[date] = [];
  }
  if (!googleIntegrationConfigured()) return result;

  const cacheKey = `${professionalId}:${startDate}:${endDateExclusive}`;
  const cached = busyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const connection = await loadConnection(professionalId);
  if (!connection) return result;
  if (connection.status !== "active") throw new Error("GOOGLE_REAUTH_REQUIRED");

  const payload = await calendarRequest(connection, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: zonedDateTime(startDate).toISOString(),
      timeMax: zonedDateTime(endDateExclusive).toISOString(),
      timeZone: config.googleCalendarTimeZone,
      items: [{ id: connection.calendar_id || "primary" }],
    }),
  });
  const calendarResult =
    payload.calendars?.[connection.calendar_id || "primary"] ||
    Object.values(payload.calendars || {})[0];
  if (!calendarResult || calendarResult.errors?.length) {
    throw googleError(502, "Google no devolvió la disponibilidad del calendario.");
  }
  const busy = calendarResult.busy || [];
  for (const range of busy) {
    const busyStart = new Date(range.start);
    const busyEnd = new Date(range.end);
    for (let date = startDate; date < endDateExclusive; date = datePlusDays(date, 1)) {
      const dayStart = zonedDateTime(date);
      const dayEnd = zonedDateTime(datePlusDays(date, 1));
      const start = new Date(Math.max(busyStart.getTime(), dayStart.getTime()));
      const end = new Date(Math.min(busyEnd.getTime(), dayEnd.getTime()));
      if (start < end) {
        result[date].push({
          start_time: start <= dayStart ? "00:00" : timeInZone(start),
          end_time: end >= dayEnd ? "24:00" : timeInZone(end),
        });
      }
    }
  }
  busyCache.set(cacheKey, { expiresAt: Date.now() + 30_000, value: result });
  return result;
};

const eventIdForAppointment = (appointmentId) => `rekuappointment${appointmentId}`;

const meetUrlFromEvent = (event) =>
  event.hangoutLink ||
  (event.conferenceData?.entryPoints || []).find(
    (entry) => entry.entryPointType === "video",
  )?.uri ||
  "";

const getCalendarEvent = (connection, eventId) =>
  calendarRequest(
    connection,
    `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events/${encodeURIComponent(eventId)}`,
  );

export const holdAppointmentOnGoogleCalendar = async (appointmentId) => {
  if (!googleIntegrationConfigured()) return { skipped: true, reason: "not_configured" };
  const appointment = await one(
    `
      SELECT
        a.*,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date_text,
        to_char(a.start_time, 'HH24:MI') AS start_time_text,
        to_char(a.end_time, 'HH24:MI') AS end_time_text
      FROM appointments a
      WHERE a.id = $1
    `,
    [appointmentId],
  );
  if (!appointment || appointment.status !== "pending_payment") {
    return { skipped: true, reason: "not_pending_payment" };
  }
  const connection = await loadConnection(appointment.professional_id);
  if (!connection) return { skipped: true, reason: "not_connected" };
  if (connection.status !== "active") throw new Error("GOOGLE_REAUTH_REQUIRED");

  const eventId = appointment.google_calendar_event_id || eventIdForAppointment(appointmentId);
  const holdEvent = {
    summary: "Horario reservado · Reku",
    description: "Reserva de pago en curso. No incluye información clínica.",
    start: {
      dateTime: `${appointment.appointment_date_text}T${appointment.start_time_text}:00`,
      timeZone: config.googleCalendarTimeZone,
    },
    end: {
      dateTime: `${appointment.appointment_date_text}T${appointment.end_time_text}:00`,
      timeZone: config.googleCalendarTimeZone,
    },
    transparency: "opaque",
    reminders: { useDefault: false },
  };
  let event;
  try {
    event = await calendarRequest(
      connection,
      `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events?sendUpdates=none`,
      {
        method: "POST",
        body: JSON.stringify({
          id: eventId,
          ...holdEvent,
        }),
      },
    );
  } catch (error) {
    if (error.googleStatus === 409) {
      event = await calendarRequest(
        connection,
        `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: "PATCH", body: JSON.stringify(holdEvent) },
      );
    } else {
      await query(
        `
          UPDATE appointments
          SET google_calendar_event_id = $2,
              google_sync_status = 'failed',
              google_sync_error = $3,
              updated_at = NOW()
          WHERE id = $1
        `,
        [appointmentId, eventId, String(error.detail || error.message).slice(0, 500)],
      );
      throw error;
    }
  }
  await query(
    `
      UPDATE appointments
      SET google_calendar_event_id = $2,
          google_calendar_event_url = $3,
          google_sync_status = 'pending',
          google_sync_error = '',
          google_synced_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, eventId, event.htmlLink || ""],
  );
  busyCache.clear();
  await recordAudit("appointment.google_calendar.hold_created", {
    detail: {
      appointment_id: Number(appointmentId),
      professional_id: Number(appointment.professional_id),
    },
  });
  return { skipped: false, event_id: eventId };
};

export const cancelGoogleCalendarEventForProfessional = async ({
  professionalId,
  eventId,
}) => {
  if (!eventId) return { skipped: true, reason: "not_synced" };
  if (!googleIntegrationConfigured()) {
    return { skipped: false, ok: false, reason: "not_configured" };
  }
  const connection = await loadConnection(professionalId);
  if (!connection || connection.status !== "active") {
    return { skipped: false, ok: false, reason: "reauth_required" };
  }
  try {
    await calendarRequest(
      connection,
      `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (![404, 410].includes(error.googleStatus)) {
      return { skipped: false, ok: false, reason: "google_api_error" };
    }
  }
  busyCache.clear();
  return { skipped: false, ok: true };
};

export const syncAppointmentToGoogleCalendar = async (
  appointmentId,
  { force = false } = {},
) => {
  if (!googleIntegrationConfigured()) return { skipped: true, reason: "not_configured" };
  const appointment = await one(
    `
      SELECT
        a.*,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date_text,
        to_char(a.start_time, 'HH24:MI') AS start_time_text,
        to_char(a.end_time, 'HH24:MI') AS end_time_text,
        s.name AS service_name
      FROM appointments a
      INNER JOIN services s ON s.id = a.service_id
      WHERE a.id = $1
    `,
    [appointmentId],
  );
  if (!appointment || appointment.status !== "confirmed") {
    return { skipped: true, reason: "not_confirmed" };
  }
  if (
    !force &&
    appointment.google_sync_status === "synced" &&
    appointment.google_calendar_event_id &&
    appointment.google_meet_url
  ) {
    return {
      skipped: true,
      reason: "already_synced",
      event_id: appointment.google_calendar_event_id,
      meet_url: appointment.google_meet_url,
    };
  }
  const connection = await loadConnection(appointment.professional_id);
  if (!connection) {
    await query(
      `UPDATE appointments SET google_sync_status = 'not_connected', updated_at = NOW() WHERE id = $1`,
      [appointmentId],
    );
    return { skipped: true, reason: "not_connected" };
  }
  if (connection.status !== "active") {
    await query(
      `
        UPDATE appointments
        SET google_sync_status = 'failed',
            google_sync_error = 'Google requiere reconexión.',
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointmentId],
    );
    throw new Error("GOOGLE_REAUTH_REQUIRED");
  }

  const eventId = appointment.google_calendar_event_id || eventIdForAppointment(appointmentId);
  await query(
    `
      UPDATE appointments
      SET google_calendar_event_id = $2,
          google_sync_status = 'pending',
          google_sync_error = '',
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, eventId],
  );

  const confirmedEvent = {
    summary: `Turno Reku · ${appointment.service_name}`,
    description: "Reserva gestionada por Reku. No incluye información clínica.",
    start: {
      dateTime: `${appointment.appointment_date_text}T${appointment.start_time_text}:00`,
      timeZone: config.googleCalendarTimeZone,
    },
    end: {
      dateTime: `${appointment.appointment_date_text}T${appointment.end_time_text}:00`,
      timeZone: config.googleCalendarTimeZone,
    },
    // The patient receives Reku's time-gated access instead of Google's raw Meet URL.
    attendees: [],
    conferenceData: {
      createRequest: {
        requestId: `reku-appointment-${appointmentId}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
    reminders: { useDefault: true },
  };
  let event;
  try {
    event = await calendarRequest(
      connection,
      `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events?conferenceDataVersion=1&sendUpdates=none`,
      {
        method: "POST",
        body: JSON.stringify({
          id: eventId,
          ...confirmedEvent,
        }),
      },
    );
  } catch (error) {
    if (error.googleStatus === 409) {
      event = await calendarRequest(
        connection,
        `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`,
        { method: "PATCH", body: JSON.stringify(confirmedEvent) },
      );
    } else {
      await query(
        `
          UPDATE appointments
          SET google_sync_status = 'failed', google_sync_error = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [appointmentId, String(error.detail || error.message).slice(0, 500)],
      );
      throw error;
    }
  }

  let meetUrl = meetUrlFromEvent(event);
  if (!meetUrl) {
    for (let attempt = 0; attempt < 3 && !meetUrl; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      event = await getCalendarEvent(connection, eventId);
      meetUrl = meetUrlFromEvent(event);
    }
  }
  if (meetUrl) {
    const duplicate = await one(
      `
        SELECT id
        FROM appointments
        WHERE google_meet_url = $1
          AND id <> $2
        LIMIT 1
      `,
      [meetUrl, appointmentId],
    );
    if (duplicate) {
      await query(
        `
          UPDATE appointments
          SET google_sync_status = 'failed',
              google_sync_error = 'Google devolvió una videollamada asignada a otro turno.',
              updated_at = NOW()
          WHERE id = $1
        `,
        [appointmentId],
      );
      const error = new Error("GOOGLE_MEET_DUPLICATE");
      error.conflictingAppointmentId = Number(duplicate.id);
      throw error;
    }
  }
  const syncStatus = meetUrl ? "synced" : "pending";
  await query(
    `
      UPDATE appointments
      SET google_calendar_event_url = $2,
          google_meet_url = $3,
          google_sync_status = $4,
          google_sync_error = '',
          google_synced_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, event.htmlLink || "", meetUrl, syncStatus],
  );
  busyCache.clear();
  await recordAudit("appointment.google_calendar.synced", {
    detail: {
      appointment_id: Number(appointmentId),
      professional_id: Number(appointment.professional_id),
      meet_created: Boolean(meetUrl),
    },
  });
  return { skipped: false, event_id: eventId, meet_url: meetUrl, status: syncStatus };
};

export const cancelGoogleCalendarAppointment = async (appointmentId) => {
  const appointment = await one(
    `
      SELECT id, professional_id, google_calendar_event_id, google_sync_status
      FROM appointments
      WHERE id = $1
    `,
    [appointmentId],
  );
  if (!appointment?.google_calendar_event_id) {
    return { skipped: true, reason: "not_synced" };
  }
  if (!googleIntegrationConfigured()) {
    await query(
      `
        UPDATE appointments
        SET google_sync_status = 'failed',
            google_sync_error = 'No se pudo cancelar el evento: Google no está configurado.',
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointmentId],
    );
    return { skipped: false, ok: false, reason: "not_configured" };
  }
  const connection = await loadConnection(appointment.professional_id);
  if (!connection || connection.status !== "active") {
    await query(
      `
        UPDATE appointments
        SET google_sync_status = 'failed',
            google_sync_error = 'No se pudo cancelar el evento: Google requiere reconexión.',
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointmentId],
    );
    return { skipped: false, ok: false, reason: "reauth_required" };
  }
  try {
    await calendarRequest(
      connection,
      `/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events/${encodeURIComponent(appointment.google_calendar_event_id)}?sendUpdates=all`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (![404, 410].includes(error.googleStatus)) {
      await query(
        `
          UPDATE appointments
          SET google_sync_status = 'failed', google_sync_error = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [appointmentId, String(error.detail || error.message).slice(0, 500)],
      );
      return { skipped: false, ok: false, reason: "google_api_error" };
    }
  }
  await query(
    `
      UPDATE appointments
      SET google_sync_status = 'cancelled',
          google_sync_error = '',
          google_synced_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId],
  );
  busyCache.clear();
  await recordAudit("appointment.google_calendar.cancelled", {
    detail: {
      appointment_id: Number(appointmentId),
      professional_id: Number(appointment.professional_id),
    },
  });
  return { skipped: false, ok: true };
};

export const cleanupExpiredGoogleCalendarHolds = async () => {
  const expired = await query(
    `
      UPDATE appointments
      SET status = 'payment_failed',
          payment_status = 'expired',
          updated_at = NOW()
      WHERE status = 'pending_payment'
        AND payment_status = 'pending'
        AND created_at <= NOW() - INTERVAL '40 minutes'
      RETURNING id
    `,
  );
  const pendingCleanup = await query(
    `
      SELECT id
      FROM appointments
      WHERE status = 'payment_failed'
        AND payment_status = 'expired'
        AND google_calendar_event_id IS NOT NULL
        AND google_sync_status IN ('pending', 'failed')
      ORDER BY updated_at
      LIMIT 100
    `,
  );
  const appointmentIds = new Set([
    ...expired.rows.map((row) => Number(row.id)),
    ...pendingCleanup.rows.map((row) => Number(row.id)),
  ]);
  let cleaned = 0;
  for (const appointmentId of appointmentIds) {
    const result = await cancelGoogleCalendarAppointment(appointmentId);
    if (result.ok || result.reason === "not_synced") cleaned += 1;
  }
  if (appointmentIds.size) {
    await recordAudit("appointment.google_calendar.holds_expired", {
      detail: { expired: expired.rowCount, cleanup_attempted: appointmentIds.size, cleaned },
    });
  }
  return { expired: expired.rowCount, cleanup_attempted: appointmentIds.size, cleaned };
};
