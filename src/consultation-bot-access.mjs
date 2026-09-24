import { randomBytes } from 'node:crypto';
import { query, tx } from './db.mjs';
import { config, isProduction } from './config.mjs';
import { parseCookies } from './http.mjs';
import { hashToken } from './security.mjs';
import { agreementPrefixForRequest } from './agreement-resolution.mjs';
import { decryptBotReport, encryptBotReport } from './consultation-bot-report-storage.mjs';
import { consultationBotMode } from './consultation-mode.mjs';
export { consultationBotMode } from './consultation-mode.mjs';

export const botAccessCookieName = 'reku_bot_appointment';
export const botAccessMessages = {
  required: 'Este asistente está disponible para pacientes con un turno confirmado. Ingresá desde el enlace de tu turno.',
  completed: '¡Gracias! Ya completaste la entrevista para este turno. No hace falta que la vuelvas a realizar.',
  busy: 'Estamos procesando un mensaje para este turno. Esperá unos segundos antes de continuar.',
  limit: 'Por ahora alcanzaste el límite de uso para este turno. Si necesitás ayuda, contactá al equipo de Reku.',
};
const fail = (code, statusCode = 403) => Object.assign(new Error(`BOT_ACCESS_${code.toUpperCase()}`), { statusCode, publicMessage: botAccessMessages[code] });
export const botAppointmentCookie = token => `${botAccessCookieName}=${encodeURIComponent(token)}; Path=/api/bot/; HttpOnly; SameSite=Strict; Max-Age=7200${isProduction ? '; Secure' : ''}`;
export const hasBotAppointmentAccess = request => consultationBotMode() === 'production' || Object.hasOwn(parseCookies(request), botAccessCookieName);

export const validateBotAppointment = (row, prefix, { allowCompleted = false } = {}) => {
  if (!row || row.status !== 'confirmed' || (!row.current_appointment && !(allowCompleted && row.completed_at)) || row.agreement_prefix !== prefix) throw fail('required');
  if (row.consultation_required === false) throw fail('required');
  if (row.completed_at && !allowCompleted) throw fail('completed', 409);
  return row;
};

export const requireBotAppointment = async (request, { token = parseCookies(request)[botAccessCookieName], allowCompleted = false, execute = query } = {}) => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('required');
  const result = await execute(`
    SELECT link.id AS access_link_id, appointment.id AS appointment_id,
      appointment.status, appointment.consultation_required, usage.completed_at, (usage.report_encrypted IS NOT NULL) AS report_available,
      appointment.patient_id, appointment.patient_name, appointment.patient_email, appointment.patient_phone,
      ((appointment.appointment_date + appointment.end_time) AT TIME ZONE $2) > NOW() AS current_appointment,
      CASE WHEN appointment.agreement_id IS NULL THEN ''
        ELSE COALESCE(NULLIF(agreement.subdomain_prefix, ''), agreement.slug) END AS agreement_prefix
    FROM patient_appointment_access_links link
    JOIN appointments appointment ON appointment.id = link.appointment_id
    LEFT JOIN agreements agreement ON agreement.id = appointment.agreement_id
    LEFT JOIN consultation_bot_usage usage ON usage.appointment_id = appointment.id
    WHERE link.token_hash = $1 AND link.expires_at > NOW() AND link.revoked_at IS NULL
  `, [hashToken(token), config.googleCalendarTimeZone]);
  return validateBotAppointment(result.rows[0], agreementPrefixForRequest(request), { allowCompleted });
};

export const readProfessionalBotReport = async (appointmentId, professionalId, { execute = query } = {}) => {
  const result = await execute(`SELECT usage.report_encrypted
    FROM consultation_bot_usage usage JOIN appointments appointment ON appointment.id = usage.appointment_id
    WHERE appointment.id = $1 AND appointment.professional_id = $2
      AND usage.completed_at IS NOT NULL AND usage.report_encrypted IS NOT NULL`, [appointmentId, professionalId]);
  if (!result.rows[0]) throw Object.assign(new Error('BOT_REPORT_NOT_FOUND'), { statusCode: 404 });
  return decryptBotReport(result.rows[0].report_encrypted, appointmentId);
};

