import {
  getAgreementById,
  getAgreementBySlug,
  one,
  query,
  recordAudit,
  tx,
} from "./db.mjs";
import {
  agreementBookingUrl,
  validateAgreementSubdomainPrefix,
} from "./agreement-domains.mjs";
import {
  requestIdentifiesAgreement,
  resolveAgreementForRequest,
} from "./agreement-resolution.mjs";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { getClientIp, readBody, sendJson, withSecurityHeaders } from "./http.mjs";
import { parseNominaCsv, serializeCsv } from "./csv.mjs";
import {
  clearSessionCookie,
  createSessionToken,
  enforceCsrf,
  enforceLoginRateLimit,
  hashPassword,
  readSessionFromRequest,
  sessionCookie,
  verifyPassword,
} from "./security.mjs";
import { config } from "./config.mjs";
import {
  parseMultipartForm,
  readCsvUpload,
  saveAgreementLogo,
  saveAgreementPdf,
  saveProfessionalPhoto,
  saveServiceImage,
} from "./uploads.mjs";
import { createBookingAccessLink } from "./booking-links.mjs";
import {
  createMercadoPagoFullRefund,
  mergeMercadoPagoSettingsPayload,
  publicMercadoPagoSettings,
} from "./mercado-pago.mjs";
import {
  hasPermission,
  permissionsForUser,
  requireAdminApiPermission,
} from "./authorization.mjs";
import { revokeProfessionalAccess } from "./professional-links.mjs";
import {
  createPendingProfessionalUser,
  syncProfessionalUser,
  validateProfessionalPassword,
} from "./professional-users.mjs";
import {
  createProfessionalInvitation,
  sendProfessionalInvitation,
} from "./professional-invitations.mjs";
import { computeSlots } from "./booking-api.mjs";
import {
  notifyConfirmedAppointment,
  notifyPatientForCancellation,
  notifyPatientForPendingPayment,
} from "./appointment-notifications.mjs";
import {
  cancelGoogleCalendarAppointment,
  cancelGoogleCalendarEventForProfessional,
  holdAppointmentOnGoogleCalendar,
} from "./google-calendar.mjs";
import {
  mapAdminAppointmentDocument,
  streamAdminAppointmentDocument,
} from "./appointment-documents.mjs";
import {
  createAgreementApiCredential,
  listAgreementApiCredentials,
  revokeAgreementApiCredential,
} from "./agreement-api.mjs";
import {
  generateAgreementSettlement,
  getAgreementSettlementPreview,
  streamAgreementSettlementPdf,
} from "./agreement-settlements.mjs";

const canDeleteRecords = (user) => hasPermission(user, "records.delete");
const canManageSystem = (user) => hasPermission(user, "users.write");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;
const userRoles = new Set(["user", "admin", "professional"]);

const parseJsonBody = async (request) => {
  const body = await readBody(request);
  return body ? JSON.parse(body) : {};
};

const isMultipartRequest = (request) =>
  String(request.headers["content-type"] || "")
    .toLowerCase()
    .includes("multipart/form-data");

const slugify = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const downloadSlug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "formulario";

const optionalUrl = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad");
    return url.toString();
  } catch {
    const error = new Error("URL_INVALID");
    error.statusCode = 422;
    throw error;
  }
};

const parsePositiveInteger = (value, { min = 1, max = 10_000 } = {}) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    const error = new Error("NUMBER_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return number;
};

