import { query } from "./db.mjs";
import { sendJson } from "./http.mjs";
import { requireProfessionalAccessLink } from "./professional-links.mjs";

const readToken = (url) => String(url.searchParams.get("token") || "").trim();

const mapAppointment = (row) => ({
  id: Number(row.id),
  date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  service_name: row.service_name || "",
  patient_name: row.patient_name || "",
  patient_email: row.patient_email || "",
  patient_phone: row.patient_phone || "",
  payment_status: row.payment_status || "",
});

const listProfessionalAppointments = async (response, link) => {
  const result = await query(
    `
      SELECT
        a.id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.patient_name,
        a.patient_email,
        a.patient_phone,
        a.payment_status,
        s.name AS service_name
      FROM appointments a
      INNER JOIN services s ON s.id = a.service_id
      WHERE a.professional_id = $1
        AND a.status = 'confirmed'
        AND a.appointment_date >= CURRENT_DATE
      ORDER BY a.appointment_date ASC, a.start_time ASC
      LIMIT 500
    `,
    [link.professional_id],
  );

  sendJson(response, 200, {
    professional: link.professional,
    expires_at: link.expires_at,
    appointments: result.rows.map(mapAppointment),
  });
};

export const handleProfessionalApi = async (request, response, url) => {
  const pathname = url.pathname;

  try {
    const token = readToken(url);
    const link = await requireProfessionalAccessLink(token);

    if (pathname === "/api/professional/appointments" && request.method === "GET") {
      await listProfessionalAppointments(response, link);
      return true;
    }

    return false;
  } catch (error) {
    if (error.message === "PROFESSIONAL_LINK_INVALID") {
      sendJson(response, 401, { error: "El link de turnos expiró o no es válido." });
      return true;
    }
    throw error;
  }
};