// Call only after authenticating the administrator and checking appointments.read.
export const readAdminBotReport = async (appointmentId, { execute = query } = {}) => {
  const result = await execute(`SELECT report_encrypted FROM consultation_bot_usage
    WHERE appointment_id = $1 AND completed_at IS NOT NULL AND report_encrypted IS NOT NULL`, [appointmentId]);
  if (!result.rows[0]) throw Object.assign(new Error('BOT_REPORT_NOT_FOUND'), { statusCode: 404 });
  return decryptBotReport(result.rows[0].report_encrypted, appointmentId);
};

// A database row lock serializes quota reservation and completion across tabs,
// browsers and app processes. Refreshing only resets the transient conversation.
export const beginBotAppointmentAction = async (request, appointmentId, kind, { transaction = tx } = {}) => transaction(async client => {
  const access = await requireBotAppointment(request, { execute: client.query.bind(client) });
  if (String(access.appointment_id) !== String(appointmentId)) throw fail('required');
  await client.query('INSERT INTO consultation_bot_usage (appointment_id) VALUES ($1) ON CONFLICT DO NOTHING', [appointmentId]);
  const result = await client.query('SELECT *, active_until > NOW() AS active FROM consultation_bot_usage WHERE appointment_id = $1 FOR UPDATE', [appointmentId]);
  const usage = result.rows[0];
  if (usage.completed_at) throw fail('completed', 409);
  if (usage.active) throw fail('busy', 409);
  if ((kind === 'message' && usage.message_count >= 25) || (kind === 'transcribe' && usage.audio_count >= 15)) throw fail('limit', 429);
  if (!['message', 'transcribe'].includes(kind)) throw fail('required');
  const requestHash = hashToken(randomBytes(32).toString('hex'));
  await client.query(`UPDATE consultation_bot_usage SET
    message_count = message_count + $2, audio_count = audio_count + $3,
    active_request_hash = $4, active_until = NOW() + INTERVAL '5 minutes', updated_at = NOW()
    WHERE appointment_id = $1`, [appointmentId, kind === 'message' ? 1 : 0, kind === 'transcribe' ? 1 : 0, requestHash]);
  return { appointmentId, requestHash };
});

export const finishBotAppointmentAction = async (reservation, { completed = false, reportPdf, execute = query } = {}) => {
  if (!reservation) return;
  // Completion and its recoverable PDF are committed in the same SQL update.
  const encrypted = completed ? encryptBotReport(reportPdf, reservation.appointmentId) : null;
  const result = await execute(`UPDATE consultation_bot_usage SET
    completed_at = CASE WHEN $3 THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
    report_encrypted = CASE WHEN $3 THEN $4 ELSE report_encrypted END,
    active_request_hash = NULL, active_until = NULL, updated_at = NOW()
    WHERE appointment_id = $1 AND active_request_hash = $2 RETURNING appointment_id`,
  [reservation.appointmentId, reservation.requestHash, completed, encrypted]);
  if (!result.rows.length && completed) throw fail('busy', 409);
};

export const readBotAppointmentReport = async (request, { execute = query } = {}) => {
  const access = await requireBotAppointment(request, { allowCompleted: true, execute });
  if (!access.completed_at || !access.report_available) throw Object.assign(new Error('BOT_REPORT_NOT_READY'), { statusCode: 409 });
  const result = await execute('SELECT report_encrypted FROM consultation_bot_usage WHERE appointment_id = $1 AND completed_at IS NOT NULL', [access.appointment_id]);
  return decryptBotReport(result.rows[0]?.report_encrypted, access.appointment_id);
};
