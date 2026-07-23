import { one, query, recordAudit, tx } from "./db.mjs";
import { readBody, sendJson } from "./http.mjs";
import { hashToken } from "./security.mjs";
import {
  appointmentIdFromExternalReference,
  createMercadoPagoPreference,
  fetchMercadoPagoPayment,
  updateAppointmentFromMercadoPagoPayment,
  verifyMercadoPagoWebhookSignature,
  getMercadoPagoSettings,
} from "./mercado-pago.mjs";
import { notifyConfirmedAppointment } from "./appointment-notifications.mjs";

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
        p.email AS intake_email,
        p.telefono AS intake_telefono
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
      name: [link.nombre, link.apellido].filter(Boolean).join(" ") || link.patient_name || "",
      email: link.intake_email || link.patient_email || "",
      phone: link.intake_telefono || link.patient_phone || "",
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

const loadProfessional = async (professionalId) =>
  one(
    `
      SELECT *
      FROM professionals
      WHERE id = $1
        AND active = TRUE
        AND deleted_at IS NULL
    `,
    [professionalId],
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
          AND (
            status = 'confirmed'
            OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '30 minutes')
          )
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
  const professional = await loadProfessional(professionalId);
  if (!professional) {
    sendJson(response, 422, { error: "El profesional no está disponible." });
    return;
  }

  const patient = link.patient;
  const patientName = String(payload.patient_name || patient.name || "Paciente Reku").trim();
  const patientEmail = String(payload.patient_email || patient.email || "").trim().toLowerCase();
  const patientPhone = String(payload.patient_phone || patient.phone || "").trim();
  const endTime = addMinutes(startTime, Number(service.duration_minutes));

  const appointment = await tx(async (client) => {
    const conflict = await client.query(
      `
        SELECT id
        FROM appointments
        WHERE professional_id = $1
          AND appointment_date = $2::date
          AND (
            status = 'confirmed'
            OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '30 minutes')
          )
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
            payment_provider,
            status
          )
        VALUES (
          $1, $2, $3, $4, $5::date, $6::time, $7::time, $8, $9, $10, $11,
          $12, $13, $14
        )
        RETURNING *
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
        Number(service.cost_amount || 0) > 0 ? "pending" : "free",
        Number(service.cost_amount || 0) > 0 ? "mercadopago" : "manual",
        Number(service.cost_amount || 0) > 0 ? "pending_payment" : "confirmed",
      ],
    );
    await client.query("UPDATE booking_access_links SET used_at = NOW() WHERE id = $1", [
      link.id,
    ]);
    return {
      ...result.rows[0],
      id: Number(result.rows[0].id),
      booking_access_link_id: Number(result.rows[0].booking_access_link_id),
      patient_intake_id: result.rows[0].patient_intake_id
        ? Number(result.rows[0].patient_intake_id)
        : null,
    };
  });

  if (Number(service.cost_amount || 0) > 0) {
    let preference;
    try {
      preference = await createMercadoPagoPreference({
        appointment,
        service: {
          ...service,
          id: serviceId,
        },
        professional: {
          ...professional,
          id: professionalId,
        },
        patient: {
          name: patientName,
          email: patientEmail,
          phone: patientPhone,
        },
        token: readToken(url, payload),
      });
    } catch (error) {
      await query(
        `
          UPDATE appointments
          SET payment_status = 'preference_error',
              status = 'payment_failed',
              updated_at = NOW()
          WHERE id = $1
        `,
        [appointment.id],
      );
      throw error;
    }
    await query(
      `
        UPDATE appointments
        SET payment_preference_id = $1,
            payment_init_point = $2,
            payment_external_reference = $3,
            payment_detail = $4::jsonb,
            updated_at = NOW()
        WHERE id = $5
      `,
      [
        preference.preference_id,
        preference.init_point,
        preference.external_reference,
        JSON.stringify({
          preference_id: preference.preference_id,
          mode: preference.mode,
        }),
        appointment.id,
      ],
    );

    await recordAudit("appointment.payment_preference_created", {
      detail: {
        appointment_id: appointment.id,
        service_id: serviceId,
        professional_id: professionalId,
        preference_id: preference.preference_id,
        payment_mode: preference.mode,
        source: url.pathname,
      },
    });

    sendJson(response, 201, {
      ok: true,
      appointment: {
        id: appointment.id,
        date,
        start_time: startTime,
        end_time: endTime,
        payment_status: "pending",
        status: "pending_payment",
      },
      payment: {
        provider: "mercadopago",
        preference_id: preference.preference_id,
        url: preference.init_point,
      },
    });
    return;
  }

  await recordAudit("appointment.created", {
    detail: {
      appointment_id: appointment.id,
      service_id: serviceId,
      professional_id: professionalId,
      date,
      payment_status: "free",
      source: url.pathname,
    },
  });
  await notifyConfirmedAppointment(appointment.id);
  sendJson(response, 201, {
    ok: true,
    appointment: {
      id: appointment.id,
      date,
      start_time: startTime,
      end_time: endTime,
      payment_status: "free",
      status: "confirmed",
    },
  });
};

const appointmentFromRow = (row) => ({
  id: Number(row.id),
  date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  payment_status: row.payment_status,
  status: row.status,
});

const refreshPaymentStatus = async (url, response, link) => {
  const appointmentId = Number(url.searchParams.get("appointment_id"));
  const paymentId = String(
    url.searchParams.get("payment_id") ||
      url.searchParams.get("collection_id") ||
      "",
  ).trim();
  if (!appointmentId) {
    sendJson(response, 422, { error: "Turno inválido." });
    return;
  }

  const current = await one(
    `
      SELECT
        id,
        to_char(appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(start_time, 'HH24:MI') AS start_time,
        to_char(end_time, 'HH24:MI') AS end_time,
        payment_status,
        status,
        payment_id
      FROM appointments
      WHERE id = $1
        AND booking_access_link_id = $2
    `,
    [appointmentId, link.id],
  );
  if (!current) {
    sendJson(response, 404, { error: "Turno no encontrado." });
    return;
  }

  let appointment = current;
  if (paymentId) {
    const payment = await fetchMercadoPagoPayment(paymentId);
    const referencedAppointmentId =
      appointmentIdFromExternalReference(payment.external_reference) ||
      Number(payment.metadata?.appointment_id || 0);
    if (referencedAppointmentId && referencedAppointmentId !== appointmentId) {
      sendJson(response, 409, { error: "El pago no corresponde a este turno." });
      return;
    }
    appointment = await updateAppointmentFromMercadoPagoPayment(payment);
    if (appointment.status === "confirmed") {
      await notifyConfirmedAppointment(appointment.id);
    }
    appointment = {
      ...appointment,
      appointment_date: current.appointment_date,
      start_time: current.start_time,
      end_time: current.end_time,
    };
  }

  sendJson(response, 200, {
    ok: true,
    appointment: appointmentFromRow(appointment),
  });
};

const parseWebhookBody = async (request) => {
  const body = await readBody(request, 200_000);
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
};

const handleMercadoPagoWebhook = async (request, response, url) => {
  const payload = await parseWebhookBody(request);
  const dataId = String(
    url.searchParams.get("data.id") ||
      payload.data?.id ||
      url.searchParams.get("id") ||
      "",
  ).trim();
  const topic = String(
    url.searchParams.get("type") ||
      payload.type ||
      url.searchParams.get("topic") ||
      "",
  );
  const settings = await getMercadoPagoSettings();
  const active = settings[settings.mode] || {};
  const signature = verifyMercadoPagoWebhookSignature({
    headers: request.headers,
    dataId,
    secret: active.webhook_secret,
  });
  if (signature.configured && !signature.valid) {
    sendJson(response, 401, { error: "Firma inválida." });
    return;
  }

  if (topic !== "payment" || !dataId) {
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }

  const payment = await fetchMercadoPagoPayment(dataId);
  const appointment = await updateAppointmentFromMercadoPagoPayment(payment);
  if (appointment.status === "confirmed") {
    await notifyConfirmedAppointment(appointment.id);
  }
  await recordAudit("mercado_pago.payment_webhook", {
    detail: {
      appointment_id: appointment.id,
      payment_id: String(payment.id || ""),
      status: payment.status || "",
      signature_validated: signature.configured,
    },
  });
  sendJson(response, 200, { ok: true });
};

export const handleBookingApi = async (request, response, url) => {
  const pathname = url.pathname;

  try {
    if (pathname === "/api/booking/mercado-pago/webhook" && request.method === "POST") {
      await handleMercadoPagoWebhook(request, response, url);
      return true;
    }

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
    if (pathname === "/api/booking/payment-status" && request.method === "GET") {
      await refreshPaymentStatus(url, response, link);
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
    if (error.message === "MERCADO_PAGO_NOT_CONFIGURED") {
      sendJson(response, 503, {
        error: "Mercado Pago no está configurado para crear el pago.",
      });
      return true;
    }
    if (error.message === "MERCADO_PAGO_API_ERROR") {
      console.error("Mercado Pago API error", {
        status: error.mercadoPagoStatus,
        payload: error.payload,
      });
      sendJson(response, 502, {
        error: "Mercado Pago no pudo crear o consultar el pago.",
      });
      return true;
    }
    throw error;
  }
};
