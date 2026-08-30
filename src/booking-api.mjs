import { one, query, recordAudit, tx } from "./db.mjs";
import {
  getClientIp,
  parseCookies,
  readBody,
  sendJson,
  sendRedirect,
  withSecurityHeaders,
} from "./http.mjs";
import { hashToken } from "./security.mjs";
import {
  createMercadoPagoPreference,
  fetchMercadoPagoPayment,
  updateAppointmentFromMercadoPagoPayment,
  validateMercadoPagoPaymentForAppointment,
  verifyMercadoPagoReturnToken,
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
  enforcePaymentReturnRateLimits,
  enforceWebhookRateLimits,
  rateLimitRetryMessage,
} from "./rate-limit.mjs";
import {
  buildPatientIntakeSubmission,
  createPatientBookingLink,
  loadPatientIntakeAgreement,
  redeemPatientIntakeVerification,
  savePatientIntakeAndNotify,
  validatePatientIntakeSubmission,
} from "./patient-intakes.mjs";
import {
  bookingAccessCookie,
  createBookingAccessLink,
} from "./booking-links.mjs";
import { config } from "./config.mjs";
import {
  cancelGoogleCalendarAppointment,
  getGoogleBusyRanges,
  holdAppointmentOnGoogleCalendar,
} from "./google-calendar.mjs";
import {
  getPatientMeetWaitingRoomStatus,
  patientMeetTimeAccess,
} from "./patient-meet-waiting.mjs";
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
  createPatientAppointmentAccessLink,
  exchangePatientAppointmentAccessLink,
  patientAppointmentSessionCookie,
  requirePatientAppointmentSession,
} from "./patient-appointment-links.mjs";
import {
  appointmentCalendarContent,
  appointmentCalendarFilename,
  googleCalendarTemplateUrl,
  isGoogleCalendarEmail,
} from "./appointment-calendar.mjs";
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
  "agreement_api_paid",
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
    booking_url: result.bookingLink.url,
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

