import { one, query, recordAudit, tx } from "./db.mjs";
import {
  getClientIp,
  parseCookies,
  readBody,
  sendJson,
  sendRedirect,
} from "./http.mjs";
import { hashToken } from "./security.mjs";
import {
  appointmentIdFromExternalReference,
  createMercadoPagoPreference,
  fetchMercadoPagoPayment,
  updateAppointmentFromMercadoPagoPayment,
  verifyMercadoPagoWebhookSignature,
  getMercadoPagoSettings,
} from "./mercado-pago.mjs";
import {
  notifyConfirmedAppointment,
  notifyPatientForPendingPayment,
  notifyPatientForCancellation,
} from "./appointment-notifications.mjs";
import {
  enforceIntakeRateLimits,
  enforceWebhookRateLimits,
} from "./rate-limit.mjs";
import {
  buildPatientIntakeSubmission,
  createPatientBookingLink,
  loadPatientIntakeAgreement,
  redeemPatientIntakeVerification,
  savePatientIntakeAndNotify,
  validatePatientIntakeSubmission,
} from "./patient-intakes.mjs";
import { bookingAccessCookie } from "./booking-links.mjs";
import { config } from "./config.mjs";
import {
  cancelGoogleCalendarAppointment,
  getGoogleBusyRanges,
  holdAppointmentOnGoogleCalendar,
} from "./google-calendar.mjs";
import { ensureAppointmentTriage } from "./appointment-triage.mjs";
import { parseMultipartForm } from "./uploads.mjs";
import {
  mapAppointmentDocument,
  normalizeDocumentLinks,
  removeClinicalDocuments,
  saveClinicalDocument,
} from "./appointment-documents.mjs";
import {
  enforcePatientAppointmentOrigin,
  exchangePatientAppointmentAccessLink,
  patientAppointmentSessionCookie,
  requirePatientAppointmentSession,
} from "./patient-appointment-links.mjs";
import { agreementBookingUrl } from "./agreement-domains.mjs";
import {
  agreementPrefixForRequest,
  requestIdentifiesAgreement,
  resolveAgreementForRequest,
} from "./agreement-resolution.mjs";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;
const firstAvailableProfessionalId = "first_available";
const settledPaymentStatuses = new Set([
  "approved",
  "paid_simulated",
  "nomina",
  "free",
]);
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

const calendarDateTimeParts = (
  instant = new Date(),
  timeZone = config.googleCalendarTimeZone,
) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
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
      .map((part) => [part.type, part.value]),
  );

const currentDateInCalendarTimeZone = () => {
  const parts = calendarDateTimeParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const filterSlotsByMinimumNotice = ({
  slots,
  date,
  minimumNoticeMinutes = 30,
  now = new Date(),
  timeZone = config.googleCalendarTimeZone,
}) => {
  const parts = calendarDateTimeParts(now, timeZone);
  const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (date < currentDate) return [];
  if (date > currentDate) return slots;
  const currentMinutes =
    Number(parts.hour) * 60 +
    Number(parts.minute) +
    Number(parts.second) / 60 +
    now.getMilliseconds() / 60_000;
  const earliestStart = currentMinutes + Math.max(0, Number(minimumNoticeMinutes) || 0);
  return slots.filter((slot) => timeToMinutes(slot) >= earliestStart);
};

const rangesOverlap = (startA, endA, startB, endB) =>
  timeToMinutes(startA) < timeToMinutes(endB) &&
  timeToMinutes(startB) < timeToMinutes(endA);

export const buildAvailableSlots = ({
  availabilityRanges,
  busyRanges,
  durationMinutes,
}) => {
  const slots = [];
  for (const range of availabilityRanges) {
    const rangeStart = timeToMinutes(range.start_time);
    const rangeEnd = timeToMinutes(range.end_time);
    for (
      let start = rangeStart;
      start + durationMinutes <= rangeEnd;
      start += durationMinutes
    ) {
      const startTime = minutesToTime(start);
      const endTime = minutesToTime(start + durationMinutes);
      const overlaps = busyRanges.some((busy) =>
        rangesOverlap(startTime, endTime, busy.start_time, busy.end_time),
      );
      if (!overlaps) slots.push(startTime);
    }
  }
  return slots;
};

export const getBookingGoogleBusyRanges = async (
  options,
  {
    loadBusyRanges = getGoogleBusyRanges,
    audit = recordAudit,
    warn = console.warn,
  } = {},
) => {
  try {
    return await loadBusyRanges(options);
  } catch (error) {
    const detail = {
      professional_id: Number(options.professionalId),
      start_date: String(options.startDate || ""),
      end_date_exclusive: String(options.endDateExclusive || ""),
      error: String(error?.message || error?.name || "GOOGLE_AVAILABILITY_FAILED").slice(
        0,
        120,
      ),
    };
    warn("Google Calendar availability unavailable; using Reku availability", detail);
    try {
      await audit("booking.google_calendar.availability_fallback", { detail });
    } catch (auditError) {
      warn("Could not audit Google Calendar availability fallback", {
        professional_id: detail.professional_id,
        error: String(auditError?.message || "AUDIT_FAILED").slice(0, 120),
      });
    }
    return {};
  }
};

const markBookingGoogleHoldFailed = (appointmentId, error) =>
  query(
    `
      UPDATE appointments
      SET google_sync_status = 'failed',
          google_sync_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [appointmentId, String(error || "GOOGLE_SYNC_FAILED").slice(0, 500)],
  );

export const holdGoogleCalendarForBooking = async (
  appointmentId,
  {
    hold = holdAppointmentOnGoogleCalendar,
    markFailed = markBookingGoogleHoldFailed,
    audit = recordAudit,
    warn = console.warn,
  } = {},
) => {
  try {
    return await hold(appointmentId);
  } catch (error) {
    const detail = {
      appointment_id: Number(appointmentId),
      error: String(error?.message || error?.name || "GOOGLE_SYNC_FAILED").slice(0, 120),
    };
    warn("Google Calendar hold unavailable; continuing with Reku booking", detail);
    try {
      await markFailed(appointmentId, error?.detail || detail.error);
    } catch (markError) {
      warn("Could not persist Google Calendar hold failure", {
        appointment_id: detail.appointment_id,
        error: String(markError?.message || "GOOGLE_SYNC_STATUS_UPDATE_FAILED").slice(0, 120),
      });
    }
    try {
      await audit("appointment.google_calendar.hold_failed", { detail });
    } catch (auditError) {
      warn("Could not audit Google Calendar hold failure", {
        appointment_id: detail.appointment_id,
        error: String(auditError?.message || "AUDIT_FAILED").slice(0, 120),
      });
    }
    return { ok: false, error: detail.error };
  }
};

const readToken = (request, url, payload = {}) =>
  String(
    request.headers["x-booking-token"] ||
      payload.token ||
      url.searchParams.get("token") ||
      parseCookies(request)[config.bookingAccessCookieName] ||
      "",
  ).trim();

const requireAccessLink = async (token) => {
  const tokenHash = hashToken(token);
  const link = await one(
    `
      SELECT
        l.*,
        p.nombre,
        p.apellido,
        p.email AS intake_email,
        p.telefono AS intake_telefono,
        p.patient_id AS intake_patient_id,
        p.agreement_id AS intake_agreement_id,
        p.agreement_name_snapshot AS intake_agreement_name,
        p.agreement_slug_snapshot AS intake_agreement_slug,
        p.agreement_type_snapshot AS intake_agreement_type,
        a.name AS current_agreement_name,
        a.slug AS current_agreement_slug,
        a.type AS current_agreement_type,
        a.subdomain_prefix AS current_agreement_subdomain_prefix,
        a.cobranded AS current_agreement_cobranded,
        a.logo_path AS current_agreement_logo_path,
        a.pdf_path AS current_agreement_pdf_path
      FROM booking_access_links l
      LEFT JOIN patient_intakes p ON p.id = l.patient_intake_id
      LEFT JOIN agreements a ON a.id = COALESCE(p.agreement_id, l.agreement_id)
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
    patient_id: link.intake_patient_id ? Number(link.intake_patient_id) : null,
    expires_at: link.expires_at,
    agreement: {
      id: link.intake_agreement_id || link.agreement_id
        ? Number(link.intake_agreement_id || link.agreement_id)
        : null,
      name:
        link.current_agreement_name ||
        link.intake_agreement_name ||
        link.agreement_name_snapshot ||
        "",
      slug:
        link.current_agreement_slug ||
        link.intake_agreement_slug ||
        link.agreement_slug_snapshot ||
        "",
      type:
        link.current_agreement_type ||
        link.intake_agreement_type ||
        link.agreement_type_snapshot ||
        "",
      subdomain_prefix: link.current_agreement_subdomain_prefix || "",
      cobranded: Boolean(link.current_agreement_cobranded),
      logo_url:
        link.current_agreement_cobranded && link.current_agreement_logo_path
          ? `/uploads/${link.current_agreement_logo_path}`
          : "",
      pdf_url: link.current_agreement_pdf_path
        ? `/uploads/${link.current_agreement_pdf_path}`
        : "",
    },
    patient: {
      name: [link.nombre, link.apellido].filter(Boolean).join(" ") || link.patient_name || "",
      email: link.intake_email || link.patient_email || "",
      phone: link.intake_telefono || link.patient_phone || "",
    },
  };
};

