import { query } from './db.mjs';

// Completion means the recoverable report was committed, not just that a tab
// was opened or the assistant generated its closing message.
export const consultationStatusSql = (appointmentAlias) => {
  if (!/^[a-z_]+$/.test(appointmentAlias)) throw new Error('INVALID_SQL_ALIAS');
  return `COALESCE((SELECT CASE
    WHEN usage.completed_at IS NOT NULL AND usage.report_encrypted IS NOT NULL THEN 'completed'
    WHEN usage.message_count > 0 OR usage.audio_count > 0 THEN 'started'
    ELSE 'pending' END FROM consultation_bot_usage usage
    WHERE usage.appointment_id = ${appointmentAlias}.id), 'pending')`;
};

export const readAppointmentConsultationStatus = async (appointmentId, { execute = query } = {}) => {
  const result = await execute(`SELECT ${consultationStatusSql('appointment')} AS status
    FROM appointments appointment WHERE appointment.id = $1`, [appointmentId]);
  if (!result.rows[0]) throw Object.assign(new Error('PATIENT_APPOINTMENT_NOT_FOUND'), { statusCode: 404 });
  return result.rows[0].status;
};
