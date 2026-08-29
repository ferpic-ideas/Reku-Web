import { config } from "../src/config.mjs";
import { pool, query } from "../src/db.mjs";
import { syncAppointmentToGoogleCalendar } from "../src/google-calendar.mjs";

const summary = {
  selected: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  failures: [],
};

try {
  const result = await query(
    `
      SELECT appointment.id
      FROM appointments appointment
      INNER JOIN professional_google_connections connection
        ON connection.professional_id = appointment.professional_id
       AND connection.status = 'active'
      WHERE appointment.status = 'confirmed'
        AND NULLIF(trim(appointment.patient_email), '') IS NOT NULL
        AND appointment.google_calendar_event_id IS NOT NULL
        AND ((appointment.appointment_date + appointment.end_time) AT TIME ZONE $1) > NOW()
      ORDER BY appointment.appointment_date ASC, appointment.start_time ASC, appointment.id ASC
    `,
    [config.googleCalendarTimeZone],
  );

  summary.selected = result.rows.length;
  for (const row of result.rows) {
    try {
      const synced = await syncAppointmentToGoogleCalendar(row.id, { force: true });
      if (synced.skipped) summary.skipped += 1;
      else summary.updated += 1;
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({
        appointment_id: Number(row.id),
        error: String(error?.message || "UNKNOWN_ERROR").slice(0, 120),
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
} finally {
  await pool?.end();
}
