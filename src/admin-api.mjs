import {
  getAgreementById,
  getAgreementBySlug,
  one,
  query,
  recordAudit,
  tx,
} from "./db.mjs";
import QRCode from "qrcode";
import { getClientIp, readBody, sendJson, withSecurityHeaders } from "./http.mjs";
import { parseNominaCsv } from "./csv.mjs";
import { sendEmail } from "./email.mjs";
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
  defaultPatientBody,
  defaultPatientSubject,
  buildPatientEmail,
  getTemplateErrors,
  renderTemplate,
  sampleTemplateContext,
} from "./templates.mjs";
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
  mergeMercadoPagoSettingsPayload,
  publicMercadoPagoSettings,
} from "./mercado-pago.mjs";

const canDeleteRecords = (user) => user?.email?.toLowerCase() === "ferpic@gmail.com";
const canManageSystem = canDeleteRecords;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

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
  if (!timePattern.test(trimmed)) {
    const error = new Error("TIME_INVALID");
    error.statusCode = 422;
    throw error;
  }
  return trimmed;
};

const validateDate = (value) => {
  const trimmed = String(value || "").trim();
  if (!datePattern.test(trimmed)) {
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

const assertTimeRange = (startTime, endTime) => {
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    const error = new Error("TIME_RANGE_INVALID");
    error.statusCode = 422;
    throw error;
  }
};

const normalizeAvailability = (value) =>
  parseJsonArray(value)
    .map((item) => ({
      day_of_week: parsePositiveInteger(item.day_of_week, { min: 1, max: 7 }),
      start_time: normalizeTime(item.start_time),
      end_time: normalizeTime(item.end_time),
    }))
    .map((item) => {
      assertTimeRange(item.start_time, item.end_time);
      return item;
    });

const requireSystemAdmin = (user) => {
  if (!canManageSystem(user)) {
    const error = new Error("SYSTEM_ADMIN_REQUIRED");
    error.statusCode = 403;
    throw error;
  }
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
      SELECT id, email, name, role, is_active, session_version
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
  can_delete_records: Boolean(user.can_delete_records),
  can_manage_system: Boolean(user.can_manage_system),
});