const requireAccessLinkForRequest = async (request, token) => {
  const link = await requireAccessLink(token);
  const requestPrefix = agreementPrefixForRequest(request);
  if (
    requestPrefix &&
    requestPrefix !== String(link.agreement?.subdomain_prefix || "").toLowerCase()
  ) {
    const error = new Error("BOOKING_TOKEN_INVALID");
    error.statusCode = 401;
    throw error;
  }
  return link;
};

const mapService = (row) => ({
  id: Number(row.id),
  name: row.name,
  duration_minutes: Number(row.duration_minutes),
  cost_amount: Number(row.cost_amount || 0),
  image_url: row.image_path ? `/uploads/${row.image_path}` : "",
});

const mapServiceForLink = (row, link) => ({
  ...mapService(row),
  covered_by_agreement: link.agreement?.type === "Nomina",
});

const mapAgreement = (agreement) => ({
  id: agreement.id,
  name: agreement.name,
  slug: agreement.slug,
  subdomain_prefix: agreement.subdomain_prefix || "",
  cobranded: agreement.cobranded,
  type: agreement.type,
  logo_url: agreement.cobranded ? agreement.logo_url : "",
  pdf_url: agreement.pdf_url,
});

const mapProfessional = (row) => ({
  id: Number(row.id),
  name: row.name,
  photo_url: row.photo_path ? `/uploads/${row.photo_path}` : "",
  specialty: row.specialty || "",
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
    agreement: link.agreement,
    payment_required: link.agreement?.type !== "Nomina",
    services: result.rows.map((row) => mapServiceForLink(row, link)),
  });
};

const getAgreementForIntake = async (request, url, response) => {
  if (!requestIdentifiesAgreement(request, url)) {
    sendJson(response, 422, { error: "Indicá el acuerdo para iniciar la agenda." });
    return;
  }
  const agreement = await resolveAgreementForRequest(request, url);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }
  sendJson(response, 200, { agreement: mapAgreement(agreement) });
};

const createIntakeAccess = async (request, payload, response, url) => {
  const submission = buildPatientIntakeSubmission({
    agreementSlug: payload.agreement_slug || payload.form || "",
    values: payload,
  });
  const requestPrefix = agreementPrefixForRequest(request);
  const hostAgreement = requestPrefix
    ? await resolveAgreementForRequest(request, url)
    : null;
  if (
    requestPrefix &&
    (!hostAgreement ||
      hostAgreement.slug.toLowerCase() !== submission.agreementSlug.toLowerCase())
  ) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }
  const agreement =
    hostAgreement || (await loadPatientIntakeAgreement(submission));
  await enforceIntakeRateLimits({
    clientIp: getClientIp(request),
    email: submission.values.email,
    agreementSlug: submission.agreementSlug,
  });
  const errors = await validatePatientIntakeSubmission(submission, agreement);

  if (Object.keys(errors).length > 0) {
    sendJson(response, 422, {
      error: "Revisá los campos marcados para poder continuar.",
      errors,
    });
    return;
  }

  const sourcePath = `/turnos/?form=${encodeURIComponent(agreement.slug)}`;
  const result = await savePatientIntakeAndNotify({
    submission,
    agreement,
    sourcePath,
    requireEmailVerification: config.bookingEmailVerificationEnabled,
  });

  if (config.bookingEmailVerificationEnabled) {
    await recordAudit("patient_intake.created_pending_verification", {
      detail: {
        patient_intake_id: result.recordId,
        email: submission.values.email,
        agreement_slug: agreement.slug,
        source: "/turnos/",
      },
    });

    sendJson(response, 202, {
      ok: true,
      verification_required: true,
      message: "Revisá tu mail para confirmar la dirección y continuar con la reserva.",
    });
    return;
  }

  const bookingLink = await createPatientBookingLink({
    recordId: result.recordId,
    submission,
    agreement,
  });
  await recordAudit("patient_intake.created_with_direct_booking_access", {
    detail: {
      patient_intake_id: result.recordId,
      email: submission.values.email,
      agreement_slug: agreement.slug,
      source: "/turnos/",
    },
  });

  sendJson(
    response,
    201,
    {
      ok: true,
      verification_required: false,
      booking_expires_at: bookingLink.expires_at,
      patient: {
        name: [submission.values.nombre, submission.values.apellido]
          .filter(Boolean)
          .join(" "),
        email: submission.values.email,
        phone: submission.values.telefono,
      },
      agreement: mapAgreement(agreement),
    },
    {
      "Set-Cookie": bookingAccessCookie(bookingLink.token, bookingLink.expires_at),
    },
  );
};

