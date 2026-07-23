import { one, query, recordAudit, tx } from "./db.mjs";
import { readBody, sendJson } from "./http.mjs";
import { hashToken } from "./security.mjs";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

const parseJsonBody = async (request) => {
  const body = await readBody(request);
  return body ? JSON.parse(body) : {};
};

const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
};

const timeToMinutes = (value) => {
  const [hours, minutes] = String(value || "00:00").slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
};

const dateToDow = (date) => {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

const addMinutes = (time, minutes) => minutesToTime(timeToMinutes(time) + minutes);

const rangesOverlap = (startA, endA, startB, endB) =>
  timeToMinutes(startA) < timeToMinutes(endB) &&
  timeToMinutes(startB) < timeToMinutes(endA);

const readToken = (url, payload = {}) =>
  String(payload.token || url.searchParams.get("token") || "").trim();

const requireAccessLink = async (token) => {
  const tokenHash = hashToken(token);
  const link = await one(
    `
      SELECT
        l.*,
        p.nombre,
        p.apellido,
        p.email,
        p.telefono
      FROM booking_access_links l
      LEFT JOIN patient_intakes p ON p.id = l.patient_intake_id
      WHERE l.token_hash = $1
        AND l.expires_at > NOW()
    `,
    [tokenHash],
  );
  if (!link) {
    const error = new Error("BOOKING_TOKEN_INVALID");
    error.statusCode = 401;
    throw error;
  }
  return {
    id: Number(link.id),
    patient_intake_id: link.patient_intake_id ? Number(link.patient_intake_id) : null,
    expires_at: link.expires_at,
    patient: {
      name: [link.nombre, link.apellido].filter(Boolean).join(" "),
      email: link.email || "",
      phone: link.telefono || "",
    },
  };
};

const mapService = (row) => ({
  id: Number(row.id),
  name: row.name,
  duration_minutes: Number(row.duration_minutes),
  cost_amount: Number(row.cost_amount || 0),
});

const mapProfessional = (row) => ({
  id: Number(row.id),
  name: row.name,
  photo_url: row.photo_path ? `/uploads/${row.photo_path}` : "",
});

const listServices = async (response, link) => {
  const result = await query(`
    SELECT *
    FROM services
    WHERE deleted_at IS NULL
      AND active = TRUE
    ORDER BY name ASC
  `);
  sendJson(response, 200, {
    expires_at: link.expires_at,
    patient: link.patient,
    services: result.rows.map(mapService),
  });
};

const listProfessionals = async (url, response) => {
  const serviceId = Number(url.searchParams.get("service_id"));
  if (!serviceId) {
    sendJson(response, 422, { error: "Seleccioná un servicio." });
    return;
  }
  const result = await query(
    `
      SELECT DISTINCT p.*
      FROM professionals p
      INNER JOIN professional_services ps ON ps.professional_id = p.id
      WHERE ps.service_id = $1
        AND p.deleted_at IS NULL
        AND p.active = TRUE
      ORDER BY p.name ASC
    `,
    [serviceId],
  );
  sendJson(response, 200, { professionals: result.rows.map(mapProfessional) });
};

const loadService = async (serviceId) =>
  one(
    `
      SELECT *
      FROM services
      WHERE id = $1
        AND active = TRUE
        AND deleted_at IS NULL
    `,
    [serviceId],
  );

const professionalSupportsService = async (professionalId, serviceId) =>
  one(
    `
      SELECT 1
      FROM professional_services ps
      INNER JOIN professionals p ON p.id = ps.professional_id
      WHERE ps.professional_id = $1
        AND ps.service_id = $2
        AND p.active = TRUE
        AND p.deleted_at IS NULL
    `,
    [professionalId, serviceId],
  );

const computeSlots = async ({ serviceId, professionalId, date }) => {
  if (!datePattern.test(date)) {
    const error = new Error("BOOKING_DATE_INVALID");
    error.statusCode = 422;
    throw error;
  }

  const service = await loadService(serviceId);
  if (!service || !(await professionalSupportsService(professionalId, serviceId))) {
    const error = new Error("BOOKING_SELECTION_INVALID");
    error.statusCode = 422;
    throw error;
  }

  if (date < new Date().toISOString().slice(0, 10)) {
    return { service, slots: [] };
  }

  const dayOfWeek = dateToDow(date);
  const [availability, blocks, appointments] = await Promise.all([
    query(
      `
        SELECT to_char(start_time, 'HH24:MI') AS start_time,
               to_char(end_time, 'HH24:MI') AS end_time
        FROM professional_availability
        WHERE professional_id = $1
          AND day_of_week = $2
      `,
      [professionalId, dayOfWeek],
    ),
    query(
      `
        SELECT to_char(start_time, 'HH24:MI') AS start_time,
               to_char(end_time, 'HH24:MI') AS end_time
        FROM schedule_blocks
        WHERE professional_id = $1
          AND block_date = $2::date
      `,
      [professionalId, date],
    ),
    query(
      `
        SELECT to_char(start_time, 'HH24:MI') AS start_time,
               to_char(end_time, 'HH24:MI') AS end_time
        FROM appointments
        WHERE professional_id = $1
          AND appointment_date = $2::date
          AND status = 'confirmed'
      `,
      [professionalId, date],
    ),
  ]);

  const duration = Number(service.duration_minutes);
  const busyRanges = [...blocks.rows, ...appointments.rows];
  const slots = [];

  for (const range of availability.rows) {
    const rangeStart = timeToMinutes(range.start_time);
    const rangeEnd = timeToMinutes(range.end_time);
    for (let start = rangeStart; start + duration <= rangeEnd; start += duration) {
      const startTime = minutesToTime(start);
      const endTime = minutesToTime(start + duration);
      const overlaps = busyRanges.some((busy) =>
        rangesOverlap(startTime, endTime, busy.start_time, busy.end_time),
      );
      if (!overlaps) slots.push(startTime);
    }
  }

  return { service, slots };
};

const listSlots = async (url, response) => {
  const serviceId = Number(url.searchParams.get("service_id"));
  const professionalId = Number(url.searchParams.get("professional_id"));
  const date = String(url.searchParams.get("date") || "");
  const { slots } = await computeSlots({ serviceId, professionalId, date });
  sendJson(response, 200, { slots });
};

const listDays = async (url, response) => {
  const serviceId = Number(url.searchParams.get("service_id"));
  const professionalId = Number(url.searchParams.get("professional_id"));
  const month = String(url.searchParams.get("month") || "");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    sendJson(response, 422, { error: "Ingresá un mes válido." });
    return;
  }

  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const { slots } = await computeSlots({ serviceId, professionalId, date });
    if (slots.length) days.push({ date, slots_count: slots.length });
  }
  sendJson(response, 200, { days });
};

