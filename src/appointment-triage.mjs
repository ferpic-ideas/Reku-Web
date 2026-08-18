import { recordAudit, tx } from "./db.mjs";
import { isReHubConfigured, requestPatientTriage } from "./rehub.mjs";

const unavailableError = () => {
  const error = new Error("TRIAGE_APPOINTMENT_NOT_AVAILABLE");
  error.statusCode = 409;
  return error;
};

const fallbackNameParts = (fullName) => {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return {
    name: parts.shift() || "Paciente",
    familyName: parts.join(" "),
  };
};

export const ensureAppointmentTriage = async (
  appointmentId,
  { bookingAccessLinkId = null } = {},
) => {
  if (!isReHubConfigured()) {
    const error = new Error("REHUB_NOT_CONFIGURED");
    error.statusCode = 503;
    throw error;
  }

  const result = await tx(async (client) => {
    const appointmentResult = await client.query(
      `
        SELECT
          a.id,
          a.triage_url,
          a.patient_name,
          pi.nombre AS intake_first_name,
          pi.apellido AS intake_family_name
        FROM appointments a
        LEFT JOIN patient_intakes pi ON pi.id = a.patient_intake_id
        WHERE a.id = $1
          AND a.status = 'confirmed'
          AND ($2::bigint IS NULL OR a.booking_access_link_id = $2)
        FOR UPDATE OF a
      `,
      [Number(appointmentId), bookingAccessLinkId || null],
    );
    const appointment = appointmentResult.rows[0];
    if (!appointment) return { error: unavailableError() };
    if (appointment.triage_url) {
      return { url: appointment.triage_url, created: false };
    }

    const fallback = fallbackNameParts(appointment.patient_name);
    try {
      const triage = await requestPatientTriage({
        name: appointment.intake_first_name || fallback.name,
        familyName: appointment.intake_family_name || fallback.familyName,
        patientExternalId: `REKU-APT-${String(appointment.id).padStart(6, "0")}`,
      });
      await client.query(
        `
          UPDATE appointments
          SET triage_url = $2,
              triage_assigned_at = NOW(),
              triage_assignment_attempted_at = NOW(),
              triage_assignment_error = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [appointment.id, triage.url],
      );
      return { url: triage.url, created: true };
    } catch (error) {
      await client.query(
        `
          UPDATE appointments
          SET triage_assignment_attempted_at = NOW(),
              triage_assignment_error = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [appointment.id, String(error.message || "REHUB_UNAVAILABLE").slice(0, 500)],
      );
      return { error };
    }
  });

  if (result.error) {
    await recordAudit("appointment.triage_assignment_failed", {
      detail: {
        appointment_id: Number(appointmentId),
        error: String(result.error.message || "REHUB_UNAVAILABLE").slice(0, 120),
      },
    });
    throw result.error;
  }

  if (result.created) {
    await recordAudit("appointment.triage_assigned", {
      detail: { appointment_id: Number(appointmentId) },
    });
  }
  return result;
};