const verifyIntakeAccess = async (payload, response) => {
  const token = String(payload.verification_token || payload.token || "").trim();
  if (!token) {
    sendJson(response, 401, { error: "El enlace de verificación no es válido." });
    return;
  }
  const result = await redeemPatientIntakeVerification(token);
  await recordAudit("patient_intake.verified", {
    detail: { patient_intake_id: result.patientIntakeId },
  });
  sendJson(response, 200, {
    ok: true,
    booking_expires_at: result.bookingLink.expires_at,
    patient: result.patient,
    agreement: mapAgreement(result.agreement),
  }, {
    "Set-Cookie": bookingAccessCookie(
      result.bookingLink.token,
      result.bookingLink.expires_at,
    ),
  });
};

const exchangeBookingAccess = async (request, payload, response, url) => {
  const token = readToken(request, url, payload);
  const link = await requireAccessLinkForRequest(request, token);
  sendJson(
    response,
    200,
    {
      ok: true,
      expires_at: link.expires_at,
      patient: link.patient,
      agreement: link.agreement,
    },
    { "Set-Cookie": bookingAccessCookie(token, link.expires_at) },
  );
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
        AND (
          $2::boolean = FALSE
          OR EXISTS (
            SELECT 1
            FROM professional_google_connections pgc
            WHERE pgc.professional_id = p.id
              AND pgc.status IN ('active', 'error')
          )
        )
      ORDER BY p.name ASC
    `,
    [serviceId, config.googleCalendarRequired],
  );
  sendJson(response, 200, { professionals: result.rows.map(mapProfessional) });
};

const loadEligibleProfessionals = async (serviceId) => {
  const result = await query(
    `
      SELECT
        p.*,
        COUNT(upcoming.id) AS upcoming_appointments
      FROM professionals p
      INNER JOIN professional_services ps ON ps.professional_id = p.id
      LEFT JOIN appointments upcoming
        ON upcoming.professional_id = p.id
       AND upcoming.status = 'confirmed'
       AND upcoming.appointment_date >= CURRENT_DATE
      WHERE ps.service_id = $1
        AND p.deleted_at IS NULL
        AND p.active = TRUE
        AND (
          $2::boolean = FALSE
          OR EXISTS (
            SELECT 1
            FROM professional_google_connections pgc
            WHERE pgc.professional_id = p.id
              AND pgc.status IN ('active', 'error')
          )
        )
      GROUP BY p.id
      ORDER BY COUNT(upcoming.id), p.name, p.id
    `,
    [serviceId, config.googleCalendarRequired],
  );
  return result.rows;
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
        AND (
          $3::boolean = FALSE
          OR EXISTS (
            SELECT 1
            FROM professional_google_connections pgc
            WHERE pgc.professional_id = p.id
              AND pgc.status IN ('active', 'error')
          )
        )
    `,
    [professionalId, serviceId, config.googleCalendarRequired],
  );