const parseMoney = (value) => {
  const number = Number(String(value || "").replace(",", "."));
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error("MONEY_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return Number(number.toFixed(2));
};

const parseJsonArray = (value) => {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeTime = (value) => {
  const trimmed = String(value || "").trim();
  const [hours, minutes] = trimmed.split(":").map(Number);
  if (
    !timePattern.test(trimmed) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    const error = new Error("TIME_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return trimmed;
};

const validateDate = (value) => {
  const trimmed = String(value || "").trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (
    !datePattern.test(trimmed) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== trimmed
  ) {
    const error = new Error("DATE_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return trimmed;
};

const timeToMinutes = (value) => {
  const [hours, minutes] = String(value || "00:00").slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
};

const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
};

const addMinutes = (value, minutes) =>
  minutesToTime(timeToMinutes(value) + Number(minutes || 0));

const assertTimeRange = (startTime, endTime) => {
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    const error = new Error("TIME_RANGE_INVALID");
    error.statusCode = 422;
    throw error;
  }
};

const normalizeAvailability = (value) => {
  const availability = parseJsonArray(value)
    .map((item) => ({
      day_of_week: parsePositiveInteger(item.day_of_week, { min: 1, max: 7 }),
      start_time: normalizeTime(item.start_time),
      end_time: normalizeTime(item.end_time),
    }))
    .map((item) => {
      assertTimeRange(item.start_time, item.end_time);
      return item;
    });
  const ordered = [...availability].sort(
    (a, b) =>
      a.day_of_week - b.day_of_week ||
      timeToMinutes(a.start_time) - timeToMinutes(b.start_time),
  );
  if (
    ordered.some(
      (range, index) =>
        index > 0 &&
        ordered[index - 1].day_of_week === range.day_of_week &&
        timeToMinutes(ordered[index - 1].end_time) >
          timeToMinutes(range.start_time),
    )
  ) {
    const error = new Error("TIME_RANGE_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return availability;
};

const requireSystemAdmin = (user) => {
  if (!canManageSystem(user)) {
    const error = new Error("SYSTEM_ADMIN_REQUIRED");
    error.statusCode = 403;
    throw error;
  }
};

const normalizeUserRole = (value) => {
  const role = String(value || "user").trim().toLowerCase();
  return userRoles.has(role) ? role : "user";
};

const requireCurrentUser = async (request) => {
  const session = readSessionFromRequest(request);
  if (!session) {
    const error = new Error("NOT_AUTHENTICATED");
    error.statusCode = 401;
    throw error;
  }

  const user = await one(
    `
      SELECT id, email, name, role, permissions, is_active, session_version
      FROM users
      WHERE id = $1
    `,
    [session.sub],
  );

  if (
    !user ||
    !user.is_active ||
    Number(user.session_version) !== Number(session.sv)
  ) {
    const error = new Error("SESSION_EXPIRED");
    error.statusCode = 401;
    throw error;
  }

  return {
    user: {
      ...user,
      id: Number(user.id),
      permissions: permissionsForUser(user),
      can_delete_records: canDeleteRecords(user),
      can_manage_system: canManageSystem(user),
    },
    session,
  };
};

const requireCsrfForMutation = (request, session) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    enforceCsrf(request, session);
  }
};

const publicUser = (user) => ({
  id: Number(user.id),
  email: user.email,
  name: user.name,
  role: user.role,
  permissions: permissionsForUser(user),
  can_delete_records: Boolean(user.can_delete_records),
  can_manage_system: Boolean(user.can_manage_system),
});

const mapAdminUser = (row) => ({
  id: Number(row.id),
  email: row.email,
  name: row.name || "",
  role: row.role,
  professional_id: row.professional_id ? Number(row.professional_id) : null,
  professional_name: row.professional_name || "",
  is_active: Boolean(row.is_active),
  last_login_at: row.last_login_at,
  created_at: row.created_at,
});

const handleLogin = async (request, response) => {
  const payload = await parseJsonBody(request);
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");

  enforceLoginRateLimit(getClientIp(request), email);

  const user = await one(
    `
      SELECT id, email, name, role, permissions, is_active, password_hash, session_version
      FROM users
      WHERE lower(email) = lower($1)
    `,
    [email],
  );

  if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
    await recordAudit("auth.login_failed", {
      detail: { email, client_ip: getClientIp(request) },
    });
    sendJson(response, 401, { error: "Credenciales inválidas." });
    return;
  }

  if (user.role === "professional") {
    sendJson(response, 403, {
      error: "Ingresá desde el portal de profesionales.",
      portal_url: "/profesional/",
    });
    return;
  }

  await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
  await recordAudit("auth.login_succeeded", {
    actorUserId: user.id,
    detail: { email, client_ip: getClientIp(request) },
  });

  const { token, csrf } = createSessionToken(user);
  sendJson(
    response,
    200,
    {
      user: publicUser({
        ...user,
        permissions: permissionsForUser(user),
        can_delete_records: canDeleteRecords(user),
        can_manage_system: canManageSystem(user),
      }),
      csrf_token: csrf,
    },
    { "Set-Cookie": sessionCookie(token) },
  );
};

const handleMe = async (request, response) => {
  const { user, session } = await requireCurrentUser(request);
  sendJson(response, 200, { user: publicUser(user), csrf_token: session.csrf });
};

const handleLogout = async (request, response) => {
  const { user, session } = await requireCurrentUser(request);
  enforceCsrf(request, session);
  await recordAudit("auth.logout", { actorUserId: user.id, detail: { email: user.email } });
  sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

const handleChangePassword = async (request, response) => {
  const { user, session } = await requireCurrentUser(request);
  enforceCsrf(request, session);
  const payload = await parseJsonBody(request);
  const currentPassword = String(payload.current_password || "");
  const newPassword = String(payload.new_password || "");

  if (newPassword.length < 10) {
    sendJson(response, 422, { error: "La nueva clave debe tener al menos 10 caracteres." });
    return;
  }

  const dbUser = await one("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!dbUser || !(await verifyPassword(currentPassword, dbUser.password_hash))) {
    await recordAudit("auth.password_change_failed", {
      actorUserId: user.id,
      detail: { email: user.email },
    });
    sendJson(response, 400, { error: "La clave actual no es correcta." });
    return;
  }

  await query(
    `
      UPDATE users
      SET password_hash = $1,
          session_version = session_version + 1,
          updated_at = NOW()
      WHERE id = $2
    `,
    [await hashPassword(newPassword), user.id],
  );
  await recordAudit("auth.password_changed", { actorUserId: user.id });
  sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

const listUsers = async (response) => {
  const result = await query(`
    SELECT
      u.id,
      u.email,
      u.name,
      u.role,
      u.professional_id,
      u.is_active,
      u.last_login_at,
      u.created_at,
      p.name AS professional_name
    FROM users u
    LEFT JOIN professionals p ON p.id = u.professional_id
    WHERE u.is_active = TRUE
    ORDER BY u.created_at DESC
  `);
  sendJson(response, 200, { users: result.rows.map(mapAdminUser) });
};

const createUser = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const email = String(payload.email || "").trim().toLowerCase();
  const name = String(payload.name || "").trim();
  const password = String(payload.password || "");
  const requestedRole = normalizeUserRole(payload.role);

  if (!emailPattern.test(email)) {
    sendJson(response, 422, { error: "Ingresá un email válido." });
    return;
  }
  if (password.length < 10) {
    sendJson(response, 422, { error: "La clave debe tener al menos 10 caracteres." });
    return;
  }
  if (requestedRole === "professional") {
    sendJson(response, 422, {
      error: "Las cuentas profesionales se crean y administran desde Profesionales.",
    });
    return;
  }
  if (requestedRole === "admin" && !canManageSystem(user)) {
    sendJson(response, 403, { error: "Solo un admin puede crear ese tipo de usuario." });
    return;
  }

  const role = canManageSystem(user) ? requestedRole : "user";
  const safeName = name || email.split("@")[0];
  const passwordHash = await hashPassword(password);
  const existing = await one(
    `
      SELECT id, role, professional_id, is_active
      FROM users
      WHERE lower(email) = lower($1)
    `,
    [email],
  );

  let result;
  if (existing?.role === "professional" || existing?.professional_id) {
    sendJson(response, 409, {
      error: "Esa cuenta profesional se administra desde Profesionales.",
    });
    return;
  }
  if (existing?.is_active) {
    sendJson(response, 409, { error: "Ya existe un usuario con ese email." });
    return;
  }
  if (existing) {
    result = await one(
      `
        UPDATE users
        SET name = $1,
            password_hash = $2,
            role = $3,
            professional_id = NULL,
            is_active = TRUE,
            session_version = session_version + 1,
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, email, name, role, professional_id, is_active, last_login_at, created_at
      `,
      [safeName, passwordHash, role, existing.id],
    );
  } else {
    result = await one(
      `
        INSERT INTO users (email, name, password_hash, role)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, name, role, professional_id, is_active, last_login_at, created_at
      `,
      [email, safeName, passwordHash, role],
    );
  }

  await recordAudit("user.created", {
    actorUserId: user.id,
    detail: { target_user_id: Number(result.id), email, role },
  });
  sendJson(response, 200, { user: mapAdminUser(result) });
};

const deleteUser = async (response, user, id) => {
  if (Number(user.id) === Number(id)) {
    sendJson(response, 422, { error: "No podés eliminar tu propio usuario." });
    return;
  }

  const target = await one(
    `
      SELECT id, email, role, is_active
      FROM users
      WHERE id = $1
    `,
    [id],
  );
  if (!target || !target.is_active) {
    sendJson(response, 404, { error: "Usuario no encontrado." });
    return;
  }

  if (target.role === "admin") {
    requireSystemAdmin(user);
    const adminCount = await one(
      "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active = TRUE",
    );
    if (Number(adminCount?.count || 0) <= 1) {
      sendJson(response, 422, { error: "No podés eliminar el último admin activo." });
      return;
    }
  }

  await query(
    `
      UPDATE users
      SET is_active = FALSE,
          session_version = session_version + 1,
          updated_at = NOW()
      WHERE id = $1
    `,
    [id],
  );
  await recordAudit("user.deleted", {
    actorUserId: user.id,
    detail: { target_user_id: Number(target.id), email: target.email, role: target.role },
  });
  sendJson(response, 200, { ok: true });
};

const listAgreements = async (response) => {
  const result = await query(`
    SELECT
      a.*,
      COUNT(DISTINCT n.id)::int AS nomina_count,
      COUNT(DISTINCT p.id)::int AS intake_count,
      COUNT(DISTINCT professional_agreement.professional_id) FILTER (
        WHERE professional.active = TRUE
          AND professional.deleted_at IS NULL
      )::int AS professional_count,
      COUNT(DISTINCT api_credential.id) FILTER (
        WHERE api_credential.active = TRUE
          AND api_credential.revoked_at IS NULL
      )::int AS active_api_credentials
    FROM agreements a
    LEFT JOIN nomina_entries n ON n.agreement_id = a.id
    LEFT JOIN patient_intakes p ON p.agreement_id = a.id
    LEFT JOIN professional_agreements professional_agreement
      ON professional_agreement.agreement_id = a.id
    LEFT JOIN professionals professional
      ON professional.id = professional_agreement.professional_id
    LEFT JOIN agreement_api_credentials api_credential
      ON api_credential.agreement_id = a.id
    WHERE a.deleted_at IS NULL
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `);
  sendJson(response, 200, { agreements: result.rows.map(mapAgreement) });
};

const mapAgreement = (row) => ({
  id: Number(row.id),
  name: row.name,
  slug: row.slug,
  subdomain_prefix: row.subdomain_prefix || "",
  cobranded: Boolean(row.cobranded),
  type: row.type,
  logo_path: row.logo_path || "",
  logo_url: row.logo_path ? `/uploads/${row.logo_path}` : "",
  pdf_path: row.pdf_path || "",
  pdf_url: row.pdf_path ? `/uploads/${row.pdf_path}` : "",
  payment_evaluation_url: row.payment_evaluation_url || "",
  payment_treatment_url: row.payment_treatment_url || "",
  nomina_count: Number(row.nomina_count || 0),
  intake_count: Number(row.intake_count || 0),
  professional_count: Number(row.professional_count || 0),
  active_api_credentials: Number(row.active_api_credentials || 0),
  api_available: row.type === "Pago",
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const agreementPayloadFromMultipart = async (request) => {
  const { fields, files } = await parseMultipartForm(request);
  const name = String(fields.name || "").trim();
  const slug = slugify(fields.slug || name);
  const subdomainPrefix = validateAgreementSubdomainPrefix(
    fields.subdomain_prefix,
  );
  const type = fields.type === "Nomina" ? "Nomina" : "Pago";

  if (!name) {
    const error = new Error("NAME_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  if (!slug) {
    const error = new Error("SLUG_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  return {
    fields: {
      name,
      slug,
      subdomain_prefix: subdomainPrefix,
      cobranded: fields.cobranded === "true" || fields.cobranded === "on",
      type,
      payment_evaluation_url:
        type === "Nomina" ? "" : optionalUrl(fields.payment_evaluation_url),
      payment_treatment_url:
        type === "Nomina" ? "" : optionalUrl(fields.payment_treatment_url),
      remove_logo: fields.remove_logo === "true",
      remove_pdf: fields.remove_pdf === "true",
    },
    files,
  };
};

const createAgreement = async (request, response, user) => {
  const payload = await agreementPayloadFromMultipart(request);
  const logoPath = await saveAgreementLogo(payload.files.logo);
  const pdfPath = await saveAgreementPdf(payload.files.pdf);
  if (payload.fields.cobranded && !logoPath) {
    const error = new Error("COBRANDED_LOGO_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  const result = await query(
    `
      INSERT INTO agreements
        (
          name,
          slug,
          subdomain_prefix,
          logo_path,
          pdf_path,
          cobranded,
          type,
          payment_evaluation_url,
          payment_treatment_url
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.slug,
      payload.fields.subdomain_prefix,
      logoPath || null,
      pdfPath || null,
      payload.fields.cobranded,
      payload.fields.type,
      payload.fields.payment_evaluation_url || null,
      payload.fields.payment_treatment_url || null,
    ],
  );
  await recordAudit("agreement.created", {
    actorUserId: user.id,
    detail: {
      agreement_id: result.rows[0].id,
      slug: result.rows[0].slug,
      subdomain_prefix: result.rows[0].subdomain_prefix,
    },
  });
  sendJson(response, 201, { agreement: mapAgreement(result.rows[0]) });
};

const updateAgreement = async (request, response, user, id) => {
  const current = await getAgreementById(id);
  if (!current) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }

  const payload = await agreementPayloadFromMultipart(request);
  const logoPath = await saveAgreementLogo(payload.files.logo);
  const pdfPath = await saveAgreementPdf(payload.files.pdf);
  const nextLogoPath = payload.fields.remove_logo
    ? null
    : logoPath || current.logo_path || null;
  if (payload.fields.cobranded && !nextLogoPath) {
    const error = new Error("COBRANDED_LOGO_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  const result = await query(
    `
      UPDATE agreements
      SET name = $1,
          slug = $2,
          subdomain_prefix = $3,
          logo_path = $4,
          pdf_path = $5,
          cobranded = $6,
          type = $7,
          payment_evaluation_url = $8,
          payment_treatment_url = $9,
          updated_at = NOW()
      WHERE id = $10
        AND deleted_at IS NULL
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.slug,
      payload.fields.subdomain_prefix,
      nextLogoPath,
      payload.fields.remove_pdf ? null : pdfPath || current.pdf_path || null,
      payload.fields.cobranded,
      payload.fields.type,
      payload.fields.payment_evaluation_url || null,
      payload.fields.payment_treatment_url || null,
      id,
    ],
  );
  await recordAudit("agreement.updated", {
    actorUserId: user.id,
    detail: { agreement_id: id },
  });
  sendJson(response, 200, { agreement: mapAgreement(result.rows[0]) });
};

const deleteAgreement = async (response, user, id) => {
  await query("UPDATE agreements SET deleted_at = NOW() WHERE id = $1", [id]);
  await recordAudit("agreement.deleted", {
    actorUserId: user.id,
    detail: { agreement_id: id },
  });
  sendJson(response, 200, { ok: true });
};

const downloadAgreementQr = async (response, id) => {
  const agreement = await getAgreementById(id);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }

  const formUrl = agreementBookingUrl(agreement, config.appPublicUrl);
  const filename = `reku-agenda-${downloadSlug(agreement.slug)}-qr.png`;
  const png = await QRCode.toBuffer(formUrl, {
    type: "png",
    width: 500,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#18213f",
      light: "#ffffff",
    },
  });

  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": "image/png",
        "Content-Length": String(png.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
      { privateRoute: true },
    ),
  );
  response.end(png);
};

const listAdminAgreementApiCredentials = async (response, agreementId) => {
  const agreement = await getAgreementById(agreementId);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }
  const credentials = await listAgreementApiCredentials(agreementId);
  sendJson(response, 200, {
    agreement: {
      id: Number(agreement.id),
      name: agreement.name,
      type: agreement.type,
      api_available: agreement.type === "Pago",
    },
    credentials,
  });
};

const createAdminAgreementApiCredential = async (
  request,
  response,
  user,
  agreementId,
) => {
  const payload = await parseJsonBody(request);
  const result = await createAgreementApiCredential({
    agreementId,
    name: payload.name,
    userId: user.id,
  });
  sendJson(response, 201, result);
};

const revokeAdminAgreementApiCredential = async (
  response,
  user,
  agreementId,
  credentialId,
) => {
  await revokeAgreementApiCredential({
    agreementId,
    credentialId,
    userId: user.id,
  });
  sendJson(response, 200, { ok: true });
};

const previewAdminAgreementSettlement = async (url, response) => {
  const preview = await getAgreementSettlementPreview({
    agreementId: url.searchParams.get("agreement_id"),
    month: url.searchParams.get("month"),
  });
  sendJson(response, 200, { settlement: preview });
};

const generateAdminAgreementSettlement = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const result = await generateAgreementSettlement({
    agreementId: payload.agreement_id,
    month: payload.month,
    userId: user.id,
  });
  sendJson(response, 201, {
    settlement: {
      ...result.settlement,
      pdf_url: `/api/admin/settlements/${result.settlement.id}/pdf`,
    },
  });
};

const listPatientIntakes = async (url, response) => {
  const agreementId = url.searchParams.get("agreement_id") || null;
  const result = await query(
    `
      SELECT
        p.*,
        COALESCE(a.name, p.agreement_name_snapshot, '') AS agreement_name,
        COALESCE(a.slug, p.agreement_slug_snapshot, '') AS agreement_slug,
        COUNT(*) OVER (PARTITION BY lower(p.email))::int AS email_duplicate_count
      FROM patient_intakes p
      LEFT JOIN agreements a ON a.id = p.agreement_id
      WHERE ($1::bigint IS NULL OR p.agreement_id = $1::bigint)
      ORDER BY p.created_at DESC
      LIMIT 300
    `,
    [agreementId || null],
  );
  sendJson(response, 200, { patient_intakes: result.rows.map(mapPatientIntake) });
};

const mapPatientIntake = (row) => ({
  id: Number(row.id),
  agreement_id: row.agreement_id ? Number(row.agreement_id) : null,
  agreement_name: row.agreement_name || "",
  agreement_slug: row.agreement_slug || "",
  nombre: row.nombre,
  apellido: row.apellido,
  telefono: row.telefono,
  email: row.email,
  identificador: row.identificador || "",
  email_message_id: row.email_message_id || "",
  email_error: row.email_error || "",
  verification_email_message_id: row.booking_email_message_id || "",
  verification_email_error: row.booking_email_error || "",
  email_duplicate_count: Number(row.email_duplicate_count || 1),
  created_at: row.created_at,
});

const listPatients = async (url, response) => {
  const agreementId = url.searchParams.get("agreement_id") || null;
  const result = await query(
    `
      SELECT
        patient.id,
        patient.first_name,
        patient.last_name,
        patient.full_name,
        patient.email,
        patient.phone,
        patient.created_at,
        GREATEST(
          patient.updated_at,
          COALESCE(latest_intake.created_at, patient.created_at),
          COALESCE(appointment_stats.last_appointment_at, patient.created_at)
        ) AS last_activity_at,
        latest_intake.identificador,
        latest_intake.email_message_id,
        latest_intake.email_error,
        latest_intake.booking_email_message_id,
        latest_intake.booking_email_error,
        COALESCE(intake_stats.intake_count, 0)::int AS intake_count,
        COALESCE(intake_stats.agreement_names, '') AS agreement_names,
        COALESCE(appointment_stats.appointment_count, 0)::int AS appointment_count
      FROM patients patient
      LEFT JOIN LATERAL (
        SELECT intake.*
        FROM patient_intakes intake
        WHERE intake.patient_id = patient.id
          AND ($1::bigint IS NULL OR intake.agreement_id = $1::bigint)
        ORDER BY intake.created_at DESC, intake.id DESC
        LIMIT 1
      ) latest_intake ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS intake_count,
          string_agg(
            DISTINCT COALESCE(agreement.name, intake.agreement_name_snapshot, ''),
            ' · '
          ) FILTER (
            WHERE COALESCE(agreement.name, intake.agreement_name_snapshot, '') <> ''
          ) AS agreement_names
        FROM patient_intakes intake
        LEFT JOIN agreements agreement ON agreement.id = intake.agreement_id
        WHERE intake.patient_id = patient.id
          AND ($1::bigint IS NULL OR intake.agreement_id = $1::bigint)
      ) intake_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS appointment_count,
          MAX(appointment.created_at) AS last_appointment_at
        FROM appointments appointment
        WHERE appointment.patient_id = patient.id
      ) appointment_stats ON TRUE
      WHERE patient.active = TRUE
        AND ($1::bigint IS NULL OR latest_intake.id IS NOT NULL)
      ORDER BY last_activity_at DESC, patient.id DESC
      LIMIT 300
    `,
    [agreementId || null],
  );
  sendJson(response, 200, { patients: result.rows.map(mapPatient) });
};

const mapPatient = (row) => ({
  id: Number(row.id),
  nombre: row.first_name || "",
  apellido: row.last_name || "",
  full_name:
    row.full_name || [row.first_name, row.last_name].filter(Boolean).join(" "),
  telefono: row.phone || "",
  email: row.email,
  identificador: row.identificador || "",
  agreement_name: row.agreement_names || "",
  intake_count: Number(row.intake_count || 0),
  appointment_count: Number(row.appointment_count || 0),
  email_message_id: row.email_message_id || "",
  email_error: row.email_error || "",
  verification_email_message_id: row.booking_email_message_id || "",
  verification_email_error: row.booking_email_error || "",
  created_at: row.created_at,
  last_activity_at: row.last_activity_at || row.created_at,
});

const deactivatePatient = async (response, user, patientId) => {
  if (!canDeleteRecords(user)) {
    sendJson(response, 403, { error: "No tenés permisos para eliminar registros." });
    return;
  }
  const result = await query(
    `
      UPDATE patients
      SET active = FALSE,
          updated_at = NOW()
      WHERE id = $1
        AND active = TRUE
      RETURNING id
    `,
    [patientId],
  );
  if (!result.rows[0]) {
    sendJson(response, 404, { error: "Paciente no encontrado." });
    return;
  }
  await recordAudit("patients.deactivated", {
    actorUserId: user.id,
    detail: { patient_id: patientId },
  });
  sendJson(response, 200, { ok: true });
};

const listContacts = async (response) => {
  const result = await query(`
    SELECT *
    FROM contacts
    ORDER BY created_at DESC
    LIMIT 300
  `);
  sendJson(response, 200, { contacts: result.rows.map(mapContact) });
};

const mapContact = (row) => ({
  id: Number(row.id),
  nombre: row.nombre,
  apellido: row.apellido,
  telefono: row.telefono,
  email: row.email,
  organizacion: row.organizacion,
  rol: row.rol,
  pacientes: row.pacientes,
  email_message_id: row.email_message_id || "",
  email_error: row.email_error || "",
  created_at: row.created_at,
});

const congressRegistrationSelect = `
  SELECT
    id,
    nombre,
    apellido,
    profesion,
    telefono,
    email,
    ambitos,
    interes_telerehabilitacion,
    interes_tecnologia,
    comentario,
    source_path,
    email_message_id,
    email_error,
    created_at
  FROM congreso_cokiba_registrations
  ORDER BY created_at DESC, id DESC
`;

const mapCongressRegistration = (row) => ({
  id: Number(row.id),
  nombre_apellido: [row.nombre, row.apellido].filter(Boolean).join(" ").trim(),
  profesion: row.profesion || "",
  telefono: row.telefono || "",
  email: row.email || "",
  ambitos: Array.isArray(row.ambitos) ? row.ambitos : [],
  interes_telerehabilitacion: row.interes_telerehabilitacion || "",
  interes_tecnologia: row.interes_tecnologia || "",
  comentario: row.comentario || "",
  source_path: row.source_path || "",
  email_message_id: row.email_message_id || "",
  email_error: row.email_error || "",
  created_at: row.created_at,
});

const listCongressRegistrations = async (response) => {
  const result = await query(`${congressRegistrationSelect} LIMIT 1000`);
  sendJson(response, 200, {
    congress_registrations: result.rows.map(mapCongressRegistration),
  });
};

const downloadCongressRegistrationsCsv = async (response) => {
  const result = await query(congressRegistrationSelect);
  const registrations = result.rows.map(mapCongressRegistration);
  const csv = serializeCsv(
    [
      "ID",
      "Fecha",
      "Nombre y apellido",
      "Correo electrónico",
      "Teléfono / WhatsApp",
      "Profesión / especialidad",
      "Ámbitos de trabajo",
      "Interés en telerehabilitación",
      "Interés en tecnología",
      "Comentario",
      "Origen",
      "Estado del email",
    ],
    registrations.map((registration) => [
      registration.id,
      registration.created_at
        ? new Date(registration.created_at).toISOString()
        : "",
      registration.nombre_apellido,
      registration.email,
      registration.telefono,
      registration.profesion,
      registration.ambitos,
      registration.interes_telerehabilitacion,
      registration.interes_tecnologia,
      registration.comentario,
      registration.source_path,
      registration.email_error
        ? `Error: ${registration.email_error}`
        : registration.email_message_id
          ? "Enviado"
          : "Pendiente",
    ]),
  );

  response.writeHead(
    200,
    withSecurityHeaders(
      {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(csv)),
        "Content-Disposition":
          'attachment; filename="reku-contactos-congreso-cokiba.csv"',
        "Cache-Control": "no-store",
      },
      { privateRoute: true },
    ),
  );
  response.end(csv);
};

const deleteRecord = async (response, user, table, id) => {
  if (!canDeleteRecords(user)) {
    sendJson(response, 403, { error: "No tenés permisos para eliminar registros." });
    return;
  }
  await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  await recordAudit(`${table}.deleted`, {
    actorUserId: user.id,
    detail: { id },
  });
  sendJson(response, 200, { ok: true });
};

const revokeProfessionalLinksAndSessions = async (response, user, id) => {
  const professional = await one(
    `
      SELECT id, name, email
      FROM professionals
      WHERE id = $1
        AND deleted_at IS NULL
    `,
    [id],
  );
  if (!professional) {
    sendJson(response, 404, { error: "Profesional no encontrado." });
    return;
  }

  const revoked = await revokeProfessionalAccess(id);
  await recordAudit("professional.access_revoked", {
    actorUserId: user.id,
    detail: {
      professional_id: Number(professional.id),
      professional_email: professional.email,
      ...revoked,
    },
  });
  sendJson(response, 200, { ok: true, revoked });
};

const listNomina = async (url, response) => {
  const agreementId = url.searchParams.get("agreement_id") || null;
  const result = await query(
    `
      SELECT
        n.*,
        a.name AS agreement_name,
        EXISTS (
          SELECT 1
          FROM patient_intakes p
          WHERE p.agreement_id = n.agreement_id
            AND lower(p.identificador) = n.identificador_normalized
        ) AS form_submitted
      FROM nomina_entries n
      INNER JOIN agreements a ON a.id = n.agreement_id
      WHERE ($1::bigint IS NULL OR n.agreement_id = $1::bigint)
        AND a.deleted_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT 500
    `,
    [agreementId || null],
  );
  sendJson(response, 200, { nomina_entries: result.rows.map(mapNominaEntry) });
};

const mapNominaEntry = (row) => ({
  id: Number(row.id),
  agreement_id: Number(row.agreement_id),
  agreement_name: row.agreement_name || "",
  nombre: row.nombre || "",
  apellido: row.apellido || "",
  identificador: row.identificador,
  form_submitted: Boolean(row.form_submitted),
  created_at: row.created_at,
});

const assertNominaAgreement = async (agreementId) => {
  const agreement = await getAgreementById(agreementId);
  if (!agreement || agreement.type !== "Nomina") {
    const error = new Error("NOMINA_AGREEMENT_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  return agreement;
};

const createNominaEntry = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const agreementId = Number(payload.agreement_id);
  const identificador = String(payload.identificador || "").trim();

  await assertNominaAgreement(agreementId);
  if (!identificador) {
    sendJson(response, 422, { error: "El identificador es obligatorio." });
    return;
  }

  const existing = await one(
    `
      SELECT id
      FROM nomina_entries
      WHERE agreement_id = $1
        AND identificador_normalized = lower($2)
    `,
    [agreementId, identificador],
  );
  if (existing) {
    sendJson(response, 409, {
      error: "Ese identificador ya existe para este acuerdo.",
    });
    return;
  }

  const result = await query(
    `
      INSERT INTO nomina_entries
        (agreement_id, nombre, apellido, identificador, identificador_normalized)
      VALUES ($1, $2, $3, $4, lower($4))
      RETURNING *
    `,
    [
      agreementId,
      String(payload.nombre || "").trim() || null,
      String(payload.apellido || "").trim() || null,
      identificador,
    ],
  );
  await recordAudit("nomina_entry.created", {
    actorUserId: user.id,
    detail: { agreement_id: agreementId, identificador },
  });
  sendJson(response, 200, { nomina_entry: mapNominaEntry(result.rows[0]) });
};

const importNominaCsv = async (request, response, user) => {
  const { fields, files } = await parseMultipartForm(request, {
    maxBytes: config.csvUploadMaxBytes,
  });
  const agreementId = Number(fields.agreement_id);
  await assertNominaAgreement(agreementId);
  const rows = parseNominaCsv(readCsvUpload(files.csv));

  const result = await tx(async (client) => {
    let upserted = 0;
    for (const row of rows) {
      await client.query(
        `
          INSERT INTO nomina_entries
            (agreement_id, nombre, apellido, identificador, identificador_normalized)
          VALUES ($1, $2, $3, $4, lower($4))
          ON CONFLICT (agreement_id, identificador_normalized)
          DO UPDATE SET
            nombre = EXCLUDED.nombre,
            apellido = EXCLUDED.apellido,
            identificador = EXCLUDED.identificador,
            updated_at = NOW()
        `,
        [
          agreementId,
          row.nombre || null,
          row.apellido || null,
          row.identificador,
        ],
      );
      upserted += 1;
    }
    return { upserted };
  });

  await recordAudit("nomina_entries.imported", {
    actorUserId: user.id,
    detail: { agreement_id: agreementId, count: result.upserted },
  });
  sendJson(response, 200, { ok: true, ...result });
};

const deleteNominaEntry = async (response, user, id) => {
  await query("DELETE FROM nomina_entries WHERE id = $1", [id]);
  await recordAudit("nomina_entry.deleted", {
    actorUserId: user.id,
    detail: { id },
  });
  sendJson(response, 200, { ok: true });
};

const mapService = (row) => ({
  id: Number(row.id),
  name: row.name,
  duration_minutes: Number(row.duration_minutes),
  cost_amount: Number(row.cost_amount || 0),
  payment_url: row.payment_url || "",
  image_path: row.image_path || "",
  image_url: row.image_path ? `/uploads/${row.image_path}` : "",
  active: Boolean(row.active),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const listServices = async (response) => {
  const result = await query(`
    SELECT *
    FROM services
    WHERE deleted_at IS NULL
    ORDER BY active DESC, name ASC
  `);
  sendJson(response, 200, { services: result.rows.map(mapService) });
};

const servicePayloadFromJson = async (request) => {
  const payload = await parseJsonBody(request);
  const name = String(payload.name || "").trim();
  if (!name) {
    const error = new Error("SERVICE_NAME_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  return {
    name,
    duration_minutes: parsePositiveInteger(payload.duration_minutes, { min: 5, max: 480 }),
    cost_amount: parseMoney(payload.cost_amount),
    payment_url: optionalUrl(payload.payment_url),
    active: payload.active !== false,
    remove_image: payload.remove_image === true,
  };
};

const servicePayloadFromMultipart = async (request) => {
  const { fields, files } = await parseMultipartForm(request);
  const name = String(fields.name || "").trim();
  if (!name) {
    const error = new Error("SERVICE_NAME_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  return {
    fields: {
      name,
      duration_minutes: parsePositiveInteger(fields.duration_minutes, {
        min: 5,
        max: 480,
      }),
      cost_amount: parseMoney(fields.cost_amount),
      payment_url: optionalUrl(fields.payment_url),
      active: fields.active !== "false",
      remove_image: fields.remove_image === "true",
    },
    files,
  };
};

const servicePayloadFromRequest = async (request) => {
  if (isMultipartRequest(request)) {
    return servicePayloadFromMultipart(request);
  }
  return {
    fields: await servicePayloadFromJson(request),
    files: {},
  };
};

const createService = async (request, response, user) => {
  const payload = await servicePayloadFromRequest(request);
  const imagePath = await saveServiceImage(payload.files.image);
  const result = await query(
    `
      INSERT INTO services (name, duration_minutes, cost_amount, payment_url, image_path, active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.duration_minutes,
      payload.fields.cost_amount,
      payload.fields.payment_url,
      imagePath || null,
      payload.fields.active,
    ],
  );
  await recordAudit("service.created", {
    actorUserId: user.id,
    detail: { service_id: result.rows[0].id, name: payload.fields.name },
  });
  sendJson(response, 201, { service: mapService(result.rows[0]) });
};

const updateService = async (request, response, user, id) => {
  const currentResult = await query(
    "SELECT * FROM services WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  const current = currentResult.rows[0];
  if (!current) {
    sendJson(response, 404, { error: "Servicio no encontrado." });
    return;
  }

  const payload = await servicePayloadFromRequest(request);
  const imagePath = await saveServiceImage(payload.files.image);
  const result = await query(
    `
      UPDATE services
      SET name = $1,
          duration_minutes = $2,
          cost_amount = $3,
          payment_url = $4,
          image_path = $5,
          active = $6,
          updated_at = NOW()
      WHERE id = $7
        AND deleted_at IS NULL
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.duration_minutes,
      payload.fields.cost_amount,
      payload.fields.payment_url,
      payload.fields.remove_image ? null : imagePath || current.image_path || null,
      payload.fields.active,
      id,
    ],
  );
  if (!result.rows[0]) {
    sendJson(response, 404, { error: "Servicio no encontrado." });
    return;
  }
  await recordAudit("service.updated", {
    actorUserId: user.id,
    detail: { service_id: id },
  });
  sendJson(response, 200, { service: mapService(result.rows[0]) });
};

const deleteService = async (response, user, id) => {
  await query(
    "UPDATE services SET active = FALSE, deleted_at = NOW(), updated_at = NOW() WHERE id = $1",
    [id],
  );
  await recordAudit("service.deleted", {
    actorUserId: user.id,
    detail: { service_id: id },
  });
  sendJson(response, 200, { ok: true });
};

const mapProfessional = (row) => ({
  id: Number(row.id),
  name: row.name,
  email: row.email,
  photo_path: row.photo_path || "",
  photo_url: row.photo_path ? `/uploads/${row.photo_path}` : "",
  active: Boolean(row.active),
  license_number: row.license_number || "",
  specialty: row.specialty || "",
  bio: row.bio || "",
  phone: row.phone || "",
  services: row.services || [],
  agreements: row.agreements || [],
  availability: row.availability || [],
  has_user: Boolean(
    row.user_id && row.user_role === "professional" && row.user_is_active,
  ),
  user_id: row.user_id ? Number(row.user_id) : null,
  user_email: row.user_email || "",
  user_is_active: Boolean(row.user_is_active),
  invitation_pending: Boolean(row.invitation_id),
  invitation_expires_at: row.invitation_expires_at || null,
  invitation_sent_at: row.invitation_sent_at || null,
  invitation_email_error: row.invitation_email_error || "",
  calendar_connected: row.google_calendar_status === "active",
  calendar_status: row.google_calendar_status || "not_connected",
  notifications_connected: Boolean(
    config.webPushVapidPublicKey &&
      config.webPushVapidPrivateKey &&
      Number(row.push_mobile_devices || 0) > 0,
  ),
  push_mobile_devices: Number(row.push_mobile_devices || 0),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const professionalSelect = `
  SELECT
    p.*,
    pu.id AS user_id,
    pu.email AS user_email,
    pu.role AS user_role,
    pu.is_active AS user_is_active,
    pgc.status AS google_calendar_status,
    COALESCE(push_devices.mobile_devices, 0)::int AS push_mobile_devices,
    pending_invitation.id AS invitation_id,
    pending_invitation.expires_at AS invitation_expires_at,
    pending_invitation.sent_at AS invitation_sent_at,
    pending_invitation.email_error AS invitation_email_error,
    COALESCE(
      (
        SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
        FROM professional_services ps
        INNER JOIN services s ON s.id = ps.service_id
        WHERE ps.professional_id = p.id
          AND s.deleted_at IS NULL
      ),
      '[]'::json
    ) AS services,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object('id', agreement.id, 'name', agreement.name)
          ORDER BY agreement.name
        )
        FROM professional_agreements relation
        INNER JOIN agreements agreement ON agreement.id = relation.agreement_id
        WHERE relation.professional_id = p.id
          AND agreement.deleted_at IS NULL
      ),
      '[]'::json
    ) AS agreements,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'day_of_week', pa.day_of_week,
            'start_time', to_char(pa.start_time, 'HH24:MI'),
            'end_time', to_char(pa.end_time, 'HH24:MI')
          )
          ORDER BY pa.day_of_week, pa.start_time
        )
        FROM professional_availability pa
        WHERE pa.professional_id = p.id
      ),
      '[]'::json
    ) AS availability
  FROM professionals p
  LEFT JOIN users pu ON pu.professional_id = p.id
  LEFT JOIN professional_google_connections pgc ON pgc.professional_id = p.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS mobile_devices
    FROM professional_push_subscriptions subscription
    WHERE subscription.professional_id = p.id
      AND subscription.active = TRUE
      AND subscription.device_kind = 'mobile'
  ) push_devices ON TRUE
  LEFT JOIN LATERAL (
    SELECT invitation.id, invitation.expires_at, invitation.sent_at, invitation.email_error
    FROM professional_invitations invitation
    WHERE invitation.professional_id = p.id
      AND invitation.accepted_at IS NULL
      AND invitation.revoked_at IS NULL
      AND invitation.expires_at > NOW()
    ORDER BY invitation.created_at DESC
    LIMIT 1
  ) pending_invitation ON TRUE
`;

const listProfessionals = async (response) => {
  const result = await query(`
    ${professionalSelect}
    WHERE p.deleted_at IS NULL
    ORDER BY p.active DESC, p.name ASC
  `);
  sendJson(response, 200, { professionals: result.rows.map(mapProfessional) });
};

const getProfessionalMapped = async (id) => {
  const result = await query(
    `
      ${professionalSelect}
      WHERE p.id = $1
        AND p.deleted_at IS NULL
    `,
    [id],
  );
  return result.rows[0] ? mapProfessional(result.rows[0]) : null;
};

const replaceProfessionalRelations = async (
  client,
  professionalId,
  serviceIds,
  agreementIds,
  availability,
) => {
  await client.query("DELETE FROM professional_services WHERE professional_id = $1", [
    professionalId,
  ]);
  for (const serviceId of serviceIds) {
    await client.query(
      `
        INSERT INTO professional_services (professional_id, service_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [professionalId, serviceId],
    );
  }

  await client.query("DELETE FROM professional_agreements WHERE professional_id = $1", [
    professionalId,
  ]);
  for (const agreementId of agreementIds) {
    await client.query(
      `
        INSERT INTO professional_agreements (professional_id, agreement_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [professionalId, agreementId],
    );
  }

  await client.query("DELETE FROM professional_availability WHERE professional_id = $1", [
    professionalId,
  ]);
  for (const range of availability) {
    await client.query(
      `
        INSERT INTO professional_availability
          (professional_id, day_of_week, start_time, end_time)
        VALUES ($1, $2, $3::time, $4::time)
      `,
      [professionalId, range.day_of_week, range.start_time, range.end_time],
    );
  }
};

const professionalPayloadFromMultipart = async (request) => {
  const { fields, files } = await parseMultipartForm(request);
  const name = String(fields.name || "").trim();
  const email = String(fields.email || "").trim().toLowerCase();
  const licenseNumber = String(fields.license_number || "").trim().slice(0, 120);
  const specialty = String(fields.specialty || "").trim().slice(0, 160);
  const bio = String(fields.bio || "").trim().slice(0, 2_000);
  const phone = String(fields.phone || "").trim().slice(0, 80);
  const serviceIds = [
    ...new Set(parseJsonArray(fields.service_ids).map((value) => parsePositiveInteger(value))),
  ];
  const agreementIds = [
    ...new Set(parseJsonArray(fields.agreement_ids).map((value) => parsePositiveInteger(value))),
  ];
  const availability = normalizeAvailability(fields.availability);
  const password = String(fields.account_password || "");

  if (!name) {
    const error = new Error("PROFESSIONAL_NAME_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!emailPattern.test(email)) {
    const error = new Error("PROFESSIONAL_EMAIL_INVALID");
    error.statusCode = 422;
    throw error;
  }
  if (!serviceIds.length) {
    const error = new Error("PROFESSIONAL_SERVICE_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!agreementIds.length) {
    const error = new Error("PROFESSIONAL_AGREEMENT_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!availability.length) {
    const error = new Error("PROFESSIONAL_AVAILABILITY_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  return {
    fields: {
      name,
      email,
      licenseNumber,
      specialty,
      bio,
      phone,
      serviceIds,
      agreementIds,
      availability,
      active: fields.active !== "false",
      remove_photo: fields.remove_photo === "true",
      password,
    },
    files,
  };
};

const createProfessional = async (request, response, user) => {
  const payload = await professionalPayloadFromMultipart(request);
  const password = validateProfessionalPassword(payload.fields.password, { required: true });
  const passwordHash = await hashPassword(password);
  const photoPath = await saveProfessionalPhoto(payload.files.photo);
  const created = await tx(async (client) => {
    const result = await client.query(
      `
        INSERT INTO professionals
          (name, email, photo_path, active, license_number, specialty, bio, phone)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `,
      [
        payload.fields.name,
        payload.fields.email,
        photoPath || null,
        payload.fields.active,
        payload.fields.licenseNumber,
        payload.fields.specialty,
        payload.fields.bio,
        payload.fields.phone,
      ],
    );
    const id = Number(result.rows[0].id);
    await replaceProfessionalRelations(
      client,
      id,
      payload.fields.serviceIds,
      payload.fields.agreementIds,
      payload.fields.availability,
    );
    const account = await syncProfessionalUser(client, {
      professionalId: id,
      name: payload.fields.name,
      email: payload.fields.email,
      passwordHash,
    });
    return { professionalId: id, account };
  });
  await recordAudit("professional.created", {
    actorUserId: user.id,
    detail: {
      professional_id: created.professionalId,
      professional_user_id: Number(created.account.user.id),
      email: payload.fields.email,
    },
  });
  sendJson(response, 201, {
    professional: await getProfessionalMapped(created.professionalId),
  });
};

const invitationPayload = async (request) => {
  const payload = await parseJsonBody(request);
  const name = String(payload.name || "").trim().slice(0, 180);
  const email = String(payload.email || "").trim().toLowerCase();
  if (!name) {
    const error = new Error("PROFESSIONAL_NAME_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!emailPattern.test(email)) {
    const error = new Error("PROFESSIONAL_EMAIL_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return { name, email };
};

const prepareProfessionalInvitation = async ({ professional, actorUserId }) => {
  const placeholderPasswordHash = await hashPassword(randomBytes(48).toString("base64url"));
  return tx(async (client) => {
    const account = await createPendingProfessionalUser(client, {
      professionalId: professional.id,
      name: professional.name,
      email: professional.email,
      passwordHash: placeholderPasswordHash,
    });
    const invitation = await createProfessionalInvitation(client, {
      professionalId: professional.id,
      userId: account.id,
      email: professional.email,
      createdByUserId: actorUserId,
    });
    return { account, invitation };
  });
};

const inviteProfessional = async (request, response, user) => {
  const payload = await invitationPayload(request);
  const result = await tx(async (client) => {
    const professionalResult = await client.query(
      `
        INSERT INTO professionals (name, email, active)
        VALUES ($1, $2, TRUE)
        RETURNING id, name, email
      `,
      [payload.name, payload.email],
    );
    const professional = professionalResult.rows[0];
    const placeholderPasswordHash = await hashPassword(
      randomBytes(48).toString("base64url"),
    );
    const account = await createPendingProfessionalUser(client, {
      professionalId: professional.id,
      name: professional.name,
      email: professional.email,
      passwordHash: placeholderPasswordHash,
    });
    const invitation = await createProfessionalInvitation(client, {
      professionalId: professional.id,
      userId: account.id,
      email: professional.email,
      createdByUserId: user.id,
    });
    return { professional, account, invitation };
  });
  const delivery = await sendProfessionalInvitation({
    invitationId: result.invitation.id,
    professionalId: Number(result.professional.id),
    name: result.professional.name,
    email: result.professional.email,
    url: result.invitation.url,
  });
  await recordAudit("professional.invited", {
    actorUserId: user.id,
    detail: {
      professional_id: Number(result.professional.id),
      professional_user_id: Number(result.account.id),
      email: result.professional.email,
      email_sent: delivery.sent,
    },
  });
  sendJson(response, 201, {
    professional: await getProfessionalMapped(result.professional.id),
    invitation_sent: delivery.sent,
  });
};

const resendProfessionalInvitation = async (response, user, id) => {
  const professional = await one(
    `
      SELECT id, name, email
      FROM professionals
      WHERE id = $1 AND deleted_at IS NULL
    `,
    [id],
  );
  if (!professional) {
    sendJson(response, 404, { error: "Profesional no encontrado." });
    return;
  }
  const activeAccount = await one(
    "SELECT id FROM users WHERE professional_id = $1 AND is_active = TRUE",
    [id],
  );
  if (activeAccount) {
    sendJson(response, 409, { error: "La cuenta profesional ya está activa." });
    return;
  }
  const result = await prepareProfessionalInvitation({
    professional,
    actorUserId: user.id,
  });
  const delivery = await sendProfessionalInvitation({
    invitationId: result.invitation.id,
    professionalId: Number(professional.id),
    name: professional.name,
    email: professional.email,
    url: result.invitation.url,
  });
  await recordAudit("professional.invitation.resent", {
    actorUserId: user.id,
    detail: { professional_id: id, email: professional.email, email_sent: delivery.sent },
  });
  sendJson(response, 200, {
    professional: await getProfessionalMapped(id),
    invitation_sent: delivery.sent,
  });
};

const updateProfessional = async (request, response, user, id) => {
  const current = await getProfessionalMapped(id);
  if (!current) {
    sendJson(response, 404, { error: "Profesional no encontrado." });
    return;
  }

  const payload = await professionalPayloadFromMultipart(request);
  const password = validateProfessionalPassword(payload.fields.password, {
    required: !current.has_user && !current.invitation_pending,
  });
  const passwordHash = password ? await hashPassword(password) : null;
  const pendingPasswordHash =
    current.invitation_pending && !passwordHash
      ? await hashPassword(randomBytes(48).toString("base64url"))
      : null;
  const photoPath = await saveProfessionalPhoto(payload.files.photo);
  const account = await tx(async (client) => {
    await client.query(
      `
        UPDATE professionals
        SET name = $1,
            email = $2,
            photo_path = $3,
            active = $4,
            license_number = $5,
            specialty = $6,
            bio = $7,
            phone = $8,
            updated_at = NOW()
        WHERE id = $9
      `,
      [
        payload.fields.name,
        payload.fields.email,
        payload.fields.remove_photo ? null : photoPath || current.photo_path || null,
        payload.fields.active,
        payload.fields.licenseNumber,
        payload.fields.specialty,
        payload.fields.bio,
        payload.fields.phone,
        id,
      ],
    );
    await replaceProfessionalRelations(
      client,
      id,
      payload.fields.serviceIds,
      payload.fields.agreementIds,
      payload.fields.availability,
    );
    if (current.invitation_pending && !passwordHash) {
      const pendingAccount = await createPendingProfessionalUser(client, {
        professionalId: id,
        name: payload.fields.name,
        email: payload.fields.email,
        passwordHash: pendingPasswordHash,
      });
      await client.query(
        `
          UPDATE professional_invitations
          SET email = $1, updated_at = NOW()
          WHERE professional_id = $2
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        `,
        [payload.fields.email, id],
      );
      return { user: pendingAccount, action: "invitation_pending" };
    }
    const syncedAccount = await syncProfessionalUser(client, {
      professionalId: id,
      name: payload.fields.name,
      email: payload.fields.email,
      passwordHash,
    });
    if (current.invitation_pending) {
      await client.query(
        `
          UPDATE professional_invitations
          SET revoked_at = NOW(), updated_at = NOW()
          WHERE professional_id = $1
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        `,
        [id],
      );
    }
    return syncedAccount;
  });
  await recordAudit("professional.updated", {
    actorUserId: user.id,
    detail: {
      professional_id: id,
      professional_user_id: Number(account.user.id),
      account_action: account.action,
    },
  });
  sendJson(response, 200, { professional: await getProfessionalMapped(id) });
};

const deleteProfessional = async (response, user, id) => {
  await query(
    "UPDATE professionals SET active = FALSE, deleted_at = NOW(), updated_at = NOW() WHERE id = $1",
    [id],
  );
  await recordAudit("professional.deleted", {
    actorUserId: user.id,
    detail: { professional_id: id },
  });
  sendJson(response, 200, { ok: true });
};

const mapScheduleBlock = (row) => ({
  id: Number(row.id),
  professional_id: Number(row.professional_id),
  professional_name: row.professional_name || "",
  block_date: row.block_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  reason: row.reason || "",
  created_at: row.created_at,
});

const listScheduleBlocks = async (response) => {
  const result = await query(`
    SELECT
      b.*,
      p.name AS professional_name,
      to_char(b.block_date, 'YYYY-MM-DD') AS block_date,
      to_char(b.start_time, 'HH24:MI') AS start_time,
      to_char(b.end_time, 'HH24:MI') AS end_time
    FROM schedule_blocks b
    INNER JOIN professionals p ON p.id = b.professional_id
    WHERE p.deleted_at IS NULL
    ORDER BY b.block_date DESC, b.start_time DESC
    LIMIT 500
  `);
  sendJson(response, 200, { schedule_blocks: result.rows.map(mapScheduleBlock) });
};

const createScheduleBlock = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const professionalId = parsePositiveInteger(payload.professional_id);
  const blockDate = validateDate(payload.block_date);
  const startTime = normalizeTime(payload.start_time);
  const endTime = normalizeTime(payload.end_time);
  const reason = String(payload.reason || "").trim();
  assertTimeRange(startTime, endTime);

  const result = await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [professionalId, blockDate],
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
        LIMIT 1
      `,
      [professionalId, blockDate, startTime, endTime],
    );
    if (conflict.rows[0]) return null;
    const existingBlock = await client.query(
      `
        SELECT id
        FROM schedule_blocks
        WHERE professional_id = $1
          AND block_date = $2::date
          AND start_time < $4::time
          AND end_time > $3::time
        LIMIT 1
      `,
      [professionalId, blockDate, startTime, endTime],
    );
    if (existingBlock.rows[0]) return null;
    const inserted = await client.query(
      `
        INSERT INTO schedule_blocks
          (professional_id, block_date, start_time, end_time, reason)
        VALUES ($1, $2::date, $3::time, $4::time, $5)
        RETURNING id
      `,
      [professionalId, blockDate, startTime, endTime, reason || null],
    );
    return inserted.rows[0];
  });
  if (!result) {
    sendJson(response, 409, {
      error: "Ese bloqueo se superpone con un turno u otro bloqueo existente.",
    });
    return;
  }
  await recordAudit("schedule_block.created", {
    actorUserId: user.id,
    detail: { schedule_block_id: result.id, professional_id: professionalId },
  });
  sendJson(response, 201, { ok: true, id: Number(result.id) });
};

const deleteScheduleBlock = async (response, user, id) => {
  await query("DELETE FROM schedule_blocks WHERE id = $1", [id]);
  await recordAudit("schedule_block.deleted", {
    actorUserId: user.id,
    detail: { schedule_block_id: id },
  });
  sendJson(response, 200, { ok: true });
};

const mapAppointment = (row) => ({
  id: Number(row.id),
  booking_access_link_id: row.booking_access_link_id
    ? Number(row.booking_access_link_id)
    : null,
  patient_intake_id: row.patient_intake_id ? Number(row.patient_intake_id) : null,
  service_id: Number(row.service_id),
  professional_id: Number(row.professional_id),
  service_name: row.service_name || "",
  professional_name: row.professional_name || "",
  agreement_id: row.agreement_id ? Number(row.agreement_id) : null,
  agreement_name: row.agreement_name || "",
  agreement_slug: row.agreement_slug || "",
  agreement_type: row.agreement_type || "",
  appointment_date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  patient_name: row.patient_name || "",
  patient_email: row.patient_email || row.intake_email || "",
  patient_phone: row.patient_phone || row.intake_phone || "",
  identificador: row.identificador || "",
  amount: Number(row.amount || 0),
  payment_status: row.payment_status,
  payment_provider: row.payment_provider || "",
  payment_reference: row.payment_reference || "",
  booking_channel: row.booking_channel || "web",
  agreement_api_external_id: row.agreement_api_external_id || "",
  agreement_api_public_id: row.agreement_api_public_id || "",
  status: row.status,
  cancelled_at: row.cancelled_at || null,
  cancellation_reason: row.cancellation_reason || "",
  refund_status: row.refund_status || "not_required",
  refund_id: row.refund_id || "",
  refund_amount: Number(row.refund_amount || 0),
  refund_error: row.refund_error || "",
  google_meet_url: row.google_meet_url || "",
  google_sync_status: row.google_sync_status || "not_connected",
  google_sync_error: row.google_sync_error || "",
  triage_status: row.triage_url
    ? "assigned"
    : row.triage_assignment_error
      ? "failed"
      : "pending",
  is_future: Boolean(row.is_future),
  reservation_active: Boolean(row.reservation_active),
  reschedule_count: Number(row.reschedule_count || 0),
  documents: (row.documents || []).map(mapAdminAppointmentDocument),
  created_at: row.created_at,
});

const listAppointments = async (response) => {
  const result = await query(`
    SELECT
      a.*,
      s.name AS service_name,
      p.name AS professional_name,
      pi.identificador,
      pi.email AS intake_email,
      pi.telefono AS intake_phone,
      COALESCE(NULLIF(a.agreement_name_snapshot, ''), pi.agreement_name_snapshot, ag.name, '') AS agreement_name,
      COALESCE(NULLIF(a.agreement_slug_snapshot, ''), pi.agreement_slug_snapshot, ag.slug, '') AS agreement_slug,
      COALESCE(NULLIF(a.agreement_type_snapshot, ''), pi.agreement_type_snapshot, ag.type, '') AS agreement_type,
      (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', document.id,
              'kind', document.kind,
              'original_name', document.original_name,
              'mime_type', document.mime_type,
              'size_bytes', document.size_bytes,
              'external_url', document.external_url,
              'created_at', document.created_at
            )
            ORDER BY document.created_at, document.id
          ),
          '[]'::jsonb
        )
        FROM appointment_documents document
        WHERE document.appointment_id = a.id
      ) AS documents,
      ((a.appointment_date + a.start_time) AT TIME ZONE $1) > NOW() AS is_future,
      (a.status <> 'pending_payment' OR a.created_at > NOW() - INTERVAL '40 minutes') AS reservation_active,
      to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
      to_char(a.start_time, 'HH24:MI') AS start_time,
      to_char(a.end_time, 'HH24:MI') AS end_time
    FROM appointments a
    INNER JOIN services s ON s.id = a.service_id
    INNER JOIN professionals p ON p.id = a.professional_id
    LEFT JOIN patient_intakes pi ON pi.id = a.patient_intake_id
    LEFT JOIN agreements ag ON ag.id = COALESCE(a.agreement_id, pi.agreement_id)
    ORDER BY a.appointment_date DESC, a.start_time DESC
    LIMIT 500
  `, [config.googleCalendarTimeZone]);
  sendJson(response, 200, { appointments: result.rows.map(mapAppointment) });
};

export const adminAppointmentCapabilities = (appointment) => {
  const status = String(appointment?.status || "");
  const active =
    status === "confirmed" ||
    (status === "pending_payment" && appointment?.reservation_active !== false);
  const future = Boolean(appointment?.is_future);
  return {
    can_edit: active && future,
    can_cancel: active && future,
  };
};

const appointmentManagementError = (message, statusCode = 409) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const loadAppointmentForManagement = async (appointmentId, client = null) => {
  const executor = client || { query };
  const result = await executor.query(
    `
      SELECT
        appointment.*,
        to_char(appointment.appointment_date, 'YYYY-MM-DD') AS appointment_date_text,
        to_char(appointment.start_time, 'HH24:MI') AS start_time_text,
        to_char(appointment.end_time, 'HH24:MI') AS end_time_text,
        ((appointment.appointment_date + appointment.start_time) AT TIME ZONE $2) > NOW() AS is_future,
        (appointment.status <> 'pending_payment' OR appointment.created_at > NOW() - INTERVAL '40 minutes') AS reservation_active,
        service.name AS service_name,
        service.duration_minutes,
        professional.name AS professional_name,
        professional.email AS professional_email
      FROM appointments appointment
      INNER JOIN services service ON service.id = appointment.service_id
      INNER JOIN professionals professional ON professional.id = appointment.professional_id
      WHERE appointment.id = $1
      ${client ? "FOR UPDATE OF appointment" : ""}
    `,
    [appointmentId, config.googleCalendarTimeZone],
  );
  return result.rows[0] || null;
};

const requireEditableAdminAppointment = (appointment) => {
  if (!appointment) throw appointmentManagementError("ADMIN_APPOINTMENT_NOT_FOUND", 404);
  if (!adminAppointmentCapabilities(appointment).can_edit) {
    throw appointmentManagementError("ADMIN_APPOINTMENT_EDIT_NOT_ALLOWED");
  }
};

const listAdminAppointmentSlots = async (url, response, appointmentId) => {
  const appointment = await loadAppointmentForManagement(appointmentId);
  requireEditableAdminAppointment(appointment);
  const professionalId = parsePositiveInteger(url.searchParams.get("professional_id"));
  const appointmentDate = validateDate(url.searchParams.get("date"));
  const { slots } = await computeSlots({
    serviceId: Number(appointment.service_id),
    professionalId,
    date: appointmentDate,
    excludeAppointmentId: appointmentId,
    minimumNoticeMinutes: 0,
    agreementId: appointment.agreement_id ? Number(appointment.agreement_id) : null,
    selectionValidated: professionalId === Number(appointment.professional_id),
  });
  if (
    professionalId === Number(appointment.professional_id) &&
    appointmentDate === appointment.appointment_date_text &&
    !slots.includes(appointment.start_time_text)
  ) {
    slots.push(appointment.start_time_text);
    slots.sort();
  }
  sendJson(response, 200, {
    slots,
    duration_minutes: Number(appointment.duration_minutes),
  });
};

const updateAdminAppointment = async (request, response, user, appointmentId) => {
  const payload = await parseJsonBody(request);
  const professionalId = parsePositiveInteger(payload.professional_id);
  const appointmentDate = validateDate(payload.appointment_date);
  const startTime = normalizeTime(payload.start_time);
  const initial = await loadAppointmentForManagement(appointmentId);
  requireEditableAdminAppointment(initial);
  if (
    professionalId === Number(initial.professional_id) &&
    appointmentDate === initial.appointment_date_text &&
    startTime === initial.start_time_text
  ) {
    throw appointmentManagementError("ADMIN_APPOINTMENT_UNCHANGED", 422);
  }

  const { service, slots } = await computeSlots({
    serviceId: Number(initial.service_id),
    professionalId,
    date: appointmentDate,
    excludeAppointmentId: appointmentId,
    minimumNoticeMinutes: 0,
    agreementId: initial.agreement_id ? Number(initial.agreement_id) : null,
    selectionValidated: professionalId === Number(initial.professional_id),
  });
  if (!slots.includes(startTime)) {
    throw appointmentManagementError("ADMIN_APPOINTMENT_SLOT_TAKEN");
  }
  const endTime = addMinutes(startTime, Number(service.duration_minutes));

  const previous = await tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [professionalId, appointmentDate],
    );
    const current = await loadAppointmentForManagement(appointmentId, client);
    requireEditableAdminAppointment(current);
    if (
      professionalId === Number(current.professional_id) &&
      appointmentDate === current.appointment_date_text &&
      startTime === current.start_time_text
    ) {
      throw appointmentManagementError("ADMIN_APPOINTMENT_UNCHANGED", 422);
    }
    const eligible = await client.query(
      `
        SELECT 1
        FROM professional_services relation
        INNER JOIN professionals professional ON professional.id = relation.professional_id
        WHERE relation.professional_id = $1
          AND relation.service_id = $2
          AND professional.active = TRUE
          AND professional.deleted_at IS NULL
          AND (
            relation.professional_id = $4
            OR $5::bigint IS NULL
            OR EXISTS (
              SELECT 1
              FROM professional_agreements professional_agreement
              WHERE professional_agreement.professional_id = professional.id
                AND professional_agreement.agreement_id = $5
            )
          )
          AND (
            $3::boolean = FALSE
            OR EXISTS (
              SELECT 1
              FROM professional_google_connections connection
              WHERE connection.professional_id = professional.id
                AND connection.status IN ('active', 'error')
            )
          )
      `,
      [
        professionalId,
        current.service_id,
        config.googleCalendarRequired,
        current.professional_id,
        current.agreement_id,
      ],
    );
    if (!eligible.rows[0]) {
      throw appointmentManagementError("ADMIN_APPOINTMENT_PROFESSIONAL_INVALID", 422);
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
      [professionalId, appointmentDate, appointmentId, startTime, endTime],
    );
    const block = await client.query(
      `
        SELECT id
        FROM schedule_blocks
        WHERE professional_id = $1
          AND block_date = $2::date
          AND start_time < $4::time
          AND end_time > $3::time
        FOR UPDATE
      `,
      [professionalId, appointmentDate, startTime, endTime],
    );
    if (conflict.rows[0] || block.rows[0]) {
      throw appointmentManagementError("ADMIN_APPOINTMENT_SLOT_TAKEN");
    }
    const professionalChanged = professionalId !== Number(current.professional_id);
    await client.query(
      `
        UPDATE appointments
        SET professional_id = $2,
            appointment_date = $3::date,
            start_time = $4::time,
            end_time = $5::time,
            rescheduled_at = NOW(),
            reschedule_count = reschedule_count + 1,
            patient_notified_at = NULL,
            patient_notification_message_id = NULL,
            patient_notification_error = NULL,
            professional_notified_at = NULL,
            professional_notification_message_id = NULL,
            professional_notification_error = NULL,
            pending_payment_notified_at = NULL,
            pending_payment_notification_message_id = NULL,
            pending_payment_notification_error = NULL,
            patient_followup_notified_at = NULL,
            patient_followup_notification_message_id = NULL,
            patient_followup_notification_error = NULL,
            professional_followup_notified_at = NULL,
            professional_followup_notification_message_id = NULL,
            professional_followup_notification_error = NULL,
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
            google_calendar_event_id = CASE WHEN $6 THEN NULL ELSE google_calendar_event_id END,
            google_calendar_event_url = CASE WHEN $6 THEN NULL ELSE google_calendar_event_url END,
            google_meet_url = CASE WHEN $6 THEN NULL ELSE google_meet_url END,
            google_sync_status = CASE WHEN $6 THEN 'not_connected' ELSE google_sync_status END,
            google_sync_error = CASE WHEN $6 THEN '' ELSE google_sync_error END,
            google_synced_at = CASE WHEN $6 THEN NULL ELSE google_synced_at END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [appointmentId, professionalId, appointmentDate, startTime, endTime, professionalChanged],
    );
    return current;
  });

  const professionalChanged = professionalId !== Number(previous.professional_id);
  const oldCalendar = professionalChanged
    ? await cancelGoogleCalendarEventForProfessional({
        professionalId: Number(previous.professional_id),
        eventId: previous.google_calendar_event_id,
      })
    : { skipped: true, reason: "same_professional" };
  let notification;
  let googleCalendar;
  if (previous.status === "confirmed") {
    notification = await notifyConfirmedAppointment(appointmentId, {
      forceGoogleSync: true,
    });
    googleCalendar = notification.google_calendar;
  } else {
    try {
      googleCalendar = await holdAppointmentOnGoogleCalendar(appointmentId);
    } catch (error) {
      googleCalendar = { ok: false, error: error.message };
    }
    notification = await notifyPatientForPendingPayment(appointmentId);
  }

  await recordAudit("admin.appointment.updated", {
    actorUserId: user.id,
    detail: {
      appointment_id: appointmentId,
      previous_professional_id: Number(previous.professional_id),
      professional_id: professionalId,
      previous_date: previous.appointment_date_text,
      appointment_date: appointmentDate,
      previous_start_time: previous.start_time_text,
      start_time: startTime,
      previous_google_event_id: previous.google_calendar_event_id || "",
      old_calendar_removed:
        oldCalendar.skipped === true || oldCalendar.ok === true,
      patient_notified: Boolean(
        previous.status === "confirmed"
          ? notification.patient?.ok
          : notification.ok,
      ),
    },
  });
  const warnings = [];
  if (professionalChanged && oldCalendar.skipped !== true && oldCalendar.ok !== true) {
    warnings.push("No se pudo quitar el evento del Calendar anterior.");
  }
  if (googleCalendar?.ok === false || googleCalendar?.status === "pending") {
    warnings.push("La actualización de Google Calendar quedó pendiente.");
  }
  const patientNotification =
    previous.status === "confirmed" ? notification.patient : notification;
  if (patientNotification?.ok !== true || patientNotification?.skipped === true) {
    warnings.push("El mail al paciente quedó pendiente de envío.");
  }
  sendJson(response, 200, {
    ok: true,
    message: warnings.length
      ? "Turno actualizado."
      : "Turno actualizado y notificado por mail.",
    warnings,
  });
};

const cancelAdminAppointment = async (request, response, user, appointmentId) => {
  const payload = await parseJsonBody(request);
  const reason = String(payload.reason || "").trim().slice(0, 500);
  if (!reason) throw appointmentManagementError("ADMIN_APPOINTMENT_REASON_REQUIRED", 422);

  const appointment = await tx(async (client) => {
    const current = await loadAppointmentForManagement(appointmentId, client);
    if (!current) throw appointmentManagementError("ADMIN_APPOINTMENT_NOT_FOUND", 404);
    if (!adminAppointmentCapabilities(current).can_cancel) {
      throw appointmentManagementError("ADMIN_APPOINTMENT_CANCEL_NOT_ALLOWED");
    }
    const paidWithMercadoPago =
      current.payment_status === "approved" &&
      current.payment_provider === "mercadopago";
    const refundStatus = paidWithMercadoPago
      ? "pending"
      : current.booking_channel === "agreement_api"
        ? "external_management"
        : "not_required";
    const updated = await client.query(
      `
        UPDATE appointments
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancelled_by_user_id = $2,
            cancellation_reason = $3,
            refund_status = $4,
            refund_error = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [appointmentId, user.id, reason, refundStatus],
    );
    return updated.rows[0];
  });

  let refundStatus = appointment.refund_status || "not_required";
  let refundError = "";
  if (refundStatus === "pending") {
    if (!appointment.payment_id) {
      refundStatus = "failed";
      refundError = "El pago aprobado no tiene un identificador para reembolsar.";
    } else {
      try {
        const refund = await createMercadoPagoFullRefund({
          appointmentId,
          paymentId: appointment.payment_id,
        });
        refundStatus = "approved";
        await query(
          `
            UPDATE appointments
            SET refund_status = 'approved',
                refund_id = $2,
                refund_amount = $3,
                refund_error = NULL,
                payment_status = 'refunded',
                updated_at = NOW()
            WHERE id = $1
          `,
          [appointmentId, refund.id || null, refund.amount || Number(appointment.amount || 0)],
        );
      } catch (error) {
        refundStatus = "failed";
        refundError = String(error.message || "No se pudo solicitar el reembolso.").slice(0, 500);
      }
    }
    if (refundStatus === "failed") {
      await query(
        `
          UPDATE appointments
          SET refund_status = 'failed', refund_error = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [appointmentId, refundError],
      );
    }
  }

  const [googleCalendar, notification] = await Promise.all([
    cancelGoogleCalendarAppointment(appointmentId),
    notifyPatientForCancellation(appointmentId),
  ]);
  await recordAudit("admin.appointment.cancelled", {
    actorUserId: user.id,
    detail: {
      appointment_id: appointmentId,
      refund_status: refundStatus,
      patient_notified: Boolean(notification.ok),
      google_calendar_cancelled:
        googleCalendar.reason === "not_synced" || Boolean(googleCalendar.ok),
    },
  });
  sendJson(response, 200, {
    ok: true,
    message:
      refundStatus === "approved"
        ? "Turno cancelado y reembolso solicitado correctamente."
        : refundStatus === "failed"
          ? "Turno cancelado. El reembolso requiere revisión."
          : "Turno cancelado.",
    refund_status: refundStatus,
    refund_error: refundError,
    notification,
    google_calendar: googleCalendar,
  });
};

const dashboard = async (response) => {
  const result = await query(`
    SELECT
      (
        (SELECT COUNT(*)::int FROM contacts)
        + (SELECT COUNT(*)::int FROM congreso_cokiba_registrations)
      ) AS contacts,
      (SELECT COUNT(*)::int FROM patients WHERE active = TRUE) AS patients,
      (SELECT COUNT(*)::int FROM patient_intakes) AS patient_intakes,
      (SELECT COUNT(*)::int FROM appointments WHERE payment_status IN ('approved', 'nomina', 'agreement_api_paid')) AS appointments_confirmed,
      (SELECT COUNT(*)::int FROM appointments WHERE payment_status = 'pending') AS appointments_pending,
      (SELECT COALESCE(SUM(amount), 0)::numeric
       FROM appointments
       WHERE payment_status IN ('approved', 'paid_simulated', 'free', 'agreement_api_paid')) AS revenue,
      (SELECT COUNT(*)::int FROM services WHERE deleted_at IS NULL AND active = TRUE) AS services,
      (SELECT COUNT(*)::int FROM professionals WHERE deleted_at IS NULL AND active = TRUE) AS professionals,
      (SELECT COUNT(*)::int FROM schedule_blocks WHERE block_date >= CURRENT_DATE) AS upcoming_blocks
  `);
  sendJson(response, 200, {
    dashboard: {
      contacts: Number(result.rows[0].contacts || 0),
      patients: Number(result.rows[0].patients || 0),
      patient_intakes: Number(result.rows[0].patient_intakes || 0),
      appointments: Number(result.rows[0].appointments_confirmed || 0),
      appointments_confirmed: Number(result.rows[0].appointments_confirmed || 0),
      appointments_pending: Number(result.rows[0].appointments_pending || 0),
      revenue: Number(result.rows[0].revenue || 0),
      services: Number(result.rows[0].services || 0),
      professionals: Number(result.rows[0].professionals || 0),
      upcoming_blocks: Number(result.rows[0].upcoming_blocks || 0),
    },
  });
};

const getMercadoPagoSettings = async (response, user) => {
  const row = await one("SELECT value FROM app_settings WHERE key = 'mercado_pago'");
  sendJson(response, 200, { settings: publicMercadoPagoSettings(row?.value || {}) });
};

const updateMercadoPagoSettings = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const current = await one("SELECT value FROM app_settings WHERE key = 'mercado_pago'");
  const value = mergeMercadoPagoSettingsPayload(current?.value || {}, payload);
  await query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('mercado_pago', $1::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [JSON.stringify(value)],
  );
  await recordAudit("settings.mercado_pago.updated", { actorUserId: user.id });
  sendJson(response, 200, {
    ok: true,
    settings: publicMercadoPagoSettings(value),
  });
};

const listAuditEvents = async (response, user) => {
  const result = await query(`
    SELECT
      e.id,
      e.event_type,
      e.detail,
      e.created_at,
      u.email AS actor_email
    FROM audit_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    ORDER BY e.created_at DESC
    LIMIT 150
  `);
  sendJson(response, 200, {
    audit_events: result.rows.map((row) => ({
      id: Number(row.id),
      event_type: row.event_type,
      actor_email: row.actor_email || "Sistema",
      detail: row.detail || {},
      created_at: row.created_at,
    })),
  });
};

const createTestBookingLink = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const agreementId = parsePositiveInteger(payload.agreement_id);
  const agreement = await getAgreementById(agreementId);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return;
  }
  const link = await createBookingAccessLink({
    label: `Prueba admin ${agreement.slug} ${user.email}`,
    patientName: user.name || user.email,
    patientEmail: user.email,
    agreementId: agreement.id,
    agreementName: agreement.name,
    agreementSlug: agreement.slug,
    agreementSubdomainPrefix: agreement.subdomain_prefix || "",
    agreementType: agreement.type,
    ttlHours: 48,
  });
  await recordAudit("booking_link.test_created", {
    actorUserId: user.id,
    detail: { booking_access_link_id: link.id, agreement_id: agreement.id },
  });
  sendJson(response, 201, {
    booking_url: link.url,
    expires_at: link.expires_at,
  });
};

export const handlePublicAgreementApi = async (request, response, url) => {
  const slug = decodeURIComponent(url.pathname.replace("/api/public/agreements/", ""));
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) {
    sendJson(response, 404, { error: "Acuerdo no encontrado." });
    return true;
  }
  sendJson(response, 200, {
    agreement: {
      id: agreement.id,
      name: agreement.name,
      slug: agreement.slug,
      subdomain_prefix: agreement.subdomain_prefix || "",
      cobranded: agreement.cobranded,
      type: agreement.type,
      logo_url: agreement.cobranded ? agreement.logo_url : "",
      pdf_url: agreement.pdf_url,
    },
  });
  return true;
};

export const validatePublicAgreementRoute = async (request, url, response) => {
  if (!requestIdentifiesAgreement(request, url)) return true;
  const agreement = await resolveAgreementForRequest(request, url);
  if (agreement) return true;
  sendJson(response, 404, { error: "Acuerdo no encontrado." });
  return false;
};

export const handleAdminApi = async (request, response, url) => {
  const pathname = url.pathname;

  try {
    if (pathname === "/api/admin/auth/login" && request.method === "POST") {
      await handleLogin(request, response);
      return true;
    }

    const { user, session } = await requireCurrentUser(request);
    requireCsrfForMutation(request, session);
    requireAdminApiPermission(user, request.method, pathname);

    if (pathname === "/api/admin/auth/me" && request.method === "GET") {
      await handleMe(request, response);
      return true;
    }
    if (pathname === "/api/admin/auth/logout" && request.method === "POST") {
      await handleLogout(request, response);
      return true;
    }
    if (
      pathname === "/api/admin/auth/change-password" &&
      request.method === "POST"
    ) {
      await handleChangePassword(request, response);
      return true;
    }

    if (pathname === "/api/admin/users" && request.method === "GET") {
      await listUsers(response);
      return true;
    }
    if (pathname === "/api/admin/users" && request.method === "POST") {
      await createUser(request, response, user);
      return true;
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (userMatch && request.method === "DELETE") {
      await deleteUser(response, user, Number(userMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/dashboard" && request.method === "GET") {
      await dashboard(response);
      return true;
    }

    if (pathname === "/api/admin/agreements" && request.method === "GET") {
      await listAgreements(response);
      return true;
    }
    if (pathname === "/api/admin/agreements" && request.method === "POST") {
      await createAgreement(request, response, user);
      return true;
    }

    const agreementQrMatch = pathname.match(/^\/api\/admin\/agreements\/(\d+)\/qr$/);
    if (agreementQrMatch && request.method === "GET") {
      await downloadAgreementQr(response, Number(agreementQrMatch[1]));
      return true;
    }

    const agreementApiCredentialsMatch = pathname.match(
      /^\/api\/admin\/agreements\/(\d+)\/api-credentials$/,
    );
    if (agreementApiCredentialsMatch && request.method === "GET") {
      await listAdminAgreementApiCredentials(
        response,
        Number(agreementApiCredentialsMatch[1]),
      );
      return true;
    }
    if (agreementApiCredentialsMatch && request.method === "POST") {
      await createAdminAgreementApiCredential(
        request,
        response,
        user,
        Number(agreementApiCredentialsMatch[1]),
      );
      return true;
    }
    const agreementApiCredentialRevokeMatch = pathname.match(
      /^\/api\/admin\/agreements\/(\d+)\/api-credentials\/(\d+)\/revoke$/,
    );
    if (agreementApiCredentialRevokeMatch && request.method === "POST") {
      await revokeAdminAgreementApiCredential(
        response,
        user,
        Number(agreementApiCredentialRevokeMatch[1]),
        Number(agreementApiCredentialRevokeMatch[2]),
      );
      return true;
    }

    const agreementMatch = pathname.match(/^\/api\/admin\/agreements\/(\d+)$/);
    if (agreementMatch && request.method === "PUT") {
      await updateAgreement(request, response, user, Number(agreementMatch[1]));
      return true;
    }
    if (agreementMatch && request.method === "DELETE") {
      await deleteAgreement(response, user, Number(agreementMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/services" && request.method === "GET") {
      await listServices(response);
      return true;
    }
    if (pathname === "/api/admin/services" && request.method === "POST") {
      await createService(request, response, user);
      return true;
    }
    const serviceMatch = pathname.match(/^\/api\/admin\/services\/(\d+)$/);
    if (serviceMatch && request.method === "PUT") {
      await updateService(request, response, user, Number(serviceMatch[1]));
      return true;
    }
    if (serviceMatch && request.method === "DELETE") {
      await deleteService(response, user, Number(serviceMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/professionals" && request.method === "GET") {
      await listProfessionals(response);
      return true;
    }
    if (pathname === "/api/admin/professionals" && request.method === "POST") {
      await createProfessional(request, response, user);
      return true;
    }
    if (pathname === "/api/admin/professionals/invite" && request.method === "POST") {
      await inviteProfessional(request, response, user);
      return true;
    }
    const professionalMatch = pathname.match(/^\/api\/admin\/professionals\/(\d+)$/);
    if (professionalMatch && request.method === "PUT") {
      await updateProfessional(request, response, user, Number(professionalMatch[1]));
      return true;
    }
    if (professionalMatch && request.method === "DELETE") {
      await deleteProfessional(response, user, Number(professionalMatch[1]));
      return true;
    }
    const professionalRevokeMatch = pathname.match(
      /^\/api\/admin\/professionals\/(\d+)\/revoke-access$/,
    );
    const professionalInviteMatch = pathname.match(
      /^\/api\/admin\/professionals\/(\d+)\/invite$/,
    );
    if (professionalInviteMatch && request.method === "POST") {
      await resendProfessionalInvitation(
        response,
        user,
        Number(professionalInviteMatch[1]),
      );
      return true;
    }
    if (professionalRevokeMatch && request.method === "POST") {
      await revokeProfessionalLinksAndSessions(
        response,
        user,
        Number(professionalRevokeMatch[1]),
      );
      return true;
    }

    if (pathname === "/api/admin/schedule-blocks" && request.method === "GET") {
      await listScheduleBlocks(response);
      return true;
    }
    if (pathname === "/api/admin/schedule-blocks" && request.method === "POST") {
      await createScheduleBlock(request, response, user);
      return true;
    }
    const scheduleBlockMatch = pathname.match(/^\/api\/admin\/schedule-blocks\/(\d+)$/);
    if (scheduleBlockMatch && request.method === "DELETE") {
      await deleteScheduleBlock(response, user, Number(scheduleBlockMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/appointments" && request.method === "GET") {
      await listAppointments(response);
      return true;
    }

    if (pathname === "/api/admin/settlements/preview" && request.method === "GET") {
      await previewAdminAgreementSettlement(url, response);
      return true;
    }
    if (pathname === "/api/admin/settlements" && request.method === "POST") {
      await generateAdminAgreementSettlement(request, response, user);
      return true;
    }
    const settlementPdfMatch = pathname.match(
      /^\/api\/admin\/settlements\/(\d+)\/pdf$/,
    );
    if (settlementPdfMatch && request.method === "GET") {
      await streamAgreementSettlementPdf(response, Number(settlementPdfMatch[1]));
      return true;
    }
    const appointmentDocumentMatch = pathname.match(
      /^\/api\/admin\/appointment-documents\/(\d+)$/,
    );
    if (
      appointmentDocumentMatch &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      await streamAdminAppointmentDocument(
        request,
        response,
        Number(appointmentDocumentMatch[1]),
        user,
      );
      return true;
    }
    const appointmentSlotsMatch = pathname.match(
      /^\/api\/admin\/appointments\/(\d+)\/slots$/,
    );
    if (appointmentSlotsMatch && request.method === "GET") {
      await listAdminAppointmentSlots(
        url,
        response,
        Number(appointmentSlotsMatch[1]),
      );
      return true;
    }
    const appointmentCancelMatch = pathname.match(
      /^\/api\/admin\/appointments\/(\d+)\/cancel$/,
    );
    if (appointmentCancelMatch && request.method === "POST") {
      await cancelAdminAppointment(
        request,
        response,
        user,
        Number(appointmentCancelMatch[1]),
      );
      return true;
    }
    const appointmentMatch = pathname.match(/^\/api\/admin\/appointments\/(\d+)$/);
    if (appointmentMatch && request.method === "PUT") {
      await updateAdminAppointment(
        request,
        response,
        user,
        Number(appointmentMatch[1]),
      );
      return true;
    }

    if (pathname === "/api/admin/booking-links/test" && request.method === "POST") {
      await createTestBookingLink(request, response, user);
      return true;
    }

    if (pathname === "/api/admin/settings/mercado-pago" && request.method === "GET") {
      await getMercadoPagoSettings(response, user);
      return true;
    }
    if (pathname === "/api/admin/settings/mercado-pago" && request.method === "PUT") {
      await updateMercadoPagoSettings(request, response, user);
      return true;
    }

    if (pathname === "/api/admin/audit" && request.method === "GET") {
      await listAuditEvents(response, user);
      return true;
    }

    if (pathname === "/api/admin/patient-intakes" && request.method === "GET") {
      await listPatientIntakes(url, response);
      return true;
    }
    const patientMatch = pathname.match(/^\/api\/admin\/patient-intakes\/(\d+)$/);
    if (patientMatch && request.method === "DELETE") {
      await deleteRecord(response, user, "patient_intakes", Number(patientMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/patients" && request.method === "GET") {
      await listPatients(url, response);
      return true;
    }
    const canonicalPatientMatch = pathname.match(/^\/api\/admin\/patients\/(\d+)$/);
    if (canonicalPatientMatch && request.method === "DELETE") {
      await deactivatePatient(response, user, Number(canonicalPatientMatch[1]));
      return true;
    }

    if (pathname === "/api/admin/contacts" && request.method === "GET") {
      await listContacts(response);
      return true;
    }
    const contactMatch = pathname.match(/^\/api\/admin\/contacts\/(\d+)$/);
    if (contactMatch && request.method === "DELETE") {
      await deleteRecord(response, user, "contacts", Number(contactMatch[1]));
      return true;
    }

    if (
      pathname === "/api/admin/congress-registrations" &&
      request.method === "GET"
    ) {
      await listCongressRegistrations(response);
      return true;
    }
    if (
      pathname === "/api/admin/congress-registrations.csv" &&
      request.method === "GET"
    ) {
      await downloadCongressRegistrationsCsv(response);
      return true;
    }
    const congressRegistrationMatch = pathname.match(
      /^\/api\/admin\/congress-registrations\/(\d+)$/,
    );
    if (congressRegistrationMatch && request.method === "DELETE") {
      await deleteRecord(
        response,
        user,
        "congreso_cokiba_registrations",
        Number(congressRegistrationMatch[1]),
      );
      return true;
    }

    if (pathname === "/api/admin/nomina" && request.method === "GET") {
      await listNomina(url, response);
      return true;
    }
    if (pathname === "/api/admin/nomina" && request.method === "POST") {
      await createNominaEntry(request, response, user);
      return true;
    }
    if (pathname === "/api/admin/nomina/import" && request.method === "POST") {
      await importNominaCsv(request, response, user);
      return true;
    }
    const nominaMatch = pathname.match(/^\/api\/admin\/nomina\/(\d+)$/);
    if (nominaMatch && request.method === "DELETE") {
      await deleteNominaEntry(response, user, Number(nominaMatch[1]));
      return true;
    }

    return false;
  } catch (error) {
    if (error.publicMessage) {
      sendJson(response, error.statusCode || 422, { error: error.publicMessage });
      return true;
    }
    if (error.code === "23505") {
      sendJson(response, 409, {
        error:
          error.constraint === "agreements_subdomain_prefix_active_key"
            ? "Ese prefijo de subdominio ya está asignado a otro acuerdo."
            : "Ya existe un registro con esos datos.",
      });
      return true;
    }
    if (error.message === "URL_INVALID") {
      sendJson(response, 422, { error: "Revisá los links: deben empezar con http o https." });
      return true;
    }
    if (error.message === "URL_REQUIRED") {
      sendJson(response, 422, { error: "El link de pago es obligatorio." });
      return true;
    }
    if (error.message === "NUMBER_INVALID") {
      sendJson(response, 422, { error: "Revisá los valores numéricos." });
      return true;
    }
    if (error.message === "MONEY_INVALID") {
      sendJson(response, 422, { error: "Ingresá un costo válido." });
      return true;
    }
    if (error.message === "DATE_INVALID") {
      sendJson(response, 422, { error: "Ingresá una fecha válida." });
      return true;
    }
    if (error.message === "TIME_INVALID" || error.message === "TIME_RANGE_INVALID") {
      sendJson(response, 422, { error: "Revisá los horarios cargados." });
      return true;
    }
    if (error.message === "SERVICE_NAME_REQUIRED") {
      sendJson(response, 422, { error: "El nombre del servicio es obligatorio." });
      return true;
    }
    if (error.message === "PROFESSIONAL_NAME_REQUIRED") {
      sendJson(response, 422, { error: "El nombre del profesional es obligatorio." });
      return true;
    }
    if (error.message === "PROFESSIONAL_EMAIL_INVALID") {
      sendJson(response, 422, { error: "Ingresá un mail válido para el profesional." });
      return true;
    }
    if (error.message === "PROFESSIONAL_SERVICE_REQUIRED") {
      sendJson(response, 422, { error: "Seleccioná al menos un servicio." });
      return true;
    }
    if (error.message === "PROFESSIONAL_AGREEMENT_REQUIRED") {
      sendJson(response, 422, { error: "Seleccioná al menos un acuerdo." });
      return true;
    }
    if (error.message === "PROFESSIONAL_AVAILABILITY_REQUIRED") {
      sendJson(response, 422, { error: "Cargá al menos un día y horario de atención." });
      return true;
    }
    if (error.message === "PROFESSIONAL_PASSWORD_REQUIRED") {
      sendJson(response, 422, {
        error: "Creá una clave de al menos 8 caracteres para la cuenta profesional.",
      });
      return true;
    }
    if (error.message === "PROFESSIONAL_PASSWORD_INVALID") {
      sendJson(response, 422, {
        error: "La clave de la cuenta profesional debe tener al menos 8 caracteres.",
      });
      return true;
    }
    if (error.message === "PROFESSIONAL_EMAIL_IN_USE") {
      sendJson(response, 409, {
        error: "Ese mail ya pertenece a otra cuenta. Usá un mail distinto.",
      });
      return true;
    }
    if (error.message === "ADMIN_APPOINTMENT_NOT_FOUND") {
      sendJson(response, 404, { error: "Turno no encontrado." });
      return true;
    }
    if (
      error.message === "ADMIN_APPOINTMENT_EDIT_NOT_ALLOWED" ||
      error.message === "ADMIN_APPOINTMENT_CANCEL_NOT_ALLOWED"
    ) {
      sendJson(response, 409, {
        error: "Solo se pueden editar o cancelar turnos futuros que sigan activos.",
      });
      return true;
    }
    if (error.message === "ADMIN_APPOINTMENT_UNCHANGED") {
      sendJson(response, 422, { error: "Elegí otro profesional, día u horario." });
      return true;
    }
    if (error.message === "ADMIN_APPOINTMENT_PROFESSIONAL_INVALID") {
      sendJson(response, 422, {
        error: "El profesional elegido no atiende la práctica de este turno.",
      });
      return true;
    }
    if (
      error.message === "ADMIN_APPOINTMENT_SLOT_TAKEN" ||
      error.message === "BOOKING_SLOT_TAKEN"
    ) {
      sendJson(response, 409, { error: "Ese horario ya no está disponible." });
      return true;
    }
    if (error.message === "BOOKING_SELECTION_INVALID") {
      sendJson(response, 422, {
        error: "El profesional elegido no está disponible para esa práctica.",
      });
      return true;
    }
    if (error.message === "BOOKING_DATE_INVALID") {
      sendJson(response, 422, { error: "Seleccioná una fecha válida." });
      return true;
    }
    if (error.message === "ADMIN_APPOINTMENT_REASON_REQUIRED") {
      sendJson(response, 422, { error: "Indicá el motivo de la cancelación." });
      return true;
    }
    if (
      error.message === "GOOGLE_REAUTH_REQUIRED" ||
      error.message === "GOOGLE_API_ERROR"
    ) {
      sendJson(response, 503, {
        error: "No se pudo validar la disponibilidad de Google Calendar.",
      });
      return true;
    }
    if (error.message === "SYSTEM_ADMIN_REQUIRED") {
      sendJson(response, 403, { error: "No tenés permisos para esta configuración." });
      return true;
    }
    if (error.message === "PERMISSION_DENIED") {
      sendJson(response, 403, { error: "No tenés permisos para realizar esta acción." });
      return true;
    }
    if (error.message === "SLUG_REQUIRED") {
      sendJson(response, 422, { error: "El slug no puede quedar vacío." });
      return true;
    }
    if (error.message === "AGREEMENT_SUBDOMAIN_REQUIRED") {
      sendJson(response, 422, { error: "Ingresá el prefijo del subdominio." });
      return true;
    }
    if (error.message === "AGREEMENT_SUBDOMAIN_INVALID") {
      sendJson(response, 422, {
        error:
          "El prefijo sólo puede usar letras minúsculas, números y guiones, sin comenzar ni terminar con guion.",
      });
      return true;
    }
    if (error.message === "AGREEMENT_SUBDOMAIN_RESERVED") {
      sendJson(response, 422, { error: "Ese prefijo está reservado. Elegí otro." });
      return true;
    }
    if (error.message === "COBRANDED_LOGO_REQUIRED") {
      sendJson(response, 422, {
        error: "Un acuerdo con cobranding debe tener un logo.",
      });
      return true;
    }
    if (error.message === "TEMPLATE_INVALID") {
      sendJson(response, 422, {
        error: "El template tiene errores.",
        errors: error.details || [],
      });
      return true;
    }
    if (error.message === "TEMPLATE_TEST_EMAIL_INVALID") {
      sendJson(response, 422, { error: "Ingresá un mail válido para enviar el test." });
      return true;
    }
    if (error.message === "NOMINA_AGREEMENT_REQUIRED") {
      sendJson(response, 422, { error: "Seleccioná un acuerdo de tipo Nómina." });
      return true;
    }
    if (error.message === "PAYLOAD_TOO_LARGE") {
      sendJson(response, 413, { error: "El archivo supera el tamaño permitido." });
      return true;
    }
    if (error.message === "INVALID_IMAGE") {
      sendJson(response, 415, { error: "El archivo debe ser una imagen válida." });
      return true;
    }
    if (error.message === "INVALID_PDF") {
      sendJson(response, 415, { error: "El archivo Cómo funciona debe ser PDF." });
      return true;
    }
    if (error.message === "INVALID_CSV" || error.message === "CSV_REQUIRED") {
      sendJson(response, 415, { error: "Subí un archivo CSV válido." });
      return true;
    }
    if (
      error.message === "SES_SEND_FAILED" ||
      error.message === "SES_CONFIGURATION_MISSING" ||
      error.message === "EMAIL_SEND_FAILED" ||
      error.message === "EMAIL_CONFIGURATION_MISSING"
    ) {
      sendJson(response, 502, { error: "No se pudo enviar el mail de test." });
      return true;
    }
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode === 401 ? "No autenticado." : "Error inesperado.",
    });
    return true;
  }
};