const handleLogin = async (request, response) => {
  const payload = await parseJsonBody(request);
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");

  enforceLoginRateLimit(getClientIp(request), email);

  const user = await one(
    `
      SELECT id, email, name, role, is_active, password_hash, session_version
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

const listAgreements = async (response) => {
  const result = await query(`
    SELECT
      a.*,
      COUNT(DISTINCT n.id)::int AS nomina_count,
      COUNT(DISTINCT p.id)::int AS intake_count
    FROM agreements a
    LEFT JOIN nomina_entries n ON n.agreement_id = a.id
    LEFT JOIN patient_intakes p ON p.agreement_id = a.id
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
  cobranded: Boolean(row.cobranded),
  type: row.type,
  logo_path: row.logo_path || "",
  logo_url: row.logo_path ? `/uploads/${row.logo_path}` : "",
  pdf_path: row.pdf_path || "",
  pdf_url: row.pdf_path ? `/uploads/${row.pdf_path}` : "",
  payment_evaluation_url: row.payment_evaluation_url || "",
  payment_treatment_url: row.payment_treatment_url || "",
  email_subject_template: row.email_subject_template || defaultPatientSubject,
  email_body_template: row.email_body_template || defaultPatientBody,
  nomina_count: Number(row.nomina_count || 0),
  intake_count: Number(row.intake_count || 0),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const agreementPayloadFromMultipart = async (request) => {
  const { fields, files } = await parseMultipartForm(request);
  const name = String(fields.name || "").trim();
  const slug = slugify(fields.slug || name);
  const type = fields.type === "Nomina" ? "Nomina" : "Pago";
  const subject = String(fields.email_subject_template || defaultPatientSubject).trim();
  const body = String(fields.email_body_template || defaultPatientBody).trim();

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

  const templateErrors = getTemplateErrors(subject, body);
  if (templateErrors.length) {
    const error = new Error("TEMPLATE_INVALID");
    error.statusCode = 422;
    error.details = templateErrors;
    throw error;
  }

  return {
    fields: {
      name,
      slug,
      cobranded: fields.cobranded === "true" || fields.cobranded === "on",
      type,
      payment_evaluation_url:
        type === "Nomina" ? "" : optionalUrl(fields.payment_evaluation_url),
      payment_treatment_url:
        type === "Nomina" ? "" : optionalUrl(fields.payment_treatment_url),
      email_subject_template: subject,
      email_body_template: body,
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

  const result = await query(
    `
      INSERT INTO agreements
        (
          name,
          slug,
          logo_path,
          pdf_path,
          cobranded,
          type,
          payment_evaluation_url,
          payment_treatment_url,
          email_subject_template,
          email_body_template
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.slug,
      logoPath || null,
      pdfPath || null,
      payload.fields.cobranded,
      payload.fields.type,
      payload.fields.payment_evaluation_url || null,
      payload.fields.payment_treatment_url || null,
      payload.fields.email_subject_template,
      payload.fields.email_body_template,
    ],
  );
  await recordAudit("agreement.created", {
    actorUserId: user.id,
    detail: { agreement_id: result.rows[0].id, slug: result.rows[0].slug },
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

  const result = await query(
    `
      UPDATE agreements
      SET name = $1,
          slug = $2,
          logo_path = $3,
          pdf_path = $4,
          cobranded = $5,
          type = $6,
          payment_evaluation_url = $7,
          payment_treatment_url = $8,
          email_subject_template = $9,
          email_body_template = $10,
          updated_at = NOW()
      WHERE id = $11
        AND deleted_at IS NULL
      RETURNING *
    `,
    [
      payload.fields.name,
      payload.fields.slug,
      payload.fields.remove_logo ? null : logoPath || current.logo_path || null,
      payload.fields.remove_pdf ? null : pdfPath || current.pdf_path || null,
      payload.fields.cobranded,
      payload.fields.type,
      payload.fields.payment_evaluation_url || null,
      payload.fields.payment_treatment_url || null,
      payload.fields.email_subject_template,
      payload.fields.email_body_template,
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

  const formUrl = `${config.appPublicUrl}/alta-pacientes/?form=${encodeURIComponent(
    agreement.slug,
  )}`;
  const filename = `reku-alta-pacientes-${downloadSlug(agreement.slug)}-qr.png`;
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

const listPatientIntakes = async (url, response) => {
  const agreementId = url.searchParams.get("agreement_id") || null;
  const result = await query(
    `
      SELECT
        p.*,
        COALESCE(a.name, p.agreement_name_snapshot, '') AS agreement_name,
        COALESCE(a.slug, p.agreement_slug_snapshot, '') AS agreement_slug
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
  created_at: row.created_at,
});

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
  services: row.services || [],
  availability: row.availability || [],
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const professionalSelect = `
  SELECT
    p.*,
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

const replaceProfessionalRelations = async (client, professionalId, serviceIds, availability) => {
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
  const serviceIds = [
    ...new Set(parseJsonArray(fields.service_ids).map((value) => parsePositiveInteger(value))),
  ];
  const availability = normalizeAvailability(fields.availability);

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
  if (!availability.length) {
    const error = new Error("PROFESSIONAL_AVAILABILITY_REQUIRED");
    error.statusCode = 422;
    throw error;
  }

  return {
    fields: {
      name,
      email,
      serviceIds,
      availability,
      active: fields.active !== "false",
      remove_photo: fields.remove_photo === "true",
    },
    files,
  };
};

const createProfessional = async (request, response, user) => {
  const payload = await professionalPayloadFromMultipart(request);
  const photoPath = await saveProfessionalPhoto(payload.files.photo);
  const professionalId = await tx(async (client) => {
    const result = await client.query(
      `
        INSERT INTO professionals (name, email, photo_path, active)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [
        payload.fields.name,
        payload.fields.email,
        photoPath || null,
        payload.fields.active,
      ],
    );
    const id = Number(result.rows[0].id);
    await replaceProfessionalRelations(
      client,
      id,
      payload.fields.serviceIds,
      payload.fields.availability,
    );
    return id;
  });
  await recordAudit("professional.created", {
    actorUserId: user.id,
    detail: { professional_id: professionalId, email: payload.fields.email },
  });
  sendJson(response, 201, { professional: await getProfessionalMapped(professionalId) });
};