export const computeSlots = async ({
  serviceId,
  professionalId,
  date,
  externalBusyRanges,
  preloadedService = null,
  selectionValidated = false,
  excludeAppointmentId = null,
  minimumNoticeMinutes = 30,
}) => {
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !datePattern.test(date) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    const error = new Error("BOOKING_DATE_INVALID");
    error.statusCode = 422;
    throw error;
  }

  const service = preloadedService || (await loadService(serviceId));
  if (
    !service ||
    (!selectionValidated && !(await professionalSupportsService(professionalId, serviceId)))
  ) {
    const error = new Error("BOOKING_SELECTION_INVALID");
    error.statusCode = 422;
    throw error;
  }

  if (date < currentDateInCalendarTimeZone()) {
    return { service, slots: [] };
  }

  const dayOfWeek = dateToDow(date);
  const [availability, blocks, appointments, googleBusyByDate] = await Promise.all([
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
          AND ($3::bigint IS NULL OR id <> $3)
          AND (
            status = 'confirmed'
            OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '40 minutes')
          )
      `,
      [professionalId, date, excludeAppointmentId],
    ),
    externalBusyRanges
      ? Promise.resolve({ [date]: externalBusyRanges })
      : getBookingGoogleBusyRanges({
          professionalId,
          startDate: date,
          endDateExclusive: (() => {
            const next = new Date(`${date}T12:00:00Z`);
            next.setUTCDate(next.getUTCDate() + 1);
            return next.toISOString().slice(0, 10);
          })(),
        }),
  ]);

  const busyRanges = [
    ...blocks.rows,
    ...appointments.rows,
    ...(googleBusyByDate[date] || []),
  ];
  const slots = filterSlotsByMinimumNotice({
    slots: buildAvailableSlots({
      availabilityRanges: availability.rows,
      busyRanges,
      durationMinutes: Number(service.duration_minutes),
    }),
    date,
    minimumNoticeMinutes,
  });

  return { service, slots };
};

const computeFirstAvailableSlots = async ({ serviceId, date }) => {
  const [service, professionals] = await Promise.all([
    loadService(serviceId),
    loadEligibleProfessionals(serviceId),
  ]);
  if (!service) {
    const error = new Error("BOOKING_SELECTION_INVALID");
    error.statusCode = 422;
    throw error;
  }
  const availability = await Promise.all(
    professionals.map(async (professional) => ({
      professional,
      slots: (
        await computeSlots({
          serviceId,
          professionalId: Number(professional.id),
          date,
          preloadedService: service,
          selectionValidated: true,
        })
      ).slots,
    })),
  );
  return {
    service,
    professionals,
    availability,
    slots: [...new Set(availability.flatMap((item) => item.slots))].sort(),
  };
};

export const mapFirstAvailableSlotProfessionals = ({ slots, availability }) =>
  Object.fromEntries(
    slots.flatMap((slot) => {
      const professional = availability.find((item) =>
        item.slots.includes(slot),
      )?.professional;
      return professional ? [[slot, mapProfessional(professional)]] : [];
    }),
  );

const listSlots = async (url, response) => {
  const serviceId = Number(url.searchParams.get("service_id"));
  const requestedProfessionalId = String(url.searchParams.get("professional_id") || "");
  const date = String(url.searchParams.get("date") || "");
  if (requestedProfessionalId === firstAvailableProfessionalId) {
    const result = await computeFirstAvailableSlots({ serviceId, date });
    sendJson(response, 200, {
      slots: result.slots,
      slot_professionals: mapFirstAvailableSlotProfessionals(result),
    });
    return;
  }
  const { slots } = await computeSlots({
    serviceId,
    professionalId: Number(requestedProfessionalId),
    date,
  });
  sendJson(response, 200, { slots, slot_professionals: {} });
};

const listDays = async (url, response) => {
  const serviceId = Number(url.searchParams.get("service_id"));
  const requestedProfessionalId = String(url.searchParams.get("professional_id") || "");
  const firstAvailable = requestedProfessionalId === firstAvailableProfessionalId;
  const professionalId = Number(requestedProfessionalId);
  const month = String(url.searchParams.get("month") || "");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    sendJson(response, 422, { error: "Ingresá un mes válido." });
    return;
  }

  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const startDate = `${month}-01`;
  const endDateExclusive =
    monthNumber === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  const service = await loadService(serviceId);
  const professionals = firstAvailable
    ? await loadEligibleProfessionals(serviceId)
    : [{ id: professionalId }];
  if (!service || !professionals.length) {
    sendJson(response, 200, { days: [] });
    return;
  }
  const googleBusyEntries = await Promise.all(
    professionals.map(async (professional) => [
      Number(professional.id),
      await getBookingGoogleBusyRanges({
        professionalId: Number(professional.id),
        startDate,
        endDateExclusive,
      }),
    ]),
  );
  const googleBusyByProfessional = new Map(googleBusyEntries);
  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const availability = await Promise.all(
      professionals.map((professional) => {
        const id = Number(professional.id);
        return computeSlots({
          serviceId,
          professionalId: id,
          date,
          externalBusyRanges: googleBusyByProfessional.get(id)?.[date] || [],
          preloadedService: service,
          selectionValidated: firstAvailable,
        });
      }),
    );
    const slots = [...new Set(availability.flatMap((item) => item.slots))];
    if (slots.length) days.push({ date, slots_count: slots.length });
  }
  sendJson(response, 200, { days });
};

const createAppointment = async (payload, response, url, link) => {
  const serviceId = Number(payload.service_id);
  const automaticProfessional =
    payload.first_available === true ||
    String(payload.professional_id || "") === firstAvailableProfessionalId;
  const date = String(payload.date || "");
  const startTime = String(payload.start_time || "");
  const [startHours, startMinutes] = startTime.split(":").map(Number);
  if (
    !timePattern.test(startTime) ||
    startHours < 0 ||
    startHours > 23 ||
    startMinutes < 0 ||
    startMinutes > 59
  ) {
    sendJson(response, 422, { error: "Seleccioná un horario válido." });
    return;
  }

  let service;
  let candidates;
  if (automaticProfessional) {
    const availability = await computeFirstAvailableSlots({ serviceId, date });
    service = availability.service;
    candidates = availability.availability
      .filter((item) => item.slots.includes(startTime))
      .map((item) => item.professional);
  } else {
    const professionalId = Number(payload.professional_id);
    const availability = await computeSlots({ serviceId, professionalId, date });
    service = availability.service;
    const professional = availability.slots.includes(startTime)
      ? await loadProfessional(professionalId)
      : null;
    candidates = professional ? [professional] : [];
  }
  if (!candidates.length) {
    sendJson(response, 409, { error: "Ese horario ya no está disponible." });
    return;
  }

  const patient = link.patient;
  const patientName = String(patient.name || payload.patient_name || "Paciente Reku").trim();
  const patientEmail = String(patient.email || payload.patient_email || "").trim().toLowerCase();
  const patientPhone = String(patient.phone || payload.patient_phone || "").trim();
  const endTime = addMinutes(startTime, Number(service.duration_minutes));
  const requiresPayment = link.agreement?.type !== "Nomina" && Number(service.cost_amount || 0) > 0;
  const amount = requiresPayment ? Number(service.cost_amount || 0) : 0;
  const paymentStatus = requiresPayment
    ? "pending"
    : link.agreement?.type === "Nomina"
      ? "nomina"
      : "free";

  const reserveWithProfessional = (candidate) =>
    tx(async (client) => {
      const professionalId = Number(candidate.id);
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
        [professionalId, date],
      );
      const conflict = await client.query(
        `
          SELECT id
          FROM appointments
          WHERE professional_id = $1
            AND appointment_date = $2::date
            AND (
              status = 'confirmed'
              OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '40 minutes')
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

      let patientId = link.patient_id;
      if (patientEmail) {
        const canonicalPatient = await client.query(
          `
            INSERT INTO patients
              (full_name, email, email_normalized, phone)
            VALUES ($1, $2, lower(trim($2)), $3)
            ON CONFLICT (email_normalized) DO UPDATE SET
              full_name = CASE
                WHEN EXCLUDED.full_name <> '' THEN EXCLUDED.full_name
                ELSE patients.full_name
              END,
              email = EXCLUDED.email,
              phone = CASE
                WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone
                ELSE patients.phone
              END,
              active = TRUE,
              updated_at = NOW()
            RETURNING id
          `,
          [patientName, patientEmail, patientPhone],
        );
        patientId = Number(canonicalPatient.rows[0].id);
      }

      const result = await client.query(
        `
          INSERT INTO appointments
            (
              booking_access_link_id,
              patient_intake_id,
              patient_id,
              service_id,
              professional_id,
              appointment_date,
              start_time,
              end_time,
              patient_name,
              patient_email,
              patient_phone,
              agreement_id,
              agreement_name_snapshot,
              agreement_slug_snapshot,
              agreement_type_snapshot,
              agreement_cobranded_snapshot,
              amount,
              payment_status,
              payment_provider,
              status
          )
          VALUES (
            $1, $2, $3, $4, $5, $6::date, $7::time, $8::time, $9, $10, $11,
            $12, $13, $14, $15, $16, $17, $18, $19, $20
          )
          RETURNING *
        `,
        [
          link.id,
          link.patient_intake_id,
          patientId,
          serviceId,
          professionalId,
          date,
          startTime,
          endTime,
          patientName,
          patientEmail,
          patientPhone,
          link.agreement?.id || null,
          link.agreement?.name || "",
          link.agreement?.slug || "",
          link.agreement?.type || "",
          Boolean(link.agreement?.cobranded),
          amount,
          paymentStatus,
          requiresPayment
            ? "mercadopago"
            : link.agreement?.type === "Nomina"
              ? "nomina"
              : "manual",
          requiresPayment ? "pending_payment" : "confirmed",
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

  let appointment;
  let professional;
  for (const candidate of candidates) {
    try {
      appointment = await reserveWithProfessional(candidate);
      professional = candidate;
      break;
    } catch (error) {
      if (!automaticProfessional || error.message !== "BOOKING_SLOT_TAKEN") throw error;
    }
  }
  if (!appointment || !professional) {
    sendJson(response, 409, { error: "Ese horario ya no está disponible." });
    return;
  }
  const professionalId = Number(professional.id);

  if (requiresPayment) {
    await holdGoogleCalendarForBooking(appointment.id);
    let preference;
    try {
      preference = await createMercadoPagoPreference({
        appointment,
        returnAgendaUrl: agreementBookingUrl(
          link.agreement,
          config.appPublicUrl,
        ),
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
      await cancelGoogleCalendarAppointment(appointment.id);
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
    await notifyPatientForPendingPayment(appointment.id);

    await recordAudit("appointment.payment_preference_created", {
      detail: {
        appointment_id: appointment.id,
        service_id: serviceId,
        professional_id: professionalId,
        preference_id: preference.preference_id,
        payment_mode: preference.mode,
        selection_mode: automaticProfessional ? "first_available" : "professional",
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
        professional_id: professionalId,
        professional_name: professional.name,
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
      payment_status: paymentStatus,
      agreement_type: link.agreement?.type || "",
      selection_mode: automaticProfessional ? "first_available" : "professional",
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
      professional_id: professionalId,
      professional_name: professional.name,
      payment_status: paymentStatus,
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

const appointmentSelectionFromRow = (row, link) => ({
  service: {
    id: Number(row.service_id),
    name: row.service_name || "",
    duration_minutes: Number(row.service_duration_minutes || 0),
    cost_amount: Number(row.service_cost_amount || 0),
    image_url: row.service_image_path ? `/uploads/${row.service_image_path}` : "",
    covered_by_agreement: link.agreement?.type === "Nomina",
  },
  professional: {
    id: Number(row.professional_id),
    name: row.professional_name || "",
    photo_url: row.professional_photo_path
      ? `/uploads/${row.professional_photo_path}`
      : "",
  },
  date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
});

export const patientAppointmentCapabilities = (appointment) => {
  const settled = settledPaymentStatuses.has(String(appointment.payment_status || ""));
  const future = Boolean(appointment.is_future);
  return {
    can_reschedule:
      appointment.status === "confirmed" &&
      settled &&
      future &&
      appointment.professional_available !== false,
    can_cancel:
      appointment.status === "pending_payment" && !settled && future,
  };
};

export const patientMeetAccess = (
  appointment,
  {
    now = Date.now(),
    earlyMinutes = config.patientMeetEarlyMinutes,
    lateMinutes = config.patientMeetLateMinutes,
  } = {},
) => {
  const startsAt = new Date(appointment.starts_at || "");
  const endsAt = new Date(appointment.ends_at || "");
  const hasValidSchedule =
    Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime());
  const availableFrom = hasValidSchedule
    ? new Date(startsAt.getTime() - earlyMinutes * 60_000)
    : null;
  const availableUntil = hasValidSchedule
    ? new Date(endsAt.getTime() + lateMinutes * 60_000)
    : null;
  let state = "not_configured";

  if (appointment.status !== "confirmed") state = "unavailable";
  else if (!appointment.google_meet_url) state = "not_configured";
  else if (!hasValidSchedule) state = "unavailable";
  else if (now < availableFrom.getTime()) state = "upcoming";
  else if (now <= availableUntil.getTime()) state = "available";
  else state = "finished";

  return {
    available: state === "available",
    state,
    available_from: availableFrom?.toISOString() || null,
    available_until: availableUntil?.toISOString() || null,
    early_minutes: earlyMinutes,
    late_minutes: lateMinutes,
    time_zone: config.googleCalendarTimeZone,
  };
};

const mapManagedAppointment = (row) => ({
  id: Number(row.id),
  patient_name: row.patient_name || "",
  date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  status: row.status || "",
  payment_status: row.payment_status || "",
  payment_url: row.payment_init_point || "",
  triage_url: row.triage_url || "",
  service: {
    id: Number(row.service_id),
    name: row.service_name || "",
    duration_minutes: Number(row.duration_minutes || 0),
  },
  professional: {
    id: Number(row.professional_id),
    name: row.professional_name || "",
  },
  reschedule_count: Number(row.reschedule_count || 0),
  capabilities: patientAppointmentCapabilities(row),
  meet: patientMeetAccess(row),
});

const loadManagedAppointment = async (appointmentId) =>
  one(
    `
      SELECT
        appointment.id,
        appointment.patient_name,
        appointment.service_id,
        appointment.professional_id,
        to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(appointment.start_time, 'HH24:MI') AS start_time,
        to_char(appointment.end_time, 'HH24:MI') AS end_time,
        appointment.status,
        appointment.payment_status,
        appointment.payment_init_point,
        appointment.triage_url,
        appointment.google_meet_url,
        appointment.reschedule_count,
        service.name AS service_name,
        service.duration_minutes,
        professional.name AS professional_name,
        (professional.active = TRUE AND professional.deleted_at IS NULL) AS professional_available,
        ((appointment.appointment_date + appointment.start_time) AT TIME ZONE $2) > NOW() AS is_future,
        ((appointment.appointment_date + appointment.start_time) AT TIME ZONE $2) AS starts_at,
        ((appointment.appointment_date + appointment.end_time) AT TIME ZONE $2) AS ends_at
      FROM appointments appointment
      INNER JOIN services service ON service.id = appointment.service_id
      INNER JOIN professionals professional ON professional.id = appointment.professional_id
      WHERE appointment.id = $1
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );

const requireManagedAppointment = async (request) => {
  const session = await requirePatientAppointmentSession(request);
  const appointment = await loadManagedAppointment(session.appointment_id);
  if (!appointment) {
    const error = new Error("PATIENT_APPOINTMENT_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  return { session, appointment };
};

const exchangePatientManagementSession = async (request, response) => {
  enforcePatientAppointmentOrigin(request);
  const payload = await parseJsonBody(request);
  const exchanged = await exchangePatientAppointmentAccessLink(
    String(payload.token || "").trim(),
  );
  const appointment = await loadManagedAppointment(exchanged.appointment_id);
  sendJson(
    response,
    200,
    { ok: true, appointment: mapManagedAppointment(appointment) },
    { "Set-Cookie": patientAppointmentSessionCookie(exchanged.token) },
  );
};

const getPatientManagedAppointment = async (request, response) => {
  const { appointment } = await requireManagedAppointment(request);
  sendJson(response, 200, { appointment: mapManagedAppointment(appointment) });
};

const patientMeetUnavailableMessage = (appointment, access) => {
  const [year, month, day] = String(appointment.appointment_date || "").split("-");
  const date = year && month && day ? `${day}/${month}/${year}` : appointment.appointment_date;
  const schedule = `Tu turno es el ${date} de ${appointment.start_time} a ${appointment.end_time}.`;
  if (access.state === "upcoming") {
    const availableTime = new Intl.DateTimeFormat("es-AR", {
      timeZone: config.googleCalendarTimeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(access.available_from));
    return `La videollamada todavía no está disponible. ${schedule} Podés ingresar desde las ${availableTime}.`;
  }
  if (access.state === "finished") {
    return `El acceso a la videollamada ya finalizó. ${schedule}`;
  }
  if (access.state === "not_configured") {
    return `La videollamada todavía no fue habilitada. ${schedule}`;
  }
  return `La videollamada no está disponible para este turno. ${schedule}`;
};

const enterPatientManagedMeet = async (request, response) => {
  const { session, appointment } = await requireManagedAppointment(request);
  const access = patientMeetAccess(appointment);
  if (!access.available) {
    sendJson(response, 409, {
      error: patientMeetUnavailableMessage(appointment, access),
      appointment: mapManagedAppointment(appointment),
    });
    return;
  }
  await recordAudit("appointment.patient_meet_accessed", {
    detail: {
      appointment_id: Number(appointment.id),
      patient_appointment_session_id: Number(session.id),
    },
  });
  sendRedirect(response, appointment.google_meet_url);
};

const requireReschedulableAppointment = (appointment) => {
  if (!patientAppointmentCapabilities(appointment).can_reschedule) {
    const error = new Error("PATIENT_APPOINTMENT_RESCHEDULE_NOT_ALLOWED");
    error.statusCode = 409;
    throw error;
  }
};

const listPatientManagementDays = async (request, url, response) => {
  const { appointment } = await requireManagedAppointment(request);
  requireReschedulableAppointment(appointment);
  const month = String(url.searchParams.get("month") || "");
  if (!/^\d{4}-\d{2}$/.test(month)) {
    sendJson(response, 422, { error: "Ingresá un mes válido." });
    return;
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const startDate = `${month}-01`;
  const endDateExclusive =
    monthNumber === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  const [service, googleBusyByDate] = await Promise.all([
    loadService(Number(appointment.service_id)),
    getBookingGoogleBusyRanges({
      professionalId: Number(appointment.professional_id),
      startDate,
      endDateExclusive,
    }),
  ]);
  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const { slots } = await computeSlots({
      serviceId: Number(appointment.service_id),
      professionalId: Number(appointment.professional_id),
      date,
      externalBusyRanges: googleBusyByDate[date] || [],
      preloadedService: service,
      selectionValidated: true,
      excludeAppointmentId: Number(appointment.id),
    });
    if (slots.length) days.push({ date, slots_count: slots.length });
  }
  sendJson(response, 200, { days });
};

const listPatientManagementSlots = async (request, url, response) => {
  const { appointment } = await requireManagedAppointment(request);
  requireReschedulableAppointment(appointment);
  const date = String(url.searchParams.get("date") || "");
  const { slots } = await computeSlots({
    serviceId: Number(appointment.service_id),
    professionalId: Number(appointment.professional_id),
    date,
    excludeAppointmentId: Number(appointment.id),
  });
  sendJson(response, 200, { slots });
};

const reschedulePatientAppointment = async (request, response) => {
  enforcePatientAppointmentOrigin(request);
  const payload = await parseJsonBody(request);
  const { appointment } = await requireManagedAppointment(request);
  requireReschedulableAppointment(appointment);
  const date = String(payload.date || "");
  const startTime = String(payload.start_time || "");
  const [startHours, startMinutes] = startTime.split(":").map(Number);
  if (
    !timePattern.test(startTime) ||
    startHours < 0 ||
    startHours > 23 ||
    startMinutes < 0 ||
    startMinutes > 59
  ) {
    sendJson(response, 422, { error: "Seleccioná un horario válido." });
    return;
  }
  if (date === appointment.appointment_date && startTime === appointment.start_time) {
    sendJson(response, 422, { error: "Elegí un día u horario diferente al actual." });
    return;
  }
  const { service, slots } = await computeSlots({
    serviceId: Number(appointment.service_id),
    professionalId: Number(appointment.professional_id),
    date,
    excludeAppointmentId: Number(appointment.id),
  });
  if (!slots.includes(startTime)) {
    sendJson(response, 409, { error: "Ese horario ya no está disponible." });
    return;
  }
  const endTime = addMinutes(startTime, Number(service.duration_minutes));
  await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [appointment.professional_id, date],
    );
    const currentResult = await client.query(
      `
        SELECT
          id,
          status,
          payment_status,
          ((appointment_date + start_time) AT TIME ZONE $2) > NOW() AS is_future
        FROM appointments
        WHERE id = $1
        FOR UPDATE
      `,
      [appointment.id, config.googleCalendarTimeZone],
    );
    const current = currentResult.rows[0];
    if (!current || !patientAppointmentCapabilities({ ...current, professional_available: true }).can_reschedule) {
      const error = new Error("PATIENT_APPOINTMENT_RESCHEDULE_NOT_ALLOWED");
      error.statusCode = 409;
      throw error;
    }
    const conflict = await client.query(
      `
        SELECT id
        FROM appointments
        WHERE professional_id = $1
          AND appointment_date = $2::date
          AND id <> $3
          AND (
            status = 'confirmed'
            OR (status = 'pending_payment' AND created_at > NOW() - INTERVAL '40 minutes')
          )
          AND start_time < $5::time
          AND end_time > $4::time
        FOR UPDATE
      `,
      [appointment.professional_id, date, appointment.id, startTime, endTime],
    );
    if (conflict.rows.length) {
      const error = new Error("BOOKING_SLOT_TAKEN");
      error.statusCode = 409;
      throw error;
    }
    await client.query(
      `
        UPDATE appointments
        SET appointment_date = $2::date,
            start_time = $3::time,
            end_time = $4::time,
            rescheduled_at = NOW(),
            reschedule_count = reschedule_count + 1,
            patient_notified_at = NULL,
            patient_notification_message_id = NULL,
            patient_notification_error = NULL,
            professional_notified_at = NULL,
            professional_notification_message_id = NULL,
            professional_notification_error = NULL,
            patient_followup_notified_at = NULL,
            patient_followup_notification_message_id = NULL,
            patient_followup_notification_error = NULL,
            professional_followup_notified_at = NULL,
            professional_followup_notification_message_id = NULL,
            professional_followup_notification_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, date, startTime, endTime],
    );
  });
  const notification = await notifyConfirmedAppointment(appointment.id, {
    forceGoogleSync: true,
  });
  await recordAudit("appointment.patient_rescheduled", {
    detail: {
      appointment_id: Number(appointment.id),
      previous_date: appointment.appointment_date,
      previous_start_time: appointment.start_time,
      date,
      start_time: startTime,
      notification_pending: notification.patient?.skipped === true,
    },
  });
  const refreshed = await loadManagedAppointment(appointment.id);
  const patientEmailSent =
    notification.patient?.ok === true && notification.patient?.skipped !== true;
  sendJson(response, 200, {
    ok: true,
    message: patientEmailSent
      ? "El turno fue reprogramado. Te enviamos la actualización por mail."
      : "El turno fue reprogramado. La actualización por mail quedó pendiente de envío.",
    appointment: mapManagedAppointment(refreshed),
  });
};

const cancelPatientUnpaidAppointment = async (request, response) => {
  enforcePatientAppointmentOrigin(request);
  const { appointment } = await requireManagedAppointment(request);
  if (!patientAppointmentCapabilities(appointment).can_cancel) {
    const error = new Error("PATIENT_APPOINTMENT_CANCEL_NOT_ALLOWED");
    error.statusCode = 409;
    throw error;
  }
  await tx(async (client) => {
    const result = await client.query(
      `
        SELECT
          id,
          status,
          payment_status,
          ((appointment_date + start_time) AT TIME ZONE $2) > NOW() AS is_future
        FROM appointments
        WHERE id = $1
        FOR UPDATE
      `,
      [appointment.id, config.googleCalendarTimeZone],
    );
    const current = result.rows[0];
    if (!current || !patientAppointmentCapabilities(current).can_cancel) {
      const error = new Error("PATIENT_APPOINTMENT_CANCEL_NOT_ALLOWED");
      error.statusCode = 409;
      throw error;
    }
    await client.query(
      `
        UPDATE appointments
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancellation_reason = 'Cancelado por el paciente desde el mail de gestión.',
            refund_status = 'not_required',
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id],
    );
  });
  const [googleCalendar, notification] = await Promise.all([
    cancelGoogleCalendarAppointment(appointment.id),
    notifyPatientForCancellation(appointment.id),
  ]);
  await recordAudit("appointment.patient_cancelled_unpaid", {
    detail: {
      appointment_id: Number(appointment.id),
      google_calendar_cancelled:
        googleCalendar.reason === "not_synced" || Boolean(googleCalendar.ok),
      patient_notified: Boolean(notification.ok),
    },
  });
  const refreshed = await loadManagedAppointment(appointment.id);
  sendJson(response, 200, {
    ok: true,
    message: "La reserva pendiente de pago fue cancelada.",
    appointment: mapManagedAppointment(refreshed),
  });
};

const assignAppointmentTriage = async (payload, response, link) => {
  const appointmentId = Number(payload.appointment_id);
  if (!Number.isInteger(appointmentId) || appointmentId < 1) {
    sendJson(response, 422, { error: "Turno inválido." });
    return;
  }
  const triage = await ensureAppointmentTriage(appointmentId, {
    bookingAccessLinkId: link.id,
  });
  sendJson(response, 200, { ok: true, url: triage.url });
};

const uploadAppointmentDocuments = async (
  request,
  response,
  link,
  appointmentId,
) => {
  const appointment = await one(
    `
      SELECT id
      FROM appointments
      WHERE id = $1
        AND booking_access_link_id = $2
        AND status = 'confirmed'
    `,
    [appointmentId, link.id],
  );
  if (!appointment) {
    sendJson(response, 404, { error: "Turno confirmado no encontrado." });
    return;
  }

  const { fields, files } = await parseMultipartForm(request, {
    maxFiles: 5,
    collectFiles: true,
  });
  const uploadedFiles = files.documents || [];
  const links = normalizeDocumentLinks(fields.links_json || "[]");
  if (!uploadedFiles.length && !links.length) {
    sendJson(response, 422, { error: "Adjuntá al menos un archivo o enlace." });
    return;
  }
  if (uploadedFiles.length + links.length > 8) {
    sendJson(response, 422, { error: "Podés compartir hasta 8 elementos por vez." });
    return;
  }
  const existing = await one(
    `
      SELECT COUNT(*) AS document_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM appointment_documents
      WHERE appointment_id = $1
    `,
    [appointmentId],
  );
  const nextCount = Number(existing.document_count || 0) + uploadedFiles.length + links.length;
  const nextBytes =
    Number(existing.total_bytes || 0) +
    uploadedFiles.reduce((total, file) => total + Number(file.buffer?.length || 0), 0);
  if (nextCount > 20 || nextBytes > 30 * 1024 * 1024) {
    sendJson(response, 422, {
      error: "Este turno alcanzó el límite de documentación compartida.",
    });
    return;
  }

  const savedFiles = [];
  try {
    for (const file of uploadedFiles) {
      savedFiles.push(await saveClinicalDocument(file, appointmentId));
    }
    const created = await tx(async (client) => {
      const rows = [];
      for (const file of savedFiles) {
        const result = await client.query(
          `
            INSERT INTO appointment_documents
              (appointment_id, kind, original_name, storage_path, mime_type, size_bytes)
            VALUES ($1, 'file', $2, $3, $4, $5)
            RETURNING *
          `,
          [
            appointmentId,
            file.originalName,
            file.storagePath,
            file.mimeType,
            file.sizeBytes,
          ],
        );
        rows.push(result.rows[0]);
      }
      for (const externalUrl of links) {
        const result = await client.query(
          `
            INSERT INTO appointment_documents
              (appointment_id, kind, original_name, external_url)
            VALUES ($1, 'link', 'Estudio por enlace', $2)
            RETURNING *
          `,
          [appointmentId, externalUrl],
        );
        rows.push(result.rows[0]);
      }
      return rows;
    });
    await recordAudit("appointment.documents.uploaded", {
      detail: {
        appointment_id: appointmentId,
        file_count: savedFiles.length,
        link_count: links.length,
        source: "/turnos/",
      },
    });
    sendJson(response, 201, {
      ok: true,
      documents: created.map(mapAppointmentDocument),
      message: "La documentación se compartió con tu profesional.",
    });
  } catch (error) {
    await removeClinicalDocuments(savedFiles.map((file) => file.storagePath));
    throw error;
  }
};

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
        a.id,
        a.service_id,
        a.professional_id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.payment_status,
        a.status,
        a.payment_id,
        a.payment_init_point,
        s.name AS service_name,
        s.duration_minutes AS service_duration_minutes,
        s.cost_amount AS service_cost_amount,
        s.image_path AS service_image_path,
        p.name AS professional_name,
        p.photo_path AS professional_photo_path
      FROM appointments a
      INNER JOIN services s ON s.id = a.service_id
      INNER JOIN professionals p ON p.id = a.professional_id
      WHERE a.id = $1
        AND a.booking_access_link_id = $2
    `,
    [appointmentId, link.id],
  );
  if (!current) {
    sendJson(response, 404, { error: "Turno no encontrado." });
    return;
  }

  let appointment = current;
  let paymentError = "";
  if (paymentId) {
    try {
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
      } else if (appointment.status === "cancelled") {
        await notifyPatientForCancellation(appointment.id);
      }
    } catch (error) {
      if (error.message !== "MERCADO_PAGO_API_ERROR") throw error;
      paymentError =
        "No pudimos validar el pago con Mercado Pago. Si no se completó, podés reintentarlo.";
    }
    appointment = {
      ...appointment,
      service_id: current.service_id,
      professional_id: current.professional_id,
      appointment_date: current.appointment_date,
      start_time: current.start_time,
      end_time: current.end_time,
      payment_init_point: current.payment_init_point,
      service_name: current.service_name,
      service_duration_minutes: current.service_duration_minutes,
      service_cost_amount: current.service_cost_amount,
      service_image_path: current.service_image_path,
      professional_name: current.professional_name,
      professional_photo_path: current.professional_photo_path,
    };
  }

  sendJson(response, 200, {
    ok: true,
    appointment: appointmentFromRow(appointment),
    selection: appointmentSelectionFromRow(appointment, link),
    payment_required: link.agreement?.type !== "Nomina",
    payment_error: paymentError,
    payment: {
      provider: "mercadopago",
      url: appointment.payment_init_point || current.payment_init_point || "",
    },
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
  await enforceWebhookRateLimits({
    clientIp: getClientIp(request),
    dataId,
  });
  const settings = await getMercadoPagoSettings();
  const active = settings[settings.mode] || {};
  const signature = verifyMercadoPagoWebhookSignature({
    headers: request.headers,
    dataId,
    secret: active.webhook_secret,
  });
  if (!signature.configured) {
    await recordAudit("mercado_pago.webhook_rejected_unconfigured", {
      detail: { topic, data_id_set: Boolean(dataId) },
    });
    sendJson(response, 503, {
      error: "La validación del webhook no está configurada.",
    });
    return;
  }
  if (!signature.valid) {
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
  } else if (appointment.status === "cancelled") {
    await notifyPatientForCancellation(appointment.id);
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

    if (pathname === "/api/booking/manage/session" && request.method === "POST") {
      await exchangePatientManagementSession(request, response);
      return true;
    }
    if (pathname === "/api/booking/manage/appointment" && request.method === "GET") {
      await getPatientManagedAppointment(request, response);
      return true;
    }
    if (pathname === "/api/booking/manage/meet" && request.method === "GET") {
      await enterPatientManagedMeet(request, response);
      return true;
    }
    if (pathname === "/api/booking/manage/days" && request.method === "GET") {
      await listPatientManagementDays(request, url, response);
      return true;
    }
    if (pathname === "/api/booking/manage/slots" && request.method === "GET") {
      await listPatientManagementSlots(request, url, response);
      return true;
    }
    if (pathname === "/api/booking/manage/reschedule" && request.method === "POST") {
      await reschedulePatientAppointment(request, response);
      return true;
    }
    if (pathname === "/api/booking/manage/cancel" && request.method === "POST") {
      await cancelPatientUnpaidAppointment(request, response);
      return true;
    }

    const appointmentDocumentsMatch = pathname.match(
      /^\/api\/booking\/appointments\/(\d+)\/documents$/,
    );
    if (appointmentDocumentsMatch && request.method === "POST") {
      const link = await requireAccessLinkForRequest(
        request,
        readToken(request, url),
      );
      await uploadAppointmentDocuments(
        request,
        response,
        link,
        Number(appointmentDocumentsMatch[1]),
      );
      return true;
    }

    let payload = {};
    if (request.method === "POST") {
      payload = await parseJsonBody(request);
    }

    if (pathname === "/api/booking/agreement" && request.method === "GET") {
      await getAgreementForIntake(request, url, response);
      return true;
    }
    if (pathname === "/api/booking/intake" && request.method === "POST") {
      await createIntakeAccess(request, payload, response, url);
      return true;
    }
    if (pathname === "/api/booking/intake/verify" && request.method === "POST") {
      await verifyIntakeAccess(payload, response);
      return true;
    }
    if (pathname === "/api/booking/session" && request.method === "POST") {
      await exchangeBookingAccess(request, payload, response, url);
      return true;
    }

    const token = readToken(request, url, payload);
    const link = await requireAccessLinkForRequest(request, token);

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
    if (pathname === "/api/booking/triage" && request.method === "POST") {
      await assignAppointmentTriage(payload, response, link);
      return true;
    }

    return false;
  } catch (error) {
    if (error.message === "BOOKING_TOKEN_INVALID") {
      sendJson(response, 401, { error: "El link de agenda expiró o no es válido." });
      return true;
    }
    if (error.message === "INTAKE_VERIFICATION_INVALID") {
      sendJson(response, 401, {
        error: "El enlace de verificación expiró o ya fue utilizado.",
      });
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
    if (
      error.message === "PATIENT_APPOINTMENT_LINK_INVALID" ||
      error.message === "PATIENT_APPOINTMENT_SESSION_INVALID"
    ) {
      sendJson(response, 401, {
        error: "El acceso privado al turno venció o no es válido. Abrí nuevamente el enlace del mail.",
      });
      return true;
    }
    if (error.message === "PATIENT_APPOINTMENT_ORIGIN_INVALID") {
      sendJson(response, 403, { error: "No pudimos validar el origen de la solicitud." });
      return true;
    }
    if (error.message === "PATIENT_APPOINTMENT_NOT_FOUND") {
      sendJson(response, 404, { error: "Turno no encontrado." });
      return true;
    }
    if (error.message === "PATIENT_APPOINTMENT_RESCHEDULE_NOT_ALLOWED") {
      sendJson(response, 409, {
        error: "Este turno no se puede reprogramar desde el mail.",
      });
      return true;
    }
    if (error.message === "PATIENT_APPOINTMENT_CANCEL_NOT_ALLOWED") {
      sendJson(response, 409, {
        error: "Solo podés cancelar desde el mail mientras el pago siga pendiente.",
      });
      return true;
    }
    if (error.message === "PAYLOAD_TOO_LARGE") {
      sendJson(response, 413, { error: "Los archivos superan el máximo total de 10 MB." });
      return true;
    }
    if (error.message === "TOO_MANY_FILES") {
      sendJson(response, 422, { error: "Podés adjuntar hasta 5 archivos por vez." });
      return true;
    }
    if (error.message === "INVALID_APPOINTMENT_DOCUMENT") {
      sendJson(response, 415, {
        error: "Solo se permiten imágenes JPG, PNG o WebP y archivos PDF válidos.",
      });
      return true;
    }
    if (error.message === "INVALID_APPOINTMENT_DOCUMENT_LINK") {
      sendJson(response, 422, { error: "Revisá los enlaces. Deben ser direcciones web válidas." });
      return true;
    }
    if (
      error.message === "GOOGLE_REAUTH_REQUIRED" ||
      error.message === "GOOGLE_API_ERROR"
    ) {
      sendJson(response, 503, {
        error:
          "La agenda del profesional no se puede validar con Google en este momento.",
      });
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
    if (error.message === "AGREEMENT_NOT_FOUND") {
      sendJson(response, 404, { error: "Acuerdo no encontrado." });
      return true;
    }
    if (error.message === "DB_UNAVAILABLE") {
      sendJson(response, 503, { error: "La agenda no está disponible." });
      return true;
    }
    if (error.message === "TRIAGE_APPOINTMENT_NOT_AVAILABLE") {
      sendJson(response, 409, {
        error: "El cuestionario se habilita cuando el turno queda confirmado.",
      });
      return true;
    }
    if (error.message === "REHUB_NOT_CONFIGURED") {
      sendJson(response, 503, {
        error: "El cuestionario todavía no está disponible.",
      });
      return true;
    }
    if (String(error.message || "").startsWith("REHUB_")) {
      sendJson(response, 502, {
        error:
          "No pudimos preparar el cuestionario ahora. Probá nuevamente en unos minutos.",
      });
      return true;
    }
    if (error.message === "RATE_LIMITED") {
      sendJson(
        response,
        429,
        { error: "Demasiadas solicitudes. Probá nuevamente más tarde." },
        { "Retry-After": String(error.retryAfter || 60) },
      );
      return true;
    }
    throw error;
  }
};