const createAppointment = async (payload, response, url, link) => {
  const serviceId = Number(payload.service_id);
  const professionalId = Number(payload.professional_id);
  const date = String(payload.date || "");
  const startTime = String(payload.start_time || "");
  if (!timePattern.test(startTime)) {
    sendJson(response, 422, { error: "Seleccioná un horario válido." });
    return;
  }

  const { service, slots } = await computeSlots({ serviceId, professionalId, date });
  if (!slots.includes(startTime)) {
    sendJson(response, 409, { error: "Ese horario ya no está disponible." });
    return;
  }

  const patient = link.patient;
  const patientName = String(payload.patient_name || patient.name || "Paciente Reku").trim();
  const patientEmail = String(payload.patient_email || patient.email || "").trim().toLowerCase();
  const patientPhone = String(payload.patient_phone || patient.phone || "").trim();
  const endTime = addMinutes(startTime, Number(service.duration_minutes));

  const appointmentId = await tx(async (client) => {
    const conflict = await client.query(
      `
        SELECT id
        FROM appointments
        WHERE professional_id = $1
          AND appointment_date = $2::date
          AND status = 'confirmed'
          AND start_time < $4::time
          AND end_time > $3::time
        FOR UPDATE
      `,
      [professionalId, date, startTime, endTime],
    );
    if (conflict.rows.length) {
      const error = new Error("BOOKING_SLOT_TAKEN");
      error.statusCode = 409;
      throw error;
    }

    const result = await client.query(
      `
        INSERT INTO appointments
          (
            booking_access_link_id,
            patient_intake_id,
            service_id,
            professional_id,
            appointment_date,
            start_time,
            end_time,
            patient_name,
            patient_email,
            patient_phone,
            amount,
            payment_status,
            payment_reference,
            status
          )
        VALUES ($1, $2, $3, $4, $5::date, $6::time, $7::time, $8, $9, $10, $11, 'paid_simulated', 'checkout_pro_simulado', 'confirmed')
        RETURNING id
      `,
      [
        link.id,
        link.patient_intake_id,
        serviceId,
        professionalId,
        date,
        startTime,
        endTime,
        patientName,
        patientEmail,
        patientPhone,
        Number(service.cost_amount || 0),
      ],
    );
    await client.query("UPDATE booking_access_links SET used_at = NOW() WHERE id = $1", [
      link.id,
    ]);
    return Number(result.rows[0].id);
  });

  await recordAudit("appointment.created", {
    detail: {
      appointment_id: appointmentId,
      service_id: serviceId,
      professional_id: professionalId,
      date,
      payment_status: "paid_simulated",
      source: url.pathname,
    },
  });
  sendJson(response, 201, {
    ok: true,
    appointment: {
      id: appointmentId,
      date,
      start_time: startTime,
      end_time: endTime,
      payment_status: "paid_simulated",
    },
  });
};

export const handleBookingApi = async (request, response, url) => {
  const pathname = url.pathname;

  try {
    let payload = {};
    if (request.method === "POST") {
      payload = await parseJsonBody(request);
    }
    const token = readToken(url, payload);
    const link = await requireAccessLink(token);

    if (pathname === "/api/booking/services" && request.method === "GET") {
      await listServices(response, link);
      return true;
    }
    if (pathname === "/api/booking/professionals" && request.method === "GET") {
      await listProfessionals(url, response);
      return true;
    }
    if (pathname === "/api/booking/days" && request.method === "GET") {
      await listDays(url, response);
      return true;
    }
    if (pathname === "/api/booking/slots" && request.method === "GET") {
      await listSlots(url, response);
      return true;
    }
    if (pathname === "/api/booking/appointments" && request.method === "POST") {
      await createAppointment(payload, response, url, link);
      return true;
    }

    return false;
  } catch (error) {
    if (error.message === "BOOKING_TOKEN_INVALID") {
      sendJson(response, 401, { error: "El link de agenda expiró o no es válido." });
      return true;
    }
    if (error.message === "BOOKING_SELECTION_INVALID") {
      sendJson(response, 422, { error: "La selección no está disponible." });
      return true;
    }
    if (error.message === "BOOKING_DATE_INVALID") {
      sendJson(response, 422, { error: "Seleccioná una fecha válida." });
      return true;
    }
    if (error.message === "BOOKING_SLOT_TAKEN") {
      sendJson(response, 409, { error: "Ese horario ya no está disponible." });
      return true;
    }
    throw error;
  }
};