const updateProfessional = async (request, response, user, id) => {
  const current = await getProfessionalMapped(id);
  if (!current) {
    sendJson(response, 404, { error: "Profesional no encontrado." });
    return;
  }

  const payload = await professionalPayloadFromMultipart(request);
  const photoPath = await saveProfessionalPhoto(payload.files.photo);
  await tx(async (client) => {
    await client.query(
      `
        UPDATE professionals
        SET name = $1,
            email = $2,
            photo_path = $3,
            active = $4,
            updated_at = NOW()
        WHERE id = $5
      `,
      [
        payload.fields.name,
        payload.fields.email,
        payload.fields.remove_photo ? null : photoPath || current.photo_path || null,
        payload.fields.active,
        id,
      ],
    );
    await replaceProfessionalRelations(
      client,
      id,
      payload.fields.serviceIds,
      payload.fields.availability,
    );
  });
  await recordAudit("professional.updated", {
    actorUserId: user.id,
    detail: { professional_id: id },
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

  const result = await query(
    `
      INSERT INTO schedule_blocks
        (professional_id, block_date, start_time, end_time, reason)
      VALUES ($1, $2::date, $3::time, $4::time, $5)
      RETURNING id
    `,
    [professionalId, blockDate, startTime, endTime, reason || null],
  );
  await recordAudit("schedule_block.created", {
    actorUserId: user.id,
    detail: { schedule_block_id: result.rows[0].id, professional_id: professionalId },
  });
  sendJson(response, 201, { ok: true, id: Number(result.rows[0].id) });
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
  professional_id: Number(row.professional_id),
  service_name: row.service_name || "",
  professional_name: row.professional_name || "",
  appointment_date: row.appointment_date,
  start_time: String(row.start_time || "").slice(0, 5),
  end_time: String(row.end_time || "").slice(0, 5),
  patient_name: row.patient_name || "",
  patient_email: row.patient_email || "",
  patient_phone: row.patient_phone || "",
  amount: Number(row.amount || 0),
  payment_status: row.payment_status,
  status: row.status,
  created_at: row.created_at,
});

const listAppointments = async (response) => {
  const result = await query(`
    SELECT
      a.*,
      s.name AS service_name,
      p.name AS professional_name,
      to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
      to_char(a.start_time, 'HH24:MI') AS start_time,
      to_char(a.end_time, 'HH24:MI') AS end_time
    FROM appointments a
    INNER JOIN services s ON s.id = a.service_id
    INNER JOIN professionals p ON p.id = a.professional_id
    ORDER BY a.appointment_date DESC, a.start_time DESC
    LIMIT 500
  `);
  sendJson(response, 200, { appointments: result.rows.map(mapAppointment) });
};

const dashboard = async (response) => {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM contacts) AS contacts,
      (SELECT COUNT(*)::int FROM patient_intakes) AS patient_intakes,
      (SELECT COUNT(*)::int FROM appointments WHERE status = 'confirmed') AS appointments,
      (SELECT COALESCE(SUM(amount), 0)::numeric
       FROM appointments
       WHERE payment_status IN ('approved', 'paid_simulated', 'free')) AS revenue,
      (SELECT COUNT(*)::int FROM services WHERE deleted_at IS NULL AND active = TRUE) AS services,
      (SELECT COUNT(*)::int FROM professionals WHERE deleted_at IS NULL AND active = TRUE) AS professionals,
      (SELECT COUNT(*)::int FROM schedule_blocks WHERE block_date >= CURRENT_DATE) AS upcoming_blocks
  `);
  sendJson(response, 200, {
    dashboard: {
      contacts: Number(result.rows[0].contacts || 0),
      patient_intakes: Number(result.rows[0].patient_intakes || 0),
      appointments: Number(result.rows[0].appointments || 0),
      revenue: Number(result.rows[0].revenue || 0),
      services: Number(result.rows[0].services || 0),
      professionals: Number(result.rows[0].professionals || 0),
      upcoming_blocks: Number(result.rows[0].upcoming_blocks || 0),
    },
  });
};

const getMercadoPagoSettings = async (response, user) => {
  requireSystemAdmin(user);
  const row = await one("SELECT value FROM app_settings WHERE key = 'mercado_pago'");
  sendJson(response, 200, { settings: publicMercadoPagoSettings(row?.value || {}) });
};

const updateMercadoPagoSettings = async (request, response, user) => {
  requireSystemAdmin(user);
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
  requireSystemAdmin(user);
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

const createTestBookingLink = async (response, user) => {
  const link = await createBookingAccessLink({
    label: `Prueba admin ${user.email}`,
    patientName: user.name || user.email,
    patientEmail: user.email,
    ttlHours: 48,
  });
  await recordAudit("booking_link.test_created", {
    actorUserId: user.id,
    detail: { booking_access_link_id: link.id },
  });
  sendJson(response, 201, {
    booking_url: link.url,
    expires_at: link.expires_at,
  });
};

const validateTemplatePreview = async (request, response) => {
  const payload = await parseJsonBody(request);
  const subject = String(payload.subject || "");
  const body = String(payload.body || "");
  const errors = getTemplateErrors(subject, body);
  sendJson(response, errors.length ? 422 : 200, {
    ok: errors.length === 0,
    errors,
    preview: {
      subject: renderTemplate(subject, sampleTemplateContext()),
      body: renderTemplate(body, sampleTemplateContext()),
    },
  });
};

const sendTemplateTest = async (request, response, user) => {
  const payload = await parseJsonBody(request);
  const to = String(payload.to || "").trim().toLowerCase();
  const subject = String(payload.subject || "");
  const body = String(payload.body || "");
  const type = payload.type === "Nomina" ? "Nomina" : "Pago";

  if (!emailPattern.test(to)) {
    const error = new Error("TEMPLATE_TEST_EMAIL_INVALID");
    error.statusCode = 422;
    throw error;
  }

  const templateErrors = getTemplateErrors(subject, body);
  if (templateErrors.length) {
    const error = new Error("TEMPLATE_INVALID");
    error.statusCode = 422;
    error.details = templateErrors;
    throw error;
  }

  const agreementId = Number(payload.agreement_id || 0);
  const existingAgreement = agreementId ? await getAgreementById(agreementId) : null;
  const sample = sampleTemplateContext();
  const agreement = {
    ...(existingAgreement || {}),
    name:
      String(payload.agreement_name || existingAgreement?.name || sample.agreement.name)
        .trim() || sample.agreement.name,
    type,
    pdf_path: existingAgreement?.pdf_path || "",
    payment_evaluation_url:
      type === "Nomina" ? "" : optionalUrl(payload.payment_evaluation_url),
    payment_treatment_url:
      type === "Nomina" ? "" : optionalUrl(payload.payment_treatment_url),
    email_subject_template: subject,
    email_body_template: body,
  };
  const email = buildPatientEmail({
    submission: { values: sample.patient },
    agreement,
  });
  const result = await sendEmail({
    formName: "template-test",
    to,
    replyTo: user.email,
    ...email,
  });

  await recordAudit("template.test_sent", {
    actorUserId: user.id,
    detail: { to, agreement_id: agreementId || null },
  });
  sendJson(response, 200, { ok: true, id: result?.id || "" });
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
      cobranded: agreement.cobranded,
      type: agreement.type,
      logo_url: agreement.cobranded ? agreement.logo_url : "",
      pdf_url: agreement.pdf_url,
    },
  });
  return true;
};

export const validatePublicAgreementRoute = async (url, response) => {
  const slug = String(url.searchParams.get("form") || "").trim();
  if (!slug) return true;
  const agreement = await getAgreementBySlug(slug);
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
    const professionalMatch = pathname.match(/^\/api\/admin\/professionals\/(\d+)$/);
    if (professionalMatch && request.method === "PUT") {
      await updateProfessional(request, response, user, Number(professionalMatch[1]));
      return true;
    }
    if (professionalMatch && request.method === "DELETE") {
      await deleteProfessional(response, user, Number(professionalMatch[1]));
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

    if (pathname === "/api/admin/booking-links/test" && request.method === "POST") {
      await createTestBookingLink(response, user);
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

    if (pathname === "/api/admin/contacts" && request.method === "GET") {
      await listContacts(response);
      return true;
    }
    const contactMatch = pathname.match(/^\/api\/admin\/contacts\/(\d+)$/);
    if (contactMatch && request.method === "DELETE") {
      await deleteRecord(response, user, "contacts", Number(contactMatch[1]));
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

    if (pathname === "/api/admin/templates/validate" && request.method === "POST") {
      await validateTemplatePreview(request, response);
      return true;
    }
    if (pathname === "/api/admin/templates/test" && request.method === "POST") {
      await sendTemplateTest(request, response, user);
      return true;
    }

    return false;
  } catch (error) {
    if (error.code === "23505") {
      sendJson(response, 409, { error: "Ya existe un registro con esos datos." });
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
    if (error.message === "PROFESSIONAL_AVAILABILITY_REQUIRED") {
      sendJson(response, 422, { error: "Cargá al menos un día y horario de atención." });
      return true;
    }
    if (error.message === "SYSTEM_ADMIN_REQUIRED") {
      sendJson(response, 403, { error: "No tenés permisos para esta configuración." });
      return true;
    }
    if (error.message === "SLUG_REQUIRED") {
      sendJson(response, 422, { error: "El slug no puede quedar vacío." });
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
      error.message === "SES_CONFIGURATION_MISSING"
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