const listProfessionals = async (url, response, agreementId = null) => {
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
          $2::bigint IS NULL
          OR EXISTS (
            SELECT 1
            FROM professional_agreements pa
            WHERE pa.professional_id = p.id
              AND pa.agreement_id = $2
          )
        )
        AND (
          $3::boolean = FALSE
          OR EXISTS (
            SELECT 1
            FROM professional_google_connections pgc
            WHERE pgc.professional_id = p.id
              AND pgc.status IN ('active', 'error')
          )
        )
      ORDER BY p.name ASC
    `,
    [serviceId, agreementId, config.googleCalendarRequired],
  );
  sendJson(response, 200, { professionals: result.rows.map(mapProfessional) });
};

export const loadEligibleProfessionals = async (serviceId, agreementId = null) => {
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
          $2::bigint IS NULL
          OR EXISTS (
            SELECT 1
            FROM professional_agreements pa
            WHERE pa.professional_id = p.id
              AND pa.agreement_id = $2
          )
        )
        AND (
          $3::boolean = FALSE
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
    [serviceId, agreementId, config.googleCalendarRequired],
  );
  return result.rows;
};

export const loadService = async (serviceId) =>
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

export const loadProfessional = async (professionalId) =>
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

export const professionalSupportsService = async (
  professionalId,
  serviceId,
  agreementId = null,
) =>
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
          $3::bigint IS NULL
          OR EXISTS (
            SELECT 1
            FROM professional_agreements pa
            WHERE pa.professional_id = p.id
              AND pa.agreement_id = $3
          )
        )
        AND (
          $4::boolean = FALSE
          OR EXISTS (
            SELECT 1
            FROM professional_google_connections pgc
            WHERE pgc.professional_id = p.id
              AND pgc.status IN ('active', 'error')
          )
        )
    `,
    [professionalId, serviceId, agreementId, config.googleCalendarRequired],
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
  agreementId = null,
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
    (!selectionValidated &&
      !(await professionalSupportsService(professionalId, serviceId, agreementId)))
  ) {
    const error = new Error("BOOKING_SELECTION_INVALID");
    error.statusCode = 422;
    throw error;
  }

  if (date < currentDateInCalendarTimeZone()) {
    return { service, slots: [] };
  }

  const dayOfWeek = dateToDow(date);
  const [availability, blocks, appointments, agreementApiHolds, googleBusyByDate] = await Promise.all([
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
    query(
      `
        SELECT to_char(start_time, 'HH24:MI') AS start_time,
               to_char(end_time, 'HH24:MI') AS end_time
        FROM agreement_api_holds
        WHERE professional_id = $1
          AND hold_date = $2::date
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `,
      [professionalId, date],
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
    ...agreementApiHolds.rows,
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

const computeFirstAvailableSlots = async ({ serviceId, date, agreementId = null }) => {
  const [service, professionals] = await Promise.all([
    loadService(serviceId),
    loadEligibleProfessionals(serviceId, agreementId),
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
          agreementId,
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

const listSlots = async (url, response, agreementId = null) => {
  const serviceId = Number(url.searchParams.get("service_id"));
  const requestedProfessionalId = String(url.searchParams.get("professional_id") || "");
  const date = String(url.searchParams.get("date") || "");
  if (requestedProfessionalId === firstAvailableProfessionalId) {
    const result = await computeFirstAvailableSlots({ serviceId, date, agreementId });
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
    agreementId,
  });
  sendJson(response, 200, { slots, slot_professionals: {} });
};

const listDays = async (url, response, agreementId = null) => {
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
    ? await loadEligibleProfessionals(serviceId, agreementId)
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
          agreementId,
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
  const agreementId = link.agreement?.id || null;
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
    const availability = await computeFirstAvailableSlots({ serviceId, date, agreementId });
    service = availability.service;
    candidates = availability.availability
      .filter((item) => item.slots.includes(startTime))
      .map((item) => item.professional);
  } else {
    const professionalId = Number(payload.professional_id);
    const availability = await computeSlots({
      serviceId,
      professionalId,
      date,
      agreementId,
    });
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
      const activeHold = await client.query(
        `
          SELECT id
          FROM agreement_api_holds
          WHERE professional_id = $1
            AND hold_date = $2::date
            AND consumed_at IS NULL
            AND expires_at > NOW()
            AND start_time < $4::time
            AND end_time > $3::time
          LIMIT 1
        `,
        [professionalId, date, startTime, endTime],
      );
      if (activeHold.rows.length) {
        const error = new Error("BOOKING_SLOT_TAKEN");
        error.statusCode = 409;
        throw error;
      }

      let patientId = link.patient_id;
      // Public intake data only becomes canonical after email verification.
      // Links without an intake are created by authenticated staff workflows.
      if (patientEmail && !link.patient_intake_id) {
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
            payment_return_token_hash = $4,
            payment_return_token_expires_at = $5,
            payment_detail = $6::jsonb,
            updated_at = NOW()
        WHERE id = $7
      `,
      [
        preference.preference_id,
        preference.init_point,
        preference.external_reference,
        preference.payment_return_token_hash,
        preference.payment_return_token_expires_at,
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
  prefers_google_calendar: isGoogleCalendarEmail(row.patient_email),
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
  options = {},
) => patientMeetTimeAccess(appointment, options);

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
  agreement: row.agreement_id
    ? {
        id: Number(row.agreement_id),
        name: row.agreement_name || "",
        cobranded: Boolean(row.agreement_cobranded),
        logo_url:
          row.agreement_cobranded && row.agreement_logo_path
            ? `/uploads/${row.agreement_logo_path}`
            : "",
      }
    : null,
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
  prefers_google_calendar: isGoogleCalendarEmail(row.patient_email),
  capabilities: patientAppointmentCapabilities(row),
  meet: patientMeetAccess(row),
});

const loadManagedAppointment = async (appointmentId) =>
  one(
    `
      SELECT
        appointment.id,
        appointment.patient_name,
        appointment.patient_email,
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
        appointment.patient_meet_started_at,
        appointment.reschedule_count,
        appointment.agreement_id,
        COALESCE(NULLIF(agreement.name, ''), appointment.agreement_name_snapshot) AS agreement_name,
        COALESCE(agreement.cobranded, appointment.agreement_cobranded_snapshot) AS agreement_cobranded,
        agreement.logo_path AS agreement_logo_path,
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
      LEFT JOIN agreements agreement ON agreement.id = appointment.agreement_id
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

const sendAppointmentCalendar = async (
  response,
  appointment,
  { access = "management" } = {},
) => {
  if (appointment.status !== "confirmed") {
    sendJson(response, 409, {
      error: "Sólo podés agregar al calendario un turno confirmado.",
    });
    return;
  }
  const manageLink = await createPatientAppointmentAccessLink({
    appointmentId: appointment.id,
  });
  const calendar = appointmentCalendarContent({
    appointment,
    manageUrl: manageLink.url,
  });
  try {
    await recordAudit("appointment.patient_calendar_downloaded", {
      detail: {
        appointment_id: Number(appointment.id),
        access,
      },
    });
  } catch {
    // An audit failure must not prevent the patient from saving the appointment.
  }
  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
        "Content-Disposition": `attachment; filename="${appointmentCalendarFilename(appointment)}"`,
        "Cache-Control": "no-store",
      },
      { privateRoute: true },
    ),
  );
  response.end(calendar);
};

const redirectAppointmentToGoogleCalendar = async (
  response,
  appointment,
  { access = "management" } = {},
) => {
  if (appointment.status !== "confirmed") {
    sendJson(response, 409, {
      error: "Sólo podés agregar a Google Calendar un turno confirmado.",
    });
    return;
  }
  const manageLink = await createPatientAppointmentAccessLink({
    appointmentId: appointment.id,
  });
  const calendarUrl = googleCalendarTemplateUrl({
    appointment,
    manageUrl: manageLink.url,
    timeZone: config.googleCalendarTimeZone,
  });
  try {
    await recordAudit("appointment.patient_google_calendar_opened", {
      detail: {
        appointment_id: Number(appointment.id),
        access,
      },
    });
  } catch {
    // An audit failure must not prevent the patient from opening Google Calendar.
  }
  sendRedirect(response, calendarUrl);
};

const downloadManagedAppointmentCalendar = async (request, response) => {
  const { appointment } = await requireManagedAppointment(request);
  await sendAppointmentCalendar(response, appointment);
};

const openManagedAppointmentGoogleCalendar = async (request, response) => {
  const { appointment } = await requireManagedAppointment(request);
  await redirectAppointmentToGoogleCalendar(response, appointment);
};

const loadBookedAppointmentCalendar = async (
  appointmentId,
  link,
) => {
  const appointment = await one(
    `
      SELECT
        appointment.id,
        to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        appointment.status,
        appointment.reschedule_count,
        appointment.patient_email,
        to_char(appointment.start_time, 'HH24:MI') AS start_time,
        to_char(appointment.end_time, 'HH24:MI') AS end_time,
        ((appointment.appointment_date + appointment.start_time) AT TIME ZONE $3) AS starts_at,
        ((appointment.appointment_date + appointment.end_time) AT TIME ZONE $3) AS ends_at,
        service.name AS service_name,
        professional.name AS professional_name
      FROM appointments appointment
      INNER JOIN services service ON service.id = appointment.service_id
      INNER JOIN professionals professional ON professional.id = appointment.professional_id
      WHERE appointment.id = $1
        AND appointment.booking_access_link_id = $2
    `,
    [appointmentId, link.id, config.googleCalendarTimeZone],
  );
  if (!appointment) {
    const error = new Error("PATIENT_APPOINTMENT_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
  return appointment;
};

const downloadBookedAppointmentCalendar = async (response, appointmentId, link) => {
  const appointment = await loadBookedAppointmentCalendar(appointmentId, link);
  await sendAppointmentCalendar(response, appointment, { access: "booking" });
};

const openBookedAppointmentGoogleCalendar = async (response, appointmentId, link) => {
  const appointment = await loadBookedAppointmentCalendar(appointmentId, link);
  await redirectAppointmentToGoogleCalendar(response, appointment, {
    access: "booking",
  });
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
  if (access.state === "waiting_early") {
    return `Ya estás en la sala de espera. ${schedule} El ingreso se habilitará cuando comience la videollamada.`;
  }
  if (access.state === "waiting_professional") {
    return `Tu profesional todavía no ingresó. Debería llegar en cualquier momento y ya estamos avisándole que estás esperando. ${schedule}`;
  }
  if (access.state === "checking") {
    return `Estamos verificando si la videollamada ya comenzó. Esperá unos segundos; esta pantalla se actualiza automáticamente. ${schedule}`;
  }
  if (access.state === "closed") {
    return `La videollamada ya no está activa. Si tu profesional vuelve a abrirla, el ingreso se habilitará nuevamente. ${schedule}`;
  }
  return `La videollamada no está disponible para este turno. ${schedule}`;
};

const getPatientManagedMeetStatus = async (request, response) => {
  enforcePatientAppointmentOrigin(request);
  const { appointment } = await requireManagedAppointment(request);
  const waitingRoom = await getPatientMeetWaitingRoomStatus({ appointment });
  sendJson(response, 200, {
    appointment: mapManagedAppointment(appointment),
    waiting_room: waitingRoom,
  });
};

const enterPatientManagedMeet = async (
  request,
  response,
  { jsonResponse = false } = {},
) => {
  if (jsonResponse) enforcePatientAppointmentOrigin(request);
  const { session, appointment } = await requireManagedAppointment(request);
  const access = await getPatientMeetWaitingRoomStatus({ appointment });
  if (!access.can_enter) {
    sendJson(response, 409, {
      error: patientMeetUnavailableMessage(appointment, access),
      appointment: mapManagedAppointment(appointment),
      waiting_room: access,
    });
    return;
  }
  await recordAudit("appointment.patient_meet_accessed", {
    detail: {
      appointment_id: Number(appointment.id),
      patient_appointment_session_id: Number(session.id),
    },
  });
  if (jsonResponse) {
    sendJson(response, 200, {
      ok: true,
      url: appointment.google_meet_url,
      waiting_room: access,
    });
    return;
  }
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
    const activeHold = await client.query(
      `
        SELECT id
        FROM agreement_api_holds
        WHERE professional_id = $1
          AND hold_date = $2::date
          AND consumed_at IS NULL
          AND expires_at > NOW()
          AND start_time < $4::time
          AND end_time > $3::time
        LIMIT 1
      `,
      [appointment.professional_id, date, startTime, endTime],
    );
    if (activeHold.rows.length) {
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
            patient_meet_started_at = NULL,
            patient_waiting_started_at = NULL,
            patient_waiting_last_seen_at = NULL,
            patient_waiting_professional_attempted_at = NULL,
            patient_waiting_professional_notified_at = NULL,
            patient_waiting_professional_message_id = NULL,
            patient_waiting_professional_error = NULL,
            patient_waiting_escalation_attempted_at = NULL,
            patient_waiting_escalated_at = NULL,
            patient_waiting_escalation_message_id = NULL,
            patient_waiting_escalation_error = NULL,
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

const saveAppointmentDocuments = async (
  request,
  response,
  appointmentId,
  { source = "/turnos/" } = {},
) => {
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
        source,
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
  await saveAppointmentDocuments(request, response, appointmentId);
};

const uploadManagedAppointmentDocuments = async (request, response) => {
  enforcePatientAppointmentOrigin(request);
  const { appointment } = await requireManagedAppointment(request);
  if (appointment.status !== "confirmed") {
    sendJson(response, 409, {
      error: "La documentación sólo puede enviarse para un turno confirmado.",
    });
    return;
  }
  await saveAppointmentDocuments(request, response, appointment.id, {
    source: "/turnos/?manage=1",
  });
};

const optionalAccessLinkForPaymentReturn = async (request, url) => {
  const token = readToken(request, url);
  if (!token) return null;
  try {
    return await requireAccessLinkForRequest(request, token);
  } catch (error) {
    if (error.message === "BOOKING_TOKEN_INVALID") return null;
    throw error;
  }
};

const paymentReturnLinkContext = (row, id) => ({
  id: Number(id),
  agreement: {
    id: row.agreement_id ? Number(row.agreement_id) : null,
    name: row.agreement_name_snapshot || "",
    slug: row.agreement_slug_snapshot || "",
    type: row.agreement_type_snapshot || "",
    subdomain_prefix: row.agreement_subdomain_prefix || "",
    cobranded: Boolean(row.agreement_cobranded_snapshot),
  },
});

const reissueBookingAccessAfterPaymentReturn = async (appointment) => {
  return tx(async (client) => {
    const bookingLink = await createBookingAccessLink({
      patientIntakeId: appointment.patient_intake_id || null,
      label: `Retorno de pago turno ${appointment.id}`,
      patientName: appointment.patient_name || "",
      patientEmail: appointment.patient_email || "",
      patientPhone: appointment.patient_phone || "",
      agreementId: appointment.agreement_id || null,
      agreementName: appointment.agreement_name_snapshot || "",
      agreementSlug: appointment.agreement_slug_snapshot || "",
      agreementSubdomainPrefix: appointment.agreement_subdomain_prefix || "",
      agreementType: appointment.agreement_type_snapshot || "",
      ttlHours: 48,
      client,
    });
    await client.query(
      `
        UPDATE appointments
        SET booking_access_link_id = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [appointment.id, bookingLink.id],
    );
    await client.query(
      "UPDATE booking_access_links SET used_at = NOW() WHERE id = $1",
      [bookingLink.id],
    );
    return bookingLink;
  });
};

export const isLegacyMercadoPagoReturnEligible = (
  appointment,
  { now = new Date(), maxAgeHours = 6 } = {},
) => {
  if (appointment?.payment_return_token_hash) return false;
  const createdAt = new Date(appointment?.created_at || 0);
  if (!Number.isFinite(createdAt.getTime())) return false;
  const ageMs = new Date(now).getTime() - createdAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 60 * 60 * 1000;
};

const refreshPaymentStatus = async (request, url, response) => {
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
  await enforcePaymentReturnRateLimits({
    clientIp: getClientIp(request),
    appointmentId,
  });

  const link = await optionalAccessLinkForPaymentReturn(request, url);

  const current = await one(
    `
      SELECT
        a.id,
        a.booking_access_link_id,
        a.patient_intake_id,
        a.service_id,
        a.professional_id,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        to_char(a.start_time, 'HH24:MI') AS start_time,
        to_char(a.end_time, 'HH24:MI') AS end_time,
        a.payment_status,
        a.status,
        a.amount,
        a.payment_id,
        a.payment_preference_id,
        a.payment_external_reference,
        a.payment_return_token_hash,
        a.payment_return_token_expires_at,
        a.payment_init_point,
        a.patient_name,
        a.patient_email,
        a.patient_phone,
        a.agreement_id,
        a.agreement_name_snapshot,
        a.agreement_slug_snapshot,
        a.agreement_type_snapshot,
        a.agreement_cobranded_snapshot,
        a.created_at,
        agreement.subdomain_prefix AS agreement_subdomain_prefix,
        s.name AS service_name,
        s.duration_minutes AS service_duration_minutes,
        s.cost_amount AS service_cost_amount,
        s.image_path AS service_image_path,
        p.name AS professional_name,
        p.photo_path AS professional_photo_path
      FROM appointments a
      INNER JOIN services s ON s.id = a.service_id
      INNER JOIN professionals p ON p.id = a.professional_id
      LEFT JOIN agreements agreement ON agreement.id = a.agreement_id
      WHERE a.id = $1
    `,
    [appointmentId],
  );
  if (!current) {
    sendJson(response, 404, { error: "Turno no encontrado." });
    return;
  }

  const bookingAccessAuthorized =
    Boolean(link) && Number(current.booking_access_link_id) === Number(link.id);
  const paymentReturnAuthorized = verifyMercadoPagoReturnToken({
    token: String(url.searchParams.get("payment_return_token") || ""),
    tokenHash: current.payment_return_token_hash,
    expiresAt: current.payment_return_token_expires_at,
  });

  let appointment = current;
  let paymentError = "";
  let payment = null;
  let legacyReturnAuthorized = false;
  if (
    !bookingAccessAuthorized &&
    !paymentReturnAuthorized &&
    paymentId &&
    isLegacyMercadoPagoReturnEligible(current)
  ) {
    payment = await fetchMercadoPagoPayment(paymentId);
    validateMercadoPagoPaymentForAppointment(payment, current);
    legacyReturnAuthorized = true;
  }
  if (!bookingAccessAuthorized && !paymentReturnAuthorized && !legacyReturnAuthorized) {
    sendJson(response, 401, {
      error: "No pudimos validar el acceso al turno. Volvé a abrir el enlace de la reserva.",
    });
    return;
  }

  if (paymentId) {
    try {
      payment ||= await fetchMercadoPagoPayment(paymentId);
      validateMercadoPagoPaymentForAppointment(payment, current);
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
      patient_email: current.patient_email,
    };
  }

  let activeLink = bookingAccessAuthorized
    ? link
    : paymentReturnLinkContext(current, current.booking_access_link_id);
  let responseHeaders = {};
  if (!bookingAccessAuthorized) {
    const reissuedLink = await reissueBookingAccessAfterPaymentReturn(current);
    activeLink = paymentReturnLinkContext(current, reissuedLink.id);
    responseHeaders = {
      "Set-Cookie": bookingAccessCookie(reissuedLink.token, reissuedLink.expires_at),
    };
    await recordAudit("appointment.payment_return_session_reissued", {
      detail: {
        appointment_id: appointmentId,
        access_mode: legacyReturnAuthorized ? "legacy_validated_payment" : "return_token",
        payment_status: appointment.payment_status || current.payment_status,
      },
    });
  }

  sendJson(
    response,
    200,
    {
      ok: true,
      appointment: appointmentFromRow(appointment),
      selection: appointmentSelectionFromRow(appointment, activeLink),
      payment_required: activeLink.agreement?.type !== "Nomina",
      payment_error: paymentError,
      payment: {
        provider: "mercadopago",
        url: appointment.payment_init_point || current.payment_init_point || "",
      },
    },
    responseHeaders,
  );
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
    if (pathname === "/api/booking/manage/meet" && request.method === "POST") {
      await enterPatientManagedMeet(request, response, { jsonResponse: true });
      return true;
    }
    if (
      pathname === "/api/booking/manage/meet-status" &&
      request.method === "POST"
    ) {
      await getPatientManagedMeetStatus(request, response);
      return true;
    }
    if (
      pathname === "/api/booking/manage/calendar.ics" &&
      request.method === "GET"
    ) {
      await downloadManagedAppointmentCalendar(request, response);
      return true;
    }
    if (
      pathname === "/api/booking/manage/google-calendar" &&
      request.method === "GET"
    ) {
      await openManagedAppointmentGoogleCalendar(request, response);
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
    if (pathname === "/api/booking/manage/documents" && request.method === "POST") {
      await uploadManagedAppointmentDocuments(request, response);
      return true;
    }

    const appointmentDocumentsMatch = pathname.match(
      /^\/api\/booking\/appointments\/(\d+)\/documents$/,
    );
    const appointmentCalendarMatch = pathname.match(
      /^\/api\/booking\/appointments\/(\d+)\/calendar\.ics$/,
    );
    const appointmentGoogleCalendarMatch = pathname.match(
      /^\/api\/booking\/appointments\/(\d+)\/google-calendar$/,
    );
    if (appointmentGoogleCalendarMatch && request.method === "GET") {
      const link = await requireAccessLinkForRequest(
        request,
        readToken(request, url),
      );
      await openBookedAppointmentGoogleCalendar(
        response,
        Number(appointmentGoogleCalendarMatch[1]),
        link,
      );
      return true;
    }
    if (appointmentCalendarMatch && request.method === "GET") {
      const link = await requireAccessLinkForRequest(
        request,
        readToken(request, url),
      );
      await downloadBookedAppointmentCalendar(
        response,
        Number(appointmentCalendarMatch[1]),
        link,
      );
      return true;
    }
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
    if (pathname === "/api/booking/payment-status" && request.method === "GET") {
      await refreshPaymentStatus(request, url, response);
      return true;
    }

    const token = readToken(request, url, payload);
    const link = await requireAccessLinkForRequest(request, token);

    if (pathname === "/api/booking/services" && request.method === "GET") {
      await listServices(response, link);
      return true;
    }
    if (pathname === "/api/booking/professionals" && request.method === "GET") {
      await listProfessionals(url, response, link.agreement?.id || null);
      return true;
    }
    if (pathname === "/api/booking/days" && request.method === "GET") {
      await listDays(url, response, link.agreement?.id || null);
      return true;
    }
    if (pathname === "/api/booking/slots" && request.method === "GET") {
      await listSlots(url, response, link.agreement?.id || null);
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
    if (String(error.message || "").startsWith("MERCADO_PAGO_PAYMENT_")) {
      sendJson(response, 409, {
        error: "El pago informado no corresponde de forma segura a este turno.",
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
        { error: rateLimitRetryMessage(error.retryAfter) },
        { "Retry-After": String(error.retryAfter || 60) },
      );
      return true;
    }
    throw error;
  }
};
